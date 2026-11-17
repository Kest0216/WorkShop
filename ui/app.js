// WorkShop UI entry: wires the store, the scene, the top bar, the drawer, toasts, the ticker and the keyboard.
// Helpers live in ./lib (dom, api, store, selectors, vm, widgets, labs, questions, diff, md). Panels live in ./panels and are registered in ./panels/index.js.

import { h, mount, clear, focusables, showMarks } from './lib/dom.js';
import { createApi } from './lib/api.js';
import { createStore, prefs } from './lib/store.js';
import { sel } from './lib/selectors.js';
import { buildVM, createTruck, createShipCounter, bubbleKind } from './lib/vm.js';
import { createNative } from './lib/native.js';
import { createLabs } from './lib/labs.js';
import { isAsk, guessPanel } from './lib/notices.js';
import { fitDrawer, wholeDpr, SCENE_W } from './lib/layout.js';
import * as ui from './lib/widgets.js';
import { loadTheme } from './theme.js';
import { PANELS } from './panels/index.js';

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'), stage: $('stage'), canvas: $('scene'), stageWait: $('stage-wait'), topbar: $('topbar'), conn: $('conn'), jobchip: $('jobchip'),
  presence: $('presence'), labchips: $('labchips'), nav: $('nav'), strip: $('strip'), hint: $('hint'),
  drawer: $('drawer'), drawerTitle: $('drawer-title'), drawerBody: $('drawer-body'), drawerClose: $('drawer-close'),
  toasts: $('toasts'), ticker: $('ticker'), modals: $('modals'),
};
const query = new URLSearchParams(location.search);
const RESERVED = new Set(['panel', 'scene', 'stream', 'debug']); // URL parameters that are not panel parameters
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
/** Text that ends like a sentence, so the next sentence can follow it. */
const sentence = (s) => { const t = oneLine(s); return !t || /[.!?:]$/.test(t) ? t : t + '.'; };
const fmt = ui.fmt;

const toasts = ui.createToasts(el.toasts);
const modals = ui.createModals(el.modals, { fallbackFocus: () => (el.drawer.hidden ? null : el.drawerTitle) });
const api = createApi({ onError: (message) => toasts.show({ level: 'error', text: message }) });
const store = createStore({ api });
const native = createNative(); // the Mac app's bridge; a no-op in a plain browser
const panelById = new Map(PANELS.map((p) => [p.id, p]));
// Lab setup actions, shared by the first-run strip and the Keys panel (ctx.labs).
const labs = createLabs({ api, store, toasts, modals, openPanel: (id, params) => openPanel(id, params) });

// ------------------------------------------------------------------ sound (settings.ui.sound)

// Short square-wave blips, made in the browser. No audio files. Silent until the owner turns sound on and has clicked or typed once.
const sound = (() => {
  let ac = null, armed = false;
  const arm = () => { armed = true; };
  window.addEventListener('pointerdown', arm, { once: true, capture: true });
  window.addEventListener('keydown', arm, { once: true, capture: true });
  const TUNES = {
    owner: [[660, 0, 0.09], [880, 0.11, 0.16]],
    warn: [[330, 0, 0.14]],
    ship: [[196, 0, 0.18], [196, 0.26, 0.32]],
    done: [[523, 0, 0.09], [659, 0.1, 0.09], [784, 0.2, 0.09], [1047, 0.3, 0.22]],
    test: [[784, 0, 0.07], [988, 0.08, 0.1]],
  };
  const on = () => !!(store.settings && store.settings.ui && store.settings.ui.sound);
  return {
    /** play(name, force?) -> true when a sound started. force plays it even when the setting is off (the test blip of the Settings panel). */
    play(name, force = false) {
      if ((!force && !on()) || !armed || !Object.hasOwn(TUNES, name)) return false;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        ac = ac || new AC();
        if (ac.state === 'suspended') ac.resume();
        const t0 = ac.currentTime + 0.02;
        for (const [freq, at, dur] of TUNES[name]) {
          const osc = ac.createOscillator(), gain = ac.createGain();
          osc.type = 'square'; osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.045, t0 + at); gain.gain.setValueAtTime(0, t0 + at + dur);
          osc.connect(gain); gain.connect(ac.destination);
          osc.start(t0 + at); osc.stop(t0 + at + dur + 0.02);
        }
        return true;
      } catch { return false; }
    },
  };
})();

// ------------------------------------------------------------------ scene

const sceneCtl = (() => {
  let mod = null, scene = null, kind = 'none', fails = 0, pending = null, options = { scanlines: false, paused: document.hidden };
  let stages = null; // delivery stages the loaded scene module draws; null = every stage of the contract
  const avatars = new Map();

  function make() {
    scene = mod.createScene(el.canvas, { onEvent: onSceneEvent });
    try { scene.setOptions(options); scene.resize(); } catch { /* optional calls */ }
    if (pending) { try { scene.sync(adapt(pending)); } catch { /* first frame can wait */ } }
    el.stageWait.hidden = true; // the floor is drawn: the "opening" card leaves
  }
  /** A scene build that does not know a stage of the contract yet gets the nearest older one, so no crate vanishes. */
  function adapt(vm) {
    if (!stages || !vm.deliveries.some((d) => !stages.has(d.stage))) return vm;
    return { ...vm, deliveries: vm.deliveries.map((d) => (stages.has(d.stage) ? d : { ...d, stage: d.stage === 'buddy_check' && stages.has('to_office') ? 'to_office' : d.stage })).filter((d) => stages.has(d.stage)) };
  }
  async function useStandIn(why) {
    if (kind === 'standin') return;
    if (why) console.warn(`Scene: using the stand-in (${why}).`);
    try { if (scene) scene.destroy(); } catch { /* it is broken anyway */ }
    scene = null; stages = null; avatars.clear();
    // A canvas keeps its first context type. Give the stand-in a clean one.
    const fresh = h('canvas#scene', { width: 480, height: 272 });
    el.canvas.replaceWith(fresh);
    el.canvas = fresh;
    try { mod = await import('./scene-standin.js'); kind = 'standin'; fails = 0; make(); } catch (e) {
      mod = null; kind = 'none'; console.warn('Scene: no scene at all.', e);
      el.stageWait.hidden = false; el.stageWait.textContent = 'The workshop floor did not load. The panels work without it.';
    }
    layoutStage();
  }
  async function load() {
    await loadTheme(); // CSS variables from the scene palette; the defaults in style.css stay when it is missing
    if (query.get('scene') !== 'standin') {
      try {
        const real = await import('./scene/scene.js');
        if (typeof real.createScene !== 'function') throw new Error('scene.js has no createScene');
        try { const m = await import('./scene/model.js'); if (Array.isArray(m.STAGES) && m.STAGES.length) stages = new Set(m.STAGES); } catch { stages = null; }
        mod = real; kind = 'real';
        make();
      } catch (e) {
        mod = null; scene = null; kind = 'none';
        await useStandIn(e && e.message ? String(e.message).slice(0, 120) : 'real scene not available');
        return;
      }
    } else await useStandIn('');
    layoutStage();
  }
  function call(name, ...args) {
    if (!scene) return;
    try { scene[name](...args); if (name === 'sync') fails = 0; } catch (e) {
      console.warn(`Scene: ${name}() failed.`, e);
      if (kind === 'real' && name === 'sync' && ++fails >= 3) useStandIn('the real scene keeps failing');
    }
  }
  return {
    load,
    get kind() { return kind; },   // 'real' | 'standin' | 'none'
    get raw() { return scene; },   // the scene object itself, for tests and the console
    sync(vm) { pending = vm; call('sync', adapt(vm)); },
    fx(name, payload) { call('fx', name, payload || {}); },
    resize() { call('resize'); },
    setOptions(o) { options = { ...options, ...o }; call('setOptions', options); },
    /** PNG data URL of an agent sprite from the real scene, or null (stand-in or no scene: panels show a neutral tile). Cached. */
    avatar(agent, scale = 2) {
      if (!agent || kind !== 'real' || !mod || typeof mod.avatarDataURL !== 'function') return null;
      const key = `${agent.id}|${agent.role}|${agent.provider}|${agent.style && agent.style.seed}|${scale}`;
      if (!avatars.has(key)) { let url = null; try { url = mod.avatarDataURL(agent, scale) || null; } catch { url = null; } avatars.set(key, url); if (avatars.size > 300) avatars.delete(avatars.keys().next().value); }
      return avatars.get(key);
    },
  };
})();

