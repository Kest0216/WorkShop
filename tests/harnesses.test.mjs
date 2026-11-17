import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHarnesses, normalizeHarness, validateHarnessRegistry, renderHarnessCard } from '../server/harnesses.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-harnesses-'));
}

test('createHarnesses loads 7 shipped curated harnesses and renders .shop/HARNESS.md', () => {
  const configDir = tmpDir();
  try {
    const rack = createHarnesses({ configDir });
    const list = rack.list();
    assert.equal(list.length, 7);
    assert.ok(list.some((h) => h.id === 'fullstack-node'));
    const fixRig = rack.forDomain('fix', 'maker');
    assert.equal(fixRig.id, 'systems-debug');
    const leadRig = rack.forDomain('plan', 'manager');
    assert.equal(leadRig.id, 'team-lead-coord');

    const md = renderHarnessCard(fixRig);
    assert.match(md, /# Equipped Harness: Systems Root-Cause & Fix Rig/);
    assert.match(md, /systems-debug/);
    assert.match(md, /repro_before_fix/);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('createHarnesses upsert, remove, persistence and validation', () => {
  const configDir = tmpDir();
  try {
    const rack = createHarnesses({ configDir });
    const events = [];
    rack.onChange((snap) => events.push(snap.length));

    const added = rack.upsert({
      id: 'rust-kernel-rig',
      label: 'Rust Systems Rig',
      summary: 'Cargo check and miri-safe harness.',
      roleHint: 'maker',
      domains: ['backend'],
      tools: ['read_file', 'edit_file', 'run_shell', 'shop_mcp'],
      protocol: { workflow: ['Run cargo test'], systemPromptAddon: 'Always run cargo clippy.' },
      rft: { status: 'phase1_ready', rewardSignals: ['cargo_test_zero'], evalSuite: 'suites/rust-v0' },
    });
    assert.equal(added.id, 'rust-kernel-rig');
    assert.equal(events.at(-1), 8);

    // Reload from disk verifies atomic persistence
    const reloaded = createHarnesses({ configDir });
    assert.equal(reloaded.get('rust-kernel-rig').label, 'Rust Systems Rig');

    reloaded.remove('rust-kernel-rig');
    assert.equal(reloaded.get('rust-kernel-rig'), null);
    assert.equal(reloaded.list().length, 7);

    assert.throws(() => normalizeHarness({ id: 'BAD!', label: 'x', summary: 'y', domains: ['backend'] }), /2 to 40 lowercase/);
    assert.throws(() => validateHarnessRegistry({ version: 1, harnesses: [] }), /at least one harness/);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
