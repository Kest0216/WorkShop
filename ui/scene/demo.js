// WorkShop scene demo: a scripted, looping "day in the shop" that drives the scene through sync() and fx() only.
//
// URL parameters:
//   t=<ms>        fast-forward the simulation synchronously to that time, then keep running
//   freeze=1      stop time after the fast-forward
//   clock=HH:MM   fix the wall clock and the sky
//   scale=<n>     force the integer scale
//   crop=x,y,w,h  show only that logical region, scaled up to fill the window
//   reload=1      build the scene fresh from the view model at time t (no history, no animation)
//   sheet=1       character and prop sheet for art review (role=maker|manager|boss limits the pose rows)
//   hover=x,y     put the pointer on that logical position (to check the highlight and the tooltip)
//   stress=1      a crowded still life instead of the script: 12 makers (4 find no bench), review backlogs in the
//                 offices, a full truck, many bubbles. t=<ms> lets it run that long (default 2500).
//   scan=1        scanline overlay          hud=0  hide the small status line
//
// freeze=1 really freezes: the scene is paused after the fast-forward and nothing moves it any more, so the same
// URL always gives the same picture. Without it, the script and the scene advance together, frame by frame.
//
// The script (vmAt, effectsBetween, stressVm) is pure and importable in Node; the scene is only loaded in a browser.

export const LOOP_MS = 92000;

// Looks: six makers with six different headgears (goggles, cap, bandana, beanie, visor, ear muffs) and mixed skin tones.
const AGENTS = [
  { id: 'B1', name: 'Ada', handle: '@boss1', role: 'boss', provider: 'claude', model: 'claude-opus', style: { seed: 1101 }, spot: 0 },
  { id: 'B2', name: 'Gus', handle: '@boss2', role: 'boss', provider: 'gemini', model: 'gemini-pro', style: { seed: 2207 }, spot: 1 },
  { id: 'M1', name: 'Pip', handle: '@fm1', role: 'manager', provider: 'claude', model: 'claude-sonnet', style: { seed: 3301 }, spot: 0 },
  { id: 'M2', name: 'Rex', handle: '@fm2', role: 'manager', provider: 'gemini', model: 'gemini-flash', style: { seed: 1258 }, spot: 1 },
  { id: 'K1', name: 'Sprocket', handle: '@m1', role: 'maker', provider: 'claude', model: 'claude-sonnet', style: { seed: 12345 }, spot: 0 },
  { id: 'K2', name: 'Dot', handle: '@m2', role: 'maker', provider: 'gemini', model: 'gemini-flash', style: { seed: 268 }, spot: 1 },
  { id: 'K3', name: 'Flux', handle: '@m3', role: 'maker', provider: 'openai', model: 'gpt-mini', style: { seed: 2682 }, spot: 2 },
  { id: 'K4', name: 'Nib', handle: '@m4', role: 'maker', provider: 'claude', model: 'claude-haiku', style: { seed: 1358 }, spot: 4 },
  { id: 'K5', name: 'Bolt', handle: '@m5', role: 'maker', provider: 'gemini', model: 'gemini-flash', style: { seed: 3409 }, spot: 5 },
  { id: 'K6', name: 'Moss', handle: '@m6', role: 'maker', provider: 'mock', model: 'mock-1', style: { seed: 9491 }, spot: 6 },
];

// maker work plan: [task id, title, domain, work start s, work end s]
const WORK = {
  K1: ['T1', 'Session API', 'backend', 6, 20],
  K2: ['T2', 'Login form', 'frontend', 6, 28],
  K3: ['T3', 'Compare auth libs', 'research', 6, 38],
  K4: ['T4', 'Token tests', 'test', 6, 16],
  K5: ['T5', 'Setup guide', 'docs', 6, 12],
  K6: ['T6', 'User table import', 'data', 6, 34],
};

