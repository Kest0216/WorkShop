// WorkShop small art: doohickeys (4 growth stages per domain), bench tooling, crates, stock, icons.
// Pixel generation is pure; canvases are built lazily (DOM needed only when Items.* is called).
// Everything here is anchored bottom-center: Items.draw(ctx, img, x, y) puts the base of the sprite at (x, y).

import { PALETTE as P, domainColor } from './palette.js';
import { Pix, sprite, CM, fromRows } from './pix.js';
import { familyOf, DOMAINS, FAMILIES } from './model.js';

const S = 12;                                     // doohickeys live in a 12 x 12 box, base on row 11
function box12() { return new Pix(S + 2, S + 2); }
const R = (p, x, y, w, h, c) => p.rect(x + 1, y + 1, w, h, c);
const D = (p, x, y, c) => p.set(x + 1, y + 1, c);

// a toothed wheel centered on (cx, cy)
function gear(p, cx, cy, r, teeth, body, light, dark, hub) {
  for (let y = Math.floor(cy - r - 2); y <= cy + r + 2; y++) for (let x = Math.floor(cx - r - 2); x <= cx + r + 2; x++) {
    const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
    const a = Math.atan2(dy, dx);
    const tooth = Math.cos(a * teeth) > 0.25;
    if (d <= r || (tooth && d <= r + 1.35)) D(p, x, y, d < r - 0.2 && dx + dy < -r * 0.5 ? light : dx + dy > r * 0.8 ? dark : body);
    if (d < r * 0.36) D(p, x, y, hub);
  }
}

// ---------------------------------------------------------------- doohickeys: family x stage (variant = second domain of the family)

