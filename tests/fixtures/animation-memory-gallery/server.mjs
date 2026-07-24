import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 4190);
const variant = process.env.VARIANT === "broken" ? "broken" : "fixed";

const cases = {
  "overlay-flight": {
    markup: `<div class="animation-canvas"><header class="toolbar">Deployments <span>3 active</span></header><article class="flight-card"><strong>Release candidate</strong><small>Moving into position</small></article><div class="destination">Drop zone</div></div>`,
    setup: `
      const card = document.querySelector('.flight-card');
      const frames = broken
        ? ['translate(250px, 210px) scale(.8)', 'translate(65px, -8px) scale(1.12)', 'translate(32px, 92px) scale(1)']
        : ['translate(250px, 210px) scale(.8)', 'translate(130px, 92px) scale(.94)', 'translate(32px, 92px) scale(1)'];
      renderFrame = frame => { card.style.transform = frames[frame]; };`
  },
  crossfade: {
    markup: `<div class="crossfade-panel"><article class="old-card"><strong>Preparing release</strong><small>Checking dependencies</small></article><article class="new-card"><strong>Release ready</strong><small>All checks passed</small></article></div>`,
    setup: `
      const oldCard = document.querySelector('.old-card');
      const newCard = document.querySelector('.new-card');
      const oldFrames = broken
        ? [[1, 'none'], [1, 'translateX(12px)'], [0, 'none']]
        : [[1, 'none'], [.2, 'translateX(-8px)'], [0, 'none']];
      const newFrames = broken
        ? [[0, 'none'], [1, 'translateX(-12px)'], [1, 'none']]
        : [[0, 'none'], [.8, 'translateX(8px)'], [1, 'none']];
      renderFrame = frame => {
        oldCard.style.opacity = oldFrames[frame][0]; oldCard.style.transform = oldFrames[frame][1];
        newCard.style.opacity = newFrames[frame][0]; newCard.style.transform = newFrames[frame][1];
      };`
  },
  "drawer-path": {
    markup: `<div class="animation-canvas drawer-canvas"><div class="drawer-lane"><aside class="drawer"><strong>Inspector</strong><p>Spacing 24px</p><p>Opacity 100%</p></aside></div><section class="workspace-card"><strong>Canvas content</strong><p>The drawer should never cover this card.</p></section></div>`,
    setup: `
      const drawer = document.querySelector('.drawer');
      const frames = broken
        ? ['translateX(-250px)', 'translateX(185px) rotate(4deg)', 'translateX(0)']
        : ['translateX(-250px)', 'translateX(-90px)', 'translateX(0)'];
      renderFrame = frame => { drawer.style.transform = frames[frame]; };`
  }
};

const styles = `
*{box-sizing:border-box}body{margin:0;background:#eef1f6;color:#172033;font:16px/1.4 system-ui,sans-serif}button{border:0;border-radius:10px;background:#315efb;color:white;padding:10px 16px;font:inherit}#stage{width:680px;height:430px;margin:32px auto;padding:24px;border:1px solid #ccd3e0;border-radius:18px;background:white}.stage-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}.stage-header h1{margin:0;font-size:24px}.animation-canvas,.crossfade-panel{position:relative;overflow:hidden;width:630px;height:310px;border-radius:16px;background:#eaf0fb}.toolbar{position:absolute;z-index:3;inset:0 0 auto;display:flex;justify-content:space-between;height:58px;padding:18px 22px;background:#172033;color:white}.flight-card{position:absolute;z-index:2;display:grid;gap:6px;width:210px;padding:18px;border-radius:14px;background:white;box-shadow:0 14px 34px #17203338}.flight-card small,.old-card small,.new-card small{color:#5b6474}.destination{position:absolute;left:28px;top:150px;width:230px;height:110px;padding:40px;border:2px dashed #9aabd0;border-radius:14px;color:#63708a;text-align:center}.crossfade-panel{display:grid;place-items:center}.old-card,.new-card{position:absolute;display:grid;gap:10px;width:360px;padding:32px;border-radius:18px;background:white;box-shadow:0 18px 44px #1720332c;font-size:22px}.drawer-canvas{display:flex;align-items:center}.drawer-lane{position:relative;z-index:2;overflow:hidden;width:270px;height:270px;margin-left:18px;border-radius:14px;background:#dce6fb}.drawer{position:absolute;inset:0 auto 0 0;width:250px;padding:26px;background:#18233a;color:white;box-shadow:10px 0 28px #17203333}.workspace-card{width:280px;margin-left:24px;padding:28px;border-radius:14px;background:white;box-shadow:0 12px 30px #1720331f}p{margin:12px 0}[role=status]{position:absolute;clip:rect(0 0 0 0);clip-path:inset(50%);width:1px;height:1px;overflow:hidden;white-space:nowrap}
`;

function page(id) {
  const animationCase = cases[id];
  if (!animationCase) return "<!doctype html><title>Not found</title><h1>Unknown animation</h1>";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${id} · Animation memory</title><style>${styles}</style></head><body><main id="stage"><div class="stage-header"><h1>Animation memory</h1><button>Start animation</button></div>${animationCase.markup}<p role="status">Ready</p></main><script>
    const button=document.querySelector('button');
    const statusNode=document.querySelector('[role=status]');
    const broken=${variant === "broken"};
    let renderFrame=()=>{};
    ${animationCase.setup}
    renderFrame(0);
    button.onclick=()=>{
      renderFrame(0);
      statusNode.textContent='Animation started';
      setTimeout(()=>{ renderFrame(1); statusNode.textContent='Animation midpoint'; },100);
      setTimeout(()=>{ renderFrame(2); statusNode.textContent='Animation complete'; },250);
    };
  </script></body></html>`;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (url.pathname === "/health") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ready: true, variant }));
    return;
  }
  const match = /^\/scenario\/([a-z0-9-]+)$/.exec(url.pathname);
  response.statusCode = match && cases[match[1]] ? 200 : 404;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(page(match?.[1] ?? ""));
});

server.listen(port, "127.0.0.1", () =>
  process.stdout.write(`Animation memory gallery (${variant}) listening on http://127.0.0.1:${port}\n`),
);
