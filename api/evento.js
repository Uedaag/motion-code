// Recebe os eventos de navegação da página (visita, seção vista, cliques de compra)
// e soma no Redis por dia. É o que alimenta as estatísticas do painel /admin.

const { redis, redisLigado, diaBR, corta } = require("./_comum");

const TIPOS = ["visita", "secao", "cta", "modal", "pix", "obrigado", "afiliado"];
const SECOES = ["vsl", "vslplay", "vsl25", "vsl50", "vsl75", "vsl100", "palco", "apresentacao", "cliques", "portfolio", "feitos", "muda", "calculadora", "virada", "metodo", "comecar", "programa", "paraquem", "conduz", "aovivo", "lotes", "duvidas", "final"];
const VIDA = 34560000; // 400 dias

const limpa = (s, n) => corta(s, n).toLowerCase().replace(/[^\p{L}\p{N} ._|:/-]/gu, "").trim();

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).end();
  // só conta visitas do site oficial (prévias da Vercel não entram nas estatísticas)
  if (!redisLigado() || (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production")) return res.status(204).end();

  let e = req.body;
  if (typeof e === "string") { try { e = JSON.parse(e); } catch (x) { e = null; } }
  if (!e || !TIPOS.includes(e.t)) return res.status(400).end();
  const vid = limpa(e.v, 40) || "anonimo";
  const d = diaBR();
  const cmds = [];
  const soma = (k, campo) => { cmds.push(["HINCRBY", k, campo, 1], ["EXPIRE", k, VIDA]); };
  const unico = (k) => { cmds.push(["PFADD", k, vid], ["EXPIRE", k, VIDA]); };

  if (e.t === "visita") {
    soma("mc:d:" + d, "visitas");
    unico("mc:uv:" + d);
    const src = limpa(e.src, 60), ref = limpa(e.ref, 60);
    soma("mc:o:" + d, src || (ref ? "site: " + ref : "direto"));
    const camp = limpa(e.camp, 90), cont = limpa(e.cont, 90);
    if (camp || cont) soma("mc:c:" + d, (camp || "sem campanha") + " | " + (cont || "sem anúncio"));
    soma("mc:dev:" + d, e.dev === "celular" ? "celular" : "computador");
    if (e.perfil) soma("mc:p:" + d, limpa(e.perfil, 30));
  } else if (e.t === "afiliado") {
    // chegada pelo link de um afiliado cadastrado no painel
    const af = String(e.af || "").toLowerCase();
    if (!/^[a-z0-9-]{2,40}$/.test(af)) return res.status(400).end();
    try { const r = await redis([["HEXISTS", "mc:af", af]]); if (!r || !r[0]) return res.status(204).end(); } catch (x) { return res.status(204).end(); }
    soma("mc:afv:" + d, af);
    unico("mc:afu:" + d + ":" + af);
  } else if (e.t === "secao") {
    if (!SECOES.includes(e.s)) return res.status(400).end();
    soma("mc:s:" + d, e.s);
    if (e.s === "lotes") unico("mc:f:" + d + ":lotes");
  } else {
    soma("mc:d:" + d, e.t);
    if (e.t !== "obrigado") unico("mc:f:" + d + ":" + e.t);
  }

  try { await redis(cmds); } catch (x) { console.error("[evento]", x.message); }
  return res.status(204).end();
};

module.exports.SECOES = SECOES;
