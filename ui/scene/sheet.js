// WorkShop art sheet (QA): every role with 12 seeds in all poses and facings, every bench tooling,
// every doohickey family and growth stage, crates, stock, icons and furniture. Opened by demo.html?sheet=1.

import { PALETTE as P } from './palette.js';
import { drawText } from './font.js';
import { lookFor, characterAtlas, drawCharacter, FRAME_NAMES, CHAR_W, CHAR_H, CHAR_AX, CHAR_AY } from './sprites.js';
import { DOMAINS, FAMILIES } from './model.js';

const ROLES = ['maker', 'manager', 'boss'];
const PROVIDERS = ['claude', 'gemini', 'openai', 'mock'];
export const SHEET_SEEDS = [12345, 777, 4242, 9001, 31337, 5150, 1101, 2207, 3301, 4409, 86, 60613];

const POSES = [
  'S_idle', 'S_blink', 'S_lookL', 'S_lookR', 'S_walk0', 'S_walk1', 'S_walk2', 'S_walk3', 'S_think', 'S_work0', 'S_work1', 'S_review0', 'S_review1', 'S_note0', 'S_note1',
  'S_carry', 'S_carry0', 'S_carry1', 'S_carry2', 'S_carry3',
  'N_idle', 'N_walk0', 'N_walk1', 'N_walk2', 'N_walk3', 'N_carry', 'N_carry1',
  'E_idle', 'E_blink', 'E_walk0', 'E_walk1', 'E_walk2', 'E_walk3', 'E_carry', 'E_carry0', 'E_note0', 'E_note1', 'E_review0', 'E_review1',
  'W_idle', 'W_walk0', 'W_walk1', 'W_walk2', 'W_walk3', 'W_carry', 'W_review0',
];

export const SHEET_W = 24 + POSES.length * 20 + 8;

function floorBand(ctx, y, h, kind) {
  ctx.fillStyle = kind === 1 ? P.carpet2 : kind === 2 ? P.tile2 : P.floor2;
  ctx.fillRect(0, y, SHEET_W, h);
}

