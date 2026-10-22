// Dados do painel /admin: vendas (direto da Abacate Pay), estatísticas de navegação
// (Redis) e ações (ativar o aviso de vendas, mandar uma venda para o Meta).
// Protegido pela senha da variável ADMIN_SENHA na Vercel.

const { abacate, redis, redisLigado, segredoWebhook, iguais, diaBR, enviarCompraMeta, clienteDo, SITE } = require("./_comum");

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

async function estadoWebhook() {
  try {
    const b = await abacate("/webhooks/list", { method: "GET" });
    const arr = Array.isArray(b.data) ? b.data : [];
    return arr.some((w) => String(w.endpoint || "").includes("/api/abacate-webhook")) ? "ativo" : "inativo";
  } catch (e) { return "desconhecido"; }
}

async function estatisticas(ds) {
  if (!redisLigado()) return null;
  const cmds = [];
  ds.forEach((d) => {
    ["d", "s", "o", "c", "dev", "p"].forEach((k) => cmds.push(["HGETALL", "mc:" + k + ":" + d]));
    cmds.push(["PFCOUNT", "mc:uv:" + d]);
  });
  cmds.push(["PFCOUNT", ...ds.map((d) => "mc:uv:" + d)]);
  ["lotes", "cta", "modal", "pix"].forEach((f) => cmds.push(["PFCOUNT", ...ds.map((d) => "mc:f:" + d + ":" + f)]));
  const r = await redis(cmds);
  const est = { porDia: [], tot: {}, secoes: {}, origens: {}, campanhas: {}, dispositivos: {}, perfis: {}, pessoas: 0, funil: {} };
  ds.forEach((d, i) => {
    const b = i * 7, dd = hash(r[b]);
    somaEm(est.tot, dd); somaEm(est.secoes, hash(r[b + 1])); somaEm(est.origens, hash(r[b + 2]));
    somaEm(est.campanhas, hash(r[b + 3])); somaEm(est.dispositivos, hash(r[b + 4])); somaEm(est.perfis, hash(r[b + 5]));
    est.porDia.push({ dia: d, visitas: dd.visitas || 0, pessoas: r[b + 6] || 0 });
  });
  const f = ds.length * 7;
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
        const manual = { endereco: webhookEndereco(), segredo: segredoWebhook(), evento: "checkout.completed" };
        try {
          await abacate("/webhooks/create", { method: "POST", body: JSON.stringify({ name: "Motion Code · vendas", endpoint: manual.endereco, secret: manual.segredo, events: ["checkout.completed"] }) });
          return res.status(200).json({ ok: true });
        } catch (e) {
          return res.status(200).json({ ok: false, erro: e.message, manual });
        }
      }

      if (b.acao === "meta") {
        const p = String(b.pedido || "");
        if (!/^mc-\d{10,}-[a-z0-9]{1,12}$/.test(p)) return res.status(400).json({ erro: "Pedido inválido." });
        const ck = (await abacate("/checkouts/get?externalId=" + encodeURIComponent(p), { method: "GET" })).data;
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

    const [pagos, pendentes, webhook, est] = await Promise.all([
      listar("PAID"),
      listar("PENDING").catch(() => []),
      estadoWebhook(),
      estatisticas(ds).catch((e) => { console.error("[admin] redis", e.message); return null; }),
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
        origem: { src: m.src || "", camp: m.camp || "", cont: m.cont || "" },
        cliente: cli ? { nome: cli.name || "", email: cli.email || "", fone: cli.cellphone || "" } : null,
        meta,
        podeMeta: Date.now() - new Date(c.updatedAt || c.createdAt).getTime() < 6.9 * 864e5,
      };
    }).sort((a, b) => (a.pagoEm < b.pagoEm ? 1 : -1));

    const vendasPorDia = {};
    vendas.forEach((v) => { const d = diaBR(new Date(v.pagoEm).getTime()); vendasPorDia[d] = (vendasPorDia[d] || 0) + 1; });
    if (est) est.porDia.forEach((x) => { x.vendas = vendasPorDia[x.dia] || 0; });

    return res.status(200).json({
      periodo, inicio: ini, fim,
      config: { redis: redisLigado(), meta: !!process.env.META_CAPI_TOKEN, teste: !!process.env.META_TEST_CODE, webhook },
      vendas,
      pixGerados: pendentes.filter((c) => noPeriodo(c.createdAt)).length,
      vendasPorDia: ds.map((d) => ({ dia: d, vendas: vendasPorDia[d] || 0 })),
      estat: est,
    });
  } catch (e) {
    console.error("[admin]", e.message);
    return res.status(502).json({ erro: "Não consegui falar com a Abacate Pay agora: " + e.message });
  }
};
