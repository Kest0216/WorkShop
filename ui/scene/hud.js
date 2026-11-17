// WorkShop overlays: sky in the windows, clock hands, speech bubbles, tooltips, tags. Drawing helpers only.

import { PALETTE as P, BUBBLE_COLORS, mix } from './palette.js';
import { drawText, measureText, truncateText, wrapText } from './font.js';

// ---------------------------------------------------------------- sky by local time

// hours: 0..24 (float). Returns { bands: [4 colors top->bottom], stars: 0..1, sun: 0..1 position or null, moon: bool, phase }
export function skyAt(hours) {
  const h = ((hours % 24) + 24) % 24;
  const night = [P.wallDark, P.navy1, P.navy1, P.navy2];
  const dawn = [P.navy2, P.purple, P.pink, P.orange];
  const day = [P.blue, P.blue, P.sky, P.sky];
  const dusk = [P.navy2, P.purple, P.brick3, P.amber];
  const lerpBands = (a, b, t) => a.map((c, i) => mix(c, b[i], t));
  let bands, stars = 0, phase;
  if (h < 5) { bands = night; stars = 1; phase = 'night'; }
  else if (h < 6.5) { bands = lerpBands(night, dawn, (h - 5) / 1.5); stars = 1 - (h - 5) / 1.5; phase = 'dawn'; }
  else if (h < 8) { bands = lerpBands(dawn, day, (h - 6.5) / 1.5); phase = 'dawn'; }
  else if (h < 17) { bands = day; phase = 'day'; }
  else if (h < 19) { bands = lerpBands(day, dusk, (h - 17) / 2); phase = 'sunset'; }
  else if (h < 20.5) { bands = lerpBands(dusk, night, (h - 19) / 1.5); stars = (h - 19) / 1.5; phase = 'sunset'; }
  else { bands = night; stars = 1; phase = 'night'; }
  const sun = h >= 6 && h <= 19.5 ? (h - 6) / 13.5 : null;
  return { bands, stars, sun, moon: h < 5.5 || h > 20, phase };
}

// Fill one window rect with the sky. idx varies the star / sun placement per window.
export function drawSky(ctx, r, sky, idx, timeMs) {
  const n = sky.bands.length;
  for (let i = 0; i < n; i++) {
    const y0 = r.y + Math.floor((r.h * i) / n), y1 = r.y + Math.floor((r.h * (i + 1)) / n);
    ctx.fillStyle = sky.bands[i]; ctx.fillRect(r.x, y0, r.w, y1 - y0);
  }
  if (sky.stars > 0.25) {
    for (let k = 0; k < 6; k++) {
      const sx = r.x + 1 + ((k * 37 + idx * 53 + 11) % Math.max(1, r.w - 2));
      const sy = r.y + 1 + ((k * 17 + idx * 29) % Math.max(1, r.h - 4));
      const tw = Math.floor(timeMs / 700 + k * 1.7 + idx) % 5 === 0;
      ctx.fillStyle = tw ? P.steel3 : sky.stars > 0.7 ? P.white : P.steel4;
      ctx.fillRect(sx, sy, 1, 1);
    }
  }
  if (sky.sun !== null && idx % 2 === 1) {
    const sx = r.x + 2 + Math.floor(sky.sun * (r.w - 7));
    const sy = r.y + 1 + Math.floor((1 - Math.sin(sky.sun * Math.PI)) * (r.h - 5));
    ctx.fillStyle = sky.phase === 'day' ? P.yellow : P.amber; ctx.fillRect(sx, sy, 3, 3);
    ctx.fillStyle = P.white; ctx.fillRect(sx, sy, 1, 1);
  } else if (sky.sun === null && sky.moon && idx % 2 === 0) {
    const mx = r.x + r.w - 8, my = r.y + 2;
    ctx.fillStyle = P.paper; ctx.fillRect(mx, my, 3, 3); ctx.fillStyle = sky.bands[0]; ctx.fillRect(mx + 2, my, 1, 2);
  }
  if (sky.phase === 'day' || sky.phase === 'dawn') { // one small cloud
    const cx = r.x + ((Math.floor(timeMs / 900) + idx * 13) % (r.w + 10)) - 8;
    ctx.fillStyle = P.white;
    for (const [dx, dy, w] of [[1, 0, 4], [0, 1, 7]]) {
      const x0 = Math.max(r.x, cx + dx), x1 = Math.min(r.x + r.w, cx + dx + w);
      if (x1 > x0) ctx.fillRect(x0, r.y + r.h - 5 + dy - (idx % 2) * 2, x1 - x0, 1);
    }
  }
}

