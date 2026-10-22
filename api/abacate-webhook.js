// A Abacate Pay chama esta rota quando um PIX é pago (evento checkout.completed).
// Daqui a compra vai para o Meta pela API de Conversões, mesmo que o cliente
// feche a página e nunca chegue ao obrigado.
// Endereço cadastrado na Abacate: /api/abacate-webhook?webhookSecret=<segredo do painel>

const { abacate, redis, segredoWebhook, iguais, diaBR, enviarCompraMeta, clienteDo } = require("./_comum");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ erro: "Método não permitido" });
  const seg = String((req.query && req.query.webhookSecret) || "");
  if (!seg || !iguais(seg, segredoWebhook())) return res.status(401).json({ erro: "Não autorizado" });

  let ev = req.body;
  if (typeof ev === "string") { try { ev = JSON.parse(ev); } catch (e) { ev = {}; } }
  if (!ev || ev.event !== "checkout.completed") return res.status(200).json({ ok: true, ignorado: ev && ev.event });
  if (ev.devMode) return res.status(200).json({ ok: true, ignorado: "devMode" });

  const d = ev.data || {};
  const c0 = d.checkout || d;
  const chave = "mc:wh:" + (ev.id || c0.id);
  try {
    // a Abacate pode reenviar o mesmo evento: processa uma vez só
    const r0 = await redis([["SET", chave, "1", "NX", "EX", 259200]]).catch(() => null);
    if (r0 && r0[0] === null) return res.status(200).json({ ok: true, repetido: true });

    let ck = c0;
    if (c0.id) { try { ck = (await abacate("/checkouts/get?id=" + encodeURIComponent(c0.id))).data || c0; } catch (e) { ck = c0; } }
    if (!String(ck.externalId || "").startsWith("mc-")) return res.status(200).json({ ok: true, ignorado: "não é do Motion Code" });

    const cliente = await clienteDo(ck, d.customer);
    const meta = await enviarCompraMeta(ck, cliente);
    if (!meta.ok && meta.temporario) {
      await redis([["DEL", chave]]).catch(() => null);
      return res.status(502).json({ erro: "Meta indisponível, a Abacate tenta de novo", detalhe: meta.resposta });
    }
    await redis([
      ["SET", "mc:meta:" + ck.externalId, JSON.stringify({ ok: meta.ok, quando: Date.now(), resposta: meta.resposta, via: "webhook" }), "EX", 31536000],
      ["HINCRBY", "mc:d:" + diaBR(), "vendas", 1],
      ["EXPIRE", "mc:d:" + diaBR(), 34560000],
    ]).catch(() => null);
    return res.status(200).json({ ok: true, meta: meta.ok });
  } catch (e) {
    console.error("[webhook]", e.message);
    await redis([["DEL", chave]]).catch(() => null);
    return res.status(500).json({ erro: "Falha ao processar" });
  }
};