// delivery stage schedule: [seconds, stage]
// Stages follow the contract order: to_office (checking) -> buddy_check -> in_review -> to_truck.
// D4: Bolt (K5) is Nib's buddy. Nib checks the item at the bench (to_office), Bolt inspects it there (buddy_check),
//     then Nib carries it to Gus's office for the boss review.
// D6: Rex (M2, a floor manager) reviews Moss's work at Moss's bench and stamps it; Moss carries the crate to the
//     staging pallet by the dock, where the dolly picks it up. No boss office is involved.
const DELIVERIES = [
  { id: 'D5', taskId: 'T5', domain: 'docs', makerId: 'K5', reviewerId: 'B2', plan: [[12, 'to_office'], [16, 'in_review'], [19.5, 'to_truck'], [29, 'on_truck'], [70, 'shipped']] },
  { id: 'D4', taskId: 'T4', domain: 'test', makerId: 'K4', reviewerId: 'B2', buddyId: 'K5', plan: [[16, 'to_office'], [17, 'buddy_check'], [21.5, 'in_review'], [28, 'to_truck'], [35, 'on_truck'], [70, 'shipped']] },
  { id: 'D1', taskId: 'T1', domain: 'backend', makerId: 'K1', reviewerId: 'B1', plan: [[20, 'to_office'], [24, 'in_review'], [27, 'rejected'], [38, 'to_office'], [42, 'in_review'], [45.5, 'to_truck'], [57, 'on_truck'], [70, 'shipped']] },
  { id: 'D2', taskId: 'T2', domain: 'frontend', makerId: 'K2', reviewerId: 'B1', plan: [[29, 'to_office'], [33, 'in_review'], [36.5, 'to_truck'], [44, 'on_truck'], [70, 'shipped']] },
  { id: 'D6', taskId: 'T6', domain: 'data', makerId: 'K6', reviewerId: 'M2', plan: [[34, 'to_office'], [35, 'in_review'], [39.5, 'to_truck'], [51, 'on_truck'], [70, 'shipped']] },
  { id: 'D3', taskId: 'T3', domain: 'research', makerId: 'K3', reviewerId: 'B1', plan: [[39, 'to_office'], [47.5, 'in_review'], [50.5, 'to_truck'], [63, 'on_truck'], [70, 'shipped']] },
];
// owner questions: the counter bell rings while one waits (the truck beacon does not light for it)
const ATTENTION = [[55, 60], [66, 70]];

// speech bubbles: [seconds, agent, kind, text]
const BUBBLES = [
  [3, 'B1', 'info', 'Six tasks. Plan is ready.'],
  [6.5, 'M1', 'info', 'Benches 1 to 3 are mine.'],
  [10, 'K2', 'ask', 'Which button style do we use?'],
  [13, 'M1', 'info', 'The flat one, as in the spec.'],
  [18, 'K6', 'warn', 'Blocked: I need the schema!'],
  [19, 'K5', 'info', 'Buddy check: tests look solid.'],
  [22.5, 'B2', 'info', 'Schema is on the board.'],
  [27.5, 'B1', 'warn', 'No. The refresh path fails.'],
  [30.5, 'K1', 'info', 'On it. Fixing the refresh.'],
  [37, 'M2', 'info', 'Import checks out. Pass.'],
  [46, 'B1', 'done', 'Pass! Nice fix.'],
  [55, 'B2', 'ask', 'Owner: keep the old login page?'],
  [66, 'B1', 'ask', 'Truck is full. Ship it?'],
  [70.5, 'B2', 'done', 'Approved. Off it goes!'],
  [88, 'M2', 'done', 'Job done. Shelves are full.'],
];

