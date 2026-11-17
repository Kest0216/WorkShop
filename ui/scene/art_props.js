// WorkShop furniture and vehicles as pixel buffers (pure) with lazy canvas caching (DOM only in Props.*).
// Light comes from the top-left: top faces are lightest, front faces mid, right and bottom edges dark.
// Every sprite carries a 1 px outline in the darkest tone of its own material; draw it at (rect.x - 1, rect.y - 1).

import { PALETTE as P } from './palette.js';
import { Pix, sprite, CM } from './pix.js';

const GLASS = 'rgba(134,189,240,0.26)';
const GLINT = 'rgba(251,247,236,0.5)';

// a Pix with a 1 px margin; ops below use inner coordinates
function canvas(w, h) { const p = new Pix(w + 2, h + 2); p.ox = 1; return p; }
const R = (p, x, y, w, h, c) => p.rect(x + 1, y + 1, w, h, c);
const D = (p, x, y, c) => p.set(x + 1, y + 1, c);
// box with a lit top-left edge and a dark bottom-right edge
function bevel(p, x, y, w, h, hi, mid, lo) {
  R(p, x, y, w, h, mid);
  R(p, x, y, w, 1, hi); R(p, x, y, 1, h, hi);
  R(p, x, y + h - 1, w, 1, lo); R(p, x + w - 1, y, 1, h, lo);
}
function rows(p, x, y, list, map = CM) { p.stamp(x + 1, y + 1, list, map); }

// 32 x 24 workbench: rows 0-11 light-wood top with darker trim, rows 12-23 front with a dark recess for the name plate
function benchPix() {
  const p = canvas(32, 24);
  R(p, 0, 0, 32, 10, P.wood5);
  R(p, 0, 0, 32, 1, P.wood6); R(p, 0, 1, 1, 9, P.wood6);
  for (const x of [10, 21]) R(p, x, 1, 1, 9, P.wood4);
  for (const [x, y] of [[4, 4], [26, 3]]) D(p, x, y, P.wood6);
  for (const [x, y] of [[14, 6], [29, 7]]) D(p, x, y, P.wood4);
  R(p, 0, 10, 32, 2, P.wood3); R(p, 0, 10, 32, 1, P.wood4);
  R(p, 0, 12, 32, 10, P.wood3); R(p, 0, 12, 32, 1, P.wood2);
  R(p, 0, 13, 3, 11, P.wood4); R(p, 29, 13, 3, 11, P.wood3); R(p, 31, 13, 1, 11, P.wood2);
  R(p, 3, 13, 26, 8, P.wood1); R(p, 3, 13, 26, 1, P.shadow); R(p, 3, 21, 26, 1, P.wood2);
  R(p, 3, 22, 26, 2, null);
  return p.outline(P.wood1);
}

// 16 x 23 standing desk for a manager post
function postPix() {
  const p = canvas(16, 23);
  R(p, 0, 0, 16, 7, P.wood5); R(p, 0, 0, 16, 1, P.wood6); R(p, 0, 1, 1, 6, P.wood6);
  R(p, 8, 1, 6, 5, P.paper); R(p, 9, 2, 4, 1, P.steel3); R(p, 9, 4, 3, 1, P.steel3); R(p, 10, 0, 2, 1, P.steel2);
  R(p, 2, 2, 3, 3, P.brick2); R(p, 2, 2, 3, 1, P.brick3); D(p, 3, 1, P.amber); D(p, 4, 1, P.blue);
  R(p, 0, 7, 16, 3, P.wood3); R(p, 0, 7, 16, 1, P.wood4); R(p, 15, 7, 1, 3, P.wood2);
  R(p, 1, 10, 2, 12, P.steel3); R(p, 13, 10, 2, 12, P.steel2); R(p, 1, 10, 1, 12, P.steel4);
  R(p, 3, 10, 10, 8, P.wood1); R(p, 3, 10, 10, 1, P.shadow); R(p, 3, 18, 10, 1, P.wood2);
  R(p, 3, 20, 10, 1, P.steel2);
  R(p, 0, 22, 4, 1, P.steel1); R(p, 12, 22, 4, 1, P.steel1);
  return p.outline(P.wood1);
}

