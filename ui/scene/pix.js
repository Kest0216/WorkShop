// WorkShop pixel buffer: a tiny software sprite. Pure (works in Node); only toCanvas()/sprite() touch the DOM, and only when called.

import { PALETTE as P } from './palette.js';

export class Pix {
  constructor(w, h) { this.w = w; this.h = h; this.d = new Array(w * h).fill(null); }
  set(x, y, c) { if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.d[y * this.w + x] = c; return this; }
  get(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.d[y * this.w + x] : null; }
  rect(x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c); return this; }
  // rows: array of strings, map: char -> color ('.' and ' ' are transparent, a map value of 0 erases)
  stamp(x, y, rows, map, flipH = false) {
    for (let j = 0; j < rows.length; j++) {
      const row = rows[j];
      for (let i = 0; i < row.length; i++) {
        const ch = row[flipH ? row.length - 1 - i : i];
        if (ch === '.' || ch === ' ') continue;
        const c = map[ch];
        if (c) this.set(x + i, y + j, c);
        else if (c === 0) this.set(x + i, y + j, null);
      }
    }
    return this;
  }
  blit(src, dx, dy) {
    for (let j = 0; j < src.h; j++) for (let i = 0; i < src.w; i++) { const c = src.d[j * src.w + i]; if (c) this.set(dx + i, dy + j, c); }
    return this;
  }
  clone() { const o = new Pix(this.w, this.h); o.d = this.d.slice(); return o; }
  mirror() {
    const o = new Pix(this.w, this.h);
    for (let j = 0; j < this.h; j++) for (let i = 0; i < this.w; i++) o.d[j * this.w + (this.w - 1 - i)] = this.d[j * this.w + i];
    return o;
  }
  // 1 px outline around every opaque pixel (4-neighborhood). Pixels are only added, never replaced.
  outline(color = P.ink) {
    const add = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (this.d[y * this.w + x]) continue;
      if (this.get(x - 1, y) || this.get(x + 1, y) || this.get(x, y - 1) || this.get(x, y + 1)) add.push(y * this.w + x);
    }
    for (const i of add) this.d[i] = color;
    return this;
  }
  // replace one color by another everywhere
  swap(from, to) { for (let i = 0; i < this.d.length; i++) if (this.d[i] === from) this.d[i] = to; return this; }
  // bounding box of the opaque pixels, or null when empty
  bounds() {
    let x0 = this.w, y0 = this.h, x1 = -1, y1 = -1;
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) if (this.d[y * this.w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
  count() { let n = 0; for (const c of this.d) if (c) n++; return n; }
  // DOM only: paint into a context at (dx, dy), each pixel `s` screen pixels wide
  paint(ctx, dx = 0, dy = 0, s = 1) {
    let last = null;
    for (let y = 0; y < this.h; y++) {
      let x = 0;
      while (x < this.w) {
        const c = this.d[y * this.w + x];
        if (!c) { x++; continue; }
        let e = x + 1;
        while (e < this.w && this.d[y * this.w + e] === c) e++;
        if (c !== last) { ctx.fillStyle = c; last = c; }
        ctx.fillRect(dx + x * s, dy + y * s, (e - x) * s, s);
        x = e;
      }
    }
  }
  toCanvas() {
    const cv = document.createElement('canvas');
    cv.width = this.w; cv.height = this.h;
    this.paint(cv.getContext('2d'));
    return cv;
  }
}

// Pix from string rows with a color map, optionally outlined. Leaves a 1 px margin for the outline.
export function fromRows(rows, map, outline = true) {
  let w = 0;
  for (const r of rows) w = Math.max(w, r.length);
  const p = new Pix(w + 2, rows.length + 2);
  p.stamp(1, 1, rows, map);
  return outline ? p.outline() : p;
}

// Lazy canvas cache for sprites built from Pix factories (DOM).
const spriteCache = new Map();
export function sprite(key, factory) {
  let cv = spriteCache.get(key);
  if (!cv) { cv = factory().toCanvas(); spriteCache.set(key, cv); }
  return cv;
}
export function clearSpriteCache() { spriteCache.clear(); }

// Shared color key for all prop and item pixel maps.
export const CM = Object.freeze({
  k: P.ink, K: P.shadow,
  a: P.wood1, b: P.wood2, c: P.wood3, d: P.wood4, e: P.wood5, f: P.wood6,
  1: P.steel1, 2: P.steel2, 3: P.steel3, 4: P.steel4, 5: P.steel5,
  6: P.navy1, 7: P.navy2, 8: P.navy3, 9: P.navy4,
  r: P.red, o: P.orange, y: P.amber, Y: P.yellow, g: P.green, l: P.lime, t: P.teal, u: P.blue, s: P.sky, p: P.purple, i: P.pink,
  w: P.white, P: P.paper, Q: P.paper2, x: P.plaster, G: P.gray,
  B: P.brick2, C: P.brick3, D: P.brick1,
  R: P.rust2, S: P.rust3, T: P.rust1,
  L: P.leaf1, M: P.leaf2, N: P.leaf3, O: P.leaf4,
  A: P.asphalt, H: P.carpet2, I: P.carpet1, J: P.tealc2,
});
