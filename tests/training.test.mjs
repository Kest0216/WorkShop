import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHarnesses } from '../server/harnesses.js';
import { createRoster } from '../server/roster.js';
import { createTraining } from '../server/training.js';

function tmpDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-training-'));
  return { root, configDir: path.join(root, 'config'), dataDir: path.join(root, 'data') };
}

test('createTraining queues, deduplicates by job+domain, enrolls into roster, and dismisses', () => {
  const { root, configDir, dataDir } = tmpDirs();
  try {
    const harnesses = createHarnesses({ configDir });
    const roster = createRoster({ configDir, harnesses });
    const training = createTraining({ dataDir, roster, harnesses });

    const r1 = training.createRequisition({
      jobId: 'J1', taskId: 'T1', domain: 'algo', reason: 'missing_specialty',
    });
    assert.equal(r1.id, 'TR1');
    assert.equal(r1.status, 'queued_phase1');
    assert.equal(r1.candidateBaseModel, 'deepseek-r1-32b');
    assert.equal(r1.harnessId, 'data-algo-lab');
    assert.ok(r1.rftSpec.rewardSignals.length > 0);

    // Second task in same job+domain deduplicates into linkedTasks
    const r1Again = training.createRequisition({
      jobId: 'J1', taskId: 'T2', domain: 'algo', reason: 'missing_specialty',
    });
    assert.equal(r1Again.id, 'TR1');
    assert.deepEqual(r1Again.linkedTasks, ['T1', 'T2']);

    // Enroll promotes a certified character into the Employee Book
    const enrolled = training.enroll('TR1', { name: 'Euler', checkpoint: 'oss://deepseek-r1-32b-algo-rft-v1' });
    assert.equal(enrolled.requisition.status, 'enrolled');
    assert.equal(enrolled.entry.name, 'Euler');
    assert.equal(enrolled.entry.certification, 'curated');
    assert.equal(roster.match({ domain: 'algo', role: 'maker' }).needsRft, false);

    // Dismissing another requisition keeps status dismissed across reload
    const r2 = training.createRequisition({ jobId: 'J1', taskId: 'T3', domain: 'vision', reason: 'missing_specialty' });
    assert.equal(r2.id, 'TR2');
    const dismissed = training.dismiss('TR2');
    assert.equal(dismissed.status, 'dismissed');

    const reloaded = createTraining({ dataDir, roster, harnesses });
    assert.equal(reloaded.list().length, 2);
    assert.equal(reloaded.get('TR2').status, 'dismissed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
