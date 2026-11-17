#!/usr/bin/env node
// Draws the WorkShop app icon as a pixel-art PNG: a brass gear on a warm wooden workbench, in front of a
// navy brick wall. Original art, drawn by this code. No assets, no dependencies.
//   usage: node make_icon.js <out.png> [size=1024]
// The art lives on a 32 x 32 cell grid. At 1024 px one cell is 32 px, so every icon size down to
// 32 px maps cells to whole pixels (crisp). The tile uses the macOS icon grid: an 824 x 824 rounded
// square centred in the 1024 canvas, transparent outside.
// The output is deterministic: same script, same bytes.
import fs from 'node:fs';
import zlib from 'node:zlib';

const out = process.argv[2];
const S = parseInt(process.argv[3] || '1024', 10);
if (!out || !(S >= 16)) { console.error('usage: make_icon.js <out.png> [size>=16]'); process.exit(2); }

const G = 32;                          // cells per side
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const C = {
  wall: hex('#2a3b6e'), wallHi: hex('#34488a'), mortar: hex('#1f2c57'), under: hex('#141b36'),
  top: hex('#e8b46a'), topHi: hex('#f6d291'), wood: hex('#b57a3c'), woodLo: hex('#8a5626'), woodDark: hex('#643c18'),
  brass: hex('#e3a93f'), brassHi: hex('#ffd977'), brassLo: hex('#a9742a'),
  line: hex('#0e1222'), spark: hex('#ffe27a'), spark2: hex('#ff9d45'),
  lamp: hex('#f4efe0'), lampLo: hex('#c9c2ab'),
};

// ---- the gear: 8 teeth, a hub hole, light from the upper left
const GX = 16, GY = 12.5, R_BODY = 6.6, R_TEETH = 8.9, R_HOLE = 2.4;
function gearAt(cx, cy) {
  const dx = cx + 0.5 - GX, dy = cy + 0.5 - GY;
  const r = Math.hypot(dx, dy);
  if (r < R_HOLE) return null;
  const tooth = Math.cos(8 * Math.atan2(dy, dx)) > 0.15;
  if (r > R_BODY && !(tooth && r <= R_TEETH)) return null;
  if (r < R_HOLE + 1.1) return C.brassLo;                  // the rim of the hole
  const lit = dx + dy;
  if (lit < -4.2) return C.brassHi;
  if (lit > 4.6) return C.brassLo;
  return C.brass;
}

const SPARKS = { '27,5': C.spark, '28,8': C.spark2, '25,3': C.spark2, '29,4': C.spark, '4,6': C.spark2, '3,9': C.spark };

function cellColor(cx, cy) {
  const g = gearAt(cx, cy);
  if (g) return g;
  for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (gearAt(cx + ox, cy + oy)) return C.line;   // 1-cell outline
  const s = SPARKS[cx + ',' + cy];
  if (s) return s;

  if (cy >= 22) {                                          // the workbench
    if (cy === 22) return C.topHi;
    if (cy === 23) return C.top;
    if (cy === 24) return C.wood;
    if (cy === 25) return C.woodLo;
    const leg = (cx >= 4 && cx <= 7) || (cx >= 24 && cx <= 27);
    if (leg) return cx === 4 || cx === 24 ? C.wood : (cx === 7 || cx === 27 ? C.woodDark : C.woodLo);
    if (cy === 28 && cx > 7 && cx < 24) return C.woodLo;   // the stretcher between the legs
    if (cy === 29 && cx > 7 && cx < 24) return C.woodDark;
    return C.under;
  }
  if (cy === 21) return C.mortar;                          // a shadow line where the bench meets the wall
  if (cy % 4 === 1) return C.mortar;                       // brick wall
  const row = Math.floor((cy + 3) / 4);
  if ((cx + (row % 2) * 3) % 6 === 0) return C.mortar;
  if (cy % 4 === 2) return C.wallHi;
  return C.wall;
}

// ---- rounded-square mask (macOS icon grid), anti-aliased by 4x4 supersampling
const T0 = 100 / 1024 * S, T1 = 924 / 1024 * S, RAD = 185.4 / 1024 * S;
function inside(x, y) {
  if (x < T0 || x > T1 || y < T0 || y > T1) return false;
  const qx = x < T0 + RAD ? T0 + RAD : (x > T1 - RAD ? T1 - RAD : x);
  const qy = y < T0 + RAD ? T0 + RAD : (y > T1 - RAD ? T1 - RAD : y);
  const dx = x - qx, dy = y - qy;
  return dx * dx + dy * dy <= RAD * RAD;
}
function coverage(px, py) {
  let n = 0;
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) if (inside(px + (i + 0.5) / 4, py + (j + 0.5) / 4)) n++;
  return n / 16;
}

// ---- rasterise: the 32-cell grid fills the tile (not the whole canvas), so nothing is cut by the mask
const raw = Buffer.alloc((S * 4 + 1) * S);
const cellOf = (p) => Math.min(G - 1, Math.max(0, Math.floor((p - T0) * G / (T1 - T0))));
for (let y = 0; y < S; y++) {
  const rowStart = y * (S * 4 + 1);
  raw[rowStart] = 0;                                       // PNG filter: none
  for (let x = 0; x < S; x++) {
    const a = coverage(x, y);
    if (a === 0) continue;
    const o = rowStart + 1 + x * 4;
    let r = 0, g = 0, b = 0, n = 0;
    const sub = (T1 - T0) >= G ? 1 : 2;                    // box-average when one pixel spans several cells
    for (let j = 0; j < sub; j++) for (let i = 0; i < sub; i++) {
      const c = cellColor(cellOf(x + (i + 0.5) / sub), cellOf(y + (j + 0.5) / sub));
      r += c[0]; g += c[1]; b += c[2]; n++;
    }
    raw[o] = Math.round(r / n); raw[o + 1] = Math.round(g / n); raw[o + 2] = Math.round(b / n); raw[o + 3] = Math.round(a * 255);
  }
}

// ---- PNG encoder (RGBA, 8 bit)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(out, png);
console.log(`icon: wrote ${out} (${S}x${S}, ${png.length} bytes)`);
