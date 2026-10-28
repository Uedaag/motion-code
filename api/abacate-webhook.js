// A Abacate Pay chama esta rota quando um PIX é pago: checkout.completed (tela da Abacate)
// ou transparent.completed (PIX direto da página /pagamento).
// Daqui a compra vai para o Meta pela API de Conversões, mesmo que o cliente
// feche a página e nunca chegue ao obrigado.
// Endereço cadastrado na Abacate: /api/abacate-webhook?webhookSecret=<segredo do painel>

const { abacate, segredoWebhook, iguais, pixComoCheckout, processarVenda } = require("./_comum");

const EVENTOS = ["checkout.completed", "transparent.completed"];

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ erro: "Método não permitido" });
  const seg = String((req.query && req.query.webhookSecret) || "");
  if (!seg || !iguais(seg, segredoWebhook())) return res.status(401).json({ erro: "Não autorizado" });

  let ev = req.body;
  if (typeof ev === "string") { try { ev = JSON.parse(ev); } catch (e) { ev = {}; } }
  if (!ev || !EVENTOS.includes(ev.event)) return res.status(200).json({ ok: true, ignorado: ev && ev.event });
  if (ev.devMode) return res.status(200).json({ ok: true, ignorado: "devMode" });

  const d = ev.data || {};
  try {
    let ck;
    if (ev.event === "transparent.completed") {
      let t = d.transparent || d.pixQrCode || d.billing || d;
      // sem o metadata no aviso, busca o PIX na Abacate pelo id
      if (!(t.metadata && t.metadata.pedido) && t.id) {
        const b = await abacate("/transparents/list?id=" + encodeURIComponent(t.id), { method: "GET" }).catch(() => null);
        const x = b && Array.isArray(b.data) ? b.data.find((y) => y.id === t.id) : null;
        if (x) t = { ...x, ...t, metadata: x.metadata };
      }
      ck = pixComoCheckout({ ...t, status: "PAID" });
    } else {
      const c0 = d.checkout || d;
      ck = c0;
      if (c0.id) { try { ck = (await abacate("/checkouts/get?id=" + encodeURIComponent(c0.id))).data || c0; } catch (e) { ck = c0; } }
    }
    if (!String(ck.externalId || "").startsWith("mc-")) return res.status(200).json({ ok: true, ignorado: "não é do Motion Code" });

    // a Abacate pode reenviar o mesmo aviso: processarVenda age uma vez só por pedido
    const v = await processarVenda(ck, "webhook", d.customer);
    if (!v.ok && v.temporario) return res.status(502).json({ erro: "Meta indisponível, a Abacate tenta de novo", detalhe: v.meta && v.meta.resposta });
    return res.status(200).json({ ok: true, repetido: !!v.repetido, meta: v.meta ? v.meta.ok : undefined });
  } catch (e) {
    console.error("[webhook]", e.message);
    return res.status(500).json({ erro: "Falha ao processar" });
  }
};