// 34 x 18 office desk: rows 0-9 top, rows 10-17 front with two drawers
function deskPix() {
  const p = canvas(34, 18);
  R(p, 0, 0, 34, 9, P.wood4); R(p, 0, 0, 34, 1, P.wood5); R(p, 0, 1, 1, 8, P.wood5); R(p, 33, 1, 1, 8, P.wood3);
  R(p, 0, 9, 34, 1, P.wood5);
  R(p, 0, 10, 34, 8, P.wood3); R(p, 0, 10, 34, 1, P.wood2); R(p, 33, 10, 1, 8, P.wood2); R(p, 0, 11, 1, 7, P.wood4);
  for (const x of [3, 19]) { R(p, x, 12, 12, 4, P.wood2); R(p, x, 12, 12, 1, P.wood1); R(p, x + 1, 13, 10, 2, P.wood3); R(p, x + 5, 13, 2, 1, P.straw); }
  R(p, 0, 17, 34, 1, P.wood1);
  return p.outline(P.wood1);
}

// 16 x 20 office chair seen from the front (crimson)
function chairPix() {
  const p = canvas(16, 20);
  R(p, 1, 0, 14, 12, P.brick2); R(p, 1, 0, 14, 1, P.brick3); R(p, 1, 1, 1, 11, P.brick3); R(p, 14, 1, 1, 11, P.brick1); R(p, 2, 11, 12, 1, P.brick1);
  D(p, 1, 0, null); D(p, 14, 0, null);
  R(p, 0, 12, 16, 3, P.brick2); R(p, 0, 12, 16, 1, P.brick3); R(p, 0, 14, 16, 1, P.brick1);
  R(p, 7, 15, 2, 3, P.steel3); R(p, 3, 18, 10, 1, P.steel2); R(p, 2, 19, 3, 1, P.steel1); R(p, 11, 19, 3, 1, P.steel1); R(p, 7, 19, 2, 1, P.steel1);
  return p.outline(P.shadow);
}

// 48 x 22 front counter
function counterPix() {
  const p = canvas(48, 22);
  R(p, 0, 0, 48, 9, P.wood5); R(p, 0, 0, 48, 1, P.wood6); R(p, 0, 1, 1, 8, P.wood6); R(p, 47, 1, 1, 8, P.wood4);
  for (let x = 7; x < 46; x += 11) { D(p, x, 3, P.wood4); D(p, x + 1, 3, P.wood4); D(p, x + 5, 6, P.wood6); }
  R(p, 0, 9, 48, 2, P.wood3); R(p, 0, 9, 48, 1, P.wood4);
  R(p, 0, 11, 48, 10, P.wood3); R(p, 0, 11, 48, 1, P.wood2); R(p, 47, 11, 1, 10, P.wood2); R(p, 0, 12, 1, 9, P.wood4);
  for (let x = 3; x < 46; x += 11) { R(p, x, 13, 9, 7, P.wood2); R(p, x, 13, 9, 1, P.wood1); R(p, x + 1, 14, 7, 5, P.wood3); R(p, x + 1, 18, 7, 1, P.wood4); }
  R(p, 0, 21, 48, 1, P.wood1);
  return p.outline(P.wood1);
}

// 64 x 36 empty stock rack; stock is drawn on top by the renderer
function shelvesPix() {
  const p = canvas(64, 36);
  R(p, 2, 2, 60, 32, P.navy1);
  R(p, 2, 2, 60, 1, P.shadow);
  for (const y of [11, 22, 33]) { R(p, 1, y, 62, 2, P.steel3); R(p, 1, y, 62, 1, P.steel4); }
  for (const x of [0, 31, 61]) { R(p, x, 0, 3, 36, P.steel3); R(p, x, 0, 1, 36, P.steel4); R(p, x + 2, 0, 1, 36, P.steel2); }
  R(p, 0, 0, 64, 2, P.steel4); R(p, 0, 1, 64, 1, P.steel3);
  for (const x of [0, 31, 61]) for (const y of [5, 16, 27]) D(p, x + 1, y, P.steel1);
  return p.outline(P.steel1);
}