const DOOHICKEY = {
  machine(p, s, v) {
    const body = v ? P.straw : P.steel4, light = v ? P.yellow : P.steel5, dark = v ? P.wood4 : P.steel3;
    if (s === 0) { R(p, 3, 7, 6, 2, light); R(p, 3, 9, 6, 3, body); R(p, 8, 9, 1, 3, dark); return; }
    if (s === 1) { for (let y = 5; y <= 11; y++) { const w = [3, 5, 7, 7, 7, 5, 3][y - 5]; R(p, 6 - (w >> 1), y, w, 1, body); } R(p, 5, 6, 2, 1, light); R(p, 5, 8, 2, 2, P.steel1); return; }
    if (s === 2) { gear(p, 5.5, 7, 3.2, 8, body, light, dark, P.steel1); return; }
    gear(p, 4.5, 6.5, 3.2, 8, body, light, dark, P.steel1);
    gear(p, 9, 3.5, 1.8, 6, v ? P.steel4 : P.straw, v ? P.steel5 : P.yellow, v ? P.steel3 : P.wood4, P.steel1);
    R(p, 1, 11, 10, 1, P.steel2);
  },
  paint(p, s, v) {
    if (v) {       // a picture frame
      if (s === 0) { R(p, 2, 9, 8, 2, P.wood5); R(p, 2, 10, 8, 1, P.wood4); R(p, 2, 5, 2, 4, P.wood5); R(p, 3, 5, 1, 4, P.wood4); return; }
      R(p, 1, 2, 10, 10, P.wood5); R(p, 1, 2, 10, 1, P.wood6); R(p, 10, 3, 1, 9, P.wood3); R(p, 1, 11, 10, 1, P.wood3);
      R(p, 3, 4, 6, 6, s === 1 ? null : P.white);
      if (s === 3) { R(p, 3, 4, 6, 3, P.sky); R(p, 3, 7, 6, 3, P.leaf3); D(p, 7, 5, P.yellow); R(p, 4, 6, 2, 1, P.leaf2); R(p, 3, 9, 6, 1, P.leaf2); R(p, 1, 2, 10, 1, P.brick3); R(p, 1, 3, 1, 9, P.brick2); R(p, 10, 3, 1, 9, P.brick1); R(p, 1, 11, 10, 1, P.brick1); }
      return;
    }
    // a little chair
    const paintC = s === 3 ? P.brick2 : P.wood5, paintL = s === 3 ? P.brick3 : P.wood6, paintD = s === 3 ? P.brick1 : P.wood4;
    R(p, 3, 7, 7, 2, paintC); R(p, 3, 7, 7, 1, paintL);
    R(p, 3, 9, 1, 3, paintD); R(p, 9, 9, 1, 3, paintD);
    if (s >= 1) { R(p, 5, 9, 1, 2, paintD); R(p, 7, 9, 1, 2, paintD); }
    if (s >= 2) { R(p, 3, 1, 1, 6, paintC); R(p, 9, 1, 1, 6, paintD); R(p, 4, 2, 5, 1, paintC); R(p, 4, 4, 5, 1, paintC); R(p, 3, 1, 7, 1, paintL); }
    if (s === 3) D(p, 6, 3, P.yellow);
  },
  study(p, s, v) {
    if (v) {       // a scroll
      if (s === 0) { R(p, 3, 9, 7, 3, P.paper); R(p, 3, 11, 7, 1, P.paper2); return; }
      R(p, 2, 5, 8, 6, P.paper); R(p, 2, 10, 8, 1, P.paper2);
      R(p, 3, 7, 5, 1, P.steel3); if (s >= 2) R(p, 3, 9, 4, 1, P.steel3);
      R(p, 1, 3, 10, 2, P.paper2); R(p, 1, 3, 10, 1, P.white); D(p, 0, 3, P.wood4); D(p, 11, 3, P.wood4); D(p, 0, 4, P.wood3); D(p, 11, 4, P.wood3);
      if (s === 3) { R(p, 1, 10, 10, 2, P.paper2); R(p, 1, 10, 10, 1, P.white); R(p, 5, 9, 2, 3, P.brick2); D(p, 5, 9, P.brick3); }
      return;
    }
    // books
    if (s === 0) { R(p, 3, 10, 7, 2, P.paper); R(p, 3, 11, 7, 1, P.paper2); R(p, 4, 9, 6, 1, P.white); return; }
    R(p, 2, 8, 9, 4, P.blue); R(p, 2, 8, 9, 1, P.sky); R(p, 2, 11, 9, 1, P.navy3); R(p, 3, 10, 7, 1, P.paper);
    if (s >= 2) { R(p, 3, 4, 8, 4, P.brick2); R(p, 3, 4, 8, 1, P.brick3); R(p, 3, 7, 8, 1, P.brick1); R(p, 4, 6, 6, 1, P.paper); }
    if (s === 3) { R(p, 2, 1, 8, 3, P.leaf3); R(p, 2, 1, 8, 1, P.leaf4); R(p, 3, 3, 6, 1, P.paper); R(p, 8, 4, 1, 3, P.yellow); }
  },
  gauge(p, s, v) {
    R(p, 2, 10, 8, 2, P.steel3); R(p, 2, 10, 8, 1, P.steel4);
    R(p, 3, 6, 6, 4, P.steel4); R(p, 3, 6, 6, 1, P.steel5); R(p, 8, 7, 1, 3, P.steel3);
    if (s >= 1) { R(p, 5, 3, 2, 3, P.steel4); R(p, 5, 3, 2, 1, P.steel5); D(p, 6, 4, P.steel3); }
    if (s >= 2) { D(p, 4, 8, P.steel2); D(p, 6, 8, P.steel2); D(p, 4, 7, P.red); R(p, 1, 9, 10, 1, P.amber); }
    // finished: no check mark here (a check means "passed review" and belongs to the PASS stamp only)
    if (s === 3 && !v) {       // test: a dial with the needle in the green zone
      R(p, 7, 0, 5, 5, P.steel4); D(p, 7, 0, null); D(p, 11, 0, null); D(p, 7, 4, null); D(p, 11, 4, null);
      R(p, 8, 1, 3, 3, P.paper); D(p, 8, 1, P.red); D(p, 9, 1, P.amber); D(p, 10, 1, P.green);
      D(p, 9, 3, P.steel1); D(p, 10, 2, P.steel1); R(p, 8, 4, 3, 1, P.steel3);
    } else if (s === 3) {      // review: a paper tag on a string
      R(p, 8, 1, 4, 5, P.paper); D(p, 8, 1, null); R(p, 8, 5, 4, 1, P.paper2);
      D(p, 9, 2, P.steel2); R(p, 9, 4, 2, 1, P.steel3); D(p, 7, 2, P.straw);
    }
  },
  press(p, s) {
    if (s === 0) { R(p, 2, 10, 8, 2, P.paper); R(p, 2, 11, 8, 1, P.paper2); return; }
    R(p, 2, 6, 9, 6, P.paper); R(p, 2, 11, 9, 1, P.paper2); R(p, 10, 7, 1, 5, P.paper2);
    R(p, 4, 8, 5, 1, P.steel3);
    if (s >= 2) { R(p, 2, 5, 9, 6, P.teal); R(p, 2, 5, 9, 1, P.leaf4); R(p, 2, 6, 1, 5, P.tealc1); R(p, 4, 7, 5, 2, P.paper); R(p, 2, 11, 9, 1, P.paper); }
    if (s === 3) { R(p, 1, 9, 10, 3, P.paper2); R(p, 1, 9, 10, 1, P.paper); R(p, 3, 3, 9, 6, P.teal); R(p, 3, 3, 9, 1, P.leaf4); R(p, 3, 4, 1, 5, P.tealc1); R(p, 5, 5, 5, 2, P.paper); D(p, 6, 6, P.steel3); D(p, 8, 6, P.steel3); }
  },
  files(p, s) {
    R(p, 1, 7, 10, 5, P.wood4); R(p, 1, 7, 10, 1, P.wood5); R(p, 10, 8, 1, 4, P.wood3); R(p, 1, 11, 10, 1, P.wood3);
    R(p, 2, 6, 8, 1, P.wood2);
    if (s >= 1) { R(p, 3, 4, 3, 3, P.paper); D(p, 3, 4, P.amber); }
    if (s >= 2) { R(p, 6, 3, 3, 4, P.white); D(p, 8, 3, P.sky); R(p, 4, 5, 3, 2, P.paper2); D(p, 4, 5, P.pink); }
    if (s === 3) { R(p, 2, 2, 2, 5, P.paper); D(p, 2, 2, P.lime); R(p, 9, 4, 1, 3, P.paper2); R(p, 4, 9, 4, 2, P.paper); D(p, 5, 10, P.steel3); D(p, 6, 10, P.steel3); }
  },
  solder(p, s, v) {
    const pcb = v ? P.teal : P.leaf3, pcbL = v ? P.leaf4 : P.leaf4, pcbD = v ? P.tealc1 : P.leaf2;
    R(p, 1, 5, 10, 6, pcb); R(p, 1, 5, 10, 1, pcbL); R(p, 1, 10, 10, 1, pcbD); R(p, 10, 6, 1, 4, pcbD);
    D(p, 1, 11, P.steel2); D(p, 10, 11, P.steel2);
    if (s >= 1) { R(p, 2, 7, 4, 1, P.straw); R(p, 5, 7, 1, 3, P.straw); R(p, 7, 9, 3, 1, P.straw); }
    if (s >= 2) { R(p, 6, 6, 3, 2, P.steel1); D(p, 6, 6, P.steel3); R(p, 2, 8, 2, 2, P.steel1); }
    if (s === 3) { D(p, 9, 6, P.lime); D(p, 9, 5, P.white); D(p, 3, 6, P.red); R(p, 8, 3, 1, 2, P.steel4); D(p, 9, 2, P.steel4); D(p, 4, 9, P.amber); }
  },
  plan(p, s) {
    R(p, 1, 5, 10, 7, P.blue); R(p, 1, 5, 10, 1, P.sky); R(p, 1, 11, 10, 1, P.navy3);
    if (s >= 1) { R(p, 2, 7, 4, 1, P.white); R(p, 2, 7, 1, 3, P.white); }
    if (s >= 2) { R(p, 7, 7, 3, 3, P.sky); R(p, 2, 10, 6, 1, P.white); D(p, 8, 8, P.white); }
    if (s === 3) { R(p, 0, 3, 12, 2, P.paper); R(p, 0, 3, 12, 1, P.white); R(p, 5, 2, 2, 4, P.brick2); }
  },
};

