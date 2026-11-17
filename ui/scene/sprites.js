// WorkShop characters: the layered chibi generator (16 x 32 px figures) and the atlas cache.
// Pixel generation is pure (works in Node); only characterAtlas() touches the DOM, and only when called.
//
// A figure is drawn in local coordinates x 0..15, y 0..31 (hair top near row 6, feet on row 30) inside a
// 24 x 32 buffer with a 4 px side margin, so raised tools, clipboards and pony tails have room.
// Draw a frame at (feet.x - CHAR_AX, feet.y - CHAR_AY).

import { PALETTE as P, providerColor } from './palette.js';
import { Pix } from './pix.js';
import { lookFromSeed, hashString, HEADGEAR, TOOLS, HAIR_STYLES } from './model.js';

export const CHAR_W = 24, CHAR_H = 32, CHAR_AX = 12, CHAR_AY = 31;
const OX = 4;

// ---------------------------------------------------------------- colors of a look

// skin: [base, shade, blush]
const SKINS = [[P.skin1, P.skin2, P.pink, null], [P.skin2, P.skin3, P.rust3, null], [P.skin3, P.skin4, null, P.paper], [P.skin4, P.wood1, null, P.paper2]];
// ramps: [light, base, shade, dark]
const HAIRS = [
  [P.steel2, P.steel1, P.shadow, P.ink],        // black
  [P.wood3, P.wood2, P.wood1, P.shadow],        // dark brown
  [P.wood4, P.wood3, P.wood2, P.wood1],         // brown
  [P.rust3, P.rust2, P.rust1, P.wood1],         // auburn
  [P.orange, P.rust3, P.rust2, P.rust1],        // ginger
  [P.yellow, P.straw, P.wood4, P.wood3],        // blonde
  [P.white, P.steel5, P.steel4, P.steel3],      // silver
  [P.navy4, P.navy3, P.navy2, P.navy1],         // dyed blue
];
const GEARS = [
  [P.pink, P.red, P.brick2, P.brick1],
  [P.sky, P.blue, P.navy3, P.navy2],
  [P.lime, P.green, P.leaf2, P.leaf1],
  [P.yellow, P.amber, P.orange, P.rust3],
  [P.navy4, P.purple, P.navy3, P.navy2],
  [P.leaf4, P.teal, P.tealc1, P.leaf1],
];
const HARDHATS = [
  [P.white, P.yellow, P.amber, P.orange],
  [P.white, P.steel5, P.steel4, P.steel3],
  [P.yellow, P.orange, P.rust3, P.rust2],
  [P.sky, P.blue, P.navy3, P.navy2],
];
const SHIRTS = [[P.paper, P.paper2], [P.steel4, P.steel3], [P.sky, P.blue], [P.leaf4, P.leaf3], [P.yellow, P.amber], [P.pink, P.brick3]];
const APRONS = [[P.wood4, P.wood3], [P.brick2, P.brick1], [P.navy3, P.navy2], [P.leaf3, P.leaf2], [P.teal, P.tealc1], [P.purple, P.navy2], [P.steel3, P.steel2], [P.rust3, P.rust2]];
const PANTS = [[P.navy2, P.navy1], [P.wood2, P.wood1], [P.steel2, P.steel1], [P.tealc1, P.navy1], [P.steel1, P.shadow]];
const SUITS = [[P.navy3, P.navy2], [P.steel2, P.steel1], [P.wood3, P.wood2], [P.brick2, P.brick1], [P.leaf2, P.leaf1]];
const VESTS = [[P.amber, P.orange], [P.lime, P.leaf3], [P.orange, P.rust3]];
const SHOES = [[P.wood2, P.wood1], [P.steel2, P.steel1], [P.rust2, P.rust1]];

const at = (arr, i) => arr[(((i | 0) % arr.length) + arr.length) % arr.length];

// Colors for an abstract look from model.js lookFromSeed().
export function renderLook(base, provider) {
  const b = base && typeof base === 'object' ? base : {};
  const role = b.role === 'boss' || b.role === 'manager' ? b.role : 'maker';
  const look = {
    role,
    skin: at(SKINS, b.skin),
    hair: at(HAIRS, b.hairColor),
    hairStyle: HAIR_STYLES.includes(b.hairStyle) ? b.hairStyle : 'crop',
    hat: role === 'manager' ? 'hardhat' : role === 'boss' ? 'none' : HEADGEAR.includes(b.hat) ? b.hat : 'none',
    gear: role === 'manager' ? at(HARDHATS, b.gear) : at(GEARS, b.gear),
    shirt: role === 'boss' ? [P.white, P.steel5] : at(SHIRTS, b.shirt),
    apron: role === 'maker' ? at(APRONS, b.apron) : role === 'manager' ? at(VESTS, b.apron) : at(SUITS, b.apron),
    pants: at(PANTS, b.pants),
    shoes: at(SHOES, (b.pants | 0) + (b.shirt | 0)),
    outfit: role === 'maker' ? 'apron' : role === 'manager' ? 'hivis' : b.outfit === 'vest' ? 'vest' : 'blazer',
    glasses: role === 'boss' && !!b.glasses,
    tool: role === 'maker' ? (TOOLS.includes(b.tool) ? b.tool : 'hammer') : role === 'manager' ? 'clipboard' : 'magnifier',
    accent: providerColor(provider),
  };
  look.key = [role, look.skin[0], look.hair[1], look.hairStyle, look.hat, look.gear[1], look.shirt[0], look.apron[0], look.pants[0], look.shoes[0], look.outfit, look.glasses ? 1 : 0, look.tool, look.accent].join('|');
  return look;
}

