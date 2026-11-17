// WorkShop scene: public API and render loop.
//
//   import { createScene, avatarDataURL } from './scene.js'
//   const scene = createScene(canvasEl, { onEvent(evt) {}, clock: () => new Date() })
//   scene.sync(vm)  scene.fx(name, payload)  scene.resize()  scene.setOptions({ scanlines, paused })
//   fx names: 'newOrder', 'confetti', 'horn', 'ship', 'note' { from, kind, text }
//   onEvent({ type: 'hover' | 'click', target: { kind, id } }), kind: agent, truck, board, toolwall, counter, office, bench, none
//   scene.debug.advance(ms)  scene.debug.state()  scene.destroy()
//
// The view model is the truth: sync() is declarative, the world (actors.js) chases it, render.js draws it.

import { PALETTE } from './palette.js';
import * as M from './map.js';
import { createWorld } from './actors.js';
import { createWarner } from './model.js';
import { createRenderer, agentBox } from './render.js';
import { lookFor, buildCharacterFrames } from './sprites.js';

// A frame gap up to SNAP_AFTER_MS is simulated in full (the world sub-steps it), so a slow or throttled
// requestAnimationFrame never runs the shop in slow motion. A longer stall (hidden tab, sleep) is not replayed:
// the actors snap to their steady state and stale one-shot effects (bubbles, horn) are dropped.
const SNAP_AFTER_MS = 1500;

