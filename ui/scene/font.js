// WorkShop bitmap font: variable width, 5 px caps, 2 px descenders, full printable ASCII.
// Pure data + helpers at import time (no DOM). drawText only needs a 2D context when called.

const G = {
  ' ': '../../../../..',
  '!': '#/#/#/./#',
  '"': '#.#/#.#/.../.../...',
  '#': '.#.#./#####/.#.#./#####/.#.#.',
  '$': '.##/##./###/.##/##.',
  '%': '#.#/..#/.#./#../#.#',
  '&': '.#../#.#./.#../#.#./.#.#',
  "'": '#/#/././.',
  '(': '.#/#./#./#./.#',
  ')': '#./.#/.#/.#/#.',
  '*': '.../#.#/.#./#.#/...',
  '+': '.../.#./###/.#./...',
  ',': '../../../../.#/#.',
  '-': '.../.../###/.../...',
  '.': '././././#',
  '/': '..#/..#/.#./#../#..',
  '0': '###/#.#/#.#/#.#/###',
  '1': '.#./##./.#./.#./###',
  '2': '###/..#/###/#../###',
  '3': '###/..#/.##/..#/###',
  '4': '#.#/#.#/###/..#/..#',
  '5': '###/#../###/..#/###',
  '6': '###/#../###/#.#/###',
  '7': '###/..#/.#./.#./.#.',
  '8': '###/#.#/###/#.#/###',
  '9': '###/#.#/###/..#/###',
  ':': './#/./#/.',
  ';': '../.#/../../.#/#.',
  '<': '..#/.#./#../.#./..#',
  '=': '.../###/.../###/...',
  '>': '#../.#./..#/.#./#..',
  '?': '###/..#/.#./.../.#.',
  '@': '.###./#.#.#/#.###/#..../.###.',
  'A': '.##./#..#/####/#..#/#..#',
  'B': '###./#..#/###./#..#/###.',
  'C': '.###/#.../#.../#.../.###',
  'D': '###./#..#/#..#/#..#/###.',
  'E': '####/#.../###./#.../####',
  'F': '####/#.../###./#.../#...',
  'G': '.###/#.../#.##/#..#/.###',
  'H': '#..#/#..#/####/#..#/#..#',
  'I': '###/.#./.#./.#./###',
  'J': '..##/...#/...#/#..#/.##.',
  'K': '#..#/#.#./##../#.#./#..#',
  'L': '#.../#.../#.../#.../####',
  'M': '#...#/##.##/#.#.#/#...#/#...#',
  'N': '#..#/##.#/#.##/#..#/#..#',
  'O': '.##./#..#/#..#/#..#/.##.',
  'P': '###./#..#/###./#.../#...',
  'Q': '.##./#..#/#..#/#.#./.#.#',
  'R': '###./#..#/###./#.#./#..#',
  'S': '.###/#.../.##./...#/###.',
  'T': '###/.#./.#./.#./.#.',
  'U': '#..#/#..#/#..#/#..#/.##.',
  'V': '#.#/#.#/#.#/#.#/.#.',
  'W': '#...#/#...#/#.#.#/##.##/#...#',
  'X': '#..#/#..#/.##./#..#/#..#',
  'Y': '#.#/#.#/.#./.#./.#.',
  'Z': '####/...#/.##./#.../####',
  '[': '##/#./#./#./##',
  '\\': '#../#../.#./..#/..#',
  ']': '##/.#/.#/.#/##',
  '^': '.#./#.#/.../.../...',
  '_': '.../.../.../.../.../###',
  '`': '#./.#/../../..',
  'a': '.../.##/#.#/#.#/.##',
  'b': '#../##./#.#/#.#/##.',
  'c': '.../.##/#../#../.##',
  'd': '..#/.##/#.#/#.#/.##',
  'e': '.../.#./#.#/##./.##',
  'f': '.##/.#./###/.#./.#.',
  'g': '.../.##/#.#/#.#/.##/..#/##.',
  'h': '#../##./#.#/#.#/#.#',
  'i': '#/./#/#/#',
  'j': '.#/../.#/.#/.#/.#/#.',
  'k': '#../#.#/##./#.#/#.#',
  'l': '#./#./#./#./.#',
  'm': '...../##.#./#.#.#/#.#.#/#.#.#',
  'n': '.../##./#.#/#.#/#.#',
  'o': '.../.#./#.#/#.#/.#.',
  'p': '.../##./#.#/#.#/##./#../#..',
  'q': '.../.##/#.#/#.#/.##/..#/..#',
  'r': '.../#.#/##./#../#..',
  's': '.../.##/#../..#/##.',
  't': '.#./###/.#./.#./.##',
  'u': '.../#.#/#.#/#.#/.##',
  'v': '.../#.#/#.#/#.#/.#.',
  'w': '...../#...#/#.#.#/#.#.#/.#.#.',
  'x': '.../#.#/.#./.#./#.#',
  'y': '.../#.#/#.#/#.#/.##/..#/##.',
  'z': '.../###/.#./#../###',
  '{': '.##/.#./#../.#./.##',
  '|': '#/#/#/#/#',
  '}': '##./.#./..#/.#./##.',
  '~': '..../.#.#/#.#./..../....',
};