// The whole look derives from style.seed + role (optional overrides: style.hat, style.tool).
// Accepts a raw view-model agent or a normalized one (with .look from model.js).
export function lookFor(agent) {
  const a = agent && typeof agent === 'object' ? agent : {};
  if (a.look && typeof a.look === 'object' && a.look.role) return renderLook(a.look, a.provider);
  const role = a.role === 'boss' || a.role === 'manager' ? a.role : 'maker';
  const style = a.style && typeof a.style === 'object' ? a.style : {};
  let id = '';
  try { id = String(a.id === undefined || a.id === null ? '' : a.id).slice(0, 32).trim(); } catch (e) { id = ''; }
  const seed = Number.isFinite(style.seed) ? style.seed : hashString(id);
  return renderLook(lookFromSeed(seed, role, style), a.provider);
}

// ---------------------------------------------------------------- hair (front maps; back and side are derived)
// Rows start at y = 3. h base, l light, s shade, d dark.

const HAIR_Y0 = 3;
const E16 = '................';
const HAIR = {
  crop: { back: 16, side: 15, rows: [
    '................',
    '................',
    '................',
    '................',
    '.....hhhhhh.....',
    '...hhllhhhhhs...',
    '..hhlhhhhhhhss..',
    '..hlhhhhhhhhss..',
    '..hhhhhhhhhhsd..',
    '..hhsh.hs.hhsd..',
    '..hs........sd..',
    '..s..........d..',
  ] },
  mop: { back: 17, side: 16, rows: [
    '................',
    '................',
    '.....hhhhhh.....',
    '...hhhllhhhhh...',
    '..hhllhhhhhhhs..',
    '.hhlhhhhhhhhhss.',
    '.hhlhhhhhhhhhss.',
    '.hhhhhhhhhhhhsd.',
    '.hhhhhhhhhhhssd.',
    '.hhhsh.hhsh.ssd.',
    '.hhs........ssd.',
    '.hs..........sd.',
    '.hs..........sd.',
    '..s..........d..',
  ] },
  bob: { back: 18, side: 18, rows: [
    '................',
    '................',
    '................',
    '....hhhhhhhh....',
    '..hhhlllhhhhhs..',
    '.hhhlhhhhhhhhss.',
    '.hhlhhhhhhhhhss.',
    '.hhhhhhhhhhhhss.',
    '.hhhhhhhhhhhhsd.',
    '.hhsssssssssssd.',
    '.hh..........sd.',
    '.hh..........sd.',
    '.hh..........sd.',
    '.hh..........sd.',
    '.hhs.........sd.',
    '..hs........sd..',
  ] },
  long: { back: 23, side: 22, rows: [
    '................',
    '................',
    '................',
    '....hhhhhhhh....',
    '..hhhllhhhhhhs..',
    '.hhhlhhhhhhhhss.',
    '.hhlhhhhhhhhhss.',
    '.hhhhhhhhshhhsd.',
    '.hhhhhhhss.hhsd.',
    '.hhhhss.....hsd.',
    '.hhs.........sd.',
    '.hhs.........sd.',
    '.hh..........sd.',
    '.hh..........sd.',
    '.hh..........sd.',
    '.hh..........sd.',
    '.hh..........sd.',
    '.hh..........sd.',
    '.hs..........sd.',
    '.hs..........dd.',
    '..s..........d..',
  ] },
  curly: { back: 17, side: 16, rows: [
    '................',
    '................',
    '....hhh.hhh.....',
    '..hhlhhhhhhhhh..',
    '.hhlhhhshhhhshs.',
    '.hlhhhhhhhhhhss.',
    '.hhhhshhhhshhsd.',
    '.hshhhhhhhhhssd.',
    '.hhhhhshhhshhsd.',
    '.hhsh.hh.hs.ssd.',
    '..hs........ssd.',
    '.hs..........sd.',
    '..s..........sd.',
    '.............d..',
  ] },
  spiky: { back: 16, side: 14, rows: [
    '................',
    '......h....h....',
    '...h.hhh..hhh...',
    '...hhhlhhhhhhs..',
    '..hhllhhhhhhhs..',
    '..hhlhhhhhhhss..',
    '.hhhhhhhhhhhhss.',
    '..hhhhhhhhhhsd..',
    '..hhhhhhhhhssd..',
    '..hhsh.hs.h.sd..',
    '..hs........sd..',
    '..s..........d..',
  ] },
  pony: { back: 15, side: 14, tail: true, rows: [
    '................',
    '................',
    '................',
    '................',
    '.....hhhhhh.....',
    '...hhllhhhhhs...',
    '..hhlhhhhhhhss..',
    '..hlhhhhhhhhsss.',
    '..hhhhhhhhhssdh.',
    '..hhs.....hssdh.',
    '..hs........shs.',
    '..s..........hs.',
    '.............hs.',
    '.............hs.',
    '.............s..',
  ] },
  bun: { back: 15, side: 14, bun: true, rows: [
    '......hhhh......',
    '.....hlhhhs.....',
    '.....hhhhss.....',
    '....hhhhhhhs....',
    '...hhllhhhhhs...',
    '..hhlhhhhhhhss..',
    '..hlhhhhhhhhss..',
    '..hhhhhhhhhhss..',
    '..hhhhhhhhhhsd..',
    '..hhsh....shsd..',
    '..hs........sd..',
    '..s..........d..',
  ] },
  swoop: { back: 16, side: 15, rows: [
    '................',
    '................',
    '...hhhhhh.......',
    '..hhllhhhhhh....',
    '.hhllhhhhhhhhs..',
    '.hhlhhhhhhhhhss.',
    '.hhhhhhhhhhhhss.',
    '.hhhhhhhhhhhssd.',
    '.hhhhhhhhhhssd..',
    '.hhhhhhsss..sd..',
    '..hhhss.....sd..',
    '..hs.........d..',
    '..s..........d..',
  ] },
  buzz: { back: 14, side: 13, rows: [
    '................',
    '................',
    '................',
    '................',
    '....hhhhhhhh....',
    '...hhhhhhhhhs...',
    '..hhhhhhhhhhss..',
    '..hhhhhhhhhhss..',
    '..hhs......ssd..',
    '..hs........sd..',
    '..s..........d..',
  ] },
};