const VARIANT = new Set(['algo', 'vision', 'synthesis', 'review', 'chore']);

function doohickeyPix(family, stage, variant) {
  const p = box12();
  (DOOHICKEY[family] || DOOHICKEY.machine)(p, Math.max(0, Math.min(3, stage | 0)), !!variant);
  return p.outline();
}

// ---------------------------------------------------------------- bench tooling per family (bottom-center anchored, about 12 px wide)

const TOOLING = {
  machine: ['..........2.', '....44....2.', '....33..2222', '.5555555.2..', '.4333332.2..', '.4355532....', '.4333332....', '.2222222....', '.1.....1....'],
  paint: ['....d.......', '....d...d...', '....c...c...', '.BBB.uuu.YYY', '.555.555.555', '.535.535.535', '.444.444.444', '.222.222.222'],
  study: ['..yYy.......', '.yYYYy......', '.oyyyo......', '...2........', '...2...CCCC.', '...2...PPPP.', '...2..uuuuu.', '..222.PPPPP.', '.22222ttttt.'],
  gauge: ['.44444......', '4PPPPP4.444.', '4PPrPP4.4P4.', '4PP2PP4.444.', '4PPPPP4..2..', '.44444...2..', '..222...222.', '.22222.2222.'],
  press: ['....22......', '...2222.....', '.....2......', '.444444444..', '.4.......4..', '.4.PPPPP.4..', '.4.PPPPP.4..', '.333333333..', '.2.......2..'],
  files: ['.ddddddddd..', '.deeeeeeec..', '.de.22.eec..', '.deeeeeeec..', '.dccccccc...', '.deeeeeeec..', '.de.22.eec..', '.deeeeeeec..', '.bbbbbbbbb..'],
  solder: ['.........2..', '........2...', '.......Y....', '.2222..4....', '.2lg2.4.....', '.2222.33.RR.', '.2uu2.32.SS.', '.2221.32.RR.'],
  plan: ['..........e.', '.........e..', '.uuuuuuuePP.', '.uwwuuuewuQ.', '.uwuuweuuuQ.', '.uwwueuwwuQ.', '.unnennnnnQ.', '...e........'],
};
const TOOL_CM = { ...CM, n: P.navy3 };

