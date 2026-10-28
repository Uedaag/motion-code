// Cria a cobrança PIX na Abacate Pay com o ingresso do lote atual + os order bumps escolhidos.
// O preço é decidido aqui no servidor, pela data, nunca pelo navegador.
// Com nome, e-mail e telefone (página /pagamento), o PIX sai direto na página, sem CPF
// (checkout transparente). Se a Abacate recusar, cai no checkout hospedado dela.
// Variável de ambiente necessária na Vercel: ABACATEPAY_API_KEY

const API = "https://api.abacatepay.com/v2";
const { redis } = require("./_comum");

// Contato digitado na página /pagamento
function contato(x) {
  const nome = String((x && x.nome) || "").trim().replace(/\s+/g, " ").slice(0, 80);
  const email = String((x && x.email) || "").trim().toLowerCase().slice(0, 120);
  let tel = String((x && x.telefone) || "").replace(/\D/g, "");
  if (tel.length > 11 && tel.startsWith("55")) tel = tel.slice(2);
  if (nome.length < 3 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || !/^\d{10,11}$/.test(tel)) return null;
  return { nome, email, tel };
}

// Afiliado que trouxe o comprador: só vale se estiver cadastrado no painel
async function afiliadoValido(af) {
  af = String(af || "").toLowerCase();
  if (!/^[a-z0-9-]{2,40}$/.test(af)) return "";
  try { const r = await redis([["HEXISTS", "mc:af", af]]); return r === null || r[0] ? af : ""; } catch (e) { return af; }
}

// Lotes: válidos até a data indicada (horário de Brasília)
const LOTES = [
  { externalId: "mc-ingresso-lote-1", name: "Workshop Motion Code (Lote 1)", price: 3700, ate: "2026-10-25T23:59:59-03:00" },
  { externalId: "mc-ingresso-lote-2", name: "Workshop Motion Code (Lote 2)", price: 4700, ate: "2026-10-29T18:00:00-03:00" },
];

const BUMPS = {
  aula:    { externalId: "mc-bump-aula",    name: "Aula Gravada Motion Code",        price: 1990, description: "Gravação completa do workshop para rever quando precisar" },
  moldes:  { externalId: "mc-bump-moldes",  name: "Biblioteca de Moldes de Anúncio", price: 4700, description: "12 moldes de anúncio em motion (9:16, 1:1 e 16:9) prontos para editar" },
  estilos: { externalId: "mc-bump-estilos", name: "Mesa de Estilos Motion Code",     price: 2700, description: "30 estilos visuais com o prompt de cada um" },
};

function loteAtual(agora = Date.now()) {
  return LOTES.find((l) => agora <= new Date(l.ate).getTime()) || null;
}

async function api(path, key, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  let body = null;
  try { body = await r.json(); } catch (e) { /* resposta sem JSON */ }
  if (!r.ok || (body && body.success === false)) {
    const msg = (body && (body.error && (body.error.message || body.error))) || ("HTTP " + r.status);
    throw new Error(path + ": " + (typeof msg === "string" ? msg : JSON.stringify(msg)));
  }
  return body;
}

// Guarda os IDs dos produtos enquanto a função estiver "quente"
const cache = {};

async function listarProdutos(key) {
  const out = [];
  try {
    const b = await api("/products/list", key, { method: "GET" });
    const d = b && b.data;
    const arr = Array.isArray(d) ? d : (d && (d.data || d.items || d.products)) || [];
    for (const p of arr) out.push(p);
  } catch (e) { /* se a listagem falhar, segue e tenta criar */ }
  return out;
}

async function idDoProduto(def, key) {
  if (cache[def.externalId]) return cache[def.externalId];
  const lista = await listarProdutos(key);
  const achado = lista.find((p) => p.externalId === def.externalId && p.price === def.price && p.status !== "INACTIVE");
  if (achado) return (cache[def.externalId] = achado.id);
  const corpo = { externalId: def.externalId, name: def.name, price: def.price, currency: "BRL" };
  if (def.description) corpo.description = def.description;
  const b = await api("/products/create", key, { method: "POST", body: JSON.stringify(corpo) });
  return (cache[def.externalId] = b.data.id);
}

function origem(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  return proto + "://" + req.headers.host;
}

