// Router rules of the amended contract (docs/ARCHITECTURE.md section 11, A11): candidates must pass
// providers.modelUsable(provider, model); a cooled model or a model that is not on the account is dropped with
// its cause; `why` names the cause; lab fallback off keeps its meaning per model.
// The registry is a temp copy of the shipped config/models.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter } from '../server/router.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOV_15 = new Date(2026, 10, 15, 12).getTime(); // 12:00 local time
const TWO_PM = new Date(2026, 10, 15, 14, 0).getTime();

function registryCopy(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ws-router-contract-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'models.json');
  copyFileSync(path.join(ROOT, 'config', 'models.json'), file);
  return file;
}

/**
 * A fake registry with the contract calls: usable(lab), modelUsable(lab, model), list() with models and
 * cooledModels. `cooled` maps model ids to an end time; `lists` maps a lab to its account list.
 */
function fakeProviders({ labs = ['claude', 'gemini'], cooled = {}, lists = {} } = {}) {
  const onList = (lab, model) => !lists[lab] || lists[lab].some((slug) => slug === model || slug.startsWith(`${model}-`));
  return {
    usable: (id) => labs.includes(id),
    modelUsable: (id, model) => labs.includes(id) && !(cooled[model] > NOV_15) && onList(id, model),
    list: () => ['claude', 'gemini'].map((id) => ({
      id,
      models: lists[id] ?? null,
      cooledModels: Object.fromEntries(Object.entries(cooled).filter(([m]) => m.startsWith(id === 'claude' ? 'claude-' : 'gemini-')).map(([m, until]) => [m, { until, reason: 'weekly limit' }])),
    })),
  };
}

const make = (t, providers, settings = { thrift: 0.3 }) => createRouter({ modelsPath: registryCopy(t), providers, getSettings: () => settings, now: () => NOV_15 });
const BOSS = { role: 'boss', domain: 'plan' };

test('A11 item 1: a cooled model is no candidate; another boss-tier model gets the pick, else a fallback-tier one', (t) => {
  const router = make(t, fakeProviders({ cooled: { 'claude-fable-5-2': TWO_PM } }));
  assert.equal(make(t, fakeProviders()).pick(BOSS).model, 'claude-fable-5-2', 'without the cooling Fable wins the plan');
  const pick = router.pick(BOSS);
  assert.equal(pick.model, 'gemini-4-carbon', 'another primary boss');
  const table = router.explain(BOSS);
  assert.deepEqual(table.rejected.find((row) => row.id === 'claude-fable-5-2'), { id: 'claude-fable-5-2', provider: 'claude', label: 'Claude Fable 5.2', reason: 'cooled until 14:00' });
  // The Google lab is down too: no primary boss is left, so the fallback tier (Opus) takes it.
  const alone = make(t, fakeProviders({ labs: ['claude'], cooled: { 'claude-fable-5-2': TWO_PM } }));
  const opus = alone.pick(BOSS);
  assert.equal(opus.model, 'claude-opus-5-5');
  assert.equal(opus.effort, 'high');
  assert.match(opus.why, /no primary boss is available so a fallback-tier model is used/);
  // The pause is over: Fable again.
  const later = createRouter({ modelsPath: registryCopy(t), providers: fakeProviders({ cooled: { 'claude-fable-5-2': NOV_15 - 1 } }), getSettings: () => ({ thrift: 0.3 }), now: () => NOV_15 });
  assert.equal(later.pick(BOSS).model, 'claude-fable-5-2');
});

test('A11 item 2: a model that is not on the account is dropped; explain lists it with the reason', (t) => {
  const lists = { gemini: ['gemini-4-argon-low', 'gemini-4-argon-medium', 'gemini-4-hydrogen-low', 'gemini-4-hydrogen-medium'] };
  const router = make(t, fakeProviders({ lists }));
  for (const domain of ['plan', 'fix', 'review', 'backend', 'research']) {
    assert.notEqual(router.pick({ role: 'boss', domain }).model, 'gemini-4-carbon', domain);
    assert.equal(router.explain({ role: 'boss', domain }).rejected.find((row) => row.id === 'gemini-4-carbon').reason, 'not on this account', domain);
  }
  // A registry whose modelUsable says no without a list in the status: the cause is still named.
  const quiet = make(t, { usable: () => true, modelUsable: (id, model) => model !== 'gemini-4-carbon', list: () => [] });
  assert.equal(quiet.explain(BOSS).rejected.find((row) => row.id === 'gemini-4-carbon').reason, 'not usable now');
});

test('A11 item 3: why names the cause when the best model was skipped', (t) => {
  const cooled = make(t, fakeProviders({ cooled: { 'claude-fable-5-2': TWO_PM } })).pick(BOSS);
  assert.match(cooled.why, /; best model Claude Fable 5\.2 is cooled until 14:00 \(reasoning 91\)$/);
  // fix: Carbon leads the boss table; this account has no Carbon.
  const lists = { gemini: ['gemini-4-argon-low', 'gemini-4-hydrogen-low'] };
  const missing = make(t, fakeProviders({ lists })).pick({ role: 'boss', domain: 'fix' });
  assert.equal(missing.model, 'claude-fable-5-2');
  assert.match(missing.why, /best model Gemini 4 Carbon is not on this account/);
  assert.doesNotMatch(missing.why, /lab not usable/);
});

test('A11 item 4: lab fallback off keeps its meaning per model: Fable cooled, Opus usable -> Opus, not null', (t) => {
  const off = { thrift: 0.3, allowFallback: false };
  const router = make(t, fakeProviders({ cooled: { 'claude-fable-5-2': TWO_PM } }), off);
  const pick = router.pick(BOSS);
  assert.ok(pick, 'not null: another model of the same lab fits');
  assert.equal(pick.model, 'claude-opus-5-5', 'the same lab, not the other lab (Carbon)');
  assert.equal(router.explain(BOSS).fallback, false);
  // Fable and Opus cooled: no model of the lab is left, so the router waits.
  const none = make(t, fakeProviders({ cooled: { 'claude-fable-5-2': TWO_PM, 'claude-opus-5-5': TWO_PM } }), off);
  assert.equal(none.pick(BOSS), null);
  const table = none.explain(BOSS);
  assert.equal(table.fallback, true);
  assert.match(table.reason, /Claude Fable 5\.2 \(claude\) is the pick, but that model is cooled until 14:00, no other model of the lab fits, and lab fallback is off\./);
  // With fallback on the other lab takes over.
  assert.equal(make(t, fakeProviders({ cooled: { 'claude-fable-5-2': TWO_PM, 'claude-opus-5-5': TWO_PM } })).pick(BOSS).model, 'gemini-4-carbon');
  // A whole lab down with fallback off: still null (the old rule).
  assert.equal(make(t, fakeProviders({ labs: ['gemini'] }), off).pick(BOSS), null);
});

test('A11: an older registry without modelUsable falls back to usable(lab)', (t) => {
  const router = make(t, { usable: (id) => id === 'claude' });
  assert.equal(router.pick(BOSS).model, 'claude-fable-5-2');
  assert.equal(router.pick({ role: 'maker', domain: 'backend', size: 'S' }).provider, 'claude');
});