// What a click on a thing in the scene opens (contract section 13b).
function onSceneEvent(evt) {
  if (!evt || !evt.target) return;
  const { kind, id } = evt.target;
  if (evt.type === 'hover') { el.stage.style.cursor = kind && kind !== 'none' ? 'pointer' : ''; return; }
  if (evt.type !== 'click') return;
  const job = sel.activeJob(store);
  const bySpot = (role) => {
    if (id != null && store.get('agents', id)) return id;
    const a = job && sel.agentsOf(store, job.id).find((x) => x.role === role && String(x.spot) === String(id));
    return a ? a.id : null;
  };
  const crew = (agentId) => openPanel('crew', agentId ? { agent: agentId } : {});
  if (kind === 'agent') crew(id != null && store.get('agents', id) ? id : null);
  else if (kind === 'office') crew(bySpot('boss') || (job && job.leadBossId) || null);
  else if (kind === 'bench') crew(bySpot('maker'));
  else if (kind === 'truck') { // the truck in the scene is the truck of the job on the floor
    const shown = sel.truckJob(store);
    openPanel('truck', job && shown && shown.id !== job.id ? { job: job.id } : {});
  }
  else if (kind === 'board') openPanel('board');
  else if (kind === 'counter') openPanel('workorder');
  else if (kind === 'toolwall') openPanel('toolkit', { tab: 'tools' }); // the tool pegboard
  else if (kind === 'harnesses') openPanel('toolkit', { tab: 'rack' }); // the Harness Rack
  else if (kind === 'rftbay') openPanel('crew', { tab: 'rft' }); // the RFT calibration bay
}

const truck = createTruck({ onChange: () => store.touch('ui') });
const shipped = createShipCounter(); // fx ship carries { jobId, sha }: the crates it took are the deliveries that just turned shipped
function syncScene() {
  const sticky = toasts.list().some((t) => t.sticky);
  const vm = buildVM(store, { truckPhase: truck.phase, shipCrates: truck.crates, attention: sel.ownerAttention(store).any || sticky });
  sceneCtl.sync(vm);
}

/**
 * The drawer may give up a little width when that buys the floor a whole scale step (lib/layout.js fitDrawer). The width
 * goes into --drawer-fit on #app; style.css uses it for the drawer and for --side. Returns the drawer width in use.
 */
function fitDrawerWidth(dpr) {
  el.app.style.removeProperty('--drawer-fit');
  const base = el.drawer.offsetWidth; // the normal width from style.css
  const fit = fitDrawer({ width: el.app.clientWidth, height: el.stage.clientHeight, base, wide: !!open.def.wide, dpr });
  if (!fit.narrowed) return base;
  el.app.style.setProperty('--drawer-fit', `${fit.drawer}px`);
  return el.drawer.offsetWidth;
}
/**
 * Where the floor goes while the drawer is open. The drawer would cover the right part of the scene: the dock and the truck,
 * the spot the owner looks at most. So the stage shrinks to the free area left of the drawer, and the scene fits itself into it
 * (it picks its own scale). The drawer first takes the width that gives the floor the largest scale (fitDrawerWidth). When that area is narrower than the scene at its smallest scale (480 px, or 240 px on a Retina screen), the stage keeps the
 * whole window and slides left by the free margin instead, so less of the scene hides under the drawer.
 */
function layoutStage() {
  let right = 0, shift = 0;
  if (!open) el.app.style.removeProperty('--drawer-fit');
  if (open) {
    const dpr = wholeDpr(window.devicePixelRatio);
    const side = fitDrawerWidth(dpr);
    // One device pixel per scene pixel is the smallest whole-pixel scale (scene.js): on a Retina screen a room of 240 px
    // still shows the whole floor, so the dock and the truck stay in view next to a wide drawer.
    if (el.app.clientWidth - side >= SCENE_W / dpr) right = side;
    else {
      el.stage.style.right = '';
      const free = Math.max(0, (el.app.clientWidth - el.canvas.getBoundingClientRect().width) / 2);
      shift = Math.round(Math.min(side / 2, free));
    }
  }
  const r = right ? `${right}px` : '';
  if (el.stage.style.right !== r) { el.stage.style.right = r; sceneCtl.resize(); }
  el.stage.style.transform = shift ? `translateX(${-shift}px)` : '';
}

// ------------------------------------------------------------------ panel framework

let open = null;       // { def, params, ctx, rendered, failed, opener }
let urlKeys = new Set();

function makeCtx(def, params) {
  const subs = [];
  const ctx = {
    h, ui, api, store, sel, prefs,
    params,
    changes: new Set(),
    get job() { return sel.activeJob(store); },
    openPanel, closePanel,
    setParams(patch) { openPanel(def.id, { ...ctx.params, ...patch }); },
    setTitle(text) { if (open && open.def === def) el.drawerTitle.textContent = showMarks(text); },
    /** 'fill': the panel fills the sheet and scrolls its own regions. 'flow': the sheet scrolls. */
    setLayout(mode) { if (open && open.def === def) el.drawerBody.classList.toggle('fill', mode === 'fill'); },
    toast(text, level = 'info', opts = {}) { return toasts.show({ ...opts, level, text }); },
    confirm: modals.confirm, prompt: modals.prompt, modal: modals.open,
    labs, sound, native,
    scene: { get kind() { return sceneCtl.kind; }, setOptions: (o) => sceneCtl.setOptions(o) },
    on(type, fn) { const off = store.on(type, fn); subs.push(off); return off; },
    avatar(agent, scale = 2) { return sceneCtl.avatar(agent, scale); },
  };
  return { ctx, subs };
}

function sameParams(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => String(a[k]) === String(b[k]));
}
function cleanParams(p) {
  const out = {};
  for (const [k, v] of Object.entries(p || {})) if (v != null && v !== '' && !RESERVED.has(k)) out[k] = v;
  return out;
}

function renderOpen() {
  if (!open) return;
  clear(el.drawerBody);
  if (!store.ready) { el.drawerBody.append(ui.emptyState(store.conn === 'locked' ? 'Locked' : 'Connecting', store.conn === 'locked' ? 'Open WorkShop from the app (the link holds your key).' : 'Waiting for the hub to answer.')); return; }
  try {
    open.def.render(el.drawerBody, open.ctx);
    open.rendered = true;
  } catch (e) {
    console.error(`Panel "${open.def.id}" failed to render.`, e);
    open.failed = true;
    mount(el.drawerBody, h('div.callout.bad', h('div.callout-title', 'This panel hit an error'), h('p', String((e && e.message) || e))));
  }
}

/** Build the open panel again from scratch (same params). Used when something every panel may show has changed, e.g. the scene module that draws avatars arrived. */
function rerenderOpen() {
  if (!open || !open.rendered) return;
  const top = el.drawerBody.scrollTop;
  try { if (open.def.dispose) open.def.dispose(); } catch (e) { console.error(`Panel "${open.def.id}" failed to dispose.`, e); }
  for (const off of open.subs.splice(0)) off();
  open.rendered = false; open.failed = false;
  renderOpen();
  el.drawerBody.scrollTop = top;
}

function teardown() {
  if (!open) return;
  try { if (open.def.dispose) open.def.dispose(); } catch (e) { console.error(`Panel "${open.def.id}" failed to dispose.`, e); }
  for (const off of open.subs) off();
  clear(el.drawerBody);
  open = null;
}