// Returns the logical height it used. `ctx` belongs to a canvas at least SHEET_W wide.
export async function drawSheet(ctx, opts = {}) {
  let y = 0;
  ctx.fillStyle = P.floor2; ctx.fillRect(0, 0, SHEET_W, 4000);
  const label = (t) => { ctx.fillStyle = P.navy1; ctx.fillRect(0, y, SHEET_W, 11); drawText(ctx, t, 4, y + 3, P.paper); y += 13; };

  // ---- lineup: all roles x 12 seeds, front idle
  label('LINEUP  maker / manager / boss  x 12 seeds  (labs: orange claude, blue gemini, green openai, gray mock)');
  ROLES.forEach((role, r) => {
    floorBand(ctx, y, 36, r === 2 ? 1 : 0);
    SHEET_SEEDS.forEach((seed, i) => {
      const look = lookFor({ id: role + i, role, provider: PROVIDERS[i % 4], style: { seed } });
      const at = characterAtlas(look);
      ctx.fillStyle = 'rgba(21,18,30,0.25)'; ctx.fillRect(18 + i * 22 - 5, y + 32, 10, 2);
      drawCharacter(ctx, at, 'S_idle', 18 + i * 22, y + 34);
      drawCharacter(ctx, at, 'E_idle', 300 + i * 22, y + 34);
      drawCharacter(ctx, at, 'N_idle', 582 + i * 22, y + 34);
    });
    y += 38;
  });

  // ---- every pose
  const only = opts.role === 'none' ? [] : opts.role && ROLES.includes(opts.role) ? [opts.role] : ROLES;
  for (const role of only) {
    label(role.toUpperCase() + '  12 seeds, all poses: ' + 'S idle blink look walk x4 think work x2 review x2 note x2 carry x5 | N idle walk x4 carry x2 | E idle blink walk x4 carry x2 note x2 review x2 | W');
    SHEET_SEEDS.forEach((seed, i) => {
      floorBand(ctx, y, 34, role === 'boss' ? 1 : i % 4 === 3 ? 2 : 0);
      const look = lookFor({ id: role + i, role, provider: PROVIDERS[i % 4], style: { seed } });
      const at = characterAtlas(look);
      POSES.forEach((name, k) => { if (FRAME_NAMES.includes(name)) drawCharacter(ctx, at, name, 24 + k * 20, y + 33); });
      drawText(ctx, String(i + 1), 2, y + 14, P.wood1);
      y += 34;
    });
  }

  // ---- items and props (modules may be missing while the art is in work)
  let items = null, props = null;
  try { items = await import('./art_items.js'); } catch (e) { label('art_items.js failed: ' + e.message); }
  try { props = await import('./art_props.js'); } catch (e) { label('art_props.js failed: ' + e.message); }
  if (items && items.Items) {
    const I = items.Items;
    label('DOOHICKEYS  every task domain: growth stage 0..3, then its crate');
    ctx.fillStyle = P.wood5; ctx.fillRect(0, y, SHEET_W, 58);
    DOMAINS.forEach((dom, i) => {
      const x0 = 6 + (i % 7) * 124, yb = y + 24 + Math.floor(i / 7) * 28;
      drawText(ctx, dom, x0, yb - 21, P.wood1);
      for (let s = 0; s < 4; s++) I.draw(ctx, I.doohickey(dom, s), x0 + 8 + s * 17, yb);
      I.draw(ctx, I.crate(dom), x0 + 8 + 4 * 17, yb);
    });
    y += 60;
    label('BENCH TOOLING  per family, on a bench with the finished doohickey');
    floorBand(ctx, y, 44, 0);
    FAMILIES.forEach((fam, i) => {
      const x0 = 8 + i * 60, yb = y + 10;
      drawText(ctx, fam, x0, y + 2, P.wood1);
      if (props && props.Props && props.Props.bench) ctx.drawImage(props.Props.bench(), x0 - 1, yb + 5);
      I.draw(ctx, I.tooling(fam), x0 + 7, yb + 16);
      I.draw(ctx, I.doohickey(fam, 3), x0 + 23, yb + 16);
    });
    y += 46;
    label('STOCK, ICONS');
    ctx.fillStyle = P.tile2; ctx.fillRect(0, y, SHEET_W, 26);
    let x = 10;
    for (const k of ['lumber', 'metal', 'boxes']) { I.draw(ctx, I.stock(k), x, y + 20); x += 20; }
    for (const k of items.ICON_NAMES || []) { const im = I.icon(k); ctx.drawImage(im, x, y + 20 - im.height); x += im.width + 6; }
    if (I.blueprint) { ctx.drawImage(I.blueprint(), x, y + 8); x += 30; }
    y += 28;
  }
  if (props && props.Props) {
    label('FURNITURE AND VEHICLES');
    floorBand(ctx, y, 64, 0);
    let x = 6;
    for (const name of props.PROP_NAMES || []) {
      let im = null;
      try { im = props.Props[name](); } catch (e) { im = null; }
      if (!im) continue;
      if (x + im.width > SHEET_W - 4) { x = 6; y += 66; floorBand(ctx, y, 64, 0); }
      ctx.drawImage(im, x, y + 60 - im.height);
      drawText(ctx, name, x, y + 2, P.wood1);
      x += Math.max(im.width, name.length * 5) + 8;
    }
    y += 66;
  }
  label('BITMAP FONT  printable ASCII');
  ctx.fillStyle = P.navy1; ctx.fillRect(0, y, SHEET_W, 66);
  ['ABCDEFGHIJKLMNOPQRSTUVWXYZ  0123456789', 'abcdefghijklmnopqrstuvwxyz  !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~', 'The quick brown fox jumps over the lazy dog. Sphinx of black quartz, judge my vow!', 'Sprocket: retry the auth tests? 42% done  T12 backend  +3  14:30  Blocked: I need the schema!', 'Reviews running  6 tasks in work  Waiting for your OK  Session API  Login flow  claude-sonnet  @m3']
    .forEach((line, i) => drawText(ctx, line, 4, y + 4 + i * 12, i === 2 ? P.yellow : P.paper));
  y += 68;
  return y;
}

export { CHAR_W, CHAR_H, CHAR_AX, CHAR_AY };
