// Funções compartilhadas pelas rotas da API (arquivos com _ não viram rota na Vercel).
// Abacate Pay, Redis (Upstash, para as estatísticas) e a API de Conversões do Meta.

const crypto = require("crypto");

const ABACATE = "https://api.abacatepay.com/v2";
const PIXEL = "1432467972410871";
const GRAPH = "https://graph.facebook.com/v23.0";
const SITE = "https://workshopcode.uedaagency.com.br";

async function abacate(path, opts = {}) {
  const key = process.env.ABACATEPAY_API_KEY;
  if (!key) throw new Error("ABACATEPAY_API_KEY ausente");
  const r = await fetch(ABACATE + path, {
    ...opts,
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  let body = null;
  try { body = await r.json(); } catch (e) { /* resposta sem JSON */ }
  if (!r.ok || (body && body.success === false)) {
    const msg = (body && body.error && (body.error.message || body.error)) || "HTTP " + r.status;
    const err = new Error(path + ": " + (typeof msg === "string" ? msg : JSON.stringify(msg)));
    err.status = r.status;
    throw err;
  }
  return body;
}

// Redis pela API REST da Upstash. Sem as variáveis, as estatísticas ficam desligadas.
// Aceita qualquer prefixo da integração da Vercel (KV_, STORAGE_, UPSTASH_REDIS_...).
function redisCfg() {
  const env = process.env;
  let url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL, token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    const k = Object.keys(env).find((n) => /_REST_API_URL$/.test(n) && env[n.replace(/_URL$/, "_TOKEN")]);
    if (k) { url = env[k]; token = env[k.replace(/_URL$/, "_TOKEN")]; }
  }
  return url && token ? { url, token } : null;
}
function redisLigado() { return !!redisCfg(); }
async function redis(cmds) {
  const cfg = redisCfg();
  if (!cfg || !cmds.length) return null;
  const { url, token } = cfg;
  const r = await fetch(url.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error("redis HTTP " + r.status);
  return (await r.json()).map((x) => x.result);
}

// Segredo do webhook derivado da chave da Abacate: nada novo para guardar
function segredoWebhook() {
  return crypto.createHmac("sha256", process.env.ABACATEPAY_API_KEY || "").update("motion-code-webhook").digest("hex").slice(0, 40);
}
function iguais(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Dia no horário de Brasília (UTC-3, sem horário de verão)
function diaBR(ts = Date.now()) { return new Date(ts - 3 * 3600e3).toISOString().slice(0, 10); }

const sha = (s) => crypto.createHash("sha256").update(String(s).trim().toLowerCase()).digest("hex");
const corta = (s, n) => String(s == null ? "" : s).slice(0, n);

// Compra para o Meta pela API de Conversões. event_id = código do pedido,
// o mesmo do pixel no obrigado, para o Meta não contar duas vezes.
async function enviarCompraMeta(ck, cliente) {
  const token = process.env.META_CAPI_TOKEN;
  // sem token, o webhook responde erro e a Abacate tenta de novo por até ~18 h
  if (!token) return { ok: false, temporario: true, resposta: "META_CAPI_TOKEN não configurado" };
  const m = ck.metadata || {};
  const ud = { country: [sha("br")] };
  if (cliente && cliente.email) ud.em = [sha(cliente.email)];
  if (cliente && cliente.cellphone) { let d = String(cliente.cellphone).replace(/\D/g, ""); if (d.length <= 11) d = "55" + d; ud.ph = [sha(d)]; }
  if (cliente && cliente.name) { const p = String(cliente.name).trim().toLowerCase().split(/\s+/); ud.fn = [sha(p[0])]; if (p.length > 1) ud.ln = [sha(p[p.length - 1])]; }
  if (m.vid) ud.external_id = [sha(m.vid)];
  if (m.ip) ud.client_ip_address = m.ip;
  if (m.ua) ud.client_user_agent = m.ua;
  if (m.fbc) ud.fbc = m.fbc;
  if (m.fbp) ud.fbp = m.fbp;
  const bumps = String(m.bumps || "").split(",").filter((b) => b && b !== "nenhum");
  // o Meta só aceita eventos dos últimos 7 dias
  const pago = new Date(ck.updatedAt || ck.createdAt || Date.now()).getTime();
  const agora = Date.now();
  const quando = Math.floor(Math.min(agora, Math.max(pago, agora - 6.9 * 864e5)) / 1000);
  const ev = {
    event_name: "Purchase",
    event_time: quando,
    event_id: ck.externalId || ck.id,
    action_source: "website",
    event_source_url: SITE + "/obrigado",
    user_data: ud,
    custom_data: {
      currency: "BRL",
      value: (ck.paidAmount || ck.amount || 0) / 100,
      content_name: "Workshop Motion Code",
      content_type: "product",
      content_ids: ["mc-ingresso"].concat(bumps.map((b) => "mc-bump-" + b)),
      num_items: 1 + bumps.length,
      order_id: ck.externalId || ck.id,
    },
  };
  const body = { data: [ev] };
  if (process.env.META_TEST_CODE) body.test_event_code = process.env.META_TEST_CODE;
  try {
    const r = await fetch(GRAPH + "/" + PIXEL + "/events?access_token=" + encodeURIComponent(token), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    let j = {};
    try { j = await r.json(); } catch (e) { /* sem JSON */ }
    if (r.ok && j.events_received >= 1) return { ok: true, resposta: "recebido pelo Meta" };
    return { ok: false, temporario: r.status >= 500, resposta: (j.error && j.error.message) || "HTTP " + r.status };
  } catch (e) {
    return { ok: false, temporario: true, resposta: e.message };
  }
}

// Dados do comprador: vem no webhook ou é buscado na Abacate
async function clienteDo(ck, doWebhook) {
  if (doWebhook && (doWebhook.email || doWebhook.cellphone || doWebhook.name)) return doWebhook;
  if (!ck.customerId) return null;
  try { return (await abacate("/customers/get?id=" + encodeURIComponent(ck.customerId))).data || null; } catch (e) { return null; }
}

module.exports = { abacate, redis, redisLigado, segredoWebhook, iguais, diaBR, sha, corta, enviarCompraMeta, clienteDo, PIXEL, SITE };
