// End to end, the job lifecycle (contract sections 3b, 12; section 15): cancel with a loaded truck and a later ship
// of the loaded crates, then delete; and hub restarts in the middle of a job (the same folders, a new hub process
// state), after which the job finishes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertAllVerified, bootShop, finish, git, leftovers, shipAndFinish, startJob } from './e2e-harness.mjs';

const T = { timeout: 300_000 };

function guard(t, getShop, dirs) {
  t.after(async () => {
    await getShop()?.close().catch(() => {});
    if (process.env.KEEP_E2E !== '1') fs.rmSync(dirs.tmp, { recursive: true, force: true, maxRetries: 3 });
  });
}

describe('e2e: lifecycle', () => {
  test('cancel with a loaded truck: turns stop, benches are saved, the truck stays; ship the loaded crates; delete', T, async (t) => {
    const shop = await bootShop();
    guard(t, () => shop, shop.dirs);
    const { api, app } = shop;
    const J = (await startJob(shop)).id;
    // A loaded crate, and an open task whose bench holds committed work (handed in, now in review).
    await shop.waitFor(() => shop.deliveries(J).some((d) => d.status === 'loaded') && shop.tasks(J).some((x) => x.status === 'review' && x.benchDir),
      { what: 'a loaded crate while another task is in review', jobId: J, every: 20 });
    const open = shop.tasks(J).filter((x) => x.benchDir && x.status !== 'merged').map((x) => x.id);
    const withWork = shop.tasks(J).filter((x) => x.benchDir && x.status === 'review').map((x) => x.id);
    assert.ok(open.length > 0 && withWork.length > 0);

    const c = await api('POST', `/api/jobs/${J}/cancel`, {});
    assert.equal(c.status, 200);
    assert.deepEqual([c.body.status, c.body.truckKept], ['cancelled', true]);
    await shop.waitFor(() => app.runner.active().length === 0, { what: 'the turns stop', jobId: J, timeoutMs: 20_000 });
    const project = shop.project(J);
    const refs = git(project.path, 'for-each-ref', '--format=%(refname)', `refs/workshop/${J}/`).split('\n');
    for (const id of withWork) {
      assert.ok(refs.includes(`refs/workshop/${J}/${id}`), `the bench of ${id} is saved`);
      assert.equal(shop.task(id).savedRef, `refs/workshop/${J}/${id}`);
    }
    for (const id of open) {
      // A bench with no work of its own has nothing to save (gitops saveBench returns null).
      if (shop.task(id).savedRef) assert.ok(refs.includes(shop.task(id).savedRef));
      assert.equal(fs.existsSync(path.join(app.paths.work, J, id)), false, `the bench folder of ${id} is gone`);
      assert.equal(fs.existsSync(path.join(app.paths.work, J, `${id}.rev`)), false, `the review clone of ${id} is gone`);
    }
    assert.ok(shop.tasks(J).every((x) => ['merged', 'cancelled'].includes(x.status)));
    assert.ok(git(project.path, 'rev-parse', `ws/${J}/int`), 'the integration branch stays while crates are loaded');
    const inbox = await api('GET', `/api/inbox?job=${J}`);
    assert.ok(inbox.body.some((i) => i.kind === 'truck'), 'the inbox offers the truck');

    // Nothing restarts the cancelled job.
    const turns = shop.turns.length;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(shop.turns.length, turns, 'no turn starts for a cancelled job');

    const truck = await api('GET', `/api/jobs/${J}/truck`);
    const loaded = truck.body.deliveries;
    assert.ok(loaded.length >= 1);
    assert.ok(loaded.every((d) => d.status === 'loaded'));
    assert.equal(truck.body.headSha, shop.job(J).intSha);
    const ship = await api('POST', `/api/jobs/${J}/ship`, { sha: truck.body.headSha });
    assert.deepEqual(ship.body, { ok: true, sha: truck.body.headSha, left: 0 });
    assert.equal(git(project.path, 'rev-parse', 'main'), truck.body.headSha);
    const onMain = git(project.path, 'ls-tree', '-r', '--name-only', 'main').split('\n');
    for (const d of loaded) for (const f of d.files) assert.ok(onMain.includes(f.path), `${f.path} shipped`);
    assert.ok(shop.deliveries(J).filter((d) => loaded.some((l) => l.id === d.id)).every((d) => d.status === 'shipped'));
    // After Ship of a cancelled job the integration branch goes; the saved benches stay until Delete.
    assert.equal(git(project.path, 'for-each-ref', `refs/heads/ws/${J}/`), '');
    assert.notEqual(git(project.path, 'for-each-ref', `refs/workshop/${J}/`), '');
    assert.equal(shop.job(J).status, 'cancelled');
    assert.equal((await api('POST', `/api/jobs/${J}/ship`, { sha: truck.body.headSha })).body.ok, false, 'nothing is left to ship');

    const del = await api('DELETE', `/api/jobs/${J}`);
    assert.equal(del.status, 200);
    assert.equal(git(project.path, 'for-each-ref', `refs/workshop/${J}/`), '', 'delete removes the saved refs');
    assert.equal(fs.existsSync(path.join(app.paths.work, J)), false);
    assert.equal(shop.job(J).title, 'Notes app', 'the job row stays');
    await finish(shop);
  });

  test('the hub restarts twice in the middle of a job (tasks working, then a crate in the hand-in or review); the job finishes', T, async (t) => {
    let shop = await bootShop();
    const dirs = shop.dirs;
    guard(t, () => shop, dirs);
    const turns = shop.turns;
    const logs = shop.logs;
    const J = (await startJob(shop)).id;

    // Restart 1: two makers work at their benches.
    await shop.waitFor(() => shop.tasks(J).filter((x) => x.status === 'working').length >= 2, { what: 'two working tasks', jobId: J });
    const seq1 = shop.app.store.state.seq;
    await shop.close();
    assert.deepEqual(await leftovers(dirs.tmp), [], 'the stop killed every agent turn');
    const mid = JSON.parse(fs.readFileSync(path.join(dirs.dataDir, 'state.json'), 'utf8'));
    assert.ok(Object.values(mid.tasks).some((x) => x.status === 'working'), 'the state on disk holds the working tasks');

    shop = await bootShop({ dirs, turns, logs });
    assert.ok(shop.app.store.state.seq >= seq1 + 1000, 'seq jumps by 1000 on a restart');
    assert.ok(shop.agents(J).every((a) => !['working', 'thinking', 'reviewing'].includes(a.status) || shop.app.runner.busy(a.id)), 'recover set mid-turn agents idle');

    // Restart 2: a crate is in the hand-in pipeline or in review.
    await shop.waitFor(() => shop.tasks(J).some((x) => ['checking', 'review', 'integrating'].includes(x.status)), { what: 'a task in checking, review or integrating', jobId: J, every: 20 });
    const caught = shop.tasks(J).filter((x) => ['checking', 'review', 'integrating'].includes(x.status)).map((x) => `${x.id}:${x.status}`);
    await shop.close();
    assert.deepEqual(await leftovers(dirs.tmp), []);

    shop = await bootShop({ dirs, turns, logs });
    await shipAndFinish(shop, J);
    const job = shop.job(J);
    assertAllVerified(job);
    assert.ok(shop.tasks(J).every((x) => x.status === 'merged'), `every task merged (restart caught ${caught})`);
    const project = shop.project(J);
    assert.equal(git(project.path, 'rev-parse', 'main'), job.intSha);
    const check = await shop.app.git.runCheck(project.path, project.checkCmd, { timeoutMs: 120_000 });
    assert.equal(check.ok, true, check.tail);
    // A restart never doubles a crate: one shipped crate per task.
    const shipped = shop.deliveries(J).filter((d) => d.status === 'shipped');
    assert.equal(new Set(shipped.map((d) => d.taskId)).size, shipped.length);
    assert.equal(shipped.length, shop.tasks(J).length);
    await finish(shop);
  });
});