// 32 x 30 lathe: steel blue-gray cabinet, bed, headstock with a gauge, work piece, tailstock
function machinePix() {
  const p = canvas(32, 30);
  bevel(p, 0, 16, 32, 14, P.steel4, P.steel3, P.steel2);
  R(p, 0, 29, 32, 1, P.steel1);
  bevel(p, 3, 19, 11, 9, P.steel2, P.steel3, P.steel4); D(p, 12, 23, P.steel5);
  for (let y = 20; y <= 26; y += 2) R(p, 18, y, 10, 1, P.steel1);
  R(p, 0, 12, 32, 4, P.steel4); R(p, 0, 12, 32, 1, P.steel5); R(p, 0, 15, 32, 1, P.steel2);
  bevel(p, 1, 2, 12, 10, P.steel4, P.steel3, P.steel2);
  R(p, 3, 4, 4, 4, P.paper); D(p, 5, 5, P.red); D(p, 4, 6, P.steel2); D(p, 3, 4, P.steel4); D(p, 6, 4, P.steel4); D(p, 3, 7, P.steel4); D(p, 6, 7, P.steel4);
  D(p, 9, 4, P.red); D(p, 9, 6, P.green); D(p, 9, 8, P.amber); D(p, 10, 4, P.brick1); D(p, 10, 6, P.leaf2);
  R(p, 13, 5, 4, 6, P.steel5); R(p, 13, 10, 4, 1, P.steel3); R(p, 16, 5, 1, 6, P.steel3); R(p, 13, 5, 4, 1, P.white);
  R(p, 17, 7, 9, 2, P.wood5); R(p, 17, 8, 9, 1, P.wood4); R(p, 20, 7, 1, 2, P.wood3);
  bevel(p, 26, 5, 5, 7, P.steel4, P.steel3, P.steel2);
  R(p, 2, 0, 3, 2, P.amber); D(p, 2, 0, P.yellow); R(p, 2, 1, 3, 1, P.orange);
  R(p, 0, 27, 32, 1, P.amber); for (let x = 0; x < 32; x += 4) R(p, x, 27, 2, 1, P.steel1);
  return p.outline(P.steel1);
}

// 16 x 30 drill press
function pressPix() {
  const p = canvas(16, 30);
  R(p, 9, 3, 3, 23, P.steel3); R(p, 9, 3, 1, 23, P.steel4); R(p, 11, 3, 1, 23, P.steel2);
  bevel(p, 1, 0, 13, 9, P.steel4, P.steel3, P.steel2);
  R(p, 3, 2, 5, 2, P.amber); R(p, 3, 3, 5, 1, P.orange); D(p, 11, 2, P.red); D(p, 11, 5, P.green);
  R(p, 4, 9, 3, 4, P.steel5); R(p, 6, 9, 1, 4, P.steel3); R(p, 5, 13, 1, 4, P.steel4);
  R(p, 13, 5, 2, 1, P.steel2); R(p, 14, 5, 1, 4, P.steel2); D(p, 14, 8, P.red);
  R(p, 1, 19, 12, 2, P.steel4); R(p, 1, 19, 12, 1, P.steel5); R(p, 1, 21, 12, 1, P.steel2);
  R(p, 0, 26, 15, 4, P.steel3); R(p, 0, 26, 15, 1, P.steel4); R(p, 0, 29, 15, 1, P.steel1); R(p, 14, 27, 1, 3, P.steel2);
  return p.outline(P.steel1);
}

// 32 x 13 staging pallet
function palletPix() {
  const p = canvas(32, 13);
  R(p, 0, 0, 32, 9, P.wood5);
  for (const y of [2, 5]) R(p, 0, y, 32, 1, P.wood3);
  R(p, 0, 0, 32, 1, P.wood6); R(p, 0, 8, 32, 1, P.wood4);
  for (const x of [0, 13, 27]) { R(p, x, 9, 5, 4, P.wood3); R(p, x, 9, 5, 1, P.wood2); R(p, x + 4, 9, 1, 4, P.wood2); }
  return p.outline(P.wood1);
}

function crateOn(p, x, y, w, h) {
  bevel(p, x, y, w, h, P.wood5, P.wood4, P.wood3);
  R(p, x + 2, y + 2, w - 4, 1, P.wood3); R(p, x + 2, y + h - 3, w - 4, 1, P.wood3);
  for (let i = 3; i < Math.min(w, h) - 3; i++) D(p, x + i, y + i, P.wood3);
  R(p, x + w - 6, y + 3, 3, 3, P.paper); D(p, x + w - 5, y + 4, P.brick2);
}
// 32 x 26 stack of three crates (decoration)
function crateStackPix() {
  const p = canvas(32, 26);
  crateOn(p, 0, 12, 15, 14); crateOn(p, 16, 14, 16, 12); crateOn(p, 7, 0, 15, 13);
  return p.outline(P.wood1);
}

