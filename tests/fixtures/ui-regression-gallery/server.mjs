import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 4180);
const variant = process.env.VARIANT === "broken" ? "broken" : "fixed";

const scenarios = {
  "animated-progress": {
    markup: `<h1>Release progress</h1><div class="progress"><div id="progress-bar"></div></div><p id="progress-label">Preparing…</p>`,
    script: `setTimeout(() => { bar.style.width = broken ? '35%' : '75%'; label.textContent = broken ? '35% complete' : '75% complete'; }, 1000);`
  },
  "modal-transition": {
    markup: `<button>Open modal</button><div class="backdrop"><section class="modal" role="dialog"><h2>Confirm deployment</h2><p>All checks have passed.</p><button>Confirm</button></section></div>`,
    script: `button.onclick = () => stage.classList.add('open');`
  },
  "accordion-height": {
    markup: `<h1>Settings</h1><button>Account details</button><div class="accordion"><p>Workspace: Design systems</p><p>Region: Singapore</p><p>Plan: Pro</p></div>`,
    script: `button.onclick = () => stage.classList.toggle('open');`
  },
  "carousel-slide": {
    markup: `<h1>Featured projects</h1><div class="viewport"><div class="track"><article>Card 1<br><small>Research</small></article><article>Card 2<br><small>Prototype</small></article><article>Card 3<br><small>Launch</small></article></div></div><button>Next slide</button>`,
    script: `button.onclick = () => stage.classList.add('next');`
  },
  "toast-stack": {
    markup: `<h1>Notifications</h1><button>Add notification</button><div class="toasts" aria-live="polite"></div>`,
    script: `let count=0; button.onclick=()=>{ count++; const toast=document.createElement('div'); toast.className='toast'; toast.textContent='Notification '+count; toasts.append(toast); };`
  },
  "skeleton-content": {
    markup: `<h1>Dashboard</h1><div id="async-card"><div class="skeleton"></div><div class="skeleton short"></div></div>`,
    script: `if (!broken) setTimeout(()=>{ asyncCard.innerHTML='<h2>Dashboard ready</h2><p>Revenue increased 18% this week.</p>'; },800);`
  },
  "drag-reorder": {
    markup: `<h1>Priority queue</h1><div class="list"><div draggable="true" id="item-a">A</div><div draggable="true" id="item-b">B</div><div draggable="true" id="item-c">C</div></div><p id="order">Order: A,B,C</p>`,
    script: `let dragged; document.querySelectorAll('[draggable]').forEach(item=>{item.ondragstart=()=>dragged=item; item.ondragover=e=>e.preventDefault(); item.ondrop=e=>{e.preventDefault(); if(!broken&&dragged){ item.after(dragged); order.textContent='Order: '+[...document.querySelectorAll('[draggable]')].map(x=>x.textContent).join(','); }};});`
  },
  "responsive-grid": {
    markup: `<div class="narrow"><h1>Team</h1><div class="grid"><article>Ada<br><small>Design</small></article><article>Lin<br><small>Engineering</small></article><article>Sam<br><small>Research</small></article></div></div>`,
    script: ``
  },
  "sticky-header": {
    markup: `<h1>Activity</h1><div id="scroll-panel"><header>Event <span>Owner</span></header>${Array.from({length:18},(_,i)=>`<p>Event ${i+1}<span>User ${i+1}</span></p>`).join('')}</div>`,
    script: ``
  },
  "focus-ring": {
    markup: `<h1>Keyboard actions</h1><button>Primary action</button><button>Secondary action</button><p>Use Tab to move through controls.</p>`,
    script: ``
  },
  "dropdown-layer": {
    markup: `<h1>Project actions</h1><div class="dropdown"><button>Open actions</button><div class="menu"><p>Edit project</p><p>Duplicate</p><p>Archive</p></div></div><div class="cover">Recent activity panel</div>`,
    script: `button.onclick=()=>stage.classList.toggle('open');`
  },
  "theme-contrast": {
    markup: `<h1>Appearance</h1><button>Use dark theme</button><section class="theme-card"><h2>Monthly report</h2><p>Readable content in every theme.</p></section>`,
    script: `button.onclick=()=>stage.classList.add('dark');`
  },
  "table-sort": {
    markup: `<h1>Leaderboard</h1><button>Sort by score</button><p id="first">First: Lin</p><table><tbody id="rows"><tr><td>Lin</td><td>72</td></tr><tr><td>Ada</td><td>98</td></tr><tr><td>Sam</td><td>84</td></tr></tbody></table>`,
    script: `button.onclick=()=>{ const data=[['Lin',72],['Ada',98],['Sam',84]].sort((a,b)=>broken?a[1]-b[1]:b[1]-a[1]); rows.innerHTML=data.map(x=>'<tr><td>'+x[0]+'</td><td>'+x[1]+'</td></tr>').join(''); first.textContent='First: '+data[0][0]; };`
  },
  "search-filter": {
    markup: `<h1>Components</h1><label>Search <input></label><div id="results"><p class="result">Alpha</p><p class="result">Beta</p><p class="result">Gamma</p></div>`,
    script: `input.oninput=()=>{ if(broken)return; document.querySelectorAll('.result').forEach(x=>{if(!x.textContent.toLowerCase().includes(input.value.toLowerCase()))x.remove();}); };`
  },
  "form-validation": {
    markup: `<h1>Create account</h1><label>Email <input type="text"></label><button>Create account</button><p role="alert" hidden></p>`,
    script: `button.onclick=()=>{ if(!broken){ alertNode.hidden=false; alertNode.textContent='Enter a valid email'; input.setAttribute('aria-invalid','true'); } };`
  },
  "optimistic-save": {
    markup: `<h1>Profile</h1><button>Save changes</button><p role="status">No changes</p>`,
    script: `button.onclick=()=>{ statusNode.textContent='Saving'; setTimeout(()=>statusNode.textContent=broken?'Still saving':'Saved',600); };`
  },
  "tabs-panel": {
    markup: `<h1>Reports</h1><div role="tablist"><button role="tab">Overview</button><button role="tab">Analytics</button></div><section role="tabpanel">Overview metrics</section>`,
    script: `document.querySelectorAll('[role=tab]')[1].onclick=()=>{ panel.textContent=broken?'Overview metrics':'Analytics chart'; };`
  },
  "virtual-scroll": {
    markup: `<h1>Audit log</h1><div id="virtual-list">${Array.from({length:8},(_,i)=>`<p>Item ${i+1}</p>`).join('')}<div class="spacer"></div></div>`,
    script: `virtualList.onscroll=()=>{ if(!broken&&!document.getElementById('item-20')){ virtualList.innerHTML=${JSON.stringify(Array.from({length:5},(_,i)=>`<p id="item-${i+16}">Item ${i+16}</p>`).join(''))}; } };`
  },
  "chart-animation": {
    markup: `<h1>Weekly usage</h1><div class="chart"><div style="--h:45%">M</div><div style="--h:72%">T</div><div style="--h:58%">W</div><div style="--h:88%">T</div><div style="--h:64%">F</div></div>`,
    script: `setTimeout(()=>stage.classList.add('drawn'),900);`
  },
  "command-palette": {
    markup: `<h1>Workspace</h1><button>Open command palette</button><div class="palette" hidden><label>Command <input></label><div class="commands"><p>Search files</p><p>Settings</p></div></div><p role="status">Ready</p>`,
    script: `button.onclick=()=>{palette.hidden=false; input.focus();}; input.onkeydown=e=>{if(e.key==='Enter')statusNode.textContent=broken?'Opened Search':'Opened Settings';};`
  }
};