/** Open a panel in the drawer. params become ctx.params and URL parameters (deep link). Returns false for an unknown id. */
function openPanel(id, params = {}, { focus = true } = {}) {
  const def = panelById.get(id);
  if (!def) return false;
  const next = cleanParams(params);
  if (open && open.def === def && sameParams(open.params, next)) return true;
  const opener = open ? open.opener : document.activeElement;
  const same = !!open && open.def === def; // only the params change: keep the scroll position
  const top = same ? el.drawerBody.scrollTop : 0;
  teardown();
  closeMenu();
  const { ctx, subs } = makeCtx(def, next);
  open = { def, params: next, ctx, subs, rendered: false, failed: false, opener };
  el.drawer.hidden = false;
  el.drawer.classList.toggle('wide', !!def.wide);
  el.app.classList.add('drawer-open');
  el.app.classList.toggle('drawer-wide', !!def.wide);       // style.css: the notes and the lock card keep to the floor that the drawer leaves free
  el.app.classList.toggle('inbox-open', def.id === 'inbox'); // the notes about what waits hide while the Inbox itself is open
  el.app.dataset.panel = def.id; // style.css: a sticky note about the open panel hides
  el.drawerTitle.textContent = def.title;
  el.drawerBody.className = 'drawer-body paper' + (def.layout === 'fill' ? ' fill' : '');
  renderOpen();
  el.drawerBody.scrollTop = top;
  syncUrl(); updateNav(); renderWelcome(); layoutStage();
  toasts.layout(); // the drawer changed the room of the notes
  if (focus && !el.drawer.contains(document.activeElement)) el.drawerTitle.focus({ preventScroll: true });
  return true;
}

function closePanel() {
  if (!open) return;
  const { opener, def } = open;
  teardown();
  el.drawer.hidden = true;
  el.app.classList.remove('drawer-open', 'drawer-wide', 'inbox-open');
  delete el.app.dataset.panel;
  syncUrl(); updateNav(); renderWelcome(); layoutStage();
  toasts.layout();
  const own = navBtns.get(def.id).find((b) => b.button.getClientRects().length > 0);
  const back = opener && opener.isConnected && opener !== document.body && opener.getClientRects().length > 0 ? opener : own ? own.button : more.button;
  if (back && typeof back.focus === 'function') back.focus({ preventScroll: true });
}

function togglePanel(id) { if (open && open.def.id === id) closePanel(); else openPanel(id); }

function syncUrl() {
  const u = new URL(location.href);
  u.searchParams.delete('panel');
  for (const k of urlKeys) u.searchParams.delete(k);
  urlKeys = new Set();
  if (open) {
    u.searchParams.set('panel', open.def.id);
    for (const [k, v] of Object.entries(open.params)) { u.searchParams.set(k, String(v)); urlKeys.add(k); }
  }
  try { history.replaceState(null, '', u); } catch { /* not allowed in this host: the link is a nicety */ }
}

function readDeepLink() {
  const params = {};
  for (const [k, v] of query) if (!RESERVED.has(k)) params[k] = v;
  let id = query.get('panel');
  if (!id && params.agent) id = 'crew';
  if (!id && params.file) id = 'truck';
  urlKeys = new Set(Object.keys(params));
  return id && panelById.has(id) ? { id, params } : null;
}

// ------------------------------------------------------------------ top bar: panel buttons

// When the bar is short of room, panels that are rarely needed in the middle of a job fold into one "More" button:
// first the three configuration panels, then the tool wall (see fitTopbar and the #topbar.sq-N rules in style.css).
const FOLDS = [{ ids: new Set(['models', 'keys', 'settings']), from: 4 }, { ids: new Set(['toolkit']), from: 6 }];
const foldOf = (id) => FOLDS.find((f) => f.ids.has(id)) || null;
const navBtns = new Map(); // panel id -> [{ button, badge }]: the button in the bar, and for a panel that can fold its twin in the More menu
const more = { button: null, badge: null, menu: null, open: false };
let squeeze = 0;           // how many squeeze steps the top bar has taken (0 = everything in full)
let barDirty = true;       // something in the top bar changed its width: fit the bar again (fitTopbar)
const isFolded = (id) => { const f = foldOf(id); return !!f && squeeze >= f.from; };

function buildNav() {
  more.menu = h('div.tb-menu#tb-menu', { role: 'group', 'aria-label': 'More panels', hidden: true });
  PANELS.forEach((def, i) => {
    const key = i < 9 ? String(i + 1) : i === 9 ? '0' : '';
    const fold = foldOf(def.id);
    const text = def.label || def.title;
    const make = (inMenu) => {
      const badge = h('span.badge', { hidden: true });
      const label = !inMenu && def.short && def.short !== text ? [h('span.lbl-full', text), h('span.lbl-short', def.short)] : text;
      const button = h('button', { class: ['tb-btn', def.primary && 'primary', fold && `fold-${fold.from}`], type: 'button', 'aria-pressed': 'false',
        title: `${def.title}${key ? ` (key ${key})` : ''}`, onclick: () => { closeMenu(); togglePanel(def.id); } }, label, badge);
      return { button, badge };
    };
    const main = make(false);
    el.nav.append(main.button);
    const all = [main];
    if (fold) { const twin = make(true); more.menu.append(twin.button); all.push(twin); }
    navBtns.set(def.id, all);
  });
  more.badge = h('span.badge', { hidden: true });
  more.button = h('button.tb-btn.tb-more', { type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': 'tb-menu', title: 'More panels',
    onclick: () => (more.open ? closeMenu(true) : openMenu()) }, 'More', more.badge);
  el.nav.append(more.button);
  el.topbar.append(more.menu);
}

function openMenu() {
  more.open = true;
  more.menu.hidden = false;
  more.button.setAttribute('aria-expanded', 'true');
  const first = focusables(more.menu)[0];
  if (first) first.focus({ preventScroll: true });
}
/** Returns true when the menu was open. */
function closeMenu(focusBack = false) {
  if (!more.open) return false;
  more.open = false;
  more.menu.hidden = true;
  more.button.setAttribute('aria-expanded', 'false');
  if (focusBack) more.button.focus({ preventScroll: true });
  return true;
}
document.addEventListener('pointerdown', (e) => { if (more.open && !more.menu.contains(e.target) && !more.button.contains(e.target)) closeMenu(); }, true);

function updateNav() {
  const lite = { store, sel, job: sel.activeJob(store) };
  const sticky = new Set(toasts.list().filter((t) => t.sticky && t.panel).map((t) => t.panel));
  let foldedCount = 0, foldedHot = false, foldedOpen = false;
  for (const def of PANELS) {
    let n = 0, hot = false;
    if (store.ready) {
      try { n = def.badge ? def.badge(lite) : 0; hot = !!(def.attention && def.attention(lite)); } catch (e) { console.error(`Panel "${def.id}" badge failed.`, e); }
    }
    hot = hot || sticky.has(def.id);
    const text = !n ? '' : typeof n === 'number' ? (n > 99 ? '99+' : String(n)) : String(n);
    const isOpen = !!open && open.def === def;
    for (const { button, badge } of navBtns.get(def.id)) {
      if (badge.textContent !== text) { badge.textContent = text; barDirty = true; }
      badge.hidden = !text;
      badge.classList.toggle('hot', hot);
      button.classList.toggle('is-open', isOpen);
      button.classList.toggle('pulse', hot);
      button.setAttribute('aria-pressed', String(isOpen));
    }
    if (isFolded(def.id)) { if (typeof n === 'number') foldedCount += n; foldedHot = foldedHot || hot; foldedOpen = foldedOpen || isOpen; }
  }
  const text = foldedCount ? (foldedCount > 99 ? '99+' : String(foldedCount)) : '';
  if (more.badge.textContent !== text) { more.badge.textContent = text; barDirty = true; }
  more.badge.hidden = !text;
  more.badge.classList.toggle('hot', foldedHot);
  more.button.classList.toggle('is-open', foldedOpen);
  more.button.classList.toggle('pulse', foldedHot);
}

// ------------------------------------------------------------------ top bar: job chip