const BARREL = [
  '...cdddddc....',
  '.cdeeeeeeedc..',
  '.deeddddddeeb.',
  '.cdddccccdddb.',
  '.bccccccccccb.',
  '.444444444432.',
  '.dedcccccccbb.',
  '.dedcccccccbb.',
  '.dedccccccbbb.',
  '.444444444432.',
  '.dedccccccbbb.',
  '.dedccccccbbb.',
  '.dedcccccbbbb.',
  '.444444444432.',
  '.cdccccccbbba.',
  '..bccccbbbba..',
];
const BROOM = [
  '.........cd',
  '........cd.',
  '........c..',
  '.......cd..',
  '.......c...',
  '......cd...',
  '......c....',
  '.....cd....',
  '.....c.....',
  '....cd.....',
  '....c......',
  '...cd......',
  '...c.......',
  '..cd.......',
  '..c........',
  '.BB........',
  'BCCB.......',
  'yYyYy......',
  'YyYyyo.....',
  'yYyoYy.....',
  'YyoYyo.....',
  'yoYyoyo....',
];
const PLANT = [
  '......N.......',
  '.N....N....N..',
  '.NM..NO...NM..',
  '..NM.NM..NM...',
  '..MN.NM.NML...',
  'N..MNNMNNM..N.',
  'NM.MNOMNML.NM.',
  '.NMLMNMNMLNM..',
  '..NMMNONMMM...',
  '...LMNMNML....',
  '....LMMML.....',
  '.....LML......',
  '...SSSSSSSS...',
  '...RSSSSSRR...',
  '....RSSSRR....',
  '....RSSSRT....',
  '....RRSRRT....',
  '.....RRRT.....',
];
const HANGING = [
  '.....2......',
  '.....2......',
  '....2.2.....',
  '...2...2....',
  '..PPPPPPPP..',
  '.NPxPPPPxPN.',
  'NMNxxxxxxNMN',
  'NML.xxxx.LMN',
  'ML.N....N.LM',
  'N..M....M..N',
  'M..N....ML..',
  '...M....N...',
  '...N........',
];

function mapPix(list, outline) {
  let w = 0;
  for (const r of list) w = Math.max(w, r.length);
  const p = canvas(w, list.length);
  rows(p, 0, 0, list);
  return outline ? p.outline(outline) : p;
}

