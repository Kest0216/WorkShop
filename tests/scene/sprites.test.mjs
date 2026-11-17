// Scene art that is pure data: character frames, items, props, palette and the bitmap font. No DOM needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PALETTE, PROVIDER_COLORS, ROLE_COLORS, DOMAIN_COLORS, providerColor } from '../../ui/scene/palette.js';
import { lookFor, buildCharacterFrames, renderLook, FRAME_NAMES, CHAR_W, CHAR_H, HAIR, HATS } from '../../ui/scene/sprites.js';
import { lookFromSeed, HAIR_STYLES, HEADGEAR, DOMAINS, FAMILIES } from '../../ui/scene/model.js';
import { Pix } from '../../ui/scene/pix.js';
import { _pix as itemPix } from '../../ui/scene/art_items.js';
import { _pix as propPix } from '../../ui/scene/art_props.js';
import { measureText, wrapText, truncateText, clampLines, drawText } from '../../ui/scene/font.js';

const sig = (p) => p.d.map((c) => c || '.').join('');

test('importing the scene modules needs no DOM', async () => {
  assert.equal(typeof document, 'undefined');
  for (const f of ['palette', 'pix', 'font', 'model', 'map', 'actors', 'sprites', 'art_items', 'art_props', 'hud', 'backdrop', 'render', 'scene', 'sheet', 'demo']) {
    await assert.doesNotReject(import('../../ui/scene/' + f + '.js'), f + '.js');
  }
});