// ---------------------------------------------------------------- crates, stock, icons

function cratePix(domain) {
  const p = new Pix(14, 13);
  p.rect(1, 1, 12, 11, P.wood4);
  p.rect(1, 1, 12, 1, P.wood6); p.rect(1, 2, 1, 10, P.wood5); p.rect(12, 2, 1, 10, P.wood3); p.rect(1, 11, 12, 1, P.wood3);
  p.rect(3, 3, 8, 1, P.wood3); p.rect(3, 9, 8, 1, P.wood3);
  p.rect(4, 4, 6, 5, P.paper); p.rect(4, 4, 6, 2, domainColor(domain)); p.rect(5, 7, 4, 1, P.steel3);
  return p.outline(P.wood1);
}

const STOCK = {
  lumber: ['fffffffffff', 'fefeefeeefd', 'ddddddddddc', 'fffffffffff', 'feefefefeed', 'ccccccccccc'],
  metal: ['55555555555', '44344434443', '22222222222', '55555555555', '43444344432', '11111111111'],
  boxes: ['.PPPPPPPPP.', '.PQQyyQQQQ.', '.PQQyyQQQx.', '.PQQQQ22Qx.', '.PQQQQQQQx.', '.Qxxxxxxxx.'],
};

const ICONS = {
  hourglass: ['2222222', '.4PPP4.', '.4yyy4.', '..4y4..', '...4...', '..4y4..', '.4PyP4.', '.4yyy4.', '2222222'],
  bang: ['rrr', 'rCr', 'rrr', 'rrr', 'rrr', '.r.', '...', 'rrr', 'rrr'],
  dots: ['.wwwwwwwww.', 'wwwwwwwwwww', 'wwwwwwwwwww', 'wwwwwwwwwww', '.wwwwwwwww.', '..ww.......', '.w.........'],
  pass: ['...ggggg...', '..gggggggg.', '.gggggggwgg', '.ggggggwwgg', '.gwgggwwggg', '.gwwgwwgggg', '.ggwwwggggg', '.gggwgggggg', '..gggggggg.', '...ggggg...'],
  fail: ['...rrrrr...', '..rrrrrrrr.', '.rrwrrrwrrr', '.rrwwrwwrrr', '.rrrwwwrrrr', '.rrrwwwrrrr', '.rrwwrwwrrr', '.rrwrrrwrrr', '..rrrrrrrr.', '...rrrrr...'],
  // counter bell, 11 x 9: dark plunger knob, rounded brass dome with a 1 px highlight, flat steel base plate
  bell: ['....111....', '.....1.....', '...yYYYy...', '..yYwYYyy..', '.yYwYyyyyo.', '.yYYyyyyyo.', 'yyyyyyyyyoo', '44444444443', '.222222222.'],
  // the ring: the plunger is pressed down, then the dome wobbles left and right on its base
  bellHit: ['...........', '....111....', '...yYYYy...', '..yYwYYyy..', '.yYwYyyyyo.', '.yYYyyyyyo.', 'yyyyyyyyyoo', '44444444443', '.222222222.'],
  bellL: ['...111.....', '....1......', '..yYYYy....', '.yYwYYyy...', '.yYwYyyyyo.', '.yYYyyyyyo.', 'yyyyyyyyyoo', '44444444443', '.222222222.'],
  bellR: ['.....111...', '......1....', '....yYYYy..', '...yYwYYyy.', '.yYwYyyyyo.', '.yYYyyyyyo.', 'yyyyyyyyyoo', '44444444443', '.222222222.'],
  note: ['.YY', '.Yw', '.Y.', 'YY.', 'YY.'],
  // a small test gauge on an item that is being checked at the bench (to_office); the needle swings between two frames
  dial0: ['.yyyyy.', 'yl1PPry', 'yP1PPPy', 'yPP1PPy', 'o22222o'],
  dial1: ['.yyyyy.', 'ylPP1ry', 'yPPP1Py', 'yPP1PPy', 'o22222o'],
  slip: ['PPPPPPPP', 'P3333PPP', 'PPPPPPPP', 'P333P3PP', 'PPPPPPPQ', 'QQQQQQQQ'],
  redtag: ['rrrrr', 'rwrwr', 'rrwrr', 'rwrwr', 'rrrrr'],
  zzz: ['sss..', '..s..', '.s...', 'sss..'],
  person: ['.PPP.', '.PPP.', '..P..', 'PPPPP', 'PPPPP', '.P.P.', '.P.P.'],
};
export const ICON_NAMES = Object.keys(ICONS);
const PLAIN = new Set(['zzz', 'person']);