// ---------------------------------------------------------------- clock hands

function line(ctx, x0, y0, x1, y1, color) {
  ctx.fillStyle = color;
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= n; i++) ctx.fillRect(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), 1, 1);
}

export function drawClockHands(ctx, cx, cy, date) {
  const h = date.getHours() % 12, m = date.getMinutes();
  const ha = ((h + m / 60) / 12) * Math.PI * 2, ma = (m / 60) * Math.PI * 2;
  line(ctx, cx, cy, cx + Math.round(Math.sin(ma) * 5), cy - Math.round(Math.cos(ma) * 5), P.steel1);
  line(ctx, cx, cy, cx + Math.round(Math.sin(ha) * 3), cy - Math.round(Math.cos(ha) * 3), P.ink);
  ctx.fillStyle = P.red; ctx.fillRect(cx, cy, 1, 1);
}

// ---------------------------------------------------------------- boxes

function panel(ctx, x, y, w, h, fill, border) {
  ctx.fillStyle = border;
  ctx.fillRect(x + 1, y, w - 2, h); ctx.fillRect(x, y + 1, w, h - 2);
  ctx.fillStyle = fill;
  ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
}

// Box of a speech bubble above (ax, ay) for the given lines (already clamped).
export function bubbleRect(ax, ay, lines) {
  let w = 0;
  for (const l of lines) w = Math.max(w, measureText(l));
  w += 7;
  const h = lines.length * 7 + 5;
  let x = Math.round(ax - w / 2);
  x = Math.max(1, Math.min(480 - w - 1, x));
  let y = Math.round(ay - h - 4);
  if (y < 1) y = 1;
  return { x, y, w, h };
}

// Where to put a speech bubble. r0: the box right above the speaker (bubbleRect). placed: boxes of the bubbles
// already placed (hard obstacles). soft: [{ x, y, w, h, cost }] things a bubble should not hide (heads, name tags,
// work on a bench). opts: { maxUp: how far it may move up, baseY: preferred top (bosses: below the wall trim),
// headY: top of the speaker's head (enables a place beside the head), keep: the place used in the last frame
// (kept unless clearly worse, so a bubble does not jitter) }.
// Order of preference: above the head; shifted left or right (the tail stays on the speaker); beside the head;
// moved up. Returns { x, y, w, h, dx, dy, side, cost }.
export function placeBubble(r0, ax, placed, soft, opts = {}) {
  const hit = (a, b, m) => a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;
  const maxShift = Math.max(0, Math.min(24, Math.floor(r0.w / 2) - 6));
  const y0 = Number.isFinite(opts.baseY) ? opts.baseY : r0.y;
  const score = (r, base) => {
    let c = base;
    for (const q of placed) if (hit(r, q, 2)) c += 100;
    for (const o of soft) if (hit(r, o, 0)) c += o.cost;
    r.cost = c;
    return r;
  };
  // opts.sideFirst (a manager at its post, right under the wall band): a place beside the head is preferred
  const upCost = opts.sideFirst ? 1 : 0, sideCost = opts.sideFirst ? 0 : 0.6;
  const above = (dx, dy) => {
    let x = Math.max(1, Math.min(480 - r0.w - 1, r0.x + dx));
    x = Math.min(x, Math.round(ax) - 4); x = Math.max(x, Math.round(ax) - r0.w + 5); x = Math.max(1, Math.min(480 - r0.w - 1, x));   // keep the tail on the speaker
    return score({ x, y: Math.max(1, y0 + dy), w: r0.w, h: r0.h, dx, dy, side: null }, upCost + Math.abs(dx) * 0.04 + Math.abs(dy) * 0.08);
  };
  const beside = (side) => {
    const x = side === 'right' ? Math.round(ax) + 12 : Math.round(ax) - 12 - r0.w;
    if (!Number.isFinite(opts.headY) || x < 1 || x + r0.w > 479) return null;
    return score({ x, y: Math.max(1, Math.round(opts.headY + 8 - r0.h / 2)), w: r0.w, h: r0.h, dx: 0, dy: 0, side }, sideCost);
  };
  const at = (k) => (k.side ? beside(k.side) : above(k.dx, k.dy));
  let best = above(0, 0);
  for (let sx = 8; sx <= maxShift && best.cost > 0; sx += 8) for (const dx of [-sx, sx]) { const r = above(dx, 0); if (r.cost < best.cost - 1e-6) best = r; }
  for (const side of ['right', 'left']) { const r = best.cost > sideCost ? beside(side) : null; if (r && r.cost < best.cost - 1e-6) best = r; }
  const maxUp = Number.isFinite(opts.maxUp) ? opts.maxUp : 24;
  for (let dy = -4; dy >= -maxUp && best.cost > 0.6; dy -= 4) {
    for (let sx = 0; sx <= maxShift; sx += 8) for (const dx of sx ? [-sx, sx] : [0]) { const r = above(dx, dy); if (r.cost < best.cost - 1e-6) best = r; }
  }
  if (opts.keep) { const k = at(opts.keep); if (k && k.cost <= best.cost + 0.9) best = k; }
  return best;
}