// one-shot effects: [seconds, name, payload]
const EFFECTS = [
  [2, 'newOrder', {}],
  [10.2, 'note', { from: 'Dot', kind: 'ask', text: 'Which button style do we use?' }],
  [13.2, 'note', { from: 'Pip', kind: 'info', text: 'The flat one, as in the spec.' }],
  [18.2, 'note', { from: 'Moss', kind: 'warn', text: 'Blocked: I need the schema!' }],
  [22.7, 'note', { from: 'Gus', kind: 'info', text: 'Schema is on the board.' }],
  [46.2, 'note', { from: 'Ada', kind: 'done', text: 'T1 passed review.' }],
  [52, 'newOrder', {}],
  [55.2, 'note', { from: 'Gus', kind: 'ask', text: 'Keep the old login page?' }],
  [66.2, 'note', { from: 'Ada', kind: 'ask', text: 'Truck is full. Ship it?' }],
  [70, 'ship', { restock: true }],
  [88, 'confetti', {}],
  [88.2, 'note', { from: 'Rex', kind: 'done', text: 'Job done.' }],
];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ramp = (s, a, b) => clamp01((s - a) / (b - a));
function stageAt(plan, s) { let st = null; for (const [t, stage] of plan) if (s >= t) st = stage; return st; }

// The full view model at simulated time ms (pure function of time).
export function vmAt(ms) {
  const s = (((ms % LOOP_MS) + LOOP_MS) % LOOP_MS) / 1000;
  const deliveries = [];
  for (const d of DELIVERIES) {
    const stage = stageAt(d.plan, s);
    if (stage) deliveries.push({ id: d.id, taskId: d.taskId, domain: d.domain, makerId: d.makerId, reviewerId: d.reviewerId, buddyId: d.buddyId || '', stage });
  }
  const stageOf = (id) => { const d = deliveries.find((x) => x.id === id); return d ? d.stage : null; };
  const reviewing = (id) => deliveries.some((d) => d.reviewerId === id && d.stage === 'in_review');
  const buddying = (id) => deliveries.some((d) => d.buddyId === id && d.stage === 'buddy_check');
  const working = s >= 6 && s < 66;

  const agents = AGENTS.map((a) => {
    const out = { ...a, style: { ...a.style }, activity: 'idle' };
    if (a.role === 'boss') {
      if (s < 6) { out.activity = 'think'; out.task = { id: 'P1', title: 'Plan the login flow', domain: 'plan', progress: ramp(s, 0, 6) }; }
      else if (reviewing(a.id)) out.activity = 'review';
      else if (s >= 66 && s < 70 && a.id === 'B1') out.activity = 'wait';
    } else if (a.role === 'manager') {
      out.activity = reviewing(a.id) ? 'review' : working ? 'work' : 'idle';
    } else {
      const [tid, title, domain, t0, t1] = WORK[a.id];
      const dl = DELIVERIES.find((d) => d.makerId === a.id);
      const st = stageOf(dl.id);
      if (s >= t0 && s < 70) {
        out.task = { id: tid, title, domain, progress: ramp(s, t0, t1) };
        out.activity = st === null ? 'work' : st === 'on_truck' || st === 'shipped' ? 'idle' : 'wait';
        if (a.id === 'K1') {
          if (st === 'rejected' && s >= 30) { out.activity = 'work'; out.task = { id: tid, title: 'Fix refresh path', domain: 'fix', progress: 0.5 + 0.5 * ramp(s, 30, 38) }; }
          else if (st === 'rejected') out.activity = 'idle';
        }
        if (a.id === 'K3' && s >= 15 && s < 19) out.activity = 'think';
        if (a.id === 'K6' && s >= 14 && s < 22.5) { out.activity = 'blocked'; out.task.progress = ramp(14, t0, t1); }
        if (a.id === 'K6' && s >= 22.5 && st === null) out.task.progress = clamp01(ramp(14, t0, t1) + (1 - ramp(14, t0, t1)) * ramp(s, 22.5, t1));
        if (buddying(a.id)) out.activity = 'review';
        if (out.activity === 'idle') delete out.task;
      }
    }
    for (let i = BUBBLES.length - 1; i >= 0; i--) {
      const [bt, who, kind, text] = BUBBLES[i];
      if (who === a.id && s >= bt && s < bt + 8) { out.bubble = { text, kind, seq: i + 1 }; break; }
    }
    return out;
  });

  // the truck is 'ready' (beacon) only while the owner is asked to ship; at 70 s fx('ship') drives it off and back
  const onTruck = deliveries.filter((d) => d.stage === 'on_truck').length;
  const truck = s >= 66 && s < 70 ? 'ready' : 'docked';
  const notes = EFFECTS.filter(([t, name]) => name === 'note' && s >= t).length;
  const status = s < 6 ? 'Planning the job' : s < 20 ? '6 tasks in work' : s < 66 ? 'Reviews running' : s < 70 ? 'Waiting for your OK' : s < 75 ? 'Shipped!' : s < 88 ? 'Restocking' : 'Job done!';
  return {
    shop: { jobTitle: 'Login flow', paused: false, statusLine: status },
    agents,
    deliveries,
    truck: { state: truck, crates: onTruck },
    board: { unread: s >= 56 && s < 66 ? 0 : s >= 66 ? notes - 6 : notes },
    owner: { attention: ATTENTION.some(([a, b]) => s >= a && s < b) },
  };
}

