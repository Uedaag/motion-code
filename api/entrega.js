// Libera os bônus comprados na página de obrigado.
// Recebe o código do pedido (?p=), confere na Abacate Pay se o PIX foi pago
// e devolve os links dos order bumps que estão no pedido.
// A chave da Abacate Pay precisa da permissão CHECKOUT:READ.

const API = "https://api.abacatepay.com/v2";

// Páginas de entrega: endereços privados, só aparecem para quem pagou
const ENTREGAS = {
  aula:    { nome: "Aula Gravada",                 desc: "A gravação completa do workshop, para rever quando precisar.", url: "/entrega/aula-tllu15yc57" },
  moldes:  { nome: "Biblioteca de Moldes",         desc: "12 moldes de anúncio em motion: troque o texto e baixe o vídeo.", url: "/entrega/moldes-laq70cugnp" },
  estilos: { nome: "Mesa de Estilos",              desc: "30 estilos visuais com o prompt de cada um.", url: "/entrega/estilos-ls5wvg9xlw" },
};

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ erro: "Método não permitido" });

  const p = String((req.query && req.query.p) || "");
  if (!/^mc-\d{10,}-[a-z0-9]{1,12}$/.test(p)) return res.status(400).json({ erro: "Pedido inválido." });

  const key = process.env.ABACATEPAY_API_KEY;
  if (!key) return res.status(500).json({ erro: "Pagamento ainda não configurado." });

  try {
    const r = await fetch(API + "/checkouts/get?externalId=" + encodeURIComponent(p), { headers: { Authorization: "Bearer " + key } });
    let body = null;
    try { body = await r.json(); } catch (e) { /* resposta sem JSON */ }
    // a Abacate Pay responde 400 "Billing not found" quando o pedido não existe
    if (r.status === 404 || /not found/i.test(String(body && body.error))) return res.status(404).json({ status: "nao-encontrado" });
    if (!r.ok || !body || body.success === false || !body.data) throw new Error("HTTP " + r.status + " " + JSON.stringify(body && body.error));

    const c = body.data;
    if (c.status === "PENDING") return res.status(200).json({ status: "pendente" });
    if (c.status !== "PAID" && c.status !== "REDEEMED") return res.status(200).json({ status: "indisponivel" });

    const bumps = String((c.metadata && c.metadata.bumps) || "").split(",").filter((b) => ENTREGAS[b]);
    return res.status(200).json({ status: "pago", itens: bumps.map((b) => ({ id: b, ...ENTREGAS[b] })) });
  } catch (e) {
    console.error("[entrega]", e.message);
    return res.status(502).json({ erro: "Não foi possível confirmar o pagamento agora." });
  }
};