export const FONT_CAP_HEIGHT = 5;
export const FONT_LINE_HEIGHT = 8;

// glyph -> { w, runs: [[x, y, len], ...] }
const GLYPHS = new Map();
for (const ch of Object.keys(G)) {
  const rows = G[ch].split('/');
  const w = rows[0].length;
  const runs = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] === '#') {
        let e = x;
        while (e < row.length && row[e] === '#') e++;
        runs.push([x, y, e - x]);
        x = e;
      } else x++;
    }
  });
  GLYPHS.set(ch, { w, runs });
}
const FALLBACK = GLYPHS.get('?');

function glyphFor(ch) {
  return GLYPHS.get(ch) || FALLBACK;
}

function clean(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/[\r\n\t]+/g, ' ');
}

// Width in pixels of one line of text (1 px gap between glyphs).
export function measureText(text) {
  const s = clean(text);
  let w = 0;
  for (let i = 0; i < s.length; i++) w += glyphFor(s[i]).w + 1;
  return w > 0 ? w - 1 : 0;
}

// Break text into lines no wider than maxWidth pixels. Long words are split.
export function wrapText(text, maxWidth) {
  const s = clean(text).trim();
  if (!s) return [];
  const max = Math.max(6, maxWidth | 0);
  const lines = [];
  let line = '';
  for (const word0 of s.split(/ +/)) {
    let word = word0;
    while (word) {
      const candidate = line ? line + ' ' + word : word;
      if (measureText(candidate) <= max) { line = candidate; word = ''; break; }
      if (line) { lines.push(line); line = ''; continue; }
      // a single word wider than the line: split by characters
      let cut = word.length;
      while (cut > 1 && measureText(word.slice(0, cut)) > max) cut--;
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Cut one line to maxWidth pixels, ending with the suffix when cut.
export function truncateText(text, maxWidth, suffix = '..') {
  let s = clean(text);
  if (measureText(s) <= maxWidth) return s;
  while (s.length > 0 && measureText(s + suffix) > maxWidth) s = s.slice(0, -1);
  return s.replace(/ +$/, '') + suffix;
}

// At most maxLines wrapped lines; the last one ends with ".." when text was cut.
export function clampLines(text, maxWidth, maxLines = 2) {
  const lines = wrapText(text, maxWidth);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = truncateText(kept[maxLines - 1] + ' ' + lines[maxLines], maxWidth);
  if (!kept[maxLines - 1].endsWith('..')) kept[maxLines - 1] = truncateText(kept[maxLines - 1] + '...', maxWidth);
  return kept;
}

function drawRuns(ctx, s, x, y) {
  let cx = x;
  for (let i = 0; i < s.length; i++) {
    const g = glyphFor(s[i]);
    const runs = g.runs;
    for (let k = 0; k < runs.length; k++) ctx.fillRect(cx + runs[k][0], y + runs[k][1], runs[k][2], 1);
    cx += g.w + 1;
  }
}

// Draw one line. (x, y) is the top-left of the cap height. opts: { align: 'left'|'center'|'right', shadow: color, outline: color }
// Returns the width drawn.
export function drawText(ctx, text, x, y, color, opts) {
  const s = clean(text);
  if (!s) return 0;
  const w = measureText(s);
  let px = Math.round(x);
  const py = Math.round(y);
  const align = opts && opts.align;
  if (align === 'center') px -= Math.floor(w / 2);
  else if (align === 'right') px -= w;
  if (opts && opts.outline) {
    ctx.fillStyle = opts.outline;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) drawRuns(ctx, s, px + dx, py + dy);
  } else if (opts && opts.shadow) {
    ctx.fillStyle = opts.shadow;
    drawRuns(ctx, s, px + 1, py + 1);
  }
  ctx.fillStyle = color || '#000';
  drawRuns(ctx, s, px, py);
  return w;
}