// Effects that fire in the half-open interval (fromMs, toMs].
export function effectsBetween(fromMs, toMs) {
  const out = [];
  for (const [t, name, payload] of EFFECTS) if (t * 1000 > fromMs && t * 1000 <= toMs) out.push({ name, payload });
  return out;
}

// Drive anything with sync(vm) and fx(name, payload) from script time `from` to `to` (handles the loop wrap).
export function applyScript(target, from, to) {
  const a = ((from % LOOP_MS) + LOOP_MS) % LOOP_MS;
  let b = ((to % LOOP_MS) + LOOP_MS) % LOOP_MS;
  if (b === 0 && to > from) b = LOOP_MS;
  const run = (x, y) => { target.sync(vmAt(y)); for (const fx of effectsBetween(x, y)) target.fx(fx.name, fx.payload); };
  if (b < a) { run(a, LOOP_MS); run(-1, b); } else run(a, b);
}

// A crowded still life for QA (pure). phase 0: the reviews run; phase 1: the third boss has passed four of them.
export function stressVm(phase) {
  const domains = ['backend', 'frontend', 'research', 'test', 'docs', 'data', 'fix', 'algo', 'vision', 'synthesis', 'review', 'chore'];
  const labs = ['claude', 'gemini', 'openai', 'mock'];
  const names = ['Sprocket', 'Dot', 'Flux', 'Nib', 'Bolt', 'Moss', 'Widget', 'Cog', 'Rivet', 'Pixel', 'Gizmo', 'Tack'];
  const say = (text, kind) => (phase ? { text, kind, seq: 1 } : undefined);
  const agents = [
    { id: 'B1', name: 'Ada', role: 'boss', provider: 'claude', style: { seed: 1101 }, spot: 0, activity: 'review', bubble: say('Next one, please.', 'info') },
    { id: 'B2', name: 'Gus', role: 'boss', provider: 'gemini', style: { seed: 2207 }, spot: 1, activity: 'review', bubble: say('This needs a second look before it goes out.', 'warn') },
    { id: 'B3', name: 'Ivy', role: 'boss', provider: 'openai', style: { seed: 1221 }, spot: 2, activity: 'idle' },
    { id: 'M1', name: 'Pip', role: 'manager', provider: 'claude', style: { seed: 3301 }, spot: 0, activity: 'work' },
    { id: 'M2', name: 'Rex', role: 'manager', provider: 'gemini', style: { seed: 1258 }, spot: 1, activity: 'work' },
    { id: 'M3', name: 'Quill', role: 'manager', provider: 'openai', style: { seed: 1332 }, spot: 2, activity: 'idle', bubble: say('All benches are taken.', 'info') },
  ];
  names.forEach((name, i) => {
    const a = { id: 'K' + (i + 1), name, role: 'maker', provider: labs[i % 4], style: { seed: 500 + i * 977 }, activity: i % 5 === 3 ? 'think' : i % 7 === 6 ? 'blocked' : 'work',
      task: { id: 'T' + (i + 1), title: 'Task ' + (i + 1), domain: domains[i % domains.length], progress: ((i * 37) % 100) / 100 } };
    if (i === 1) a.bubble = say('Which button style do we use here?', 'ask');
    if (i === 4) a.bubble = say('Guide is done.', 'done');
    if (i === 6) a.bubble = say('Blocked: I need the schema!', 'warn');
    agents.push(a);
  });
  const deliveries = [];
  const add = (n, makerId, reviewerId, stage, domain) => deliveries.push({ id: 'D' + n, taskId: 'X' + n, domain, makerId, reviewerId, stage });
  for (let n = 0; n < 5; n++) add(n, 'K' + (n + 1), 'B1', n === 0 ? 'in_review' : 'to_office', domains[n]);                 // one on the desk, four in the inbox
  for (let n = 5; n < 7; n++) add(n, 'K' + (n + 1), 'B2', 'in_review', domains[n]);                                          // two in review: one waits
  for (let n = 7; n < 12; n++) add(n, 'K' + (n - 6), 'B3', phase ? 'to_truck' : n === 7 ? 'in_review' : 'to_office', domains[n]);   // five pass at once: outbox backlog
  return {
    shop: { jobTitle: 'Stress test', paused: false, statusLine: 'A very long status line that has to be cut' },
    agents, deliveries,
    truck: { state: 'ready', crates: 9 },
    board: { unread: 120 },
    owner: { attention: true },
  };
}