// Speech bubble above (ax, ay). rect: optional box from bubbleRect() or placeBubble() (moved by the caller to avoid
// overlaps); when it was lifted away from the speaker, the tail is drawn longer so it still points at the head. Returns the box.
export function drawBubble(ctx, ax, ay, lines, kind, age, rect) {
  const border = BUBBLE_COLORS[kind] || BUBBLE_COLORS.info;
  const r = rect || bubbleRect(ax, ay, lines);
  const { x, w, h } = r;
  const y = r.y + (age < 90 ? 2 : 0); // tiny pop
  ctx.fillStyle = P.ink;
  ctx.fillRect(x + 1, y - 1, w - 2, h + 2); ctx.fillRect(x - 1, y + 1, w + 2, h - 2); ctx.fillRect(x, y, w, h);
  panel(ctx, x, y, w, h, P.white, border);
  if (r.side) {
    // beside the head: the tail leaves the near edge and points sideways at the face
    const ty = Math.max(y + 2, Math.min(y + h - 5, Math.round(ay) + 5));
    const e = r.side === 'right' ? x : x + w - 1, d = r.side === 'right' ? -1 : 1;
    ctx.fillStyle = P.ink; ctx.fillRect(e + d, ty - 1, 1, 5); ctx.fillRect(e + 2 * d, ty, 1, 3); ctx.fillRect(e + 3 * d, ty + 1, 1, 1);
    ctx.fillStyle = P.white; ctx.fillRect(e, ty, 1, 3); ctx.fillRect(e + d, ty, 1, 3); ctx.fillRect(e + 2 * d, ty + 1, 1, 1);
    ctx.fillStyle = border; ctx.fillRect(e, ty - 1, 1, 1); ctx.fillRect(e, ty + 3, 1, 1);
  } else {
    const tx = Math.max(x + 3, Math.min(x + w - 6, Math.round(ax) - 1));
    ctx.fillStyle = P.ink; ctx.fillRect(tx - 1, y + h, 5, 1); ctx.fillRect(tx, y + h + 1, 3, 1); ctx.fillRect(tx + 1, y + h + 2, 1, 1);
    ctx.fillStyle = P.white; ctx.fillRect(tx, y + h - 1, 3, 1); ctx.fillRect(tx, y + h, 3, 1); ctx.fillRect(tx + 1, y + h + 1, 1, 1);
    ctx.fillStyle = border; ctx.fillRect(tx - 1, y + h - 1, 1, 1); ctx.fillRect(tx + 3, y + h - 1, 1, 1);
    const gap = Math.min(28, Math.round(ay) - 4 - (y + h));      // lifted bubble: a thin stem down to the head
    if (gap > 2) {
      ctx.fillStyle = P.ink; ctx.fillRect(tx, y + h + 1, 3, gap + 1); ctx.fillRect(tx + 1, y + h + gap + 2, 1, 1);
      ctx.fillStyle = P.white; ctx.fillRect(tx + 1, y + h + 1, 1, gap + 1);
    }
  }
  lines.forEach((l, i) => drawText(ctx, l, x + 4, y + 3 + i * 7, P.ink));
  return r;
}