// Blueprint lying on a desk (boss planning), 24 x 8.
function blueprintPix() {
  const p = new Pix(24, 9);
  p.rect(1, 1, 22, 7, P.blue); p.rect(1, 1, 22, 1, P.sky); p.rect(1, 7, 22, 1, P.navy3);
  p.rect(1, 1, 2, 7, P.paper); p.rect(21, 1, 2, 7, P.paper2);
  for (const [x, y, w] of [[5, 3, 6], [5, 5, 3], [13, 3, 5], [10, 5, 8], [13, 4, 1], [17, 4, 1]]) p.rect(x, y, w, 1, P.white);
  return p.outline(P.navy1);
}

function resolve(name) {
  const dom = DOMAINS.includes(name) ? name : null;
  const fam = dom ? familyOf(dom) : FAMILIES.includes(name) ? name : 'machine';
  return { fam, variant: dom ? VARIANT.has(dom) : false };
}

export const Items = {
  // name: a task domain or a family name
  doohickey(name, stage) { const { fam, variant } = resolve(name); const s = Math.max(0, Math.min(3, stage | 0)); return sprite('dooh_' + fam + (variant ? 'v' : '') + s, () => doohickeyPix(fam, s, variant)); },
  tooling(name) { const { fam } = resolve(name); return sprite('tool_' + fam, () => fromRows(TOOLING[fam] || TOOLING.machine, TOOL_CM, true)); },
  crate(domain) { const d = DOMAINS.includes(domain) ? domain : 'none'; return sprite('crate_' + d, () => cratePix(d)); },
  stock(kind) { const k = STOCK[kind] ? kind : 'boxes'; return sprite('stock_' + k, () => fromRows(STOCK[k], CM, true)); },
  icon(name) { const n = ICONS[name] ? name : 'bang'; return sprite('icon_' + n, () => fromRows(ICONS[n], CM, !PLAIN.has(n))); },
  blueprint() { return sprite('blueprint', blueprintPix); },
  // bottom-center anchored drawing
  draw(ctx, img, x, y) { ctx.drawImage(img, Math.round(x) - (img.width >> 1), Math.round(y) - img.height + 1); },
};

export const _pix = { doohickeyPix, cratePix, blueprintPix, TOOLING, STOCK, ICONS, resolve };