// The job chip keeps its buttons in the DOM and only changes their text, so a click never lands on a button that is being replaced.
// J1 · title · STATUS · merged/total tasks · cost. A paused job shows why; a queued job shows what it waits for; a held job shows the lab.
// When room is short the chip gives way in this order: the title shrinks, the cost and the word "tasks" go, the status takes its
// short form (the reason stays in the tooltip), the title goes. The count is never cut.
const FAIR_TITLE = 112; // px: about 14 letters of the job title. With that much of it, and the cost, the chip reads well.
const jobChip = (() => {
  const idEl = h('span.jc-id'), titleEl = h('span.jc-title'), countEl = h('span'), wordEl = h('span.jc-word', ' tasks'), tasksEl = h('span.jc-tasks', countEl, wordEl), costEl = h('span.jc-cost');
  let statusEl = h('span');
  let jobId = null;
  const main = h('button.jc-main', { type: 'button', hidden: true, onclick: () => openPanel('blueprint') }, idEl, titleEl, statusEl, tasksEl, costEl);
  const pause = h('button.jc-btn', { type: 'button', hidden: true, title: 'Pause the job. Turns that run now finish first. "Pause now" in the Blueprint also stops them.',
    onclick: (e) => { if (jobId) ui.busy(e.currentTarget, () => api.post(`/api/jobs/${encodeURIComponent(jobId)}/pause`)); } }, 'Pause');
  const resume = h('button.jc-btn', { type: 'button', hidden: true, title: 'Resume the job', onclick: (e) => resumeJob(e.currentTarget) }, 'Resume');
  const empty = h('span.jc-empty');
  el.jobchip.append(main, pause, resume, empty);
  const shown = {};
  const text = (node, key, value) => { if (shown[key] !== value) { shown[key] = value; node.textContent = showMarks(value); barDirty = true; } };
  const show = (node, key, visible) => { if (shown[key] !== visible) { shown[key] = visible; node.hidden = !visible; barDirty = true; } };

  async function resumeJob(button) {
    const job = jobId ? store.get('jobs', jobId) : null;
    if (!job) return;
    const body = {};
    if (job.pauseReason === 'budget') { // the hub needs a budget above what is already billed
      const billed = Number(job.cost && job.cost.billedUsd) || 0;
      const v = await modals.prompt({ title: `Raise the budget of ${job.id}`, label: `New budget in USD (above ${fmt.money(billed)})`, value: String(Math.ceil(billed + 10)), okLabel: 'Resume' });
      if (v === null) return;
      const n = Number(String(v).replace(/^\$/, ''));
      if (!(n > billed)) { toasts.show({ level: 'error', text: `The budget must be above ${fmt.money(billed)}.` }); return; }
      body.budgetUsd = n;
    }
    ui.busy(button, () => api.post(`/api/jobs/${encodeURIComponent(job.id)}/resume`, body));
  }

  /** A status chip with a long and a short form: { node, words }. words is the long form for the tooltip. */
  function statusChip(job) {
    const two = (long, short, tone, title) => ({ words: title || long, node: h('span', { class: ['chip', 't-' + tone], title: title || null }, h('span.jc-long', long), h('span.jc-short', short)) });
    if (job.status === 'paused') {
      const hub = job.pauseReason && job.pauseReason !== 'owner';
      return two(hub ? `paused: ${job.pauseReason}` : 'paused', 'paused', hub ? 'red' : 'steel', `Paused: ${sel.pauseWords(job)}.${job.error ? ' ' + sentence(job.error) : ''}`);
    }
    if (job.status === 'queued') {
      const w = sel.waitsFor(store, job);
      // The hub says why a job waits on a free floor (job.waitReason), for example "No usable lab for a boss."
      return two(w ? `waits for ${w.id}` : 'queued', 'queued', job.waitReason && !w ? 'brick' : 'plain', w ? `Queued: it starts when ${w.id} is done or cancelled.` : job.waitReason ? `Queued: ${sentence(job.waitReason)}` : 'Queued: it starts when the floor is free.');
    }
    const hold = job.hold;
    if (hold && (hold.lab || hold.reason)) {
      const until = hold.until ? fmt.time(hold.until) : '';
      return two(`hold: ${hold.lab || 'lab'}${until ? ' until ' + until : ''}`, until ? `hold ${until}` : 'hold', 'brick', `On hold${hold.lab ? ` for the lab ${hold.lab}` : ''}${until ? ` until about ${until}` : ''}. ${sentence(hold.reason || 'No lab is usable right now.')}`);
    }
    const chip = ui.statusChip('job', job.status);
    return { node: chip, words: String(job.status).replace(/_/g, ' ') };
  }

  /** Take the widest form that fits the room the bar has left for the chip. */
  function fit() {
    main.classList.remove('fit-1', 'fit-2', 'fit-3');
    if (main.hidden) return;
    const over = () => main.scrollWidth > main.clientWidth;
    // The cost and the word "tasks" go before the title is squeezed to a stub (less than about 12 letters of it).
    if (over() || titleEl.clientWidth < Math.min(titleEl.scrollWidth, 96)) main.classList.add('fit-1');
    for (const c of ['fit-2', 'fit-3']) { if (!over()) break; main.classList.add(c); }
  }

  function render() {
    const job = store.ready ? sel.activeJob(store) : null;
    jobId = job ? job.id : null;
    show(main, 'main', !!job);
    show(empty, 'none', !job);
    show(pause, 'pause', sel.isLive(job));
    show(resume, 'resume', !!job && job.status === 'paused');
    text(empty, 'empty', store.ready ? 'No job yet' : ''); // while the hub does not answer, the badge beside the wordmark says why
    if (!job) return;
    const c = sel.taskCounts(store, job.id);
    const cost = sel.cost(job, fmt.money);
    text(idEl, 'id', String(job.id));
    text(titleEl, 'title', String(job.title || ''));
    const sig = [job.status, job.pauseReason, job.error, job.hold && job.hold.lab, job.hold && job.hold.until, job.hold && job.hold.reason, job.status === 'queued' && (sel.waitsFor(store, job) || {}).id, job.waitReason].join('|');
    if (shown.status !== sig) { shown.status = sig; const next = statusChip(job); statusEl.replaceWith(next.node); statusEl = next.node; shown.words = next.words; barDirty = true; }
    show(tasksEl, 'tasks', c.total > 0);
    text(countEl, 'count', `${c.merged}/${c.total}`);
    text(costEl, 'cost', cost.text);
    if (shown.costTitle !== cost.title) { shown.costTitle = cost.title; costEl.title = cost.title; }
    const tip = `${job.id}: ${job.title}. ${String(shown.words).replace(/[.\s]+$/, '')}.${c.total ? ` ${c.merged} of ${c.total} tasks merged.` : ''} Open the Blueprint.`;
    if (shown.tip !== tip) { shown.tip = tip; main.title = showMarks(tip); }
  }

  const buttons = () => (pause.hidden ? 0 : pause.offsetWidth + 6) + (resume.hidden ? 0 : resume.offsetWidth + 6);
  return {
    render, fit,
    /** The least room the chip needs, in px: its buttons, and enough of the main part to read the job (id, some title, status, count). */
    room() { return (main.hidden ? 150 : 236) + buttons(); },
    /** The room the chip takes when nothing is cut: the whole title, the count and the cost. */
    full() {
      if (main.hidden) return 150;
      let w = 16 + 4; // padding and border of the chip
      const kids = [...main.children].filter((c) => !c.hidden);
      for (const c of kids) w += c === titleEl ? c.scrollWidth : c.offsetWidth;
      return w + 8 * Math.max(0, kids.length - 1) + buttons();
    },
    /** The room in which the chip reads well: all of it, with a long title cut to about 14 letters. */
    fair() { return main.hidden ? 150 : this.full() - Math.max(0, titleEl.scrollWidth - FAIR_TITLE); },
  };
})();

// ------------------------------------------------------------------ top bar: presence and lab chips

