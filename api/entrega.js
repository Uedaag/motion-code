// Libera os bônus comprados na página de obrigado e diz à página de pagamento quando o PIX caiu.
// Recebe o código do pedido (?p=), confere na Abacate Pay se o PIX foi pago
// e devolve os links dos order bumps que estão no pedido.
// Vale para o PIX direto da página /pagamento e para o checkout hospedado da Abacate.

const { buscarPedido, processarVenda, redisLigado } = require("./_comum");

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
  if (!process.env.ABACATEPAY_API_KEY) return res.status(500).json({ erro: "Pagamento ainda não configurado." });

  try {
    const c = await buscarPedido(p);
    if (!c) return res.status(404).json({ status: "nao-encontrado" });
    if (c.status === "PENDING") return res.status(200).json({ status: "pendente" });
    if (c.status === "EXPIRED" || c.status === "CANCELLED") return res.status(200).json({ status: "expirado" });
    if (c.status !== "PAID" && c.status !== "REDEEMED") return res.status(200).json({ status: "indisponivel" });

    // a compra vai para o Meta mesmo sem o aviso de vendas da Abacate (uma vez por pedido)
    if (redisLigado()) await processarVenda(c, "site").catch((e) => console.error("[entrega] venda", e.message));

    const bumps = String((c.metadata && c.metadata.bumps) || "").split(",").filter((b) => ENTREGAS[b]);
    // valor em centavos, usado pelo evento de compra do pixel no obrigado
    return res.status(200).json({ status: "pago", valor: c.paidAmount || c.amount || 0, itens: bumps.map((b) => ({ id: b, ...ENTREGAS[b] })) });
  } catch (e) {
    console.error("[entrega]", e.message);
    return res.status(502).json({ erro: "Não foi possível confirmar o pagamento agora." });
  }
};
