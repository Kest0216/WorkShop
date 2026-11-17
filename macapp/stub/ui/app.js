// Stub page script. It does what the real UI does at start (contract section 6 and 13b):
// read #k=<ownerKey>, remove the fragment, post the key once to /api/session, load /api/state,
// open the SSE stream. It also exercises what the launcher must support: fetch, EventSource, canvas,
// localStorage, a text input, alert/confirm/prompt, a file input, downloads, links, the native bridge.
// The tests drive it through window.__ws.
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const native = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.workshop;
const state = { session: null, stateStatus: null, sse: 0, sseOpens: 0, sseErrors: 0, frames: 0, clicks: 0, live: false, resumes: 0, hadKey: false, hashAfter: null };

async function api(method, path, body) {
  const init = { method, headers: { Accept: 'application/json' }, cache: 'no-store' };
  if (method !== 'GET') {
    init.headers['X-WorkShop'] = '1';
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body == null ? {} : body);
  }
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, data };
}
const beacon = (kind, data) => api('POST', '/api/beacon', { kind, ...(data || {}) }).catch(() => {});

/** Send one message to the launcher. Resolves with the reply, or { error } when the launcher refused it. */
async function bridge(message) {
  if (!native) return { error: 'no native bridge' };
  try { return await native.postMessage(message); } catch (e) { return { error: String((e && e.message) || e) }; }
}

function setLive(live) {
  if (state.live === live) return;
  state.live = live;
  bridge({ type: 'quitState', live });
}