// HERE / AWAY (contract section 12b). Away: the hub takes the default answer of every boss question at once.
const renderPresence = (() => {
  const key = (state, label) => h('button.pr-key', { type: 'button', 'aria-pressed': 'false', onclick: (e) => set(state, e.currentTarget) }, label);
  const here = key('here', 'Here'), away = key('away', 'Away');
  el.presence.append(here, away);
  let shown = null;

  async function set(state, button) {
    if (!store.ready || (store.settings.presence === 'away' ? 'away' : 'here') === state) return;
    await ui.busy(button, async () => {
      const res = await api.put('/api/presence', { state });
      if (!res) return;
      store.set('settings', { ...store.settings, presence: state });
      toasts.show({ level: 'info', key: 'presence', text: state === 'away' ? 'You are away. The hub takes the default answer of every boss question at once. You can overturn it later in the Inbox.' : 'You are here. Boss questions wait for you.' });
    });
  }

  return () => {
    const state = store.ready ? (store.settings.presence === 'away' ? 'away' : 'here') : null;
    const wait = Number(store.settings && store.settings.humanWaitMin) || 30;
    const sig = `${state}|${wait}`;
    if (sig === shown) return;
    shown = sig;
    barDirty = true;
    el.presence.hidden = !state;
    el.app.classList.toggle('is-away', state === 'away');
    here.setAttribute('aria-pressed', String(state === 'here'));
    away.setAttribute('aria-pressed', String(state === 'away'));
    here.title = state === 'here' ? `You are here. A boss question waits ${wait} minutes for you. Then the hub takes its default answer.` : 'Say that you are here: boss questions wait for you again.';
    away.title = state === 'away' ? 'You are away. The hub takes the default answer of every boss question at once. You can overturn it in the Inbox.' : 'Say that you are away: the hub then takes the default answer of every boss question at once.';
  };
})();

// One usage chip per lab (contract section 13b): the plan-limit status and its reset time, amber while the lab cools down,
// and "setup" while the lab is not usable. A click opens the lab in the Keys panel.
function labChipModel(p, now) {
  const label = String(p.label || p.id);
  const step = sel.labStep(p, store.settings, now);
  const base = { id: String(p.id), name: String(p.id), reset: null };
  if (!p.usable && step !== 'cooling') return { ...base, tone: 'bad', value: 'setup', title: `${label} is not ready: ${sentence(p.reason || 'it needs setup')} Press to set it up.` };
  if (p.id === 'oss') {
    const modeWord = p.mode === 'standin' ? 'Phase 0 Stand-in simulation ($0)' : 'Local/cluster OSS runtime ($0)';
    return { ...base, tone: 'ok', value: p.mode === 'standin' ? 'sim' : 'local', title: `${label}: ${modeWord}. Press to configure.` };
  }
  const cooling = sel.labCooling(p, now);
  if (cooling) return { ...base, tone: 'cool', value: `cool ${fmt.time(cooling.until)}`, title: `${label} cools down until ${fmt.time(cooling.until)} (${fmt.until(cooling.until)}). ${sentence(cooling.reason || 'Its plan limit is reached.')} Its work waits, or goes to the other lab.` };
  const limit = p.limit && typeof p.limit === 'object' ? p.limit : null;
  const cooled = p.cooledModels && typeof p.cooledModels === 'object' ? Object.entries(p.cooledModels).filter(([, c]) => c && c.until > now) : [];
  const pct = limit && typeof limit.utilization === 'number' && Number.isFinite(limit.utilization) ? Math.round(Math.max(0, Math.min(1, limit.utilization)) * 100) : null;
  const status = limit && limit.status ? String(limit.status).replace(/_/g, ' ') : null;
  const near = (status && status !== 'allowed') || (pct !== null && pct >= 80) || cooled.length > 0;
  const resets = limit && Number(limit.resetAt) > now ? limit.resetAt : null;
  const facts = [];
  if (limit) facts.push(`plan limit ${status || 'unknown'}${limit.type ? ` (${String(limit.type).replace(/_/g, ' ')} window)` : ''}${pct !== null ? `, ${pct}% used` : ''}${resets ? `, resets at ${fmt.time(resets)} (${fmt.until(resets)})` : ''}`);
  else facts.push('ready. It has sent no plan-limit data yet: that comes with its first turn');
  for (const [model, c] of cooled) facts.push(`the model ${model} cools down until ${fmt.time(c.until)}`);
  return { ...base, tone: near ? 'cool' : 'ok', value: pct !== null ? `${pct}%` : status && status !== 'allowed' ? fmt.clip(status, 12) : 'ok',
    reset: resets ? `resets ${fmt.time(resets)}` : null, title: `${label}: ${facts.join('. ')}.` };
}
const renderLabChips = (() => {
  let sig = null;
  return () => {
    const now = Date.now();
    const list = store.ready ? sel.labs(store).map((p) => labChipModel(p, now)) : [];
    const next = JSON.stringify(list);
    if (next === sig) return;
    sig = next;
    barDirty = true;
    el.labchips.hidden = !list.length;
    mount(el.labchips, list.map((m) => h('button', { class: ['lab-chip', 'lt-' + m.tone], type: 'button', title: m.title, 'aria-label': m.title, onclick: () => openPanel('keys', { lab: m.id }) },
      h('span.lc-sw', { style: /^[a-z0-9]{1,20}$/.test(m.id) ? { '--sw': `var(--lab-${m.id})` } : null }), h('span.lc-name', m.name), h('span.lc-val', m.value), m.reset ? h('span.lc-reset', m.reset) : null)));
  };
})();

// The bar gives the job chip what the other parts leave. When that is too little, the bar takes one squeeze step after the
// other (#topbar.sq-1 ... sq-6 in style.css). What a step costs decides how long the bar goes on taking it:
//   steps 1 and 2  cost almost nothing (no reset time on the lab chips, short labels): taken until the whole job chip shows
//   steps 3 to 5   hide what stays in reach (the word beside the cog, three panels behind "More", the names on the lab chips):
//                  taken until the chip reads well, that is about 14 letters of the title and the cost (jobChip.fair)
//   step 6         the tool wall folds too and the keys get small: only while the chip cannot even show its least (jobChip.room)
// The job is what the owner looks for in the bar. So the word WORKSHOP and three setup panels give way before the title
// drops to a stub and the cost goes, and a bar with less room does not end up telling more about the job.
const SQUEEZE = ['sq-1', 'sq-2', 'sq-3', 'sq-4', 'sq-5', 'sq-6'];
const FULL_STEPS = 2, FAIR_STEPS = 5;
function fitTopbar() {
  // A second pass runs when the first one changed what the More button shows (its count takes room too).
  for (let pass = 0; pass < 2 && barDirty; pass++) {
    barDirty = false;
    const before = squeeze;
    el.topbar.classList.remove(...SQUEEZE);
    el.jobchip.firstChild.classList.remove('fit-1', 'fit-2', 'fit-3');
    squeeze = 0;
    const least = jobChip.room(), full = Math.min(560, jobChip.full()), fair = Math.min(full, jobChip.fair());
    while (squeeze < SQUEEZE.length && el.jobchip.clientWidth < (squeeze < FULL_STEPS ? full : squeeze < FAIR_STEPS ? fair : least)) el.topbar.classList.add(SQUEEZE[squeeze++]);
    if (squeeze !== before) { if (!FOLDS.some((f) => squeeze >= f.from)) closeMenu(); updateNav(); }
  }
  barDirty = false;
  jobChip.fit();
}

const lockCard = h('div.lock', { hidden: true, role: 'alert' },
  h('p.hint-title', 'Locked'),
  h('p', 'Open WorkShop from the app (the link holds your key).'),
  h('p.dim', 'This window has no owner session, so the hub answers nothing. Close it and open WorkShop again from the app.'));
el.app.append(lockCard);

function renderConn() {
  const locked = store.conn === 'locked';
  const off = store.conn !== 'online';
  // "Reconnecting" only after the hub answered once in this window. Before that the window is still connecting.
  const word = locked ? 'Locked' : store.ready ? 'Reconnecting' : 'Connecting';
  if (el.conn.hidden === off || el.conn.textContent !== word) barDirty = true;
  el.conn.hidden = !off;
  el.conn.textContent = word;
  el.app.classList.toggle('is-offline', (store.conn === 'offline' && store.ready) || locked);
  lockCard.hidden = !locked;
}

// ------------------------------------------------------------------ first-run strip and hint