// 100 x 40 flatbed truck facing right (outline included, origin = truck origin). frame 0/1 = wheel rotation.
function truckPix(frame) {
  const p = new Pix(100, 40);
  const r = (x, y, w, h, c) => p.rect(x, y, w, h, c);
  // far rail, bed floor
  r(3, 5, 55, 5, P.wood3); r(3, 5, 55, 1, P.wood5); r(3, 9, 55, 1, P.wood2);
  for (let x = 11; x < 57; x += 9) r(x, 6, 1, 3, P.wood2);
  r(3, 10, 55, 15, P.wood5);
  for (let y = 13; y < 25; y += 4) r(4, y, 53, 1, P.wood4);
  r(3, 10, 55, 1, P.wood4); r(3, 10, 2, 15, P.wood3); r(56, 10, 2, 15, P.wood4);
  // near side panel with steel stakes
  r(2, 25, 57, 7, P.wood4); r(2, 25, 57, 1, P.wood6); r(2, 28, 57, 1, P.wood3); r(2, 31, 57, 1, P.wood2);
  for (const x of [2, 20, 39, 57]) { r(x, 24, 2, 8, P.steel3); r(x, 24, 1, 8, P.steel4); }
  // chassis
  r(4, 32, 92, 3, P.steel1); r(4, 32, 92, 1, P.steel2);
  // exhaust stack behind the cab
  r(61, 2, 2, 12, P.steel3); r(61, 2, 1, 12, P.steel4); r(60, 1, 4, 2, P.steel2);
  // cab (crimson)
  r(64, 6, 24, 4, P.brick3); r(64, 6, 24, 1, P.pink); r(64, 9, 24, 1, P.brick2);
  r(63, 10, 28, 22, P.brick2); r(63, 10, 1, 22, P.brick3); r(63, 10, 26, 1, P.brick3);
  r(89, 10, 2, 9, P.brick1);
  r(91, 19, 6, 13, P.brick2); r(91, 19, 6, 1, P.brick3); r(96, 20, 1, 12, P.brick1);
  r(63, 30, 34, 2, P.brick1);
  r(66, 12, 14, 8, P.sky); r(66, 12, 14, 1, P.steel5); r(67, 14, 2, 4, P.white); r(70, 15, 1, 2, P.white); r(66, 19, 14, 1, P.blue);
  r(82, 12, 7, 8, P.sky); r(82, 12, 7, 1, P.steel5); r(87, 13, 1, 6, P.blue); r(82, 19, 7, 1, P.blue);
  r(80, 11, 2, 20, P.brick1); r(65, 21, 15, 1, P.brick1); r(76, 23, 3, 1, P.steel5);
  r(67, 25, 10, 3, P.paper); r(68, 26, 8, 1, P.amber);
  r(94, 22, 3, 3, P.yellow); r(95, 23, 2, 1, P.white);
  r(91, 29, 7, 3, P.steel4); r(91, 29, 7, 1, P.steel5); r(91, 31, 7, 1, P.steel2);
  r(1, 29, 2, 3, P.red);
  // wheels
  for (const cx of [17, 80]) {
    r(cx - 7, 28, 15, 4, P.shadow);
    r(cx - 5, 28, 11, 11, P.steel1); r(cx - 6, 30, 13, 7, P.steel1); r(cx - 4, 27, 9, 1, P.steel1);
    r(cx - 4, 29, 9, 9, P.shadow); r(cx - 5, 31, 11, 5, P.shadow);
    r(cx - 2, 31, 5, 5, P.steel3); r(cx - 1, 32, 3, 3, P.steel5);
    if (frame) { p.set(cx - 2, 31, P.steel2); p.set(cx + 2, 35, P.steel2); p.set(cx, 33, P.steel2); }
    else { p.set(cx + 2, 31, P.steel2); p.set(cx - 2, 35, P.steel2); p.set(cx, 33, P.steel2); }
  }
  return p.outline(P.ink);
}

// 16 x 15 dolly robot. dir: 'S' | 'N' | 'E' (mirror for W). frame 0/1 = wheels and antenna light.
function dollyPix(dir, frame) {
  const p = canvas(16, 15);
  R(p, 1, 4, 14, 3, P.steel4); R(p, 1, 4, 14, 1, P.steel5); R(p, 1, 6, 14, 1, P.steel3);
  R(p, 2, 7, 12, 5, P.amber); R(p, 2, 7, 12, 1, P.yellow); R(p, 13, 8, 1, 4, P.orange); R(p, 2, 11, 12, 1, P.orange);
  if (dir === 'S') { R(p, 4, 8, 8, 3, P.navy1); D(p, 6, 9, P.sky); D(p, 9, 9, P.sky); D(p, 5, 8, P.navy3); }
  else if (dir === 'N') { R(p, 5, 8, 6, 1, P.orange); R(p, 5, 10, 6, 1, P.orange); R(p, 7, 9, 2, 1, P.red); }
  else { R(p, 8, 8, 5, 3, P.navy1); D(p, 11, 9, P.sky); D(p, 9, 8, P.navy3); R(p, 3, 9, 3, 1, P.orange); }
  const w = (x) => { R(p, x, 11, 3, 3, P.steel1); D(p, x + 1, 12, frame ? P.steel4 : P.steel3); };
  w(2); w(11);
  R(p, 5, 12, 6, 1, P.steel2);
  const ax = dir === 'E' ? 3 : 13;
  R(p, ax, 1, 1, 3, P.steel3); D(p, ax, 0, frame ? P.lime : P.green);
  return p.outline(P.ink);
}

