// Stand-in for ./scene/scene.js. Same public API, plain labelled blocks instead of pixel art.
// app.js selects it by itself when the real scene module is missing or fails, so the app never breaks.
//
//   createScene(canvas, { onEvent }) -> { sync(vm), fx(name, payload), resize(), setOptions({ scanlines, paused }), destroy() }
//   avatarDataURL(agent, scale) -> PNG data URL

const W = 480, H = 272;
const css = (name, fallback) => (getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);
function colors() {
  return {
    ink: css('--ink', '#2b1d16'), paper: css('--paper', '#f2e6c8'), paper2: css('--paper-2', '#e2d0a4'), wood: css('--wood', '#9a6a3c'),
    woodDark: css('--wood-dark', '#6a4526'), woodLight: css('--wood-light', '#c28f58'), steel: css('--steel', '#8a97a3'), steelDark: css('--steel-dark', '#4d5964'),
    steelLight: css('--steel-light', '#c5cdd4'), brick: css('--brick', '#a4452c'), amber: css('--amber', '#f0b030'), green: css('--green', '#5c9e4f'),
    red: css('--red', '#d0412d'), blue: css('--blue', '#6c8ca6'), shadow: css('--shadow', '#1a1310'), white: css('--white', '#fffaf0'),
  };
}
const LAB = { claude: '#d9774a', gemini: '#5b8fd6', oss: '#9ad66e', mock: '#9a9a9a' };
const SKIN = ['#f1c9a5', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'];
const EMPTY = { shop: { jobTitle: '', paused: false, statusLine: '' }, agents: [], deliveries: [], truck: { state: 'docked', crates: 0 }, board: { unread: 0 }, owner: { attention: false } };

function drawSprite(g, x, y, agent, C, dim) {
  const seed = (agent.style && agent.style.seed) || 0;
  const body = LAB[agent.provider] || C.steel;
  g.globalAlpha = dim ? 0.35 : 1;
  g.fillStyle = C.ink; g.fillRect(x - 1, y - 1, 12, 16);
  g.fillStyle = SKIN[seed % SKIN.length]; g.fillRect(x + 2, y, 6, 5);
  g.fillStyle = agent.role === 'boss' ? C.amber : agent.role === 'manager' ? C.steelLight : C.brick; g.fillRect(x + 1, y - 1, 8, 2); // hat by role
  g.fillStyle = body; g.fillRect(x, y + 5, 10, 6);
  g.fillStyle = C.ink; g.fillRect(x + 3, y + 2, 1, 1); g.fillRect(x + 6, y + 2, 1, 1);
  g.fillStyle = C.steelDark; g.fillRect(x + 1, y + 11, 3, 3); g.fillRect(x + 6, y + 11, 3, 3);
  g.globalAlpha = 1;
}

export function avatarDataURL(agent, scale = 2) {
  const k = Math.max(1, Math.min(8, Math.round(scale) || 1));
  const c = document.createElement('canvas');
  c.width = 16 * k; c.height = 16 * k;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.scale(k, k);
  const C = colors();
  g.fillStyle = C.paper2; g.fillRect(0, 0, 16, 16);
  drawSprite(g, 3, 1, agent || {}, C, false);
  return c.toDataURL('image/png');
}

export function createScene(canvas, { onEvent = () => {} } = {}) {
  canvas.width = W; canvas.height = H;
  canvas.style.imageRendering = 'pixelated';
  const g = canvas.getContext('2d');
  if (!g) throw new Error('2d canvas is not available');
  let vm = EMPTY, opts = { scanlines: false, paused: false }, raf = 0, last = 0, dead = false, hits = [], hover = 'none:', fxs = [];
  const bubbles = new Map(); // agent id -> { seq, until }
  const C = colors();

  function text(s, x, y, color = C.ink, size = 8, align = 'left') {
    g.font = `bold ${size}px ui-monospace, Menlo, monospace`;
    g.textAlign = align; g.textBaseline = 'top';
    g.fillStyle = color;
    g.fillText(s, Math.round(x), Math.round(y));
  }
  function box(x, y, w, h, fill, line = C.ink) { g.fillStyle = line; g.fillRect(x, y, w, h); g.fillStyle = fill; g.fillRect(x + 1, y + 1, w - 2, h - 2); }
  const hit = (x, y, w, h, kind, id) => hits.push({ x, y, w, h, kind, id });

  function seat(a, i, counts) {
    if (a.role === 'boss') return { x: 22 + (a.spot % 3) * 44, y: 82 };
    if (a.role === 'manager') return { x: 168, y: 150 + (a.spot % 3) * 34 };
    const col = a.spot % 4, row = Math.floor(a.spot / 4) % 2;
    return { x: 206 + col * 40, y: 146 + row * 58 };
  }

  function draw(now) {
    hits = [];
    const blink = Math.floor(now / 400) % 2 === 0;
    // room
    g.fillStyle = C.woodDark; g.fillRect(0, 0, W, 132);
    g.fillStyle = C.wood; g.fillRect(0, 132, W, H - 132);
    g.fillStyle = C.ink; g.fillRect(0, 130, W, 2);
    g.fillStyle = C.woodDark; for (let y = 152; y < H; y += 20) g.fillRect(0, y, W, 1);
    // sign
    box(6, 6, 220, 22, C.paper);
    text((vm.shop.jobTitle || 'NO WORK ORDER').toUpperCase().slice(0, 34), 10, 8, C.ink, 8);
    text((vm.shop.paused ? 'PAUSED. ' : '') + (vm.shop.statusLine || '').slice(0, 40), 10, 17, C.brick, 7);
    text('STAND-IN SCENE', W - 6, 6, C.paper2, 7, 'right');
    // office
    box(8, 60, 140, 60, C.woodLight);
    text('OFFICE', 12, 62, C.ink, 7);
    hit(8, 60, 140, 60, 'office', null);
    // board
    box(190, 34, 100, 50, C.paper2);
    text('BOARD', 240, 38, C.ink, 8, 'center');
    if (vm.board.unread > 0) { box(226, 52, 28, 14, blink ? C.amber : C.paper); text(String(Math.min(99, vm.board.unread)), 240, 55, C.ink, 8, 'center'); }
    hit(190, 34, 100, 50, 'board', null);
    // tool wall (the pegboard of the real scene): the app opens the Toolkit
    box(298, 34, 70, 22, C.steelLight);
    text('TOOLS', 333, 41, C.ink, 8, 'center');
    hit(298, 34, 70, 22, 'toolwall', 'toolwall');
    // harness rack & RFT calibration bay
    box(372, 34, 96, 22, C.green);
    text('HARNESS RACK', 420, 41, C.ink, 8, 'center');
    hit(372, 34, 96, 22, 'harnesses', 'harnesses');
    box(102, 232, 84, 30, C.amber);
    text('RFT BAY', 144, 243, C.ink, 8, 'center');
    hit(102, 232, 84, 30, 'rftbay', 'rftbay');
    // counter
    box(8, 232, 86, 30, C.woodLight);
    text('COUNTER', 51, 236, C.ink, 8, 'center');
    text(vm.owner.attention && blink ? '! FOR YOU !' : '+ work order', 51, 248, vm.owner.attention ? C.red : C.woodDark, 7, 'center');
    hit(8, 232, 86, 30, 'counter', null);
    // benches
    for (let i = 0; i < 8; i++) {
      const x = 198 + (i % 4) * 40, y = 164 + Math.floor(i / 4) * 58;
      box(x, y, 28, 8, C.steel);
      hit(x, y - 20, 28, 30, 'bench', i);
    }
    // truck
    const tr = vm.truck;
    let off = 0;
    const f = fxs.find((x) => x.name === '_truck');
    if (tr.state === 'leaving') off = f ? Math.min(140, (now - f.t0) / 15) : 140;
    else if (tr.state === 'away') off = 140;
    else if (tr.state === 'returning') off = f ? Math.max(0, 140 - (now - f.t0) / 15) : 0;
    const tx = 380 + off;
    box(tx, 150, 92, 60, tr.state === 'ready' ? C.amber : C.steelLight);
    box(tx + 60, 160, 30, 30, C.paper);
    g.fillStyle = C.ink; g.fillRect(tx + 8, 208, 14, 8); g.fillRect(tx + 66, 208, 14, 8);
    text('TRUCK', tx + 6, 153, C.ink, 8);
    text(tr.state, tx + 6, 196, C.ink, 7);
    for (let i = 0; i < Math.min(12, tr.crates); i++) box(tx + 6 + (i % 6) * 9, 166 + Math.floor(i / 6) * 10, 8, 8, C.woodLight);
    if (tr.crates > 12) text('+' + (tr.crates - 12), tx + 6, 186, C.ink, 7);
    hit(380, 150, 92, 66, 'truck', null);
    // deliveries on the floor
    const pos = new Map(vm.agents.map((a, i) => [a.id, seat(a, i)]));
    let q = 0;
    for (const d of vm.deliveries) {
      if (d.stage === 'on_truck' || d.stage === 'shipped') continue;
      const m = pos.get(d.makerId), r = pos.get(d.reviewerId);
      let x = 152 + (q++ % 4) * 9, y = 110;
      if (d.stage === 'in_review' && r) { x = r.x + 12; y = r.y + 8; }
      else if ((d.stage === 'rejected' || d.stage === 'buddy_check') && m) { x = m.x + 14; y = m.y + 6; }
      else if (d.stage === 'to_truck') { x = 362; y = 192 - (q % 3) * 9; }
      box(x, y, 8, 8, d.stage === 'rejected' ? C.red : d.stage === 'to_truck' ? C.green : d.stage === 'buddy_check' ? C.blue : C.woodLight);
    }
    // agents
    for (const [i, a] of vm.agents.entries()) {
      const p = seat(a, i);
      drawSprite(g, p.x, p.y, a, C, a.activity === 'off');
      text(a.name.slice(0, 8), p.x + 5, p.y + 15, a.activity === 'off' ? C.woodDark : C.paper, 7, 'center');
      const mark = { work: [C.green, '*'], think: [C.blue, '..'], wait: [C.amber, 'z'], review: [C.white, '?'], blocked: [C.red, '!'] }[a.activity];
      if (mark && (a.activity !== 'blocked' || blink)) { box(p.x + 9, p.y - 8, 9, 9, mark[0]); text(mark[1], p.x + 13.5, p.y - 8, C.ink, 7, 'center'); }
      if (a.task && a.role === 'maker') { const w = Math.round(2 + a.task.progress * 20); box(p.x - 4, p.y + 23, w, 5, C.amber); text(a.task.id, p.x + 21, p.y + 22, C.paper, 6); }
      hit(p.x - 3, p.y - 3, 16, 26, 'agent', a.id);
      if (a.bubble) {
        let b = bubbles.get(a.id);
        if (!b || b.seq !== a.bubble.seq) bubbles.set(a.id, (b = { seq: a.bubble.seq, until: now + 6000 }));
        if (now < b.until || a.bubble.kind === 'ask') {
          const s = a.bubble.text.slice(0, 22);
          const w = s.length * 4.4 + 6;
          const bx = Math.min(W - w - 2, Math.max(2, p.x - 4));
          box(bx, p.y - 20, w, 11, { ask: C.amber, warn: C.red, done: C.green }[a.bubble.kind] || C.paper);
          text(s, bx + 3, p.y - 18, a.bubble.kind === 'warn' ? C.white : C.ink, 7);
        }
      }
    }
    // effects
    fxs = fxs.filter((x) => now - x.t0 < x.ms);
    for (const x of fxs) {
      const t = (now - x.t0) / x.ms;
      if (x.name === 'confetti') { for (let i = 0; i < 60; i++) { g.fillStyle = [C.amber, C.green, C.red, C.blue, C.white][i % 5]; g.fillRect((i * 53 + t * 40) % W, ((i * 37) % 90) + t * 200, 2, 2); } }
      else if (x.name === 'horn') text('HONK!', 426, 136, blink ? C.amber : C.white, 9, 'center');
      else if (x.name === 'newOrder') text('NEW WORK ORDER!', 51, 222, C.amber, 8, 'center');
      else if (x.name === 'note') { const p = pos.get(x.payload && x.payload.from) || { x: 100, y: 240 }; box(p.x + (240 - p.x) * t, p.y + (56 - p.y) * t, 6, 5, C.white); }
    }
    if (opts.scanlines) { g.fillStyle = 'rgba(0,0,0,0.18)'; for (let y = 0; y < H; y += 2) g.fillRect(0, y, W, 1); }
  }

  function loop(now) {
    raf = 0;
    if (dead) return;
    if (now - last > 80) { last = now; draw(now); }
    if (!opts.paused) raf = requestAnimationFrame(loop);
  }
  const kick = () => { if (!raf && !dead) raf = requestAnimationFrame(loop); };

  function at(e) {
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) * W) / (r.width || W), y = ((e.clientY - r.top) * H) / (r.height || H);
    for (let i = hits.length - 1; i >= 0; i--) {
      const b = hits[i];
      if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) {
        if (b.kind === 'office') { const boss = vm.agents.find((a) => a.role === 'boss'); return { kind: 'office', id: boss ? boss.id : null }; }
        if (b.kind === 'bench') { const m = vm.agents.find((a) => a.role === 'maker' && a.spot === b.id); return { kind: 'bench', id: m ? m.id : b.id }; }
        return { kind: b.kind, id: b.id };
      }
    }
    return { kind: 'none', id: null };
  }
  const onClick = (e) => onEvent({ type: 'click', target: at(e) });
  const onMove = (e) => { const t = at(e); const k = t.kind + ':' + t.id; if (k !== hover) { hover = k; onEvent({ type: 'hover', target: t }); } };
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('mousemove', onMove);

  const scene = {
    sync(next) {
      const was = vm.truck.state;
      vm = next || EMPTY;
      if (vm.truck.state !== was && (vm.truck.state === 'leaving' || vm.truck.state === 'returning')) {
        fxs = fxs.filter((x) => x.name !== '_truck');
        fxs.push({ name: '_truck', t0: performance.now(), ms: 4000 });
      }
      last = 0; kick();
    },
    fx(name, payload) { fxs.push({ name, payload, t0: performance.now(), ms: name === 'confetti' ? 2600 : name === 'note' ? 700 : 1400 }); if (fxs.length > 40) fxs.shift(); kick(); },
    resize() {
      const box2 = canvas.parentElement;
      if (!box2) return;
      const cw = box2.clientWidth, ch = box2.clientHeight;
      const k = Math.max(1, Math.floor(Math.min(cw / W, ch / H)));
      canvas.style.width = W * k + 'px'; canvas.style.height = H * k + 'px';
      canvas.style.marginLeft = Math.floor((cw - W * k) / 2) + 'px'; canvas.style.marginTop = Math.floor((ch - H * k) / 2) + 'px'; // centered, like the real scene
      last = 0; kick();
    },
    setOptions(o) { opts = { ...opts, ...o }; last = 0; kick(); },
    destroy() { dead = true; cancelAnimationFrame(raf); canvas.removeEventListener('click', onClick); canvas.removeEventListener('mousemove', onMove); },
  };
  scene.resize();
  kick();
  return scene;
}
