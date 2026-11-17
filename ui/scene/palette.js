// WorkShop palette: "cozy 16-bit", 63 named colors, muted but saturated.
// Reused by the HTML panels of the app. Pure data, safe to import in Node.
//
// Families: navy (walls), wood (furniture), floor (parquet), steel (machines), tile (machine floor),
// carpet (offices), crimson (accent), rust (hair, clay), leaf (plants), paper, signal colors, skin.
// `ink` is for outlines only.

export const PALETTE = Object.freeze({
  // darks
  ink: '#15121e',        // outlines only
  shadow: '#252036',     // deep shade
  wallDark: '#191a2b',   // letterbox / unlit wall
  // navy ramp (walls)
  navy1: '#1d2440',
  navy2: '#2b3760',
  navy3: '#40528a',
  navy4: '#6079b4',
  // wood ramp (dark -> light)
  wood1: '#3a2319',
  wood2: '#5f3a25',
  wood3: '#8c5b36',
  wood4: '#b8834e',
  wood5: '#dcae74',
  wood6: '#f1d6a2',
  // parquet floor (two close tones + seam)
  floor1: '#9a6240',
  floor2: '#a66c47',
  floor3: '#8c5639',
  // steel ramp (dark -> light)
  steel1: '#252c3d',
  steel2: '#3e4a62',
  steel3: '#637591',
  steel4: '#97a8bd',
  steel5: '#d0dce7',
  // machine-area tile
  tile1: '#566379',
  tile2: '#606e86',
  tile3: '#485468',
  // office carpet: blue and teal
  carpet1: '#33598a',
  carpet2: '#3d699c',
  carpet3: '#4877ab',
  tealc1: '#2c6d74',
  tealc2: '#367f84',
  // crimson accent
  brick1: '#6b1d33',
  brick2: '#9a2b45',
  brick3: '#c2455b',
  // rust (ginger hair, clay pots)
  rust1: '#5c2a20',
  rust2: '#8d412b',
  rust3: '#bb6036',
  // leaf greens
  leaf1: '#1d4636',
  leaf2: '#2c6b44',
  leaf3: '#479651',
  leaf4: '#7fc465',
  // paper
  paper: '#f3ead2',
  paper2: '#d9c9a3',
  plaster: '#bfad8a',
  white: '#fbf7ec',
  // signal colors
  red: '#d6453d',
  orange: '#e8853a',
  amber: '#f2b63a',
  yellow: '#f9e07a',
  straw: '#e9c665',      // blonde hair, straw, brass
  green: '#4ea653',
  lime: '#9ad66e',
  teal: '#2f9088',
  blue: '#3f78cc',
  sky: '#86bdf0',
  purple: '#7a55a0',
  pink: '#e89aa8',
  // neutrals
  gray: '#8d8a86',
  asphalt: '#33353f',
  asphalt2: '#40434e',
  // skin tones (light -> dark)
  skin1: '#f7d4b2',
  skin2: '#e2a97e',
  skin3: '#b97a52',
  skin4: '#7f5139',
});

// Aliases kept for the HTML panels (older names).
export const NAVY = PALETTE.navy2;

// Lab accent colors. Colors only, never logos.
export const PROVIDER_COLORS = Object.freeze({
  claude: PALETTE.orange,
  gemini: PALETTE.blue,
  openai: PALETTE.green,
  oss: PALETTE.lime,
  mock: PALETTE.gray,
});

export const ROLE_COLORS = Object.freeze({
  boss: PALETTE.purple,
  manager: PALETTE.amber,
  maker: PALETTE.teal,
});

// Task domain accent (crate labels, tooltips, panels).
export const DOMAIN_COLORS = Object.freeze({
  plan: PALETTE.blue,
  backend: PALETTE.steel4,
  algo: PALETTE.purple,
  frontend: PALETTE.pink,
  vision: PALETTE.brick3,
  research: PALETTE.sky,
  synthesis: PALETTE.teal,
  test: PALETTE.lime,
  review: PALETTE.green,
  docs: PALETTE.paper,
  data: PALETTE.amber,
  fix: PALETTE.red,
  chore: PALETTE.orange,
});

// Speech bubble border by kind.
export const BUBBLE_COLORS = Object.freeze({
  ask: PALETTE.blue,
  info: PALETTE.steel3,
  done: PALETTE.green,
  warn: PALETTE.red,
});

export function providerColor(p) { return PROVIDER_COLORS[p] || PROVIDER_COLORS.mock; }
export function roleColor(r) { return ROLE_COLORS[r] || ROLE_COLORS.maker; }
export function domainColor(d) { return DOMAIN_COLORS[d] || PALETTE.gray; }

// '#rrggbb' -> [r,g,b]
export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Linear mix of two palette colors, returned as '#rrggbb' (used for the sky bands only).
export function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  const c = A.map((v, i) => Math.round(v + (B[i] - v) * t));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}