// One row per lab that the owner must set up, with the reason from the hub and the button for the next setup step.
// The strip is the first-run guide: it shows in full only while no job is on the floor and no panel is open, under the hint card.
// With a job on the floor the lab chips in the top bar say the same, and the floor stays free. A lab that only cools down is never listed here.
const STEP_BUTTONS = {
  install: (p) => [ui.btn('Install', { small: true, tone: 'primary', title: 'Show how to install it', onClick: () => labs.install(p) })],
  mode: (p) => [
    ui.btn('Use an API key', { small: true, tone: 'primary', onClick: (e) => labs.chooseMode(p, 'apikey', e.currentTarget) }),
  ],
  key: (p) => [ui.btn('Add the key', { small: true, tone: 'primary', onClick: () => openPanel('keys', { lab: p.id }) })],
  oss: (p) => [ui.btn('Configure OSS', { small: true, tone: 'primary', onClick: () => openPanel('keys', { lab: p.id }) })],
  // Consumer subscriptions are disabled in Phase 0; keep a safe fallback button pointing to Keys.
  signin: (p) => [ui.btn('Switch to API key', { small: true, tone: 'primary', onClick: (e) => labs.chooseMode(p, 'apikey', e.currentTarget) })],
  // The hub cannot test a program whose version it does not know: its reason then says "Re-check" (the check finds the version).
  test: (p) => (p.version ? [ui.btn('Test', { small: true, tone: 'primary', title: 'Run the self-test: one tiny real turn', onClick: (e) => labs.test(p, e.currentTarget) })]
    : [ui.btn('Re-check', { small: true, tone: 'primary', title: 'The hub checks this lab again: the program, its version and its sign-in', onClick: (e) => labs.recheckLab(p, e.currentTarget) }),
      ui.btn('Test', { small: true, title: 'Run the self-test: one tiny real turn', onClick: (e) => labs.test(p, e.currentTarget) })]),
  other: (p) => [ui.btn('Open Keys', { small: true, onClick: () => openPanel('keys', { lab: p.id }) })],
};
let stripSig = null;
function renderStrip() {
  const all = sel.labs(store);
  const bad = sel.labsToSetUp(store);
  // The strip guides the first run only: it shows while no job exists. Once a job ran (the demo too), the lab chips in the top bar
  // carry the lab state, so the strip never comes back over the floor (for example over the confetti of a finished job).
  // Hide keeps it away until a lab that was ready needs setup again (the list of labs to set up changes).
  const hiddenFor = String(prefs.get('stripHidden', '') || '');
  const hidden = hiddenFor !== '' && bad.every((p) => hiddenFor.split(',').some((x) => x === p.id || x.startsWith(p.id + ':')));
  const show = store.ready && bad.length > 0 && !open && sel.jobs(store).length === 0 && !hidden;
  const sig = show ? JSON.stringify([all.length, bad.map((p) => [p.id, p.label, p.reason, labs.step(p), p.version, labs.signinOpen(p)])]) : '';
  if (sig === stripSig) return;
  stripSig = sig;
  el.strip.hidden = !show;
  if (!show) { clear(el.strip); return; }
  const ready = all.filter((p) => p.usable).length;
  mount(el.strip,
    h('div.strip-head',
      h('span.strip-tag', 'Runtime setup'),
      h('span.strip-note', ready ? `${ready} of ${all.length} runtimes ready` : 'No runtime ready yet. Enable OSS Stand-in or add a Frontier API key.'),
      h('span.strip-acts',
        ui.btn('Re-check', { small: true, title: 'Look again for the lab programs and their sign-in', onClick: (e) => labs.recheck(e.currentTarget) }),
        ui.btn('Hide', { small: true, title: 'Hide this. The lab chips in the top bar stay.', onClick: () => { prefs.set('stripHidden', bad.map((p) => p.id).join(','), 300); renderStrip(); } }))),
    bad.map((p) => {
      const step = labs.step(p);
      const name = String(p.label || p.id);
      let why = String(p.reason || 'Not ready.');
      if (why.startsWith(name + ' ')) why = why.slice(name.length + 1); // "Claude Code is not signed in." after the name: say the name once
      if (step === 'signin' && labs.signinOpen(p)) why = labs.openNote(p); // what to do now, in place of "not checked yet"
      return h('div', { class: ['lab', step === 'test' ? 'warn' : 'bad'] },
        h('span.lab-dot'), h('span.lab-name', name),
        h('span.lab-why', why),
        h('span.lab-acts', (STEP_BUTTONS[step] || STEP_BUTTONS.other)(p)));
    }));
}

let hintBuilt = false;
function renderHint() {
  const show = store.ready && !open && sel.jobs(store).length === 0;
  el.hint.hidden = !show;
  if (!show || hintBuilt) return;
  hintBuilt = true;
  mount(el.hint,
    h('p.hint-title', 'The shop is quiet'),
    h('p', 'Write a work order and the crew starts. Or run the demo first: it needs no tokens.'),
    h('div.row.center',
      ui.btn('+ Work order', { tone: 'go', onClick: () => openPanel('workorder') }),
      ui.btn('Run demo', { onClick: (e) => ui.busy(e.currentTarget, async () => { const job = await api.post('/api/demo'); if (job) openPanel('blueprint'); }) })));
}
function renderWelcome() { renderHint(); renderStrip(); }

// ------------------------------------------------------------------ ticker, notices, effects

// The newest board posts and notices, one line each, newest on the left.
const ticker = (() => {
  const track = h('div.ticker-track');
  const empty = h('span.ticker-empty', 'The board is quiet.');
  mount(el.ticker, h('button.ticker-label', { type: 'button', title: 'Open the board', onclick: () => openPanel('board') }, 'Board'), track);
  track.append(empty);
  function push(tag, who, text, fresh, cls) {
    empty.remove();
    track.prepend(h('span', { class: ['tick', fresh && 'new', cls] }, tag, who ? h('span.tick-who', who + ' ') : null, text));
    while (track.children.length > 14) track.lastChild.remove();
  }
  const NOTICE = { info: ['NOTE', 'k-EVT'], warn: ['WARN', 'k-ASK'], error: ['ERROR', 'k-FAIL'], owner: ['FOR YOU', 'k-ASK'] };
  return {
    board(m, fresh = true) {
      const from = sel.who(store, m.from, m.fromId), to = m.to ? sel.who(store, m.to, m.toId) : '';
      const head = `${from}${to ? '>' + to : ''}${m.scope ? ' ' + m.scope : ''}`;
      push(ui.kindTag(m.kind), head, oneLine(m.body) || (m.re != null ? `re #${m.re}` : ''), fresh, sel.isFromHub(m) ? 'hub' : sel.isToOwner(m) ? 'you' : null);
    },
    notice(level, text) { const [label, cls] = NOTICE[level] || NOTICE.info; push(h('span', { class: ['tag', cls] }, label), null, oneLine(text), true, level === 'owner' ? 'you' : null); },
    reset() { clear(track); track.append(empty); },
  };
})();

const fxSeen = new Map();
/** Play a scene effect and remember it, so an identical effect from the hub is not played twice. */
function playFx(name, payload, key = name) {
  if (fxSeen.size > 200) fxSeen.clear();
  fxSeen.set(key, performance.now());
  sceneCtl.fx(name, payload);
}

// A hub notice of level owner names its panel (evt.panel: blueprint | truck | inbox | keys). panel: null says that no panel
// helps (a job that ended). Only an older hub sends no field at all: then lib/notices.js guesses the button from the words.
const openAction = (panel, label, params = {}) => ({ label: label || `Open ${panelById.get(panel).label || panelById.get(panel).title}`.replace('+ ', ''), run: () => openPanel(panel, params) });

store.on('notice', (evt) => {
  const level = ['info', 'warn', 'error', 'owner'].includes(evt.level) ? evt.level : 'info';
  const text = oneLine(evt.text);
  if (!text) return;
  ticker.notice(level, text);
  const named = Object.hasOwn(evt, 'panel'); // the hub chose (a panel, or none)
  const panel = typeof evt.panel === 'string' && panelById.has(evt.panel) ? evt.panel : level === 'owner' && !(named && !evt.panel) ? guessPanel(text) : null;
  // A notice about a truck opens the truck of its job (every job has its own).
  const id = toasts.show({ level, text, panel, action: panel ? openAction(panel, panel === 'inbox' && isAsk(text) ? 'Answer' : null, panel === 'truck' && evt.jobId && store.get('jobs', evt.jobId) ? { job: evt.jobId } : {}) : null });
  if (level === 'owner') {
    // A sticky hub notice lives as long as the thing it is about waits (syncAttention). One that stands for nothing in the
    // inbox (a plan summary when the plan needs no approval) leaves after NOTICE_GRACE_MS: it stays in the ticker.
    const t = toasts.list().find((x) => x.id === id);
    if (t && !t.at) { t.at = Date.now(); t.jobId = evt.jobId || null; }
    setTimeout(syncAttention, NOTICE_GRACE_MS + 500);
    sound.play('owner');
    nativeNotify(text, evt.jobId);
  } else if (level === 'warn' || level === 'error') sound.play('warn');
});