// ---------------------------------------------------------------- browser harness

async function main() {
  const q = new URLSearchParams(location.search);
  const num = (k, d) => { const v = Number(q.get(k)); return q.has(k) && Number.isFinite(v) ? v : d; };
  const hudEl = document.getElementById('hud');
  const errEl = document.getElementById('err');
  const showError = (msg) => { errEl.style.display = 'block'; errEl.textContent += msg + '\n'; };
  window.addEventListener('error', (e) => showError('error: ' + e.message + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno));
  window.addEventListener('unhandledrejection', (e) => showError('rejection: ' + (e.reason && e.reason.stack ? e.reason.stack : e.reason)));
  const warn0 = console.warn.bind(console);
  window.__warnings = [];
  console.warn = (...a) => { if (window.__warnings.length < 50) window.__warnings.push(a.join(' ')); warn0(...a); };

  const stage = document.getElementById('stage');
  const canvas = document.getElementById('scene');
  const crop = (q.get('crop') || '').split(',').map(Number);
  const hasCrop = crop.length === 4 && crop.every(Number.isFinite) && crop[2] > 0 && crop[3] > 0;
  // place a canvas of logical size (lw, lh): cropped region scaled up, or forced scale; returns the scale or 0 for "automatic"
  const place = (lw, lh, setSize) => {
    if (hasCrop) {
      const [x, y, w, h] = crop;
      const s = Math.max(1, Math.floor(Math.min(window.innerWidth / w, window.innerHeight / h)));
      stage.style.width = w * s + 'px'; stage.style.height = h * s + 'px';
      stage.style.left = Math.floor((window.innerWidth - w * s) / 2) + 'px'; stage.style.top = Math.floor((window.innerHeight - h * s) / 2) + 'px';
      setSize(s, false);
      canvas.style.marginLeft = -x * s + 'px'; canvas.style.marginTop = -y * s + 'px';
      return s;
    }
    if (q.has('scale')) { const s = Math.max(1, Math.floor(num('scale', 1))); setSize(s, true); return s; }
    return 0;
  };

  // ---- art sheet
  if (q.has('sheet') && q.get('sheet') !== '0') {
    const { drawSheet, SHEET_W } = await import('./sheet.js');
    const tmp = document.createElement('canvas');
    tmp.width = SHEET_W; tmp.height = 4000;
    const used = await drawSheet(tmp.getContext('2d'), { role: q.get('role') });
    canvas.width = SHEET_W; canvas.height = used;
    canvas.getContext('2d').drawImage(tmp, 0, 0);
    const size = (s) => { canvas.style.width = SHEET_W * s + 'px'; canvas.style.height = used * s + 'px'; };
    if (!place(SHEET_W, used, size)) size(2);
    if (!hasCrop) stage.style.overflow = 'auto';        // the sheet is taller than the window: scroll
    document.title = 'WorkShop art sheet';
    if (hudEl) hudEl.textContent = '';
    return;
  }

  // ---- scene
  const { createScene } = await import('./scene.js');
  let fixed = null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(q.get('clock') || '');
  if (m) { fixed = new Date(); fixed.setHours(Math.min(23, +m[1]), Math.min(59, +m[2]), 0, 0); }
  let lastEvent = '';
  const scene = createScene(canvas, {
    clock: () => fixed || new Date(),
    onEvent(evt) { if (evt.type === 'click' || evt.target.kind !== 'none') lastEvent = evt.type + ': ' + evt.target.kind + (evt.target.id !== null ? ' ' + evt.target.id : ''); },
  });
  window.scene = scene;
  if (q.get('scan') === '1') scene.setOptions({ scanlines: true });
  const layout = () => place(480, 272, (s, center) => scene.setOptions({ scale: s, autoCenter: center }));
  layout();
  window.addEventListener('resize', layout);

  let time = 0;                       // script time, ms
  const t0 = Math.max(0, num('t', 0));
  const stress = q.get('stress') === '1';
  if (stress) {
    scene.sync(stressVm(0));
    scene.debug.advance(400);
    scene.sync(stressVm(1));
    scene.fx('newOrder'); scene.fx('note', { from: 'Ada', kind: 'ask', text: 'Backlog!' });
    scene.debug.advance(q.has('t') ? t0 : 2500);
  } else if (q.get('reload') === '1') {
    time = t0 % LOOP_MS;
    scene.sync(vmAt(time));           // fresh scene, no history: everything must land in its steady state
  } else {
    scene.sync(vmAt(0));
    const STEP = 50;
    while (time < t0) {               // synchronous fast-forward
      const next = Math.min(t0, time + STEP);
      applyScript(scene, time, next);
      scene.debug.advance(next - time);
      time = next;
    }
    time %= LOOP_MS;
  }

  // freeze: pause the scene for good. From here on only debug.render() touches it, so the picture is stable.
  const frozen = q.get('freeze') === '1';
  if (frozen) scene.setOptions({ paused: true });
  const hv = (q.get('hover') || '').split(',').map(Number);
  if (hv.length === 2 && hv.every(Number.isFinite)) {
    const r = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: r.left + ((hv[0] + 0.5) / 480) * r.width, clientY: r.top + ((hv[1] + 0.5) / 272) * r.height, bubbles: true }));
  }
  scene.debug.render();

  const showHud = () => {
    if (hudEl && q.get('hud') !== '0') hudEl.textContent = (stress ? 'stress' : 't=' + (time / 1000).toFixed(1) + 's') + (frozen ? ' (frozen)' : '') + (lastEvent ? '  ' + lastEvent : '')
      + (window.__warnings.length ? '  warnings: ' + window.__warnings.length : '');
  };
  // The script advances in the same animation frames as the scene, so both are throttled together
  // (hidden tab, slow machine) and events never pile up in front of a world that stands still.
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    const dt = Math.min(250, Math.max(0, now - last));
    last = now;
    if (!frozen && !stress && !document.hidden) {
      applyScript(scene, time, time + dt);
      time = (time + dt) % LOOP_MS;
      window.__loops = (window.__loops || 0) + (time < dt ? 1 : 0);
    }
    showHud();
    requestAnimationFrame(tick);
  };
  showHud();
  requestAnimationFrame(tick);
  document.title = 'WorkShop scene demo';
}

if (typeof document !== 'undefined' && typeof document.getElementById === 'function' && document.getElementById('scene') && document.getElementById('stage')) main().catch((e) => { const el = document.getElementById('err'); if (el) { el.style.display = 'block'; el.textContent += 'main: ' + (e && e.stack ? e.stack : e) + '\n'; } });