// ---- owner session: the key lives in this function only
async function openSession() {
  const m = /(?:^#|&)k=([^&]+)/.exec(location.hash || '');
  state.hadKey = !!m;
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  let k = m[1];
  try { k = decodeURIComponent(k); } catch { /* keep it */ }
  state.session = (await api('POST', '/api/session', { k })).status;
}

// ---- localStorage (per origin: scheme + host + PORT)
let lsPrev = null, lsNow = null, lsErr = null;
try {
  lsPrev = localStorage.getItem('ws.launchCount');
  lsNow = String((parseInt(lsPrev || '0', 10) || 0) + 1);
  localStorage.setItem('ws.launchCount', lsNow);
} catch (e) { lsErr = String(e); }
$('sLs').textContent = lsErr ? 'ERROR ' + lsErr : `previous=${lsPrev} now=${lsNow}`;

// ---- EventSource (SSE): no "event:" field, so onmessage gets everything
let es = null;
function connectSSE(since) {
  if (es) es.close();
  es = new EventSource('/api/events?since=' + encodeURIComponent(since));
  es.onopen = () => { state.sseOpens++; };
  es.onerror = () => { state.sseErrors++; };
  es.onmessage = (ev) => {
    state.sse++;
    let data = null;
    try { data = JSON.parse(ev.data); } catch { /* ignore */ }
    if (data && data.type === 'tick') setLive(!!data.live);
    if (data && data.type === 'jobs' && data.item) setLive(data.item.status === 'running');
    $('sSse').textContent = `messages=${state.sse} opens=${state.sseOpens} errors=${state.sseErrors}`;
    if (state.sse === 1 || state.sse % 5 === 0) beacon('sse', { messages: state.sse, opens: state.sseOpens, errors: state.sseErrors, frames: state.frames, visibility: document.visibilityState });
  };
}

// ---- canvas: 160 x 90 backing store, scaled 4x by CSS
const cv = $('cv'), ctx = cv.getContext('2d');
function draw(t) {
  state.frames++;
  ctx.fillStyle = '#1a1b26'; ctx.fillRect(0, 0, 160, 90);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 40; x++) {          // 1-pixel checkerboard: any smoothing shows at once
    ctx.fillStyle = (x + y) % 2 ? '#ffffff' : '#000000'; ctx.fillRect(4 + x, 4 + y, 1, 1);
  }
  ctx.fillStyle = '#8a5a2b'; ctx.fillRect(0, 70, 160, 20);
  const px = Math.floor((t / 40) % 150);
  ctx.fillStyle = '#e3a93f'; ctx.fillRect(px + 2, 56, 4, 4);
  ctx.fillStyle = '#7aa2f7'; ctx.fillRect(px + 1, 60, 6, 6);
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

// ---- controls
$('btnCount').addEventListener('click', (ev) => {
  state.clicks++; $('btnCount').textContent = 'count ' + state.clicks;
  beacon('click', { id: 'btnCount', clicks: state.clicks, trusted: ev.isTrusted });
});
$('btnAlert').addEventListener('click', () => { alert('Hello from alert()'); $('sDlg').textContent = 'alert returned'; beacon('dialog', { which: 'alert', returned: true }); });
$('btnConfirm').addEventListener('click', () => { const r = confirm('Approve the merge truck?'); $('sDlg').textContent = 'confirm -> ' + r; beacon('dialog', { which: 'confirm', result: r }); });
$('btnPrompt').addEventListener('click', () => { const r = prompt('Name this work order', 'order-1'); $('sDlg').textContent = 'prompt -> ' + r; beacon('dialog', { which: 'prompt', result: r }); });
$('lnkDownloadBlob').addEventListener('click', async (ev) => {      // fetch -> Blob -> <a download>: no navigation to the hub
  ev.preventDefault();
  const blob = await fetch('/api/download-sample').then((r) => r.blob());
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'workshop-blob.txt';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});
$('file').addEventListener('change', async () => {
  const f = $('file').files[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
  $('sUp').textContent = `${f.name} ${buf.byteLength} bytes`;
  beacon('upload', { name: f.name, bytes: buf.byteLength, sha256short: hash.slice(0, 16) });
});
const show = (r) => { $('sBridge').textContent = JSON.stringify(r); return r; };
$('btnNotify').addEventListener('click', async () => show(await bridge({ type: 'notify', title: 'Truck is ready', body: 'J1 waits for your approval.' })));
$('btnBadge').addEventListener('click', async () => show(await bridge({ type: 'badge', count: 3 })));
$('btnPick').addEventListener('click', async () => { const r = show(await bridge({ type: 'pickFolder' })); beacon('pickFolder', r); });
$('btnLive').addEventListener('click', () => api('POST', '/api/stub/job', { live: true }));
$('btnIdle').addEventListener('click', () => api('POST', '/api/stub/job', { live: false }));

// The launcher fires this on the window after a wake or a display change.
window.addEventListener('workshop:resume', () => { state.resumes++; beacon('resume', { n: state.resumes, sse: state.sse }); });

// ---- what the tests call through the launcher's "eval" command
window.__ws = {
  state, api, bridge, beacon, sleep,
  click: (id) => { $(id).click(); return id; },
  css: () => {
    const c = getComputedStyle(cv), h = getComputedStyle(document.documentElement);
    return { imageRendering: c.imageRendering, userSelect: c.webkitUserSelect || c.userSelect, userDrag: c.webkitUserDrag,
             overscrollY: h.overscrollBehaviorY, adopted: document.adoptedStyleSheets.length, dpr: window.devicePixelRatio };
  },
  where: () => ({ href: location.origin + location.pathname, hash: location.hash, search: location.search, title: document.title, historyLength: history.length }),
  edit: (text) => { const t = $('txt'); t.focus(); t.value = text; return document.activeElement === t; },
  selection: () => ({ value: $('txt').value, start: $('txt').selectionStart, end: $('txt').selectionEnd, active: document.activeElement && document.activeElement.id }),
};

// ---- boot
(async () => {
  await openSession();
  state.hashAfter = location.hash;
  $('sSession').textContent = state.hadKey ? `key posted -> ${state.session}` : 'no key in the address (reload): cookie only';
  const st = await api('GET', '/api/state');
  state.stateStatus = st.status;
  $('sState').textContent = `GET /api/state -> ${st.status}`;
  if (st.status === 200) {
    const j = st.data.state.jobs.J1;
    setLive(!!j && j.status === 'running');
    connectSSE(st.data.seq);
  }
  await beacon('boot', {
    hadKey: state.hadKey, session: state.session, stateStatus: st.status, hashAfter: state.hashAfter, bridge: !!native,
    dpr: window.devicePixelRatio, secureContext: window.isSecureContext, lsPrev, lsNow, lsErr,
    visibility: document.visibilityState, inner: [innerWidth, innerHeight], css: window.__ws.css(),
  });
})();