/**
 * A macOS notification through the Mac app (nothing in a browser). The same words within 10 s go out once, and so does a
 * second note about the same job within 4 s (a hub notice and the inbox item it is about arrive together).
 */
const notified = new Map();
let notifiedAt = 0, notifiedJob = null;
function nativeNotify(text, jobId) {
  if (!native.available || !text) return;
  const now = Date.now();
  for (const [k, at] of notified) if (now - at > 10000) notified.delete(k);
  if (notified.has(text) || (jobId && notifiedJob === jobId && now - notifiedAt < 4000)) return;
  notified.set(text, now);
  notifiedAt = now; notifiedJob = jobId || null;
  const job = jobId ? store.get('jobs', jobId) : null;
  native.notify(job ? `WorkShop: ${job.id}` : 'WorkShop', text);
}

/** The sticky note for one thing that waits for the owner, or null when the top bar says enough. */
function noteFor(it) {
  const job = it.job;
  const n = job ? sel.loadedDeliveries(store, job.id).length : 0;
  switch (it.kind) {
    case 'question': { const who = sel.who(store, it.q.from, it.q.fromId) || 'A boss'; return { head: oneLine(it.q.text).slice(0, 40), text: `${who} asks: ${oneLine(it.q.text)}`, panel: 'inbox', action: openAction('inbox', 'Answer') }; }
    case 'plan': return { text: 'The plan is ready. Read the Blueprint and approve it to start the crew.', panel: 'blueprint', action: openAction('blueprint') };
    case 'budget': case 'paused': return job ? { text: `The hub paused ${job.id}: ${sel.pauseWords(job)}. ${job.error ? sentence(String(job.error).slice(0, 200)) + ' ' : ''}Resume or cancel it.`, panel: 'blueprint', action: openAction('blueprint') } : null;
    // Every job has its own truck: the button names the job, so the crates of a cancelled job open also while a newer job runs.
    case 'truck': return job ? { text: job.status === 'cancelled' ? `${job.id} is cancelled, but ${fmt.plural(n, 'reviewed crate is', 'reviewed crates are')} still on the truck. Ship or discard.`
      : `The truck is ready: ${fmt.plural(n, 'crate waits', 'crates wait')} for your approval.`, panel: 'truck', action: openAction('truck', null, { job: job.id }) } : null;
    case 'review': return { text: `A hand-in waits for your verdict${it.delivery ? `: ${it.delivery.taskId}` : ''}. Say PASS or FIX.`, panel: 'inbox', action: openAction('inbox') };
    case 'requirement': return { text: `${it.req ? it.req.id : 'A requirement'} ${it.req && it.req.status === 'failed' ? 'failed and no task serves it' : 'has no task'}. Waive it, add a task, or stop the job.`, panel: 'inbox', action: openAction('inbox') };
    case 'agentfiles': return { text: `${it.project ? it.project.name : 'The project'} holds agent-config files. Accept or refuse them.`, panel: 'inbox', action: openAction('inbox') };
    case 'requisition': return { text: oneLine(it.text || 'Phase 1 RFT training requisition queued.'), panel: 'crew', action: openAction('crew', 'Open Roster', { tab: 'rft' }) };
    case 'signin': return it.lab ? { text: `Work waits for ${it.lab.label || it.lab.id}: ${sentence(it.lab.reason || it.text)}`, panel: 'keys', action: openAction('keys') } : null;
    default: return it.text ? { text: oneLine(it.text), panel: 'inbox', action: openAction('inbox') } : null;
  }
}

// What waits for the owner is derived from state and from the inbox of the hub, so a reload (or a reconnect) shows it again
// and drops what no longer waits. A sticky note from a hub notice counts when it says the same thing.
// One or two things get a note each. More than two get one note that points to the Inbox, so the notes never fill the floor.
// A note the owner closed stays closed while its item waits (the Inbox button still pulses).
const closedNotes = new Set(); // item keys ('att:question:44') whose note the owner closed
const NOTICE_GRACE_MS = 20000; // a sticky hub notice that waits for nothing leaves after this long
let attentionSeen = null;      // keys of the loud items the Mac app was told about (null until the first state)
const KIND_WORDS = { question: ['a question', 'questions'], plan: ['the plan', 'plans'], budget: ['a job at its budget', 'jobs at their budget'], paused: ['a paused job', 'paused jobs'], truck: ['the truck', 'trucks'],
  review: ['a hand-in to judge', 'hand-ins to judge'], requirement: ['a requirement with no task', 'requirements with no task'], agentfiles: ['agent files to accept', 'sets of agent files to accept'], requisition: ['an RFT requisition', 'RFT requisitions'], signin: ['a runtime', 'runtimes'] };
function syncAttention() {
  const att = sel.ownerAttention(store);
  const want = new Map();
  const kinds = new Map();
  for (const it of att.loud) { const spec = noteFor(it); if (spec) { want.set('att:' + it.key, spec); kinds.set(it.kind, (kinds.get(it.kind) || 0) + 1); } }
  for (const key of [...closedNotes]) if (!want.has(key)) closedNotes.delete(key);
  const specs = [...want.entries()];
  const many = specs.length > 2;
  const covered = new Set();
  const first = (prefix, test) => (specs.find(([k, sp]) => k.startsWith('att:' + prefix + ':') && (!test || test(sp))) || [null])[0];
  // Which wanted item does a sticky hub notice stand for? Once it stood for one, it leaves when that item is gone.
  const standsFor = (t) => {
    if (t.stoodFor && want.has(t.stoodFor)) return t.stoodFor;
    if (t.panel === 'truck') { // the truck of the job that the notice names, when more than one truck waits
      const words = t.text.split(/[^A-Za-z0-9]+/);
      return (specs.find(([k]) => k.startsWith('att:truck:') && words.includes(k.slice(10))) || [null])[0] || first('truck');
    }
    if (t.panel === 'inbox' || t.panel === 'board') return first('question', (sp) => t.text.includes(sp.head)) || (/\basks?\b|question/i.test(t.text) ? first('question') : null) || (/verdict/i.test(t.text) ? first('review') : null)
      || (/requirement|no task\b|\bwaive/i.test(t.text) ? first('requirement') : null) || (/agent.?(config )?files/i.test(t.text) ? first('agentfiles') : null);
    if (t.panel === 'blueprint') return /plan/i.test(t.text) ? first('plan') : /paused/i.test(t.text) ? first('paused') || first('budget') : /requirement|no task\b|\bwaive/i.test(t.text) ? first('requirement') : null;
    return null;
  };
  const now = Date.now();
  toasts.dismissWhere((t) => {
    if (!t.sticky || (t.key && !t.key.startsWith('att:'))) return false; // only the notes about what waits for the owner are managed here
    if (t.key === 'att:many') return !many;
    if (!t.key && t.jobId) { const j = store.get('jobs', t.jobId); if (j && (j.deleted || !sel.isOpen(j)) && !(j.status === 'cancelled' && sel.loadedDeliveries(store, j.id).length)) return true; } // its job is over
    const k = t.key ? (want.has(t.key) ? t.key : null) : standsFor(t);
    if (k) {
      if (many || covered.has(k)) return true; // the one note for the Inbox, or another note, already says the same thing
      if (!t.key) { t.stoodFor = k; t.el.dataset.key = k; if (!t.onDismiss) t.onDismiss = () => closedNotes.add(k); }
      covered.add(k);
      return false;
    }
    if (t.key || t.stoodFor) return true; // what it stood for is done
    return !!t.at && now - t.at > NOTICE_GRACE_MS; // a hub notice that waits for nothing: the owner had time to read it
  });
  tellApp(att);
  if (many) {
    if (specs.every(([key]) => closedNotes.has(key))) return; // the owner closed the note and nothing new waits since
    const words = [...kinds.entries()].map(([kind, n]) => { const w = KIND_WORDS[kind] || ['an item', 'items']; return n === 1 ? w[0] : `${n} ${w[1]}`; });
    toasts.show({ level: 'owner', key: 'att:many', panel: 'inbox', action: openAction('inbox'), text: `${specs.length} things wait for you: ${words.join(', ')}.`,
      onDismiss: () => { for (const [key] of specs) closedNotes.add(key); } });
    return;
  }
  for (const [key, { text, panel, action }] of specs) {
    if (closedNotes.has(key)) continue;
    // A note that is up already keeps its place, but its words follow the item (a truck that was "ready" belongs to a job
    // that is now cancelled: "ship or discard"). show() with the same key changes the words in place.
    const up = covered.has(key) ? toasts.list().find((t) => t.key === key) : null;
    if (!covered.has(key) || (up && up.text !== String(text).trim())) toasts.show({ level: 'owner', key, text, panel, action, onDismiss: () => closedNotes.add(key) });
  }
}