const styles = `
*{box-sizing:border-box} body{margin:0;background:#eef1f6;color:#172033;font:16px/1.45 system-ui,sans-serif} button,input{font:inherit} button{border:0;border-radius:10px;background:#315efb;color:white;padding:10px 16px;cursor:pointer} #stage{position:relative;overflow:hidden;width:640px;height:380px;margin:40px auto;padding:28px;border:1px solid #ccd3e0;border-radius:18px;background:white;box-shadow:0 16px 45px #2634551c} h1{margin:0 0 24px;font-size:28px} h2{margin-top:0}.progress{height:24px;background:#e4e9f2;border-radius:20px;overflow:hidden}.progress div{width:0;height:100%;background:linear-gradient(90deg,#315efb,#8e5bff);transition:width 400ms}.backdrop{position:absolute;inset:0;display:grid;place-items:center;background:#16213a99;opacity:0;pointer-events:none;transition:opacity 250ms}.modal{width:360px;padding:24px;border-radius:16px;background:white;transform:translateY(28px) scale(.94);transition:transform 250ms}.open .backdrop{opacity:1;pointer-events:auto}.open .modal{transform:translateY(0) scale(1)}.broken.open .modal{transform:translateX(150px) scale(.8)}.accordion{max-height:0;overflow:hidden;padding:0 16px;background:#eef3ff;border-radius:12px;transition:max-height 300ms}.accordion p{margin:14px 0}.open .accordion{max-height:180px}.broken.open .accordion{max-height:38px}.viewport{width:360px;overflow:hidden;margin-bottom:18px}.track{display:flex;width:1080px;transition:transform 400ms}.track article{display:grid;place-content:center;width:360px;height:180px;border-radius:16px;background:#dce5ff;font-size:30px;text-align:center}.track article:nth-child(2){background:#eadfff}.track article:nth-child(3){background:#d7f4ea}.next .track{transform:translateX(-360px)}.broken.next .track{transform:translateX(-210px)}.toasts{position:absolute;right:24px;bottom:24px;display:flex;flex-direction:column;gap:10px}.toast{min-width:220px;padding:14px 18px;border-radius:12px;background:#172033;color:white;box-shadow:0 8px 20px #17203344}.broken .toasts{display:block}.broken .toast{position:absolute;right:0;bottom:0}.skeleton{height:40px;margin:14px 0;border-radius:8px;background:linear-gradient(90deg,#e8ebf1,#f8f9fb,#e8ebf1)}.skeleton.short{width:60%}.list{display:flex;gap:12px}.list div{display:grid;place-items:center;width:110px;height:100px;border-radius:14px;background:#e6ecff;font-size:28px}.narrow{width:360px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.grid article{padding:18px 10px;border-radius:12px;background:#edf1fb}.broken .grid{grid-template-columns:repeat(3,180px)}#scroll-panel{height:250px;overflow:auto;border:1px solid #d5dbea}#scroll-panel header,#scroll-panel p{display:flex;justify-content:space-between;margin:0;padding:12px 16px;background:white;border-bottom:1px solid #e4e8ef}#scroll-panel header{position:sticky;top:0;z-index:2;background:#172033;color:white}.broken #scroll-panel header{position:static}.focus-ring button{margin-right:12px}.focus-ring button:focus{outline:4px solid #ff7a1a;outline-offset:4px}.broken.focus-ring button:focus{outline:none}.dropdown{position:relative;z-index:3}.menu{position:absolute;display:none;width:190px;padding:10px;border-radius:12px;background:white;box-shadow:0 12px 28px #17203344}.open .menu{display:block}.cover{position:absolute;z-index:2;top:120px;left:180px;width:340px;height:170px;padding:35px;background:#dce5ff}.broken .dropdown{z-index:1}.theme-card{margin-top:22px;padding:22px;border-radius:14px;background:#eff3ff}.dark{background:#10182b;color:#f6f8ff}.dark .theme-card{background:#1d2944}.broken.dark{color:#111827}.broken.dark .theme-card{color:#111827}.broken.dark button{background:#24304b;color:#28344e}table{width:100%;border-collapse:collapse}td{padding:10px;border-bottom:1px solid #e2e6ee}label{display:block;margin:14px 0}input{padding:10px;border:1px solid #aab4c5;border-radius:8px}.result{padding:8px 12px;background:#eef3ff;border-radius:8px}.palette{position:absolute;inset:70px 90px auto;padding:18px;border-radius:14px;background:white;box-shadow:0 18px 50px #17203355}.commands p{padding:8px;margin:4px 0}.commands p:nth-child(2){background:#e9efff}.chart{display:flex;align-items:end;gap:22px;height:240px;padding:20px 40px;border-left:2px solid #9ba7ba;border-bottom:2px solid #9ba7ba}.chart div{display:flex;align-items:end;justify-content:center;width:58px;height:0;padding-bottom:8px;border-radius:8px 8px 0 0;background:#5274ff;color:white;transition:height 700ms}.drawn .chart div{height:var(--h)}.broken.drawn .chart div:nth-child(4){height:24%}#virtual-list{height:250px;overflow:auto;border:1px solid #d6dce7}#virtual-list p{margin:0;padding:12px;border-bottom:1px solid #e4e8ef}.spacer{height:500px}`;