// 64 x 18 roll-up shutter (opaque)
function shutterPix() {
  const p = new Pix(64, 18);
  for (let y = 0; y < 18; y++) p.rect(0, y, 64, 1, y % 3 === 0 ? P.steel5 : y % 3 === 1 ? P.steel4 : P.steel3);
  p.rect(0, 0, 1, 18, P.steel2); p.rect(63, 0, 1, 18, P.steel2);
  p.rect(28, 12, 8, 2, P.steel1); p.rect(0, 16, 64, 2, P.amber);
  for (let x = 0; x < 64; x += 8) { p.rect(x, 16, 4, 1, P.steel1); p.rect(x + 2, 17, 4, 1, P.steel1); }
  return p;
}

// 60 x 17 office front: a glass pane on the left and a doorway on the right. A low service counter stands in the
// doorway and carries the inbox and the outbox tray, so work is handed over the counter, never through the glass.
// Rows 14-16 (the counter front) reach 3 px into the aisle.
function glassPix() {
  const p = new Pix(60, 17);
  // glass pane, x 0..23
  p.rect(0, 0, 24, 1, P.steel4); p.rect(0, 1, 24, 1, P.steel2);
  p.rect(0, 2, 24, 8, GLASS);
  for (let k = 0; k < 5; k++) { p.set(9 - k, 3 + k, GLINT); p.set(12 - k, 3 + k, GLINT); }
  p.rect(0, 10, 24, 3, P.steel3); p.rect(0, 10, 24, 1, P.steel4); p.rect(0, 13, 24, 1, P.steel1);
  for (const x of [0, 22, 58]) { p.rect(x, 0, 2, 14, P.steel3); p.rect(x, 0, 1, 13, P.steel4); p.rect(x, 13, 2, 1, P.steel1); }
  // service counter in the doorway, x 24..57: top rows 5-12, front rows 13-15
  p.rect(24, 4, 34, 1, P.wood1);
  p.rect(24, 5, 34, 8, P.wood5); p.rect(24, 5, 34, 1, P.wood6); p.rect(24, 12, 34, 1, P.wood4);
  p.rect(24, 13, 34, 3, P.wood3); p.rect(24, 13, 34, 1, P.wood2); p.rect(24, 16, 34, 1, P.wood1);
  p.rect(24, 5, 1, 12, P.wood1); p.rect(57, 5, 1, 12, P.wood1);
  for (const x of [32, 41, 50]) p.rect(x, 14, 1, 2, P.wood2);
  // trays (inbox: cream, outbox: amber)
  const tray = (x, top, front, edge) => {
    p.rect(x - 1, 6, 14, 6, P.steel1);
    p.rect(x, 7, 12, 2, top); p.rect(x, 9, 12, 2, front); p.rect(x, 10, 12, 1, edge);
  };
  tray(26, P.white, P.paper, P.paper2);
  tray(44, P.yellow, P.amber, P.orange);
  for (let x = 45; x < 55; x += 4) p.rect(x, 10, 2, 1, P.steel1);
  p.rect(29, 9, 6, 1, P.steel3);
  return p;
}

// 11 x 23 water cooler
function coolerPix() {
  const p = canvas(11, 23);
  R(p, 3, 0, 5, 1, P.sky);
  R(p, 2, 1, 7, 7, P.sky); R(p, 2, 4, 7, 4, P.blue); R(p, 8, 1, 1, 7, P.blue); R(p, 3, 5, 1, 2, P.sky);
  D(p, 3, 2, P.white); D(p, 3, 3, P.white); D(p, 5, 5, P.sky);
  R(p, 4, 8, 3, 1, P.steel4);
  R(p, 1, 9, 9, 12, P.paper); R(p, 1, 9, 9, 1, P.white); R(p, 9, 10, 1, 11, P.paper2); R(p, 1, 20, 9, 1, P.plaster);
  D(p, 3, 11, P.blue); D(p, 6, 11, P.red); D(p, 3, 12, P.steel3); D(p, 6, 12, P.steel3);
  R(p, 2, 14, 7, 2, P.steel3); R(p, 2, 14, 7, 1, P.steel4);
  R(p, 3, 17, 5, 1, P.plaster); R(p, 3, 19, 5, 1, P.plaster);
  R(p, 1, 21, 2, 2, P.steel2); R(p, 8, 21, 2, 2, P.steel2);
  return p.outline(P.steel1);
}

