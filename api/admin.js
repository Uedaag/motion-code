// Dados do painel /admin: vendas (direto da Abacate Pay), estatísticas de navegação
// (Redis) e ações (ativar o aviso de vendas, mandar uma venda para o Meta).
// Protegido pela senha da variável ADMIN_SENHA na Vercel.

const { abacate, redis, redisLigado, segredoWebhook, iguais, diaBR, enviarCompraMeta, clienteDo, listarPix, buscarPedido, SITE } = require("./_comum");

const INICIO = "2026-10-16"; // site no ar
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (arr) => { const o = {}; for (let i = 0; arr && i < arr.length; i += 2) o[arr[i]] = +arr[i + 1] || 0; return o; };
const somaEm = (alvo, o) => { for (const k in o) alvo[k] = (alvo[k] || 0) + o[k]; return alvo; };

function dias(periodo) {
  const hoje = diaBR();
  let ini = INICIO;
  if (periodo === "hoje") ini = hoje;
  else if (periodo === "7" || periodo === "30") ini = diaBR(Date.now() - (+periodo - 1) * 864e5);
  if (ini < INICIO) ini = INICIO;
  const out = [];
  const proximo = (d) => new Date(new Date(d + "T00:00:00Z").getTime() + 864e5).toISOString().slice(0, 10);
  for (let d = ini; d <= hoje && out.length < 400; d = proximo(d)) out.push(d);
  return out;
}

async function listar(status) {
  const out = [];
  let after = "";
  for (let i = 0; i < 5; i++) {
    const b = await abacate("/checkouts/list?status=" + status + "&limit=100" + (after ? "&after=" + encodeURIComponent(after) : ""), { method: "GET" });
    const arr = Array.isArray(b.data) ? b.data : [];
    out.push(...arr.filter((c) => String(c.externalId || "").startsWith("mc-")));
    if (!b.pagination || !b.pagination.hasMore || !b.pagination.next) break;
    after = b.pagination.next;
  }
  return out;
}

const webhookEndereco = () => SITE + "/api/abacate-webhook?webhookSecret=" + segredoWebhook();
const EVENTOS = ["checkout.completed", "transparent.completed"]; // tela da Abacate e PIX direto da página /pagamento

/* ---------- afiliados: cadastrados no Redis (mc:af), link /a/<slug> ---------- */
const slugDe = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
async function afiliados() {
  if (!redisLigado()) return {};
  const r = await redis([["HGETALL", "mc:af"]]);
  const arr = (r && r[0]) || [], o = {};
  for (let i = 0; i < arr.length; i += 2) { try { o[arr[i]] = JSON.parse(arr[i + 1]); } catch (e) { /* registro inválido */ } }
  return o;
}
// visitas pelo link, pessoas diferentes, vendas e comissão de cada afiliado no período
async function resumoAfiliados(afs, ds, vendas) {
  const slugs = Object.keys(afs);
  vendas.forEach((v) => { if (v.afiliado && !slugs.includes(v.afiliado.slug)) slugs.push(v.afiliado.slug); });
  if (!slugs.length) return [];
  const cmds = ds.map((d) => ["HGETALL", "mc:afv:" + d]).concat(slugs.map((s) => ["PFCOUNT", ...ds.map((d) => "mc:afu:" + d + ":" + s)]));
  const r = await redis(cmds);
  const visitas = {};
  ds.forEach((d, i) => somaEm(visitas, hash(r[i])));
  return slugs.map((s, i) => {
    const a = afs[s] || null, minhas = vendas.filter((v) => v.afiliado && v.afiliado.slug === s);
    const faturamento = minhas.reduce((t, v) => t + v.valor, 0), comissao = a ? a.comissao || 0 : 0;
    return {
      slug: s, nome: a ? a.nome : s, removido: !a, comissao, criado: a ? a.criado : null, link: SITE + "/a/" + s,
      visitas: visitas[s] || 0, pessoas: r[ds.length + i] || 0, vendas: minhas.length,
      faturamento, aPagar: Math.round(faturamento * comissao) / 100,
    };
  }).sort((x, y) => y.faturamento - x.faturamento || y.visitas - x.visitas);
}