function rowExtent(row, lo = 0, hi = 15) {
  let a = -1, b = -1;
  if (!row) return null;
  for (let x = lo; x <= hi && x < row.length; x++) if (row[x] !== '.') { if (a < 0) a = x; b = x; }
  return a < 0 ? null : [a, b];
}

// Back view: the crown as in front, then a full curtain down to the style's back length.
const CROWN_Y = 11;       // last full row of every front map; the fringe starts below it
function hairBackRows(style) {
  const H0 = HAIR[style] || HAIR.crop;
  const H = H0.tail ? { ...H0, rows: HAIR.crop.rows } : H0;     // the pony tail is drawn separately
  const out = [];
  const crownEnd = CROWN_Y - HAIR_Y0;
  let ext = rowExtent(H.rows[crownEnd]) || [2, 13];
  for (let i = 0; i <= H.back - HAIR_Y0; i++) {
    const y = i + HAIR_Y0;
    if (i <= crownEnd) { out.push(H.rows[i] || E16); continue; }
    const fe = rowExtent(H.rows[i]);
    if (fe && fe[0] <= 3 && fe[1] >= 12) ext = fe;
    let [a, b] = ext;
    const last = y === H.back;
    if (last && b - a > 6) { a++; b--; }
    let s = '';
    for (let x = 0; x < 16; x++) {
      const strand = (x - a) % 3 === 2 && (y + x) % 5 !== 0;
      if (x < a || x > b) s += '.';
      else if (last && (x - a) % 3 === 1 && b - a > 6) s += '.';          // ragged hem
      else if (x === b) s += 'd';
      else if (x === b - 1 || last) s += 's';
      else if (x === a + 1 && y < H.back - 2 && y % 4 !== 3) s += 'l';       // light streak on the lit side
      else if (strand && y > CROWN_Y + 1) s += 's';
      else s += 'h';
    }
    out.push(s);
  }
  return out;
}

