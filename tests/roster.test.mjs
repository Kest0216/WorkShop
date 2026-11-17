import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHarnesses } from '../server/harnesses.js';
import { createRoster, normalizeEntry } from '../server/roster.js';

function tmpDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-roster-'));
  return { root, configDir: path.join(root, 'config'), dataDir: path.join(root, 'data') };
}

test('createRoster loads shipped employee book and matches curated vs missing specialty', () => {
  const { root, configDir } = tmpDirs();
  try {
    const harnesses = createHarnesses({ configDir });
    const roster = createRoster({ configDir, harnesses });
    const list = roster.list();
    assert.equal(list.length, 7);

    const backendMatch = roster.match({ domain: 'backend', role: 'maker' });
    assert.equal(backendMatch.entry.name, 'Sprocket');
    assert.equal(backendMatch.certified, true);
    assert.equal(backendMatch.needsRft, false);

    // Deliberately uncurated in Phase 0: algo and research
    const algoMatch = roster.match({ domain: 'algo', role: 'maker' });
    assert.equal(algoMatch.exactDomain, false);
    assert.equal(algoMatch.needsRft, true);
    assert.equal(algoMatch.reason, 'missing_specialty');

    const researchMatch = roster.match({ domain: 'research', role: 'maker' });
    assert.equal(researchMatch.entry.name, 'Flux');
    assert.equal(researchMatch.exactDomain, true);
    assert.equal(researchMatch.certified, false);
    assert.equal(researchMatch.needsRft, true);
    assert.equal(researchMatch.reason, 'uncertified_specialist');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createRoster upsert, recordOutcome, remove, and harness validation', () => {
  const { root, configDir } = tmpDirs();
  try {
    const harnesses = createHarnesses({ configDir });
    const roster = createRoster({ configDir, harnesses });

    assert.throws(() => roster.upsert({
      id: 'spec-bad', name: 'Bad', role: 'maker', baseModel: 'qwen3-coder-32b',
      harnessId: 'missing-harness', specialties: ['backend'],
    }), /Unknown harness/);

    const custom = roster.upsert({
      id: 'spec-euler', name: 'Euler', role: 'maker', title: 'Algorithms Specialist',
      baseModel: 'deepseek-r1-32b', harnessId: 'data-algo-lab', specialties: ['algo'], certification: 'curated',
    });
    assert.equal(custom.name, 'Euler');

    const after = roster.recordOutcome('spec-euler', { merged: true, reworked: true });
    assert.deepEqual(after.record, { tasksCompleted: 1, reworks: 1 });

    const reloaded = createRoster({ configDir, harnesses });
    assert.equal(reloaded.match({ domain: 'algo', role: 'maker' }).entry.name, 'Euler');
    assert.equal(reloaded.match({ domain: 'algo', role: 'maker' }).needsRft, false);

    reloaded.remove('spec-euler');
    assert.equal(reloaded.get('spec-euler'), null);

    assert.throws(() => normalizeEntry({ id: 'a', name: 'A' }), /id must be 2 to 40/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
