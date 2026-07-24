import { createServer } from "node:http";

const orders = [];

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Polymux Checkout</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 560px; margin: 64px auto; padding: 24px; }
    form { display: grid; gap: 16px; }
    label { display: grid; gap: 6px; }
    input, button { font: inherit; padding: 12px; }
    .scroll-area { height: 64px; overflow: auto; border: 1px solid #aaa; }
    .scroll-content { height: 300px; padding: 8px; }
    .swipe-pad, .drop-target, .drag-source { margin-top: 8px; padding: 16px; border: 1px solid #777; }
    .image-button { width: 48px; height: 48px; padding: 0; border: 0; background: rgb(225, 29, 72); }
    .styled-choice { position: relative; width: 180px; height: 44px; margin: 12px 0; }
    .styled-choice input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; }
    .styled-choice label { position: absolute; inset: 0; z-index: 1; display: grid; place-items: center; border: 1px solid #777; border-radius: 6px; }
    .confirmation { opacity: 0; transform: translateY(8px); pointer-events: none; }
    .confirmation.show { animation: reveal 180ms ease-out forwards; }
    @keyframes reveal { to { opacity: 1; transform: translateY(0); } }
  </style>
</head>
<body>
  <main>
    <h1>Checkout</h1>
    <form id="checkout">
      <label>Email <input name="email" type="email" required></label>
      <label>Card number <input name="card" inputmode="numeric" required></label>
      <button data-testid="pay" type="submit">Pay now</button>
    </form>
    <p class="confirmation" role="status">Order confirmed</p>
    <p id="configuration" role="status"></p>
    <p id="touches" role="status"></p>
    <button class="image-button" type="button" aria-label="Image target"></button>
    <button id="pay-later" type="button">Pay now later</button>
    <p id="image-result" role="status"></p>
    <label>Country
      <select aria-label="Country"><option>Australia</option><option>Singapore</option></select>
    </label>
    <div class="styled-choice">
      <input id="styled-radio" type="radio" name="database" value="sqlite">
      <label for="styled-radio">SQLite database</label>
    </div>
    <p id="database-result" role="status"></p>
    <div class="styled-choice">
      <input id="styled-checkbox" type="checkbox">
      <label for="styled-checkbox">Remember database</label>
    </div>
    <p id="checkbox-result" role="status"></p>
    <label>Notes <input aria-label="Notes" value="initial"></label>
    <button id="disabled-control" disabled>Disabled control</button>
    <span class="count-item">One</span><span class="count-item">Two</span>
    <p id="interaction-result" role="status"></p>
    <div id="scroll-area" class="scroll-area"><div class="scroll-content">Scrollable content</div></div>
    <div id="swipe-pad" class="swipe-pad">Swipe pad</div>
    <div id="drag-source" class="drag-source" draggable="true">Drag source</div>
    <div id="drop-target" class="drop-target">Drop target</div>
  </main>
  <script>
    document.querySelector("#checkout").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), card: form.get("card") })
      });
      if (response.ok) document.querySelector(".confirmation").classList.add("show");
    });
    fetch("/api/config").then((response) => response.json()).then((config) => {
      if (config.experimental) document.querySelector("#configuration").textContent = "Experimental mode";
    });
    document.addEventListener("touchstart", (event) => {
      document.querySelector("#touches").textContent = String(event.touches.length) + " touches";
    });
    document.querySelector(".image-button").addEventListener("click", () => {
      document.querySelector("#image-result").textContent = "Image activated";
    });
    const interaction = document.querySelector("#interaction-result");
    document.querySelector("#pay-later").addEventListener("click", () => {
      interaction.textContent = "Deferred payment";
    });
    document.querySelector('select[aria-label="Country"]').addEventListener("change", (event) => {
      interaction.textContent = "Selected " + event.currentTarget.value;
    });
    document.querySelector("#styled-radio").addEventListener("change", () => {
      document.querySelector("#database-result").textContent = "SQLite selected";
    });
    document.querySelector("#styled-checkbox").addEventListener("change", () => {
      document.querySelector("#checkbox-result").textContent = "Database remembered";
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Enter") interaction.textContent = "Pressed Enter";
    });
    document.addEventListener("pointerdown", (event) => {
      if (event.target === document.documentElement || event.target === document.body) interaction.textContent = "Pointer activated";
    });
    document.querySelector("#scroll-area").addEventListener("scroll", () => {
      interaction.textContent = "Scrolled content";
    });
    let swipeStart = 0;
    const swipePad = document.querySelector("#swipe-pad");
    swipePad.addEventListener("pointerdown", (event) => { swipeStart = event.clientX; });
    document.addEventListener("pointerup", (event) => {
      if (swipeStart) interaction.textContent = event.clientX > swipeStart ? "Swiped right" : "Swiped left";
      swipeStart = 0;
    });
    const dropTarget = document.querySelector("#drop-target");
    dropTarget.addEventListener("dragover", (event) => event.preventDefault());
    dropTarget.addEventListener("drop", (event) => {
      event.preventDefault();
      interaction.textContent = "Dropped card";
    });
  </script>
</body>
</html>`;

const server = createServer(async (request, response) => {
  if (request.url === "/checkout" || request.url === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  if (request.url === "/api/orders" && request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const order = {
      id: `order-${orders.length + 1}`,
      email: input.email,
      status: "paid",
    };
    orders.push(order);
    response.writeHead(201, {
      "content-type": "application/json",
      "set-cookie": "checkout_session=paid; Path=/; HttpOnly; SameSite=Lax",
    });
    response.end(JSON.stringify(order));
    return;
  }
  if (request.url === "/api/orders/latest" && request.method === "GET") {
    const order = orders.at(-1);
    response.writeHead(order ? 200 : 404, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify(order ?? { error: "not_found" }));
    return;
  }
  if (request.url === "/api/session" && request.method === "GET") {
    const authenticated = request.headers.cookie?.includes("checkout_session=paid") ?? false;
    response.writeHead(authenticated ? 200 : 401, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ authenticated }));
    return;
  }
  if (request.url === "/api/config" && request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ experimental: false }));
    return;
  }
  response.writeHead(404);
  response.end("Not found");
});

const port = Number(process.env.PORT ?? 4173);
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Checkout app fixture listening on http://127.0.0.1:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