// 12 x 17 oil drum (blue steel, hazard label)
function drumPix() {
  const p = canvas(12, 17);
  R(p, 1, 0, 10, 3, P.navy4); D(p, 1, 0, null); D(p, 10, 0, null); R(p, 2, 0, 8, 1, P.sky); D(p, 7, 1, P.steel5); D(p, 4, 1, P.navy3);
  R(p, 0, 3, 12, 13, P.blue); R(p, 1, 3, 1, 13, P.sky); R(p, 10, 3, 2, 13, P.navy3);
  R(p, 0, 3, 12, 1, P.steel4); R(p, 0, 7, 12, 1, P.navy4); R(p, 0, 12, 12, 1, P.navy4); R(p, 10, 7, 2, 1, P.navy3); R(p, 10, 12, 2, 1, P.navy3);
  R(p, 4, 8, 4, 3, P.amber); R(p, 4, 8, 4, 1, P.yellow); D(p, 5, 9, P.steel1); D(p, 6, 9, P.steel1);
  R(p, 0, 15, 12, 1, P.navy3); R(p, 1, 16, 10, 1, P.navy2);
  return p.outline(P.navy1);
}

// 15 x 19 tool cart (crimson, two shelves, tools on top)
function cartPix() {
  const p = canvas(15, 19);
  R(p, 2, 1, 4, 2, P.steel4); D(p, 2, 0, P.steel5); D(p, 5, 0, P.steel5); R(p, 8, 0, 2, 3, P.amber); D(p, 8, 0, P.yellow); R(p, 11, 1, 3, 2, P.steel3); R(p, 11, 1, 3, 1, P.steel5);
  R(p, 0, 3, 15, 3, P.brick2); R(p, 0, 3, 15, 1, P.brick3); R(p, 14, 4, 1, 2, P.brick1);
  R(p, 0, 6, 1, 10, P.steel4); R(p, 14, 6, 1, 10, P.steel2);
  R(p, 1, 6, 13, 4, P.brick2); R(p, 1, 6, 13, 1, P.brick1); R(p, 5, 8, 5, 1, P.steel5); R(p, 1, 9, 13, 1, P.brick1);
  R(p, 1, 10, 13, 3, P.shadow); R(p, 3, 11, 3, 2, P.steel4); D(p, 3, 11, P.steel5); R(p, 8, 10, 4, 3, P.wood4); R(p, 8, 10, 4, 1, P.wood5);
  R(p, 0, 13, 15, 3, P.brick2); R(p, 0, 13, 15, 1, P.brick3); R(p, 0, 15, 15, 1, P.brick1);
  R(p, 1, 16, 3, 3, P.steel1); D(p, 2, 17, P.steel4); R(p, 11, 16, 3, 3, P.steel1); D(p, 12, 17, P.steel4);
  return p.outline(P.shadow);
}

// 14 x 14 cable reel lying on its side: two wooden flanges, orange cable between them
function reelPix() {
  const p = canvas(14, 14);
  R(p, 3, 2, 8, 10, P.orange); R(p, 3, 2, 8, 1, P.amber); R(p, 3, 11, 8, 1, P.rust1);
  for (const x of [4, 6, 8, 10]) R(p, x, 3, 1, 8, P.rust2);
  R(p, 0, 0, 3, 14, P.wood5); D(p, 0, 0, null); D(p, 0, 13, null); R(p, 0, 1, 1, 12, P.wood6); R(p, 2, 1, 1, 12, P.wood4); D(p, 1, 6, P.wood3); D(p, 1, 7, P.wood3);
  R(p, 11, 0, 3, 14, P.wood4); D(p, 13, 0, null); D(p, 13, 13, null); R(p, 11, 1, 1, 12, P.wood5); R(p, 13, 1, 1, 12, P.wood3); D(p, 12, 6, P.wood2); D(p, 12, 7, P.wood2);
  return p.outline(P.wood1);
}

