// Theme: copies the scene PALETTE into the CSS variables that style.css uses.
// style.css carries sensible defaults, so the page looks right before (or without) the palette.

// CSS variable -> names it may have in PALETTE (first hit wins). Names are compared without case, dashes or underscores.
// Scene framing, wood/steel accents, and signal colors track PALETTE; reading surfaces and ink use calm high-contrast tokens below.
const WANT = {
  '--shadow': ['shadow', 'night'],
  '--letterbox': ['wallDark', 'letterbox', 'shadow'],
  '--wood': ['wood3', 'wood', 'woodMid', 'brown'],
  '--wood-dark': ['wood2', 'woodDark', 'woodShade', 'brownDark'],
  '--wood-light': ['wood4', 'woodLight', 'woodHi', 'brownLight'],
  '--steel': ['steel4', 'steel', 'metal'],
  '--gray': ['gray', 'grey', 'neutral'],
  '--steel-dark': ['steel2', 'steelDark', 'metalDark'],
  '--steel-light': ['steel5', 'steelLight', 'metalLight'],
  '--brick': ['brick2', 'brick', 'rust'],
  '--amber': ['amber', 'signalAmber', 'gold'],
  '--green': ['green', 'signalGreen', 'ok'],
  '--red': ['red', 'signalRed', 'danger'],
  '--blue': ['steel4', 'blueGray', 'blueGrey', 'slate'],
  // kind tags, diff and log colors
  '--orange': ['orange'], '--lime': ['lime'], '--teal': ['teal'], '--purple': ['purple'], '--sky': ['sky'], '--pink': ['pink'], '--yellow': ['yellow'],
  '--leaf': ['leaf2', 'leaf'], '--leaf-dark': ['leaf1', 'leafDark'], '--rust': ['rust3', 'rust'], '--navy': ['navy2', 'navy'], '--navy-dark': ['navy1', 'navyDark'],
  '--brick-light': ['brick3', 'brickLight'], '--brick-dark': ['brick1', 'brickDark'],
};

// Calm reading & form surface tokens (decoupled from raw 16-bit sprite colors to prevent eye strain).
const UI_CALM = {
  '--ink': '#1d1c22',
  '--ink-soft': '#5f5b53',
  '--paper': '#f8f6f0',
  '--paper-2': '#efebe2',
  '--paper-3': '#dcd5c7',
  '--white': '#ffffff',
  '--border': '#d8d1c4',
  '--border-strong': '#b5ad9e',
  '--link': '#2b547e',
};

const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

function toCss(v) {
  if (typeof v === 'string') return /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\))$/i.test(v.trim()) ? v.trim() : null;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffff) return '#' + v.toString(16).padStart(6, '0');
  if (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) return `rgb(${v[0]}, ${v[1]}, ${v[2]})`;
  return null;
}

/** Flatten { wood: { dark: '#..' } } to { wooddark: '#..' }. Arrays of { name, hex } entries work too. */
function flatten(palette, prefix = '', out = new Map(), depth = 0) {
  if (!palette || typeof palette !== 'object' || depth > 3) return out;
  if (Array.isArray(palette)) {
    for (const e of palette) if (e && typeof e === 'object' && e.name) { const c = toCss(e.hex ?? e.color ?? e.value); if (c) out.set(norm(prefix + e.name), c); }
    return out;
  }
  for (const [k, v] of Object.entries(palette)) {
    const c = toCss(v);
    if (c) out.set(norm(prefix + k), c);
    else if (v && typeof v === 'object') flatten(v, prefix + k, out, depth + 1);
  }
  return out;
}

/**
 * applyPalette(PALETTE, { providers, roles, domains }?) -> number of CSS variables that were set on <html>.
 * Sets the base variables of style.css, every palette color as --pal-<name>, and the accents
 * --lab-<provider>, --role-<role>, --dom-<domain>.
 */
export function applyPalette(palette, extra = {}, root = document.documentElement) {
  const flat = flatten(palette);
  let n = 0;
  for (const [cssVar, names] of Object.entries(WANT)) {
    for (const name of names) {
      const c = flat.get(norm(name));
      if (c) { root.style.setProperty(cssVar, c); n++; break; }
    }
  }
  for (const [k, c] of Object.entries(UI_CALM)) { root.style.setProperty(k, c); n++; }
  for (const [k, c] of flat) root.style.setProperty('--pal-' + k, c);
  for (const [prefix, map] of [['--lab-', extra.providers], ['--role-', extra.roles], ['--dom-', extra.domains]]) {
    if (!map || typeof map !== 'object') continue;
    for (const [k, v] of Object.entries(map)) { const c = toCss(v); if (c && /^[a-z0-9]+$/i.test(k)) { root.style.setProperty(prefix + k.toLowerCase(), c); n++; } }
  }
  return n;
}

/** Load ./scene/palette.js and apply it. Resolves to false when the scene palette is not there. */
export async function loadTheme() {
  try {
    const mod = await import('./scene/palette.js');
    const palette = mod.PALETTE || mod.default;
    if (!palette) return false;
    applyPalette(palette, { providers: mod.PROVIDER_COLORS, roles: mod.ROLE_COLORS, domains: mod.DOMAIN_COLORS });
    return true;
  } catch {
    return false;
  }
}