// Dados para o Meta reconhecer quem comprou (usados pelo webhook na API de Conversões)
// e a origem da visita, que aparece no painel /admin
function rastreio(req, pedido) {
  const ck = {};
  String(req.headers.cookie || "").split(";").forEach((p) => { const i = p.indexOf("="); if (i > 0) ck[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  const o = (pedido && typeof pedido.origem === "object" && pedido.origem) || {};
  const c = (s, n) => String(s == null ? "" : s).slice(0, n);
  let fbc = ck._fbc || "";
  if (!fbc && o.fbclid) fbc = "fb.1." + Date.now() + "." + c(o.fbclid, 200);
  return {
    vid: c(pedido && pedido.vid, 40),
    fbp: c(ck._fbp, 80),
    fbc: c(fbc, 260),
    ip: c(String(req.headers["x-forwarded-for"] || "").split(",")[0].trim(), 45),
    ua: c(req.headers["user-agent"], 220),
    src: c(o.src, 60), med: c(o.med, 60), camp: c(o.camp, 90), cont: c(o.cont, 90), ref: c(o.ref, 60),
  };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") {
    const l = loteAtual();
    return res.status(200).json({ lote: l ? { nome: l.name, preco: l.price, ate: l.ate } : null, bumps: Object.fromEntries(Object.entries(BUMPS).map(([k, b]) => [k, { nome: b.name, preco: b.price }])) });
  }
  if (req.method !== "POST") return res.status(405).json({ erro: "Método não permitido" });

  const key = process.env.ABACATEPAY_API_KEY;
  if (!key) return res.status(500).json({ erro: "Pagamento ainda não configurado." });

  const lote = loteAtual();
  if (!lote) return res.status(410).json({ erro: "As vendas do workshop foram encerradas." });

  let pedido = req.body;
  if (typeof pedido === "string") { try { pedido = JSON.parse(pedido); } catch (e) { pedido = {}; } }
  const escolhidos = Array.isArray(pedido && pedido.bumps) ? [...new Set(pedido.bumps.filter((b) => BUMPS[b]))] : [];
  const direto = !!(pedido && pedido.modo === "direto");
  const dados = direto ? contato(pedido) : null;
  if (direto && !dados) return res.status(400).json({ erro: "Confira seu nome, e-mail e telefone com DDD." });

  const pedidoId = "mc-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const rastro = rastreio(req, pedido);
  const af = await afiliadoValido(pedido && pedido.af);

  if (dados) {
    const valor = lote.price + escolhidos.reduce((t, b) => t + BUMPS[b].price, 0);
    const descricao = [lote.name].concat(escolhidos.map((b) => BUMPS[b].name)).join(" + ");
    const essencial = { pedido: pedidoId, lote: lote.externalId, bumps: escolhidos.join(",") || "nenhum", nome: dados.nome, email: dados.email, tel: dados.tel, ...(af ? { af } : {}) };
    const cria = (metadata) => api("/transparents/create", key, { method: "POST", body: JSON.stringify({ method: "PIX", data: { amount: valor, description: descricao, expiresIn: 3600, externalId: pedidoId, metadata } }) });
    try {
      let meta = { ...rastro, ...essencial }, b;
      try { b = await cria(meta); }
      catch (e) { console.error("[checkout] PIX direto com metadata completo recusado:", e.message); meta = essencial; b = await cria(meta); }
      const d = b.data || {};
      if (!d.id || !d.brCode) throw new Error("PIX direto sem código: " + JSON.stringify(d).slice(0, 200));
      // registro do pedido: a entrega, o webhook e o painel acham o PIX direto por aqui
      await redis([["SET", "mc:pix:" + pedidoId, JSON.stringify({ id: d.id, valor, criado: d.createdAt || new Date().toISOString(), meta }), "EX", 2592000]]).catch((e) => console.error("[checkout] redis", e.message));
      return res.status(200).json({ pedido: pedidoId, valor, pix: { codigo: d.brCode, imagem: d.brCodeBase64 || "", expira: d.expiresAt || "" } });
    } catch (e) {
      // sem o PIX direto (permissão da chave ou instabilidade), a venda segue pela tela da Abacate
      console.error("[checkout] PIX direto falhou, usando o checkout hospedado:", e.message);
    }
  }

  try {
    const itens = [{ id: await idDoProduto(lote, key), quantity: 1 }];
    for (const b of escolhidos) itens.push({ id: await idDoProduto(BUMPS[b], key), quantity: 1 });
    const site = origem(req);
    // O código do pedido volta na página de obrigado, que consulta o pagamento para liberar os bônus comprados
    const corpo = {
      items: itens,
      methods: ["PIX"],
      returnUrl: site + "/#lotes",
      completionUrl: site + "/obrigado?p=" + pedidoId,
      externalId: pedidoId,
      metadata: { lote: lote.externalId, bumps: escolhidos.join(",") || "nenhum", ...rastro },
    };
    if (af) corpo.metadata.af = af;
    let b;
    try { b = await api("/checkouts/create", key, { method: "POST", body: JSON.stringify(corpo) }); }
    catch (e) {
      // se a Abacate recusar os dados extras, a venda segue só com o essencial
      console.error("[checkout] metadata completo recusado:", e.message);
      corpo.metadata = { lote: lote.externalId, bumps: escolhidos.join(",") || "nenhum", ...(af ? { af } : {}) };
      b = await api("/checkouts/create", key, { method: "POST", body: JSON.stringify(corpo) });
    }
    return res.status(200).json({ url: b.data.url, pedido: pedidoId });
  } catch (e) {
    console.error("[checkout]", e.message);
    return res.status(502).json({ erro: "Não foi possível abrir o pagamento agora. Tente de novo em instantes." });
  }
};

module.exports.LOTES = LOTES;
module.exports.BUMPS = BUMPS;
module.exports.loteAtual = loteAtual;