// 16 x 20 wall decor for the offices: 0 bookshelf, 1 framed blueprint, 2 bar chart
function decorPix(kind) {
  const p = canvas(16, 20);
  if (kind === 0) {
    bevel(p, 0, 0, 16, 20, P.wood3, P.wood1, P.wood2);
    const cols = [P.red, P.amber, P.sky, P.lime, P.paper, P.pink, P.blue, P.teal];
    for (let r = 0; r < 3; r++) {
      for (let k = 0; k < 7; k++) { const h = 4 - ((k + r) % 3 === 0 ? 1 : 0); R(p, 1 + k * 2, 2 + r * 6 + (4 - h), 2, h, cols[(k * 3 + r * 5) % cols.length]); }
      R(p, 1, 6 + r * 6, 14, 1, P.wood3);
    }
  } else if (kind === 1) {
    bevel(p, 0, 2, 16, 14, P.wood5, P.wood4, P.wood2);
    R(p, 2, 4, 12, 10, P.blue); R(p, 2, 4, 12, 1, P.navy3);
    R(p, 4, 6, 5, 1, P.white); R(p, 4, 6, 1, 5, P.white); R(p, 4, 10, 8, 1, P.white); R(p, 8, 6, 1, 3, P.white); R(p, 11, 8, 1, 3, P.white); D(p, 10, 12, P.sky); D(p, 5, 12, P.sky);
  } else {
    bevel(p, 0, 1, 16, 17, P.white, P.paper, P.paper2);
    const bars = [4, 7, 5, 10, 8];
    bars.forEach((b, k) => R(p, 2 + k * 3, 15 - b, 2, b, [P.blue, P.orange, P.green, P.red, P.teal][k]));
    R(p, 1, 15, 14, 1, P.steel2);
    R(p, 7, 0, 2, 2, P.red);
  }
  return p.outline(P.wood1);
}

export const PROP_NAMES = ['bench', 'post', 'desk', 'chair', 'counter', 'shelves', 'machine', 'press', 'pallet', 'crateStack', 'barrel', 'broom', 'plant', 'hanging', 'dollyS', 'dollyE', 'dollyN', 'shutter', 'glass', 'decor0', 'decor1', 'decor2', 'cooler', 'drum', 'cart', 'reel', 'truck'];

export const Props = {
  bench() { return sprite('bench', benchPix); },
  post() { return sprite('post', postPix); },
  desk() { return sprite('desk', deskPix); },
  chair() { return sprite('chair', chairPix); },
  counter() { return sprite('counter', counterPix); },
  shelves() { return sprite('shelves', shelvesPix); },
  machine() { return sprite('machine', machinePix); },
  press() { return sprite('press', pressPix); },
  pallet() { return sprite('pallet', palletPix); },
  barrel() { return sprite('barrel', () => mapPix(BARREL, P.wood1)); },
  broom() { return sprite('broom', () => mapPix(BROOM, P.wood1)); },
  plant() { return sprite('plant', () => mapPix(PLANT, P.leaf1)); },
  hanging() { return sprite('hanging', () => mapPix(HANGING, P.leaf1)); },
  crateStack() { return sprite('crateStack', crateStackPix); },
  truck(frame) { const f = frame ? 1 : 0; return sprite('truck' + f, () => truckPix(f)); },
  dolly(dir, frame) { const d = dir === 'N' || dir === 'E' ? dir : 'S'; const f = frame ? 1 : 0; return sprite('dolly' + d + f, () => dollyPix(d, f)); },
  dollyW(frame) { const f = frame ? 1 : 0; return sprite('dollyW' + f, () => dollyPix('E', f).mirror()); },
  dollyS() { return Props.dolly('S', 0); }, dollyE() { return Props.dolly('E', 0); }, dollyN() { return Props.dolly('N', 0); },
  shutter() { return sprite('shutter', shutterPix); },
  glass() { return sprite('glass', glassPix); },
  cooler() { return sprite('cooler', coolerPix); },
  drum() { return sprite('drum', drumPix); },
  cart() { return sprite('cart', cartPix); },
  reel() { return sprite('reel', reelPix); },
  decor(kind) { const k = ((kind | 0) % 3 + 3) % 3; return sprite('decor' + k, () => decorPix(k)); },
  decor0() { return Props.decor(0); }, decor1() { return Props.decor(1); }, decor2() { return Props.decor(2); },
};

export const _pix = { benchPix, postPix, deskPix, chairPix, counterPix, shelvesPix, machinePix, pressPix, palletPix, crateStackPix, truckPix, dollyPix, shutterPix, glassPix, decorPix, coolerPix, drumPix, cartPix, reelPix, mapPix, BARREL, BROOM, PLANT, HANGING };