// Tooltip: rows = [{ text, color }] plus optional progress 0..1. Anchored near (ax, ay), kept on screen.
export function drawTooltip(ctx, ax, ay, rows, progress, accent) {
  const lines = [];
  for (const r of rows) {
    if (!r || !r.text) continue;
    for (const l of wrapText(r.text, 120).slice(0, 2)) lines.push({ text: l, color: r.color || P.paper });
  }
  if (!lines.length) return;
  let w = 0;
  for (const l of lines) w = Math.max(w, measureText(l.text));
  const bar = Number.isFinite(progress);
  w = Math.max(w, bar ? 60 : 0) + 8;
  const h = lines.length * 8 + (bar ? 9 : 2) + 3;
  let x = Math.round(ax + 10), y = Math.round(ay - h - 6);
  if (x + w > 478) x = Math.round(ax - 10 - w);
  x = Math.max(2, Math.min(478 - w, x));
  if (y < 2) y = Math.min(270 - h, Math.round(ay + 8));
  ctx.fillStyle = P.ink; ctx.fillRect(x - 1, y + 1, w + 2, h); ctx.fillRect(x + 1, y + h, w, 1);
  panel(ctx, x, y, w, h, P.shadow, accent || P.steel4);
  lines.forEach((l, i) => drawText(ctx, l.text, x + 4, y + 3 + i * 8, l.color));
  if (bar) {
    const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100) + '%';
    const by = y + h - 8, bw = w - 8 - 22;
    ctx.fillStyle = P.ink; ctx.fillRect(x + 4, by, bw, 4);
    ctx.fillStyle = P.lime; ctx.fillRect(x + 5, by + 1, Math.round((bw - 2) * Math.max(0, Math.min(1, progress))), 2);
    drawText(ctx, pct, x + w - 4, by - 1, P.lime, { align: 'right' });
  }
}

// Small "+N" style tag with a dark plate.
export function drawTag(ctx, text, x, y, color, align) {
  const w = measureText(text) + 4;
  const px = align === 'right' ? x - w : align === 'center' ? Math.round(x - w / 2) : x;
  panel(ctx, px, y, w, 9, P.ink, P.ink);
  ctx.fillStyle = P.shadow; ctx.fillRect(px + 1, y + 1, w - 2, 7);
  drawText(ctx, text, px + 2, y + 2, color || P.yellow);
  return w;
}

// A persona name that fits maxW pixels: the full name, else the name without its role word ("Boss Tungsten" -> "Tungsten",
// "Foreman Ash" -> "Ash"), else that short name cut with "..".
export function fitName(name, maxW) {
  const full = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (measureText(full) <= maxW) return full;
  const short = full.replace(/^(boss|foreman|manager|maker)\s+/i, '');
  return truncateText(short || full, maxW);
}

// Box of a name tag centered on x with its top at y: { x, y, w, h, text }.
export function nameTagRect(name, x, y, maxW) {
  const text = fitName(name, maxW || 30);
  const w = measureText(text) + 6;
  return { x: Math.round(x - w / 2), y: Math.round(y), w, h: 7, text };
}

// Name tag: a slim dark plate with the persona name and a lab accent bar. rect: optional box from nameTagRect().
export function drawNameTag(ctx, name, x, y, accent, maxW, hi, rect) {
  const r = rect || nameTagRect(name, x, y, maxW);
  const t = r.text, w = r.w, px = r.x, py = r.y;
  ctx.fillStyle = P.ink; ctx.fillRect(px, py, w, 7);
  ctx.fillStyle = hi ? P.navy2 : P.shadow; ctx.fillRect(px + 1, py, w - 2, 7);
  ctx.fillStyle = accent; ctx.fillRect(px, py, 2, 7);
  drawText(ctx, t, px + 4, py + 1, hi ? P.yellow : P.paper);
}

export { line, panel };