export function createScene(canvas, opts = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') throw new Error('createScene: a canvas element is required');
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const clock = typeof opts.clock === 'function' ? opts.clock : () => new Date();
  const warn = createWarner();
  const world = createWorld({ warn, seed: opts.seed });
  const renderer = createRenderer();
  const options = { scanlines: false, paused: false, scale: 0, autoCenter: true };
  const win = typeof window !== 'undefined' ? window : null;
  const doc = typeof document !== 'undefined' ? document : null;

  canvas.width = M.W;
  canvas.height = M.H;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = false;
  canvas.style.imageRendering = 'pixelated';
  canvas.style.display = 'block';

  let scale = 1;
  let hover = { kind: 'none', id: null };
  let raf = 0;
  let last = 0;
  let destroyed = false;
  let dirtySnap = false;
  let frameErrors = 0;
  let pausedAt = 0;
  let hiddenAt = 0;

  function now() { return win && win.performance ? win.performance.now() : Date.now(); }
  function safeDate() {
    try { const d = clock(); if (d instanceof Date && !Number.isNaN(d.getTime())) return d; } catch (e) { warn('clock', 'clock() failed, using the system time'); }
    return new Date();
  }

  function render() {
    try {
      renderer.draw(ctx, world, { date: safeDate(), hover, scanlines: options.scanlines });
    } catch (e) {
      if (frameErrors++ < 3 && typeof console !== 'undefined') console.error('[scene] render failed', e);
    }
  }

  function frame(t) {
    raf = 0;
    if (destroyed) return;
    let dt = t - last;
    last = t;
    if (!(dt >= 0)) dt = 0;
    try {
      // paused: the world stands still, whatever the frame gap; a pending snap waits until the pause ends
      if (!options.paused) {
        if (dirtySnap || dt > SNAP_AFTER_MS) { world.snap(); dirtySnap = false; dt = 16; }
        world.advance(Math.min(dt, SNAP_AFTER_MS));
      }
    } catch (e) {
      if (frameErrors++ < 3 && typeof console !== 'undefined') console.error('[scene] update failed', e);
    }
    render();
    schedule();
  }
  function schedule() {
    if (destroyed || raf || !win || (doc && doc.hidden)) return;
    raf = win.requestAnimationFrame(frame);
  }
  function onVisibility() {
    if (!doc) return;
    if (doc.hidden) { hiddenAt = now(); if (raf && win) { win.cancelAnimationFrame(raf); raf = 0; } }
    else {
      // back after a long time: snap (nothing old is replayed). A short blink is simply simulated by the next frame.
      if (now() - hiddenAt > SNAP_AFTER_MS) { dirtySnap = true; last = now(); }
      schedule();
    }
  }

  // ---- layout: largest whole-pixel scale that fits the parent, centered, dark letterbox.
  // Whole pixels are device pixels: on a Retina screen (devicePixelRatio 2) a scene pixel can be 5 device pixels wide, which is
  // CSS scale 2.5. Every scene pixel still gets the same whole number of device pixels, so the art stays even, and the scene
  // fills far more of a window that is just short of the next whole CSS scale. On a screen with ratio 1 the scale is an integer.
  // A parent smaller than 480 x 272 goes down to one device pixel per scene pixel (CSS scale 1 / devicePixelRatio: 0.5 on a
  // Retina screen, so a narrow room next to a wide drawer still shows the whole floor), never below. On a screen with ratio
  // 1 that is scale 1: the canvas is centered and the parent clips the overhang.
  function resize() {
    const parent = canvas.parentElement;
    const cw = parent ? parent.clientWidth : M.W;
    const ch = parent ? parent.clientHeight : M.H;
    const dpr = win && Number(win.devicePixelRatio) >= 1 ? Math.min(4, Math.floor(Number(win.devicePixelRatio))) : 1;
    let s = options.scale > 0 ? options.scale : Math.floor(Math.min(cw / M.W, ch / M.H) * dpr) / dpr;
    if (!(s >= 1)) s = options.scale > 0 ? 1 : Math.max(1 / dpr, Math.floor(Math.min(cw / M.W, ch / M.H) * dpr) / dpr) || 1;
    scale = s;
    canvas.style.width = Math.round(M.W * s) + 'px';
    canvas.style.height = Math.round(M.H * s) + 'px';
    if (options.autoCenter) {
      canvas.style.marginLeft = Math.floor((cw - M.W * s) / 2) + 'px';
      canvas.style.marginTop = Math.floor((ch - M.H * s) / 2) + 'px';
      if (parent && opts.letterbox !== false) parent.style.backgroundColor = PALETTE.wallDark;
    }
    return s;
  }

  // ---- pointer events
  function targetAt(x, y) {
    let best = null;
    for (const ag of world.w.agents.values()) {
      if (!ag.data.present) continue;
      const b = agentBox(ag);
      if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h && (!best || ag.y > best.y)) best = ag;
    }
    if (best) return { kind: 'agent', id: best.id };
    const T = world.truckView();
    if (T.visible && x >= T.x && x < T.x + M.truck.w && y >= M.truck.y && y < M.truck.y + M.truck.h) return { kind: 'truck', id: 'truck' };
    return M.staticTargetAt(x, y);
  }
  function toLogical(ev) {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: ((ev.clientX - r.left) / r.width) * M.W, y: ((ev.clientY - r.top) / r.height) * M.H };
  }
  function emit(type, target) { try { onEvent({ type, target: { kind: target.kind, id: target.id } }); } catch (e) { warn('onEvent', 'onEvent handler threw: ' + (e && e.message)); } }
  function setHover(t) {
    if (t.kind === hover.kind && t.id === hover.id) return;
    hover = t;
    canvas.style.cursor = t.kind === 'none' ? 'default' : 'pointer';
    emit('hover', t);
  }
  function onMove(ev) { const p = toLogical(ev); setHover(p ? targetAt(p.x, p.y) : { kind: 'none', id: null }); }
  function onLeave() { setHover({ kind: 'none', id: null }); }
  function onClick(ev) { const p = toLogical(ev); if (!p) return; const t = targetAt(p.x, p.y); setHover(t); emit('click', t); }

  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('click', onClick);
  let ro = null;
  if (win) {
    win.addEventListener('resize', resize);
    if (typeof win.ResizeObserver === 'function' && canvas.parentElement) { ro = new win.ResizeObserver(() => resize()); ro.observe(canvas.parentElement); }
  }
  if (doc) doc.addEventListener('visibilitychange', onVisibility);

  resize();
  last = now();
  render();
  schedule();

  return {
    // Declarative: pass the full view model whenever anything changes. Never throws.
    sync(vm) {
      try { world.sync(vm); } catch (e) { warn('sync', 'sync failed: ' + (e && e.message)); }
    },
    // One-shot effects: 'newOrder', 'confetti', 'horn', 'ship', 'note' { from, kind, text }.
    fx(name, payload) {
      try { world.fx(name, payload); } catch (e) { warn('fx', 'fx failed: ' + (e && e.message)); }
    },
    resize,
    setOptions(o) {
      if (!o || typeof o !== 'object') return;
      if ('scanlines' in o) options.scanlines = !!o.scanlines;
      if ('paused' in o) {
        const p = !!o.paused;
        if (p && !options.paused) pausedAt = now();
        if (!p && options.paused && now() - pausedAt > SNAP_AFTER_MS) dirtySnap = true;   // a long pause: do not replay, snap
        options.paused = p;
        if (!p) { last = now(); schedule(); }
      }
      if ('autoCenter' in o) options.autoCenter = !!o.autoCenter;
      if ('scale' in o) { options.scale = Number.isFinite(o.scale) && o.scale >= 1 ? Math.floor(o.scale) : 0; }
      if ('scale' in o || 'autoCenter' in o) resize();
      if (raf === 0) render();
    },
    debug: {
      // deterministic stepping: advances the simulation and redraws; the frame clock restarts, so a long
      // synchronous fast-forward is not mistaken for a stalled page
      advance(ms) { try { world.advance(ms); } catch (e) { warn('advance', 'advance failed: ' + (e && e.message)); } last = now(); render(); },
      state() { const s = world.state(); s.scale = scale; s.hover = { kind: hover.kind, id: hover.id }; return s; },
      snap() { world.snap(); render(); },
      render,
      targetAt,
    },
    destroy() {
      destroyed = true;
      if (raf && win) win.cancelAnimationFrame(raf);
      raf = 0;
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('click', onClick);
      if (win) win.removeEventListener('resize', resize);
      if (ro) ro.disconnect();
      if (doc) doc.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

// PNG data URL of an agent's front-facing idle sprite, same look as in the scene, cropped to the figure. '' when there is no DOM.
const avatarCache = new Map();
export function avatarDataURL(agent, scale) {
  if (typeof document === 'undefined') return '';
  try {
    const s = Math.max(1, Math.min(16, Math.round(Number(scale) || 4)));
    const look = lookFor(agent);
    const key = look.key + '@' + s;
    const hit = avatarCache.get(key);
    if (hit) return hit;
    const pix = buildCharacterFrames(look).S_idle;
    const b = pix.bounds() || { x: 0, y: 0, w: pix.w, h: pix.h };
    const cv = document.createElement('canvas');
    cv.width = b.w * s; cv.height = b.h * s;
    pix.paint(cv.getContext('2d'), -b.x * s, -b.y * s, s);
    const url = cv.toDataURL('image/png');
    if (avatarCache.size >= 128) avatarCache.delete(avatarCache.keys().next().value);
    avatarCache.set(key, url);
    return url;
  } catch (e) {
    return '';
  }
}
