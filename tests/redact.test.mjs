// Tests for server/redact.js (contract section 14, review item A32). Run: node --test tests/redact.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRedactor } from '../server/redact.js';

const KEY = 'sk-abcdefgh1234';

test('add: every exact match becomes [redacted] and hit() is true', () => {
  const r = createRedactor();
  assert.equal(r.redact(`x ${KEY} y`), `x ${KEY} y`); // nothing held yet
  assert.equal(r.hit(`x ${KEY} y`), false);
  r.add(KEY);
  assert.equal(r.redact(`x ${KEY} y`), 'x [redacted] y');
  assert.equal(r.hit(`x ${KEY} y`), true);
  assert.equal(r.redact(`${KEY}${KEY}\n${KEY}`), '[redacted][redacted]\n[redacted]'); // every match, not the first only
  assert.equal(r.redact('x sk-abcdefgh123 y'), 'x sk-abcdefgh123 y'); // not exact: a prefix is not a match
  assert.equal(r.hit('sk-ABCDEFGH1234'), false); // case counts
});

test('remove: the value passes through again', () => {
  const r = createRedactor();
  r.add(KEY);
  r.remove(KEY);
  assert.equal(r.redact(`x ${KEY} y`), `x ${KEY} y`);
  assert.equal(r.hit(`x ${KEY} y`), false);
  r.remove(KEY); // a second remove is harmless
  r.remove('never-added-value');
  assert.equal(r.size(), 0);
});

test('values shorter than 8 characters and values that are not text are ignored', () => {
  const r = createRedactor();
  for (const value of ['short', '1234567', '', null, undefined, 12345678, { k: KEY }, [KEY]]) r.add(value);
  assert.equal(r.size(), 0);
  assert.equal(r.redact('short 1234567 12345678'), 'short 1234567 12345678');
  assert.equal(r.hit('short'), false);
  r.add('12345678'); // exactly 8 counts
  assert.equal(r.redact('a 12345678 b'), 'a [redacted] b');
});

test('regex characters in a value are matched as plain text; a longer value wins over its prefix', () => {
  const r = createRedactor();
  const odd = 'a.b*c+d?e(f)[g]{h}|i^j$k\\l/m-n';
  r.add(odd);
  assert.equal(r.redact(`<${odd}>`), '<[redacted]>');
  assert.equal(r.redact('aXb*c+d?e(f)[g]{h}|i^j$k\\l/m-n'), 'aXb*c+d?e(f)[g]{h}|i^j$k\\l/m-n'); // "." is not a wildcard
  r.add('token-0123456789');
  r.add('token-0123456789-and-more');
  assert.equal(r.redact('token-0123456789-and-more!'), '[redacted]!');
  assert.equal(r.redact('token-0123456789!'), '[redacted]!');
});

test('add is idempotent; text that is not a string is returned as is; two redactors share nothing', () => {
  const a = createRedactor();
  const b = createRedactor();
  a.add(KEY);
  a.add(KEY);
  assert.equal(a.size(), 1);
  a.remove(KEY);
  assert.equal(a.hit(KEY), false); // one remove undoes any number of adds
  a.add(KEY);
  assert.equal(b.hit(KEY), false);
  const obj = { KEY };
  assert.equal(a.redact(obj), obj);
  assert.equal(a.redact(undefined), undefined);
  assert.equal(a.hit(null), false);
  // A value added after a redact() is picked up (the pattern is rebuilt).
  assert.equal(a.redact('x other-secret-value y'), 'x other-secret-value y');
  a.add('other-secret-value');
  assert.equal(a.redact('x other-secret-value y'), 'x [redacted] y');
});