test('palette: 48 to 64 valid colors, accents for every lab, role and domain', () => {
  const names = Object.keys(PALETTE);
  assert.ok(names.length >= 48 && names.length <= 64, names.length + ' colors');
  for (const n of names) assert.match(PALETTE[n], /^#[0-9a-f]{6}$/, n);
  assert.equal(new Set(Object.values(PALETTE)).size, names.length, 'no duplicate colors');
  assert.deepEqual(Object.keys(PROVIDER_COLORS), ['claude', 'gemini', 'openai', 'oss', 'mock']);
  assert.deepEqual(Object.keys(ROLE_COLORS), ['boss', 'manager', 'maker']);
  for (const d of DOMAINS) assert.ok(DOMAIN_COLORS[d], d);
  assert.equal(providerColor('unknown'), PROVIDER_COLORS.mock);
  for (const n of ['ink', 'shadow', 'wallDark', 'paper', 'paper2', 'plaster', 'white', 'wood2', 'wood3', 'wood4', 'steel2', 'steel3', 'steel4', 'steel5', 'brick2', 'amber', 'green', 'red']) assert.ok(PALETTE[n], 'the app theme needs ' + n);
});

test('every hair and hat map is 16 columns wide', () => {
  assert.deepEqual(Object.keys(HAIR).sort(), [...HAIR_STYLES].sort());
  for (const [k, v] of Object.entries(HAIR)) for (const r of v.rows) assert.equal(r.length, 16, 'hair ' + k);
  for (const h of HEADGEAR) if (h !== 'none') assert.ok(HATS[h], h);
  assert.ok(HATS.hardhat);
});

test('all frames of a look build in Node, fit the 24 x 32 buffer and show a 16 px wide figure', () => {
  assert.ok(FRAME_NAMES.length >= 50);
  for (const dir of ['S', 'N', 'E', 'W']) for (let i = 0; i < 4; i++) assert.ok(FRAME_NAMES.includes(dir + '_walk' + i), 'walk cycle of 4 frames for ' + dir);
  for (const n of ['S_idle', 'S_blink', 'S_think', 'S_work0', 'S_work1', 'S_review0', 'S_review1', 'S_carry', 'N_carry', 'E_carry', 'W_carry']) assert.ok(FRAME_NAMES.includes(n), n);
  for (const role of ['maker', 'manager', 'boss']) for (let seed = 1; seed <= 40; seed++) {
    const frames = buildCharacterFrames(lookFor({ id: 'x', role, provider: 'gemini', style: { seed: seed * 977 } }));
    assert.deepEqual(Object.keys(frames), [...FRAME_NAMES]);
    for (const [name, p] of Object.entries(frames)) {
      assert.ok(p instanceof Pix); assert.equal(p.w, CHAR_W); assert.equal(p.h, CHAR_H);
      const b = p.bounds();
      assert.ok(b && p.count() > 120, name + ' is not empty');
      assert.equal(b.y + b.h, CHAR_H, name + ': feet on the bottom row');
      assert.ok(b.y >= 0 && b.x >= 0);
    }
    const idle = frames.S_idle.bounds();
    assert.ok(idle.w <= 18 && idle.w >= 12, 'figure width ' + idle.w);
    assert.ok(idle.h >= 24 && idle.h <= 32, 'figure height ' + idle.h);
  }
});

test('the same seed always gives the same pixels; other seeds, roles and labs change them', () => {
  const a = buildCharacterFrames(lookFor({ id: 'A7', role: 'maker', provider: 'claude', style: { seed: 12345 } }));
  const b = buildCharacterFrames(lookFor({ id: 'other', role: 'maker', provider: 'claude', style: { seed: 12345 } }));
  for (const n of FRAME_NAMES) assert.equal(sig(a[n]), sig(b[n]), n);
  const lab = buildCharacterFrames(lookFor({ id: 'A7', role: 'maker', provider: 'gemini', style: { seed: 12345 } }));
  assert.notEqual(sig(a.S_idle), sig(lab.S_idle), 'the lab accent shows');
  assert.ok(a.S_idle.d.includes(PROVIDER_COLORS.claude)); assert.ok(lab.S_idle.d.includes(PROVIDER_COLORS.gemini));
  const boss = buildCharacterFrames(lookFor({ id: 'A7', role: 'boss', provider: 'claude', style: { seed: 12345 } }));
  assert.notEqual(sig(a.S_idle), sig(boss.S_idle));
  const seen = new Set();
  for (let s = 0; s < 60; s++) seen.add(sig(buildCharacterFrames(lookFor({ id: 'q', role: 'maker', provider: 'mock', style: { seed: 1000 + s * 31 } })).S_idle));
  assert.ok(seen.size >= 58, seen.size + ' distinct makers of 60');
});

test('animation frames differ from each other and W is the mirror of E', () => {
  const f = buildCharacterFrames(lookFor({ id: 'k', role: 'maker', provider: 'openai', style: { seed: 4242 } }));
  assert.notEqual(sig(f.S_walk0), sig(f.S_walk1)); assert.notEqual(sig(f.S_walk0), sig(f.S_walk2)); assert.notEqual(sig(f.E_walk0), sig(f.E_walk2));
  assert.notEqual(sig(f.S_idle), sig(f.S_blink)); assert.notEqual(sig(f.S_work0), sig(f.S_work1)); assert.notEqual(sig(f.S_idle), sig(f.S_carry));
  assert.notEqual(sig(f.S_idle), sig(f.N_idle)); assert.notEqual(sig(f.S_idle), sig(f.E_idle));
  assert.equal(sig(f.W_idle), sig(f.E_idle.mirror()));
  // the head bobs by one pixel in the walk cycle
  assert.equal(f.S_walk0.bounds().y, f.S_walk1.bounds().y + 1);
});

test('a look without a seed derives from the id; odd input still gives a look', () => {
  assert.equal(lookFor({ id: 'abc' }).key, lookFor({ id: 'abc' }).key);
  assert.notEqual(lookFor({ id: 'abc' }).key, lookFor({ id: 'abd' }).key);
  for (const junk of [null, undefined, 5, 'x', {}, { style: 7 }, { role: 'alien', provider: 9 }]) assert.ok(buildCharacterFrames(lookFor(junk)).S_idle.count() > 100);
  assert.ok(renderLook(null, 'x').key);
  assert.equal(renderLook(lookFromSeed(9, 'manager'), 'mock').hat, 'hardhat');
});

test('doohickeys grow in four stages for every domain; tooling, crates and props build', () => {
  for (const name of [...DOMAINS, ...FAMILIES]) {
    const { fam, variant } = itemPix.resolve(name);
    assert.ok(FAMILIES.includes(fam));
    const sizes = [0, 1, 2, 3].map((s) => itemPix.doohickeyPix(fam, s, variant).count());
    assert.ok(sizes[0] > 8, name + ' stage 0 is visible');
    assert.ok(sizes[3] > sizes[0], name + ' grows: ' + sizes.join(','));
    const b = itemPix.doohickeyPix(fam, 3, variant).bounds();
    assert.ok(b.w <= 14 && b.h <= 14);
    assert.ok(itemPix.TOOLING[fam], 'tooling for ' + fam);
  }
  assert.notEqual(sig(itemPix.doohickeyPix('machine', 3, false)), sig(itemPix.doohickeyPix('machine', 3, true)));
  assert.ok(itemPix.cratePix('docs').d.includes(DOMAIN_COLORS.docs));
  assert.ok(itemPix.cratePix('none').count() > 100);
  for (const fn of ['benchPix', 'postPix', 'deskPix', 'chairPix', 'counterPix', 'shelvesPix', 'machinePix', 'pressPix', 'palletPix', 'crateStackPix', 'shutterPix', 'glassPix']) assert.ok(propPix[fn]().count() > 50, fn);
  assert.ok(propPix.truckPix(0).count() > 1000); assert.notEqual(sig(propPix.truckPix(0)), sig(propPix.truckPix(1)));
  for (const d of ['S', 'N', 'E']) assert.ok(propPix.dollyPix(d, 0).count() > 80);
  for (const k of [0, 1, 2]) assert.ok(propPix.decorPix(k).count() > 100);
});

test('bitmap font: every printable ASCII character has its own glyph', () => {
  const fallback = measureText('é');
  let distinct = 0;
  for (let c = 32; c < 127; c++) {
    const ch = String.fromCharCode(c);
    const w = measureText(ch);
    assert.ok(w >= 1 && w <= 6, 'glyph ' + ch);
    const cells = [];
    drawText({ fillStyle: '', fillRect(x, y, ww) { for (let i = 0; i < ww; i++) cells.push(x + i + ',' + y); } }, ch, 0, 0, '#fff');
    if (ch !== ' ') { assert.ok(cells.length > 0, 'glyph ' + ch + ' draws pixels'); distinct++; }
  }
  assert.equal(distinct, 94);
  assert.equal(fallback, measureText('?'));
  assert.equal(measureText(''), 0); assert.equal(measureText(null), 0);
});

test('bitmap font: wrapping, truncation and two-line clamping', () => {
  assert.deepEqual(wrapText('', 50), []);
  for (const l of wrapText('The quick brown fox jumps over the lazy dog again and again', 60)) assert.ok(measureText(l) <= 60);
  assert.ok(measureText(truncateText('A very long name that will not fit', 40)) <= 40);
  assert.ok(truncateText('A very long name that will not fit', 40).endsWith('..'));
  assert.equal(truncateText('Pip', 40), 'Pip');
  const lines = clampLines('Blocked: I need the schema for the user table before I can go on with the import', 108, 2);
  assert.equal(lines.length, 2);
  for (const l of lines) assert.ok(measureText(l) <= 108, l);
  assert.ok(lines[1].endsWith('..'));
  assert.deepEqual(clampLines('Short text', 108, 2), ['Short text']);
  assert.ok(wrapText('Supercalifragilisticexpialidocious', 30).length > 1, 'long words are split');
  assert.doesNotThrow(() => { clampLines(undefined, 10); wrapText(12345, 0); truncateText({}, -4); });
});

// ---------------------------------------------------------------- review round 1

test('a finished test or review doohickey carries no check mark (that belongs to the PASS stamp only)', () => {
  const light = new Set([PALETTE.white, PALETTE.lime]);
  for (const variant of [false, true]) {
    const p = itemPix.doohickeyPix('gauge', 3, variant);
    const green = p.d.filter((c) => c === PALETTE.green).length, blue = p.d.filter((c) => c === PALETTE.blue || c === PALETTE.sky).length;
    assert.ok(green <= 1, 'at most the green zone of the dial is green (' + green + ')');
    assert.equal(blue, 0, 'no blue badge');
    assert.equal(p.d.filter((c) => light.has(c)).length, 0, 'no white or lime check mark');
    assert.notEqual(sig(p), sig(itemPix.doohickeyPix('gauge', 2, variant)), 'stage 3 still differs from stage 2');
  }
  assert.notEqual(sig(itemPix.doohickeyPix('gauge', 3, false)), sig(itemPix.doohickeyPix('gauge', 3, true)));
  // the PASS stamp keeps its check
  assert.ok(itemPix.ICONS.pass.join('').includes('w'));
});

test('new props build: office front with a doorway counter, cooler, drum, cart, reel', () => {
  const g = propPix.glassPix();
  assert.equal(g.w, 60); assert.equal(g.h, 17);
  assert.equal(g.get(30, 3), null, 'the doorway above the counter is open (no glass)');
  assert.ok(g.get(10, 5), 'the glass pane is on the left');
  for (const fn of ['coolerPix', 'drumPix', 'cartPix', 'reelPix']) { const p = propPix[fn](); assert.ok(p.count() > 100, fn); assert.ok(p.w <= 18 && p.h <= 26, fn + ' is a small prop'); }
});

test('bitmap font: lowercase a, e, s are upright and 3 px wide like their neighbours', () => {
  for (const ch of 'aes') assert.equal(measureText(ch), 3, ch);
  assert.equal(measureText('Moss'), measureText('Mooo'));
  const cells = (ch) => { const out = []; drawText({ fillRect(x, y, w) { for (let i = 0; i < w; i++) out.push((x + i) + ',' + y); }, set fillStyle(v) {} }, ch, 0, 0, '#fff'); return out.sort().join(' '); };
  assert.notEqual(cells('a'), cells('o')); assert.notEqual(cells('a'), cells('u')); assert.notEqual(cells('e'), cells('c')); assert.notEqual(cells('e'), cells('o')); assert.notEqual(cells('s'), cells('z'));
  assert.ok(cells('a').includes('2,4'), 'a has a stem on the right'); assert.ok(!cells('e').includes('2,3'), 'e is open at the bottom right');
});

test('the counter bell reads as a bell: 11 x 9 with a plunger knob, a dome highlight and a base plate', () => {
  const I = itemPix.ICONS;
  for (const n of ['bell', 'bellHit', 'bellL', 'bellR']) {
    assert.equal(I[n].length, 9, n + ' rows');
    assert.ok(I[n].every((r) => r.length === 11), n + ' is 11 px wide');
    assert.match(I[n].at(-1), /^\.2+\.$/, n + ' base plate');
  }
  assert.match(I.bell[0], /1/, 'plunger knob'); assert.ok(I.bell.some((r) => r.includes('w')), 'highlight');
  assert.notDeepEqual(I.bell, I.bellHit);
});