/**
 * The Mac app (launcher contract): the Dock badge is the number of inbox items, quitState says whether a live job runs, and a
 * new item that waits for the owner raises a notification (a hub notice of level owner raises its own).
 */
function tellApp(att) {
  if (!native.available || !store.ready) return;
  native.badge(att.count);
  native.quitState(sel.jobs(store).some((j) => sel.isLive(j)));
  const keys = new Set(att.loud.map((it) => it.key));
  if (attentionSeen && Date.now() - notifiedAt > 4000) { // a hub notice a moment ago already rang for it
    for (const it of att.loud) {
      if (attentionSeen.has(it.key)) continue;
      const spec = noteFor(it);
      if (spec) nativeNotify(spec.text, it.jobId);
    }
  }
  attentionSeen = keys;
}

store.on('state', () => {
  ticker.reset();
  for (const m of store.board.slice(-8)) ticker.board(m, false);
  syncAttention();
});

store.on('board', (m) => {
  ticker.board(m);
  if (m.fromId) playFx('note', { from: m.fromId, kind: bubbleKind(m.kind), text: oneLine(m.body) }, `note|${m.fromId}|${oneLine(m.body)}`);
  if (m.re != null && (sel.isFromOwner(m) || sel.isFromHub(m))) syncAttention(); // an answered question, a verdict: it stops asking
});
store.on('boardchange', () => syncAttention());

store.on('upsert', (evt, prev) => {
  if (evt.kind === 'deliveries') { shipped.seen(prev, evt.item); if (!prev || prev.status !== evt.item.status) syncAttention(); return; }
  if (evt.kind !== 'jobs') return;
  const job = evt.item;
  if (!prev) { playFx('newOrder', { jobId: job.id, title: job.title }); return; }
  if (prev.status !== 'done' && job.status === 'done') { playFx('confetti', { jobId: job.id }); sound.play('done'); }
  if (prev.status !== job.status || prev.pauseReason !== job.pauseReason) syncAttention();
});

store.on('fx', (evt) => {
  const name = String(evt.name || '');
  const payload = evt.payload && typeof evt.payload === 'object' ? evt.payload : {};
  if (name === 'ship') { // play the truck states of section 13 through the view model, and sound the horn
    // The scene draws the truck of the job on the floor. A ship of another truck (the crates a cancelled job left behind) moves nothing there.
    const floor = sel.activeJob(store);
    const n = payload.jobId ? shipped.take(payload.jobId) : 0;
    if (!payload.jobId || !floor || payload.jobId === floor.id) {
      truck.ship(Number(payload.count) || n || 1);
      sceneCtl.fx('horn', payload);
    }
    sound.play('ship');
    toasts.dismissWhere((t) => t.sticky && t.panel === 'truck');
    return;
  }
  // The UI plays newOrder, confetti and note by itself. Drop the same effect from the hub when it lands right after.
  const key = name === 'note' ? `note|${payload.from}|${payload.text}` : name;
  if (performance.now() - (fxSeen.get(key) ?? -1e9) < 1500) return;
  playFx(name, payload, key);
});

toasts.onChange(() => store.touch('ui'));

// ------------------------------------------------------------------ redraw on change (one pass per animation frame)

const SCENE_SLICES = ['jobs', 'tasks', 'agents', 'deliveries', 'board', 'settings', 'providers', 'projects', 'inbox', 'harnesses', 'roster', 'requisitions', 'ui', 'state'];
let scanlines = null;

function renderTitle() {
  const job = store.ready ? sel.activeJob(store) : null;
  const waits = store.ready && (sel.ownerAttention(store).any || toasts.list().some((t) => t.sticky));
  const title = `${waits ? '(!) ' : ''}${job ? `${job.id} ${String(job.status).replace(/_/g, ' ')} · ` : ''}WorkShop`;
  if (document.title !== title) document.title = title;
}

function onChange(changes) {
  renderConn();
  jobChip.render();
  renderPresence();
  renderLabChips();
  renderTitle();
  updateNav();
  fitTopbar();
  if (changes.has('providers') || changes.has('settings') || changes.has('jobs') || changes.has('state')) renderStrip();
  if (changes.has('jobs') || changes.has('state')) renderHint();
  if (changes.has('inbox') || changes.has('providers') || changes.has('projects') || changes.has('requisitions')) syncAttention();
  if (open && !open.failed) {
    if (!open.rendered) { if (store.ready || changes.has('conn')) renderOpen(); } // not ready yet: the sheet says "connecting" or "locked"
    else if (open.def.update) {
      open.ctx.changes = changes;
      try { open.def.update(open.ctx); } catch (e) { open.failed = true; console.error(`Panel "${open.def.id}" failed to update.`, e); }
    }
  }
  if (store.ready && SCENE_SLICES.some((s) => changes.has(s))) {
    const want = !!(store.settings && store.settings.ui && store.settings.ui.scanlines);
    if (want !== scanlines) { scanlines = want; sceneCtl.setOptions({ scanlines: want }); }
    syncScene();
  }
}

// ------------------------------------------------------------------ keyboard and window

const isTyping = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

document.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'Escape') {
    if (modals.closeTop()) { e.preventDefault(); return; }
    if (closeMenu(true)) { e.preventDefault(); return; }
    if (open) { e.preventDefault(); closePanel(); }
    return;
  }
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || modals.count() || isTyping(e.target)) return;
  // the number keys open the panels in the order of the top bar: 1 to 9, then 0 for the tenth
  const n = e.key.length === 1 && e.key >= '1' && e.key <= '9' ? Number(e.key) : e.key === '0' ? 10 : 0;
  if (n && PANELS[n - 1]) { e.preventDefault(); togglePanel(PANELS[n - 1].id); }
});

el.drawerClose.addEventListener('click', closePanel);

let resizeFrame = 0;
window.addEventListener('resize', () => {
  if (resizeFrame) return;
  resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; barDirty = true; fitTopbar(); sceneCtl.resize(); layoutStage(); });
});
document.addEventListener('visibilitychange', () => {
  sceneCtl.setOptions({ paused: document.hidden });
  if (document.hidden) prefs.flush(); // what stayed in this window (a draft, the unread mark) goes to the hub: the app may quit next
});
window.addEventListener('pagehide', () => prefs.flush());
// Times on screen (a lab that cools down "until 10:34", a hold) move on without an event from the hub.
setInterval(() => { if (!document.hidden && store.ready) store.touch('ui'); }, 30000);

// A safety net: a bug in one handler must not leave the owner without a word.
window.addEventListener('unhandledrejection', (e) => toasts.show({ level: 'error', text: `Something went wrong: ${oneLine((e.reason && e.reason.message) || e.reason).slice(0, 160)}` }));

// ------------------------------------------------------------------ boot

buildNav();
renderConn();
jobChip.render();
renderPresence();
store.subscribe(onChange);
const link = readDeepLink();
if (link) openPanel(link.id, link.params, { focus: false });
store.connect();
sceneCtl.load().then(() => { if (store.ready) syncScene(); rerenderOpen(); });

// Handy in the console while developing. Holds no secret.
window.__ws = { store, sel, api, openPanel, closePanel, toasts, modals, labs, sound, scene: sceneCtl };
