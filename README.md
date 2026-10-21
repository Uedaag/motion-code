# Motion Code

Site do workshop ao vivo **Motion Code** (Ueda Agency), 29/10/2026.

- `index.html`: página completa (HTML, CSS e JS sem build)
- `obrigado.html`: página depois do PIX, com o grupo do WhatsApp e o acesso aos bônus comprados
- `api/checkout.js`: cria a cobrança PIX na Abacate Pay com o lote do dia e os order bumps
- `api/entrega.js`: confere o pedido na Abacate Pay e libera os links dos order bumps pagos
- `entrega/`: páginas privadas dos order bumps (aula gravada, biblioteca de moldes, mesa de estilos)
- `assets/`: logo, favicon, foto, personagem e vídeos
- `vercel.json`: cache longo para `assets/` e `noindex` para `entrega/`

Variável de ambiente na Vercel: `ABACATEPAY_API_KEY` (precisa das permissões de produto e de checkout, incluindo `CHECKOUT:READ`).

Preços e order bumps ficam em `api/checkout.js` (o servidor decide o preço) e os valores mostrados na janela de compra ficam no objeto `PRECO` do `index.html`. Depois do evento, cole o link da gravação na variável `VIDEO` de `entrega/aula-tllu15yc57.html`.