// eventos que já chegam no aviso de vendas (somando todos os webhooks do site)
async function eventosAtivos() {
  const b = await abacate("/webhooks/list", { method: "GET" });
  const arr = Array.isArray(b.data) ? b.data : [];
  const ev = new Set();
  arr.filter((w) => String(w.endpoint || "").includes("/api/abacate-webhook")).forEach((w) => (Array.isArray(w.events) && w.events.length ? w.events : ["checkout.completed"]).forEach((e) => ev.add(e)));
  return ev;
}
async function estadoWebhook() {
  try {
    const ev = await eventosAtivos();
    if (EVENTOS.every((e) => ev.has(e))) return "ativo";
    return ev.size ? "parcial" : "inativo";
  } catch (e) { return "desconhecido"; }
}

async function estatisticas(ds) {
  if (!redisLigado()) return null;
  const cmds = [];
  ds.forEach((d) => {
    ["d", "s", "o", "c", "dev", "p"].forEach((k) => cmds.push(["HGETALL", "mc:" + k + ":" + d]));
    cmds.push(["PFCOUNT", "mc:uv:" + d]);
    ["cta", "modal", "pix"].forEach((f) => cmds.push(["PFCOUNT", "mc:f:" + d + ":" + f]));  // pessoas em cada etapa, no dia
  });
  cmds.push(["PFCOUNT", ...ds.map((d) => "mc:uv:" + d)]);
  ["lotes", "cta", "modal", "pix"].forEach((f) => cmds.push(["PFCOUNT", ...ds.map((d) => "mc:f:" + d + ":" + f)]));
  const r = await redis(cmds);
  const est = { porDia: [], tot: {}, secoes: {}, origens: {}, campanhas: {}, dispositivos: {}, perfis: {}, pessoas: 0, funil: {} };
  ds.forEach((d, i) => {
    const b = i * 10, dd = hash(r[b]), sd = hash(r[b + 1]);
    somaEm(est.tot, dd); somaEm(est.secoes, sd); somaEm(est.origens, hash(r[b + 2]));
    somaEm(est.campanhas, hash(r[b + 3])); somaEm(est.dispositivos, hash(r[b + 4])); somaEm(est.perfis, hash(r[b + 5]));
    est.porDia.push({ dia: d, visitas: dd.visitas || 0, pessoas: r[b + 6] || 0, cta: r[b + 7] || 0, modal: r[b + 8] || 0, pix: r[b + 9] || 0,
      vsl: sd.vsl || 0, vslplay: sd.vslplay || 0, vsl50: sd.vsl50 || 0 });
  });
  const f = ds.length * 10;
  est.pessoas = r[f] || 0;
  est.funil = { lotes: r[f + 1] || 0, cta: r[f + 2] || 0, modal: r[f + 3] || 0, pix: r[f + 4] || 0 };
  return est;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const senha = process.env.ADMIN_SENHA;
  if (!senha) return res.status(503).json({ erro: "Defina a variável ADMIN_SENHA na Vercel para usar o painel." });
  if (!iguais(String(req.headers["x-senha"] || ""), senha)) { await espera(600); return res.status(401).json({ erro: "Senha incorreta." }); }

  try {
    if (req.method === "POST") {
      let b = req.body;
      if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
      b = b || {};

      if (b.acao === "webhook") {
        const manual = { endereco: webhookEndereco(), segredo: segredoWebhook(), evento: EVENTOS.join(" e ") };
        try {
          // cria só o que falta: quem já tinha o aviso da tela da Abacate ganha o do PIX direto
          const ativos = await eventosAtivos().catch(() => new Set());
          const faltam = EVENTOS.filter((e) => !ativos.has(e));
          if (!faltam.length) return res.status(200).json({ ok: true });
          await abacate("/webhooks/create", { method: "POST", body: JSON.stringify({ name: "Motion Code · vendas" + (faltam.length < EVENTOS.length ? " (PIX direto)" : ""), endpoint: manual.endereco, secret: manual.segredo, events: faltam }) });
          return res.status(200).json({ ok: true });
        } catch (e) {
          return res.status(200).json({ ok: false, erro: e.message, manual });
        }
      }

      if (b.acao === "afiliado-novo") {
        if (!redisLigado()) return res.status(400).json({ erro: "Ligue o armazenamento (Upstash) para cadastrar afiliados." });
        const nome = String(b.nome || "").trim().slice(0, 60);
        if (nome.length < 2) return res.status(400).json({ erro: "Digite o nome do afiliado." });
        const comissao = Math.max(0, Math.min(100, Number(String(b.comissao || "0").replace(",", ".")) || 0));
        const atuais = await afiliados();
        const base = slugDe(b.slug || nome) || "afiliado";
        let slug = base;
        for (let n = 2; atuais[slug]; n++) slug = base.slice(0, 27) + "-" + n;
        await redis([["HSET", "mc:af", slug, JSON.stringify({ nome, comissao, criado: Date.now() })]]);
        return res.status(200).json({ ok: true, slug, link: SITE + "/a/" + slug });
      }

      if (b.acao === "afiliado-remover") {
        const slug = String(b.slug || "");
        if (!/^[a-z0-9-]{2,40}$/.test(slug)) return res.status(400).json({ erro: "Afiliado inválido." });
        await redis([["HDEL", "mc:af", slug]]);
        return res.status(200).json({ ok: true });
      }

      if (b.acao === "meta") {
        const p = String(b.pedido || "");
        if (!/^mc-\d{10,}-[a-z0-9]{1,12}$/.test(p)) return res.status(400).json({ erro: "Pedido inválido." });
        const ck = await buscarPedido(p);
        if (!ck || ck.status !== "PAID") return res.status(400).json({ erro: "Esse pedido não está pago." });
        const meta = await enviarCompraMeta(ck, await clienteDo(ck));
        await redis([["SET", "mc:meta:" + p, JSON.stringify({ ok: meta.ok, quando: Date.now(), resposta: meta.resposta, via: "painel" }), "EX", 31536000]]).catch(() => null);
        return res.status(200).json(meta);
      }

      return res.status(400).json({ erro: "Ação desconhecida." });
    }

    // GET: painel
    const periodo = String((req.query && req.query.periodo) || "7");
    const ds = dias(periodo);
    const ini = ds[0], fim = ds[ds.length - 1];
    const noPeriodo = (iso) => { const d = diaBR(new Date(iso).getTime()); return d >= ini && d <= fim; };

    // PIX direto (página /pagamento) entra junto; o que expirou sem pagar também conta como PIX sem pagamento
    const pix = (st) => listarPix(st).catch((e) => { console.error("[admin] PIX direto", st, e.message); return []; });
    const [pagos, pendentes, webhook, est, afs] = await Promise.all([
      Promise.all([listar("PAID"), pix("PAID")]).then((x) => x.flat()),
      Promise.all([listar("PENDING").catch(() => []), pix("PENDING"), pix("EXPIRED")]).then((x) => x.flat()),
      estadoWebhook(),
      estatisticas(ds).catch((e) => { console.error("[admin] redis", e.message); return null; }),
      afiliados().catch(() => ({})),
    ]);

    const doPeriodo = pagos.filter((c) => noPeriodo(c.updatedAt || c.createdAt));
    const metaSt = redisLigado() && doPeriodo.length ? await redis(doPeriodo.map((c) => ["GET", "mc:meta:" + c.externalId])).catch(() => null) : null;
    const clientes = await Promise.all(doPeriodo.slice(0, 60).map((c) => clienteDo(c)));

    const vendas = doPeriodo.map((c, i) => {
      const m = c.metadata || {};
      const cli = clientes[i] || null;
      let meta = null;
      try { meta = metaSt && metaSt[i] ? JSON.parse(metaSt[i]) : null; } catch (e) { meta = null; }
      return {
        pedido: c.externalId,
        pagoEm: c.updatedAt || c.createdAt,
        valor: (c.paidAmount || c.amount || 0) / 100,
        lote: String(m.lote || "").replace("mc-ingresso-", "").replace("-", " "),
        bumps: String(m.bumps || "").split(",").filter((b) => b && b !== "nenhum"),
        origem: { src: m.src || "", camp: m.camp || "", cont: m.cont || "", ref: m.ref || "" },
        afiliado: m.af ? { slug: m.af, nome: (afs[m.af] && afs[m.af].nome) || m.af } : null,
        cliente: cli ? { nome: cli.name || "", email: cli.email || "", fone: cli.cellphone || "" } : null,
        meta,
        podeMeta: Date.now() - new Date(c.updatedAt || c.createdAt).getTime() < 6.9 * 864e5,
      };
    }).sort((a, b) => (a.pagoEm < b.pagoEm ? 1 : -1));

    // PIX gerados sem pagamento: uma linha por pessoa (a tentativa mais recente). Quem pagou depois fica de fora.
    // No PIX direto não há cliente na Abacate: a pessoa é reconhecida pelo e-mail.
    const quem = (c) => c.customerId || (c.contato && c.contato.email ? "e:" + String(c.contato.email).toLowerCase() : "");
    const compradores = new Set(pagos.map(quem).filter(Boolean));
    const emailsPagos = new Set(clientes.filter(Boolean).map((c) => String(c.email || "").toLowerCase()).filter(Boolean));
    const pendPeriodo = pendentes.filter((c) => noPeriodo(c.createdAt)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const vistos = new Map();
    let semDados = 0, pagaramDepois = 0;
    for (const c of pendPeriodo) {
      const q = quem(c);
      if (!q) { semDados++; continue; }
      if (compradores.has(q)) { pagaramDepois++; continue; }
      if (vistos.has(q)) { vistos.get(q).tentativas++; continue; }
      vistos.set(q, { ck: c, tentativas: 1 });
    }
    const pend = [...vistos.values()].slice(0, 60);
    const clientesPend = await Promise.all(pend.map((p) => clienteDo(p.ck)));
    const abandonos = [];
    pend.forEach((p, i) => {
      const c = p.ck, m = c.metadata || {}, cli = clientesPend[i];
      if (cli && cli.email && emailsPagos.has(String(cli.email).toLowerCase())) { pagaramDepois++; return; }
      abandonos.push({
        pedido: c.externalId,
        geradoEm: c.createdAt,
        valor: (c.amount || 0) / 100,
        tentativas: p.tentativas,
        lote: String(m.lote || "").replace("mc-ingresso-", "").replace("-", " "),
        bumps: String(m.bumps || "").split(",").filter((b) => b && b !== "nenhum"),
        origem: { src: m.src || "", camp: m.camp || "", cont: m.cont || "", ref: m.ref || "" },
        afiliado: m.af ? { slug: m.af, nome: (afs[m.af] && afs[m.af].nome) || m.af } : null,
        cliente: cli ? { nome: cli.name || "", email: cli.email || "", fone: cli.cellphone || "" } : null,
      });
    });

    const vendasPorDia = {}, fatPorDia = {}, pixPorDia = {};
    vendas.forEach((v) => { const d = diaBR(new Date(v.pagoEm).getTime()); vendasPorDia[d] = (vendasPorDia[d] || 0) + 1; fatPorDia[d] = (fatPorDia[d] || 0) + v.valor; });
    pagos.concat(pendentes).forEach((c) => { const d = diaBR(new Date(c.createdAt).getTime()); pixPorDia[d] = (pixPorDia[d] || 0) + 1; });
    if (est) est.porDia.forEach((x) => { x.vendas = vendasPorDia[x.dia] || 0; x.faturamento = fatPorDia[x.dia] || 0; x.pixGerados = pixPorDia[x.dia] || 0; });

    return res.status(200).json({
      periodo, inicio: ini, fim,
      config: { redis: redisLigado(), meta: !!process.env.META_CAPI_TOKEN, teste: !!process.env.META_TEST_CODE, webhook },
      vendas,
      afiliados: redisLigado() ? await resumoAfiliados(afs, ds, vendas).catch((e) => { console.error("[admin] afiliados", e.message); return []; }) : null,
      pixGerados: pendentes.filter((c) => noPeriodo(c.createdAt)).length,
      abandonos, abandonoResumo: { semDados, pagaramDepois },
      vendasPorDia: ds.map((d) => ({ dia: d, vendas: vendasPorDia[d] || 0, faturamento: fatPorDia[d] || 0, pixGerados: pixPorDia[d] || 0 })),
      estat: est,
    });
  } catch (e) {
    console.error("[admin]", e.message);
    return res.status(502).json({ erro: "Não consegui falar com a Abacate Pay agora: " + e.message });
  }
};