// Side view (facing right): the crown as in front, the fringe over the brow, hair down the back of the head.
function hairSideRows(style) {
  const H0 = HAIR[style] || HAIR.crop;
  const H = H0.tail ? { ...H0, rows: HAIR.crop.rows } : H0;
  const out = [];
  const crownEnd = CROWN_Y - HAIR_Y0;
  const base = rowExtent(H.rows[crownEnd]) || [2, 13];
  let left = base[0];
  for (let i = 0; i <= H.side - HAIR_Y0; i++) {
    const y = i + HAIR_Y0;
    if (i <= crownEnd) { out.push(H.rows[i] || E16); continue; }
    const fe = rowExtent(H.rows[i], 0, 6);
    if (fe) left = fe[0];
    const last = y === H.side;
    const a = last ? left + 1 : left;
    let s = '';
    for (let x = 0; x < 16; x++) {
      const front = H.rows[i] ? H.rows[i][x] : '.';
      if (x >= a && x <= 7) s += last ? (x === a ? 'd' : 's') : x === 7 ? 's' : 'h';
      else if (x > 7 && x <= 11 && y <= CROWN_Y + 1 && front && front !== '.') s += front;
      else s += '.';
    }
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------- headgear
// clip: hair above this row is hidden by the hat. Maps start at y = 3. w white, k dark, m metal, M metal light, y lens, a lab accent.

const HAT_Y0 = 3;
const HATS = {
  cap: { clip: 11,
    front: [E16, E16, '.....hhhhhh.....', '...hhllhhhhhs...', '..hhlhhhhhhhss..', '..hlhhhhhhhhss..', '..hhhhhhhhhhss..', '..hhhhhhhhhsss..', '.hhhhhhhhhhhhss.', '..dddddddddddd..'],
    side: [E16, E16, '.....hhhhhh.....', '...hhllhhhhhs...', '..hhlhhhhhhhss..', '..hlhhhhhhhhss..', '..hhhhhhhhhhss..', '..hhhhhhhhhsss..', '..sssssssshhhhhhh', '...........dddddd'],
    back: [E16, E16, '.....hhhhhh.....', '...hhllhhhhhs...', '..hhlhhhhhhhss..', '..hlhhhhhhhhss..', '..hhhhhhhhhhss..', '..hhhhhkkhhsss..', '..ssssk..kssss..'],
  },
  beanie: { clip: 12,
    front: ['.......ww.......', '......wwww......', '.....hhhhhh.....', '...hhllhhhhhs...', '..hhlhhhhhhhss..', '..hlhhhhhhhhss..', '..hhhhhhhhhhss..', '..hhhhhhhhhhss..', '..llllllllllss..', '..shshshshshsd..'],
  },
  goggles: { clip: 0,
    front: [E16, E16, E16, E16, E16, E16, '...mmmm..mmmm...', '..kmywmkkmywmk..', '...mmmm..mmmm...'],
    side: [E16, E16, E16, E16, E16, E16, '.........mmmm...', '..kkkkkkkmywm...', '.........mmmm...'],
    back: [E16, E16, E16, E16, E16, E16, E16, '..kkkkkkkkkkkk..'],
  },
  bandana: { clip: 11,
    front: [E16, E16, E16, '.....hhhhhh.....', '...hhlhhhhhhs...', '..hhlhhwhhhhss..', '..hhhhhhhhwhss..', '..hwhhhhhhhhsds.', '..ssssssssssshs.', '.............s..'],
    side: [E16, E16, E16, '.....hhhhhh.....', '...hhlhhhhhhs...', '..hhlhhwhhhhss..', '.shhhhhhhhwhss..', 'hdhwhhhhhhhhss..', 'shssssssssssss..', '.s..............'],
    back: [E16, E16, E16, '.....hhhhhh.....', '...hhlhhhhhhs...', '..hhlhhwhhhhss..', '..hhhhhhhhwhss..', '..hwhhhhhhhhss..', '..ssssshdsssss..', '......hssh......', '......s..s......'],
  },
  visor: { clip: 10,
    front: [E16, '....mmmmmmmm....', '...mMMmmmmmmk...', '...mMmmmmmmmk...', '...mmkkkkkkmk...', '...mmkyykkkmk...', '...mmmmmmmmmk...', '..kkkkkkkkkkkk..'],
    back: [E16, '....mmmmmmmm....', '...mMMmmmmmmk...', '...mMmmmmmmmk...', '...mmmmmmmmmk...', '...mmmmmmmmmk...', '...mmmmmmmmmk...', '..kkkkkkkkkkkk..'],
  },
  muffs: { clip: 0, band: true,
    front: [E16, E16, E16, E16, E16, E16, E16, E16, '.lh..........hs.', '.hh..........hs.', '.hh..........hs.', '.hs..........ss.'],
    side: [E16, E16, E16, E16, E16, E16, E16, E16, '.....lhhs.......', '.....hhhs.......', '.....hhhs.......', '.....hsss.......'],
  },
  hardhat: { clip: 12,
    front: [E16, '.....hhhhhh.....', '....hllhhhhs....', '...hllhhhhhss...', '..hhlhhhhhhhss..', '..hlhhhaahhhss..', '..hhhhhaahhhss..', '..hhhhhhhhhsss..', '.ssssssssssssss.'],
    side: [E16, '.....hhhhhh.....', '....hllhhhhs....', '...hllhhhhhss...', '..hhlhhhhhhhss..', '..hlhhhhhhhhss..', '..hhhhhhhhhhss..', '..hhhhhhhhhsss..', '..ssssssssssssssd'],
    back: [E16, '.....hhhhhh.....', '....hllhhhhs....', '...hllhhhhhss...', '..hhlhhhhhhhss..', '..hlhhhhhhhhss..', '..hhhhhhhhhhss..', '..hhhhhhhhhsss..', '.ssssssssssssss.'],
  },
};

// ---------------------------------------------------------------- hand tools (grip at the bottom, pointing up)

const TM = { s: P.steel4, S: P.steel3, d: P.steel2, k: P.steel1, w: P.wood3, W: P.wood4, y: P.amber, Y: P.yellow, o: P.orange, b: P.blue, r: P.red, l: P.sky, p: P.paper, n: P.white, c: P.wood2 };
export const TOOL_MAPS = {
  hammer: ['sssss', 'sSSSd', '..w..', '..w..', '..w..', '..W..', '..W..'],
  saw: ['.s...', '.ss..', '.sSs.', '.sSs.', '.sSS.', '.ssd.', '.www.', '.wkw.'],
  wrench: ['s.s', 's.s', 'sSs', '.S.', '.s.', '.s.', '.S.'],
  iron: ['.Y.', '.s.', '.s.', '.d.', '.b.', '.b.', '.b.'],
  drill: ['..s..', '..s..', '.yyy.', '.yoy.', '.yyyk', '.yo..', '.yy..'],
  calipers: ['s..s', 's..s', 's..s', 'sSSs', '.s..', '.s..', '.S..'],
  magnifier: ['.kkk.', 'knllk', 'klllk', 'klllk', '.kkk.', '..w..', '..w..'],
  clipboard: ['..kk.', 'WpppW', 'WpSpW', 'WpppW', 'WpSpW', 'WpppW', 'WWWWc'],
};
// the same tool pointing right (grip on the left)
function rotRight(rows) {
  const h = rows.length;
  let w = 0;
  for (const r of rows) w = Math.max(w, r.length);
  const out = [];
  for (let x = 0; x < w; x++) { let s = ''; for (let y = h - 1; y >= 0; y--) s += rows[y][x] || '.'; out.push(s); }
  return out;
}

// ---------------------------------------------------------------- drawing helpers (local coordinates)

const px = (p, x, y, c) => p.set(OX + x, y, c);
const span = (p, y, x0, x1, c) => { for (let x = x0; x <= x1; x++) p.set(OX + x, y, c); };
const box = (p, x, y, w, h, c) => p.rect(OX + x, y, w, h, c);
const stamp = (p, x, y, rows, map, flip) => p.stamp(OX + x, y, rows, map, flip);

function ramp(r) { return { l: r[0], h: r[1], s: r[2], d: r[3] }; }
function hatMap(L) { return { ...ramp(L.gear), w: P.white, k: P.steel1, m: P.steel3, M: P.steel5, y: P.sky, a: L.accent }; }

function clipRows(rows, y0, clipY) {
  if (!clipY) return rows;
  return rows.map((r, i) => (i + y0 < clipY ? '' : r));
}

function drawHairAndHat(p, L, view, u) {
  const hat = HATS[L.hat];
  const clip = hat ? hat.clip : 0;
  const rows = view === 'front' ? (HAIR[L.hairStyle] || HAIR.crop).rows : view === 'back' ? hairBackRows(L.hairStyle) : hairSideRows(L.hairStyle);
  const H = HAIR[L.hairStyle] || HAIR.crop;
  const hm = ramp(L.hair);
  stamp(p, 0, HAIR_Y0 + u, clipRows(rows, HAIR_Y0, clip), hm);
  // pony tail and bun extras
  if (H.tail && view === 'back') { box(p, 7, 11 + u, 2, 1, hm.d); box(p, 7, 12 + u, 2, 8, hm.h); box(p, 8, 12 + u, 1, 8, hm.s); px(p, 7, 20 + u, hm.s); px(p, 7, 12 + u, hm.l); }
  if (H.tail && view === 'side') { box(p, 1, 9 + u, 2, 1, hm.d); box(p, 0, 10 + u, 2, 7, hm.h); box(p, 0, 12 + u, 1, 5, hm.s); px(p, 1, 17 + u, hm.s); px(p, 1, 10 + u, hm.l); }
  if (hat && hat.band) {      // head band of the ear muffs: rides on top of whatever hair there is
    let top = 0;
    while (top < rows.length && !rowExtent(rows[top])) top++;
    const e = rowExtent(rows[top]) || [5, 10];
    if (view === 'side') box(p, 7, HAIR_Y0 + top + u, 2, 11 - HAIR_Y0 - top, P.steel3);
    else {
      span(p, HAIR_Y0 + top + u, e[0], e[1], P.steel3);
      for (let i = top + 1; i + HAIR_Y0 < 11; i++) { const r = rowExtent(rows[i]); if (r) { px(p, Math.max(r[0], 2), i + HAIR_Y0 + u, P.steel3); px(p, Math.min(r[1], 13), i + HAIR_Y0 + u, P.steel2); } }
    }
  }
  if (hat) {
    const rowsH = view === 'front' ? hat.front : view === 'back' ? (hat.back || hat.front) : (hat.side || hat.front);
    stamp(p, 0, HAT_Y0 + u, rowsH, hatMap(L));
  }
}

function skull(p, L, u, view) {
  const [sk, sks] = L.skin;
  span(p, 8 + u, 5, 10, sk); span(p, 9 + u, 4, 11, sk);
  for (let y = 10; y <= 16; y++) span(p, y + u, 3, 12, sk);
  span(p, 17 + u, 4, 11, sk); span(p, 18 + u, 5, 10, sks);
  if (view === 'back') { for (let y = 16; y <= 17; y++) span(p, y + u, 4, 11, sks); return; }
  for (let y = 11; y <= 16; y++) px(p, 12, y + u, sks);
  px(p, 11, 17 + u, sks);
}

function faceFront(p, L, u, o) {
  const [, sks, blush, white] = L.skin;
  const eye = P.shadow;
  const ex = o.eye || 0, ey = 14 + u + (o.eyeDown ? 1 : 0);
  if (o.blink) { span(p, 15 + u, 4, 5, eye); span(p, 15 + u, 10, 11, eye); }
  else {
    box(p, 5 + ex, ey, 1, 2, eye); box(p, 10 + ex, ey, 1, 2, eye);
    if (white) { px(p, 4 + ex, ey, white); px(p, 11 + ex, ey, white); }
  }
  if (blush) { px(p, 4, 16 + u, blush); px(p, 11, 16 + u, blush); }
  span(p, 17 + u, 7, 8, sks);
  if (L.glasses) {
    const g = P.steel1;
    span(p, 13 + u, 4, 6, g); span(p, 13 + u, 9, 11, g); span(p, 14 + u, 7, 8, g);
    px(p, 3, 14 + u, g); px(p, 12, 14 + u, g);
    px(p, 4, 14 + u, P.white); px(p, 9, 14 + u, P.white);
    px(p, 6, 16 + u, P.steel3); px(p, 11, 16 + u, P.steel3); px(p, 4, 16 + u, P.steel3); px(p, 9, 16 + u, P.steel3);
  }
}

function faceSide(p, L, u, o) {
  const [sk, sks, blush, white] = L.skin;
  px(p, 13, 15 + u, sk);                                   // nose
  if (o.blink) span(p, 15 + u, 10, 11, P.shadow);
  else { box(p, 10, 14 + u, 1, 2, P.shadow); if (white) px(p, 11, 14 + u, white); }
  if (blush) px(p, 11, 16 + u, blush);
  px(p, 11, 17 + u, sks);
  px(p, 6, 14 + u, sks); px(p, 6, 15 + u, sks);            // ear (hidden by most hair)
  for (let y = 11; y <= 16; y++) px(p, 3, y + u, sks);
  if (L.glasses) { const g = P.steel1; span(p, 13 + u, 9, 11, g); span(p, 14 + u, 5, 8, g); px(p, 9, 14 + u, P.white); px(p, 9, 16 + u, P.steel3); px(p, 11, 16 + u, P.steel3); }
}

// legs seen from the front or the back. step: 0 stand, 1 left foot back, 2 left foot lifted, 3 right foot back, 4 right foot lifted
function legsFront(p, L, step) {
  const [pa, pas] = L.pants, [sh, shs] = L.shoes;
  span(p, 25, 5, 10, pa); px(p, 10, 25, pas);
  const leg = (x, up, shadeX) => {
    for (let y = 26; y <= 28 - up; y++) { span(p, y, x, x + 2, pa); px(p, shadeX, y, pas); }
    span(p, 29 - up, x === 5 ? 4 : 8, x === 5 ? 7 : 11, sh);
    span(p, 30 - up, x === 5 ? 4 : 8, x === 5 ? 7 : 11, shs);
  };
  leg(5, step === 1 ? 1 : step === 2 ? 2 : 0, 7);
  leg(8, step === 3 ? 1 : step === 4 ? 2 : 0, 10);
}

// legs seen from the side. step: 0 stand, 1 stride (near leg forward), 2 passing, 3 stride (far leg forward), 4 passing
function legsSide(p, L, step) {
  const [pa, pas] = L.pants, [sh, shs] = L.shoes;
  span(p, 25, 5, 10, pa); px(p, 5, 25, pas);
  const leg = (x, c, up, toe) => {
    for (let y = 26; y <= 28 - up; y++) span(p, y, x, x + 2, c);
    span(p, 29 - up, x, x + 2 + toe, sh); span(p, 30 - up, x, x + 2 + toe, shs);
  };
  if (step === 0) { leg(6, pas, 0, 1); leg(7, pa, 0, 1); px(p, 6, 26, pas); px(p, 6, 27, pas); px(p, 6, 28, pas); }
  else if (step === 1) { leg(4, pas, 1, 0); leg(9, pa, 0, 1); }
  else if (step === 3) { leg(9, pas, 0, 1); leg(4, pa, 1, 0); }
  else if (step === 2) { leg(8, pas, 2, 1); leg(6, pa, 0, 1); }
  else { leg(6, pas, 0, 1); leg(8, pa, 2, 1); }
}

function torsoFront(p, L, u, back) {
  const [sh, shs] = L.shirt, [ap, aps] = L.apron;
  const y = 19 + u;
  const jacket = L.outfit === 'blazer';
  const body = jacket ? ap : sh, bodyS = jacket ? aps : shs;
  span(p, y, 4, 11, body); px(p, 11, y, bodyS);
  box(p, 5, y + 1, 6, 5, L.outfit === 'vest' ? ap : body); box(p, 10, y + 1, 1, 5, L.outfit === 'vest' ? aps : bodyS);
  if (L.outfit === 'apron') {
    if (back) {
      px(p, 5, y, ap); px(p, 10, y, ap); px(p, 6, y + 1, ap); px(p, 9, y + 1, ap); span(p, y + 2, 7, 8, ap);
      span(p, y + 3, 5, 10, aps); span(p, y + 4, 7, 8, ap);
    } else {
      px(p, 5, y, ap); px(p, 10, y, aps);
      box(p, 5, y + 1, 6, 7, ap); box(p, 10, y + 1, 1, 7, aps);
      span(p, y + 3, 5, 10, aps);
      box(p, 8, y + 1, 2, 2, L.accent);
      span(p, y + 5, 6, 7, aps);
    }
  } else if (L.outfit === 'hivis') {
    if (back) { box(p, 5, y, 6, 6, ap); box(p, 10, y, 1, 6, aps); span(p, y + 3, 5, 10, P.white); box(p, 7, y, 2, 3, P.white); }
    else {
      box(p, 5, y, 2, 6, ap); box(p, 9, y, 2, 6, ap); box(p, 10, y, 1, 6, aps);
      span(p, y + 3, 5, 6, P.white); span(p, y + 3, 9, 10, P.white);
      px(p, 9, y + 1, L.accent); px(p, 10, y + 1, L.accent);
    }
  } else if (L.outfit === 'blazer') {
    if (!back) {
      span(p, y, 6, 9, P.white); span(p, y + 1, 7, 8, P.white);
      box(p, 7, y + 1, 2, 3, L.accent); px(p, 7, y, L.accent); px(p, 8, y, L.accent);
      px(p, 6, y + 1, aps); px(p, 9, y + 1, aps); px(p, 6, y + 2, aps); px(p, 9, y + 2, aps);
      px(p, 8, y + 4, aps);
    } else px(p, 7, y + 5, aps);
  } else {
    span(p, y, 5, 10, back ? ap : sh);
    if (!back) { box(p, 7, y, 2, 4, L.accent); px(p, 6, y + 1, aps); px(p, 9, y + 1, aps); px(p, 6, y + 4, P.amber); }
    else span(p, y + 4, 6, 9, aps);
  }
}

function sleeveColors(L) { return L.outfit === 'blazer' ? L.apron : L.shirt; }

// one arm seen from the front / back. side -1 = screen left, +1 = screen right.
function armFront(p, L, side, pose, u) {
  const [c0, c1] = sleeveColors(L);
  const sk = L.skin[0];
  const c = side < 0 ? c0 : c1;
  const x = side < 0 ? 3 : 11;
  const y = 19 + u;
  if (pose === 'fwd') { box(p, x, y, 2, 5, c); box(p, x, y + 5, 2, 2, sk); }
  else if (pose === 'back') { box(p, x, y, 2, 3, c); box(p, x, y + 3, 2, 2, sk); }
  else if (pose === 'up') {        // raised beside the head (tool swing)
    const ax = side < 0 ? 1 : 13;
    span(p, y, Math.min(x, ax), Math.max(x + 1, ax + 1), c);
    box(p, ax, y - 4, 2, 4, c); box(p, ax, y - 6, 2, 2, sk);
  } else if (pose === 'low') {     // reaching out to the side and down (tool on the work)
    box(p, x, y, 2, 3, c);
    const fx = side < 0 ? x - 3 : x + 1;
    box(p, fx, y + 3, 4, 2, c);
    box(p, side < 0 ? fx - 2 : fx + 4, y + 3, 2, 2, sk);
  } else if (pose === 'chin') {    // hand on the chin
    box(p, x, y, 2, 3, c); px(p, x, y - 1, c); px(p, x + 1, y - 1, c);
    box(p, side < 0 ? x + 1 : x - 1, y - 3, 2, 2, sk);
  } else if (pose === 'hold') {    // forearm across the chest
    box(p, x, y, 2, 3, c);
    box(p, side < 0 ? x + 1 : x - 2, y + 2, 3, 2, c);
    box(p, side < 0 ? x + 4 : x - 4, y + 2, 2, 2, sk);
  } else { box(p, x, y, 2, 4, c); box(p, x, y + 4, 2, 2, sk); }
}

// both arms raised to carry something on the head: sleeves go behind the head, hands show above it
function armsOverheadBack(p, L, u) {
  const [c0, c1] = sleeveColors(L);
  box(p, 1, 12 + u, 2, 8, c0); box(p, 13, 12 + u, 2, 8, c1);
  span(p, 19 + u, 2, 4, c0); span(p, 19 + u, 11, 13, c1);
}
function handsOverhead(p, L, u) {
  const sk = L.skin[0];
  box(p, 1, 9 + u, 2, 3, sk); box(p, 13, 9 + u, 2, 3, sk);
}

function torsoSide(p, L, u) {
  const [sh, shs] = L.shirt, [ap, aps] = L.apron;
  const y = 19 + u;
  const jacket = L.outfit === 'blazer' || L.outfit === 'vest';
  const body = jacket ? ap : sh, bodyS = jacket ? aps : shs;
  box(p, 5, y, 6, 6, body); box(p, 5, y, 1, 6, bodyS);
  if (L.outfit === 'apron') { box(p, 8, y + 1, 3, 7, ap); px(p, 9, y, ap); span(p, y + 3, 5, 10, aps); px(p, 10, y + 1, L.accent); px(p, 10, y + 2, L.accent); }
  else if (L.outfit === 'hivis') { box(p, 5, y, 6, 6, ap); box(p, 5, y, 1, 6, aps); span(p, y + 3, 5, 10, P.white); px(p, 10, y + 1, L.accent); }
  else { px(p, 10, y, P.white); px(p, 10, y + 1, L.accent); px(p, 10, y + 2, L.accent); }
}

function armSide(p, L, pose, u) {
  const [c0, c1] = L.outfit === 'vest' ? L.shirt : sleeveColors(L);
  const sk = L.skin[0];
  const y = 19 + u;
  if (pose === 'fwd') { box(p, 7, y, 2, 2, c1); box(p, 8, y + 2, 2, 2, c1); box(p, 9, y + 4, 2, 2, sk); }
  else if (pose === 'back') { box(p, 7, y, 2, 2, c1); box(p, 6, y + 2, 2, 2, c1); box(p, 5, y + 4, 2, 2, sk); }
  else if (pose === 'up') { box(p, 9, y - 12, 2, 3, sk); return; }
  else if (pose === 'hold') { box(p, 7, y, 2, 3, c1); box(p, 8, y + 2, 3, 2, c1); box(p, 11, y + 2, 2, 2, sk); }
  else { box(p, 7, y, 2, 4, c1); box(p, 7, y + 4, 2, 2, sk); }
  px(p, 7, y, c0);
}

function toolUp(p, L, x, yBottom) {
  const rows = TOOL_MAPS[L.tool] || TOOL_MAPS.hammer;
  const w = rows[0].length;
  stamp(p, x - (w >> 1), yBottom - rows.length + 1, rows, TM);
}
function toolRight(p, L, x, yMid) {
  const rows = rotRight(TOOL_MAPS[L.tool] || TOOL_MAPS.hammer);
  stamp(p, x, yMid - (rows.length >> 1), rows, TM);
}

// ---------------------------------------------------------------- views

function buildFront(L, o) {
  const p = new Pix(CHAR_W, CHAR_H);
  const u = o.bob || 0;
  legsFront(p, L, o.step || 0);
  if (o.carry) armsOverheadBack(p, L, u);
  torsoFront(p, L, u, false);
  if (!o.carry) { armFront(p, L, -1, o.armL || 'down', u); if (o.armR !== 'up') armFront(p, L, 1, o.armR || 'down', u); }
  skull(p, L, u, 'front');
  faceFront(p, L, u, o);
  drawHairAndHat(p, L, 'front', u);
  if (o.armR === 'up') { armFront(p, L, 1, 'up', u); toolUp(p, L, 14, 12 + u); }
  if (o.armR === 'low') toolRight(p, L, 17, 22 + u);
  if (o.armR === 'chin') armFront(p, L, 1, 'chin', u);
  if (o.carry) handsOverhead(p, L, u);
  if (o.mag) { stamp(p, 9 + (o.mag - 1), 16 + u, TOOL_MAPS.magnifier, TM); box(p, 11 + (o.mag - 1), 22 + u, 2, 1, L.skin[0]); }
  if (o.clip === 1) stamp(p, 0, 20 + u, TOOL_MAPS.clipboard, TM);
  if (o.clip === 2 || o.clip === 3) { stamp(p, 2, 19 + u, TOOL_MAPS.clipboard, TM); box(p, 6, 21 + u + (o.clip - 2), 2, 2, L.skin[0]); px(p, 6, 20 + u + (o.clip - 2), P.steel1); }
  return p.outline();
}

function buildBack(L, o) {
  const p = new Pix(CHAR_W, CHAR_H);
  const u = o.bob || 0;
  legsFront(p, L, o.step || 0);
  if (o.carry) armsOverheadBack(p, L, u);
  torsoFront(p, L, u, true);
  if (!o.carry) { armFront(p, L, -1, o.armL || 'down', u); armFront(p, L, 1, o.armR || 'down', u); }
  skull(p, L, u, 'back');
  drawHairAndHat(p, L, 'back', u);
  if (o.carry) handsOverhead(p, L, u);
  return p.outline();
}

function buildSide(L, o) {
  const p = new Pix(CHAR_W, CHAR_H);
  const u = o.bob || 0;
  legsSide(p, L, o.step || 0);
  torsoSide(p, L, u);
  if (o.arm === 'up') { const c = (L.outfit === 'vest' ? L.shirt : sleeveColors(L))[1]; box(p, 8, 12 + u, 2, 9, c); box(p, 11, 12 + u, 2, 8, c); }
  skull(p, L, u, 'side');
  faceSide(p, L, u, o);
  drawHairAndHat(p, L, 'side', u);
  if (o.mag) {
    // inspecting sideways: the arm reaches forward and holds a magnifier low in front of the face, over the work
    const [c0, c1] = L.outfit === 'vest' ? L.shirt : sleeveColors(L);
    const y = 19 + u, dx = o.mag - 1;
    box(p, 7, y, 2, 3, c1); px(p, 7, y, c0); box(p, 9, y + 2, 5 + dx, 2, c1);
    stamp(p, 13 + dx, 14 + u + dx, TOOL_MAPS.magnifier, TM);
    box(p, 14 + dx, y + 2, 2, 2, L.skin[0]);
  } else armSide(p, L, o.arm || 'down', u);
  if (o.clip) { stamp(p, 10, 19 + u, TOOL_MAPS.clipboard, TM); if (o.clip === 2) px(p, 12, 21 + u, P.steel1); }
  return p.outline();
}

// All frames for one look. Keys: '<dir>_<pose>' with dir S, N, E, W.
export function buildCharacterFrames(look) {
  const L = look;
  const cl = L.role === 'manager' ? 1 : 0;
  const f = {};
  // walk cycle: 0 contact, 1 passing, 2 contact, 3 passing; the head bobs 1 px down on contact
  const WALK_S = [{ step: 1, bob: 1, armL: 'fwd', armR: 'back' }, { step: 4, armL: 'down', armR: 'down' }, { step: 3, bob: 1, armL: 'back', armR: 'fwd' }, { step: 2, armL: 'down', armR: 'down' }];
  const WALK_E = [{ step: 1, bob: 1, arm: 'back' }, { step: 2, arm: 'down' }, { step: 3, bob: 1, arm: 'fwd' }, { step: 4, arm: 'down' }];
  f.S_idle = buildFront(L, { clip: cl });
  f.S_blink = buildFront(L, { blink: true, clip: cl });
  f.S_lookL = buildFront(L, { eye: -1, clip: cl });
  f.S_lookR = buildFront(L, { eye: 1, clip: cl });
  f.S_think = buildFront(L, { armR: 'chin', eye: -1, clip: cl });
  f.S_work0 = buildFront(L, { armR: 'up' });
  f.S_work1 = buildFront(L, { armR: 'low', bob: 1, eyeDown: true });
  f.S_review0 = buildFront(L, { mag: 1, eyeDown: true });
  f.S_review1 = buildFront(L, { mag: 2, eyeDown: true, bob: 1 });
  f.S_note0 = buildFront(L, { clip: 2, armR: 'hold', eyeDown: true });
  f.S_note1 = buildFront(L, { clip: 3, armR: 'hold', eyeDown: true });
  f.S_carry = buildFront(L, { carry: true });
  f.N_idle = buildBack(L, {});
  f.N_carry = buildBack(L, { carry: true });
  f.E_idle = buildSide(L, { clip: cl });
  f.E_blink = buildSide(L, { blink: true, clip: cl });
  f.E_carry = buildSide(L, { arm: 'up' });
  f.E_note0 = buildSide(L, { clip: 1, arm: 'hold' });
  f.E_note1 = buildSide(L, { clip: 2, arm: 'hold', blink: true });
  f.E_review0 = buildSide(L, { mag: 1 });
  f.E_review1 = buildSide(L, { mag: 2, bob: 1 });
  for (let i = 0; i < 4; i++) {
    const ws = WALK_S[i], we = WALK_E[i];
    f['S_walk' + i] = buildFront(L, { ...ws, clip: cl });
    f['N_walk' + i] = buildBack(L, ws);
    f['E_walk' + i] = buildSide(L, { ...we, clip: cl });
    f['S_carry' + i] = buildFront(L, { step: ws.step, bob: ws.bob, carry: true });
    f['N_carry' + i] = buildBack(L, { step: ws.step, bob: ws.bob, carry: true });
    f['E_carry' + i] = buildSide(L, { step: we.step, bob: we.bob, arm: 'up' });
  }
  for (const k of Object.keys(f)) if (k[0] === 'E') f['W' + k.slice(1)] = f[k].mirror();
  return f;
}

export const FRAME_NAMES = Object.freeze(Object.keys(buildCharacterFrames(renderLook({ role: 'maker' }, 'mock'))));
const FRAME_INDEX = Object.freeze(Object.fromEntries(FRAME_NAMES.map((n, i) => [n, i])));
const ATLAS_COLS = 12;

// ---------------------------------------------------------------- atlas cache (DOM)

const atlasCache = new Map();   // look.key -> { canvas, hi, pix }
const MAX_ATLAS = 64;

function paintAtlas(pix, recolor) {
  const cv = document.createElement('canvas');
  cv.width = ATLAS_COLS * CHAR_W; cv.height = Math.ceil(FRAME_NAMES.length / ATLAS_COLS) * CHAR_H;
  const g = cv.getContext('2d');
  FRAME_NAMES.forEach((n, i) => {
    let fr = pix[n];
    if (!fr) return;
    if (recolor) { const o = new Pix(CHAR_W, CHAR_H); o.d = fr.d.map((c) => (c === P.ink ? null : c)); fr = o.outline(recolor); }
    fr.paint(g, (i % ATLAS_COLS) * CHAR_W, Math.floor(i / ATLAS_COLS) * CHAR_H);
  });
  return cv;
}

// One canvas with every frame of a look; `hi` is the hover variant (white outline), built on first use.
export function characterAtlas(look) {
  let e = atlasCache.get(look.key);
  if (e) return e;
  const pix = buildCharacterFrames(look);
  e = { pix, canvas: paintAtlas(pix, null), _hi: null, get hi() { if (!this._hi) this._hi = paintAtlas(pix, P.white); return this._hi; } };
  if (atlasCache.size >= MAX_ATLAS) atlasCache.delete(atlasCache.keys().next().value);
  atlasCache.set(look.key, e);
  return e;
}

// Draw one frame with its feet at (x, y).
export function drawCharacter(ctx, atlas, name, x, y, hi) {
  let i = FRAME_INDEX[name];
  if (i === undefined) i = FRAME_INDEX.S_idle;
  ctx.drawImage(hi ? atlas.hi : atlas.canvas, (i % ATLAS_COLS) * CHAR_W, Math.floor(i / ATLAS_COLS) * CHAR_H, CHAR_W, CHAR_H, Math.round(x) - CHAR_AX, Math.round(y) - CHAR_AY, CHAR_W, CHAR_H);
}

export function clearCharacterCache() { atlasCache.clear(); }
export { HAIR, HATS };