function page(id) {
  const scenario = scenarios[id];
  if (!scenario) return `<!doctype html><title>Not found</title><h1>Unknown scenario</h1>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${id} · Polymux regression gallery</title><style>${styles}</style></head><body><main id="stage" class="${id} ${variant === 'broken' ? 'broken' : 'fixed'}" data-variant="${variant}" data-scenario="${id}">${scenario.markup}</main><script>const stage=document.querySelector('#stage');const broken=stage.dataset.variant==='broken';const button=stage.querySelector('button');const input=stage.querySelector('input');const bar=document.querySelector('#progress-bar');const label=document.querySelector('#progress-label');const toasts=document.querySelector('.toasts');const asyncCard=document.querySelector('#async-card');const order=document.querySelector('#order');const rows=document.querySelector('#rows');const first=document.querySelector('#first');const alertNode=document.querySelector('[role=alert]');const statusNode=document.querySelector('[role=status]');const panel=document.querySelector('[role=tabpanel]');const virtualList=document.querySelector('#virtual-list');const palette=document.querySelector('.palette');${scenario.script}</script></body></html>`;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  if (url.pathname === '/health') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ready: true, variant }));
    return;
  }
  const match = /^\/scenario\/([a-z0-9-]+)$/.exec(url.pathname);
  response.statusCode = match && scenarios[match[1]] ? 200 : 404;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(page(match?.[1] ?? ''));
});

server.listen(port, '127.0.0.1', () => process.stdout.write(`UI regression gallery (${variant}) listening on http://127.0.0.1:${port}\n`));
