// End to end over HTTP with the mock lab: the final wiring spec, part S. [mock:reqorphan] takes a job to the inbox
// item 'requirement'; POST /api/jobs/:id/changes with reqId takes it out, and the job goes on to done (S7, S8).
// On the way: the heartbeat (S1), adopt-check (S2), reveal open:false (S3), the notice panel (S5), the post limit (S6).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BRIEF, assertAllVerified, bootShop, finish, git, shipAndFinish, startJob } from './e2e-harness.mjs';

const T = { timeout: 300_000 };

describe('e2e: final wiring (part S)', () => {
  test('[mock:reqorphan] -> inbox requirement -> "Add task" with reqId -> the item leaves, the job is done', T, async (t) => {
    const revealed = [];
    const shop = await bootShop({ app: { reveal: async (p) => { revealed.push(p); } } });
    t.after(async () => {
      await shop.close().catch(() => {});
      if (process.env.KEEP_E2E !== '1') fs.rmSync(shop.dirs.tmp, { recursive: true, force: true, maxRetries: 3 });
    });

    // S2: adopt-check reads an owner repo and changes nothing; a folder that is no repo is a 400 with the git words.
    const repo = path.join(shop.dirs.tmp, 'owner-repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'trunk');
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Agents\n');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=Owner', '-c', 'user.email=owner@example.com', 'commit', '-q', '-m', 'first');
    const before = [git(repo, 'for-each-ref'), git(repo, 'status', '--porcelain'), fs.readdirSync(path.join(repo, '.git')).sort().join(',')];
    const check = await shop.api('POST', '/api/adopt-check', { path: repo });
    assert.equal(check.status, 200, JSON.stringify(check.body));
    assert.deepEqual(check.body, { path: fs.realpathSync(repo), targetBranch: 'trunk', agentFiles: ['AGENTS.md'] });
    assert.deepEqual([git(repo, 'for-each-ref'), git(repo, 'status', '--porcelain'), fs.readdirSync(path.join(repo, '.git')).sort().join(',')], before, 'the repo is unchanged');
    const plain = path.join(shop.dirs.tmp, 'plain-folder');
    fs.mkdirSync(plain);
    const notGit = await shop.api('POST', '/api/adopt-check', { path: plain });
    assert.equal(notGit.status, 400);
    assert.match(notGit.body.error, /^Not a git repository: /);
    assert.equal((await shop.api('POST', '/api/adopt-check', { path: 'relative' })).status, 400);

    const J = (await startJob(shop, { brief: `${BRIEF} [mock:reqorphan]` })).id;
    await shop.waitFor(() => shop.app.orch.inbox(J).find((i) => i.kind === 'requirement'), { what: 'the inbox item "requirement"', jobId: J });
    const viaHttp = await shop.api('GET', `/api/inbox?job=${J}`);
    const listed = viaHttp.body.find((i) => i.kind === 'requirement');
    assert.ok(listed, 'GET /api/inbox lists it');
    assert.deepEqual(listed.options.map((o) => o.key), ['waive', 'task', 'stop']);
    const lost = listed.reqId;
    assert.equal(shop.job(J).requirements.find((r) => r.id === lost).status, 'failed');
    assert.equal(shop.tasks(J).filter((x) => x.reqs.includes(lost) && x.status !== 'merged').length, 0, 'no open task serves it');
    // S5: the owner notice names its panel.
    const note = await shop.waitFor(() => shop.notices().find((n) => n.level === 'owner' && n.text.includes(`${lost} failed and no task serves`)), { what: 'the owner notice', jobId: J, timeoutMs: 15_000 });
    assert.equal(note.panel, 'inbox');

    // S7: 'Add task' with reqId. Unknown ids are 404; the item leaves the inbox at once.
    assert.equal((await shop.api('POST', `/api/jobs/${J}/changes`, { text: 'x', reqId: 'R99' })).status, 404);
    const added = await shop.api('POST', `/api/jobs/${J}/changes`, { text: `Add the missing test for ${lost}.`, reqId: lost });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal(added.body.ok, true);
    assert.equal(added.body.req.servesReq, lost);
    const after = await shop.api('GET', `/api/inbox?job=${J}`);
    assert.ok(!after.body.some((i) => i.kind === 'requirement'), 'the item left the inbox');

    // S6: a board post body over 1900 chars is refused with a clear text.
    const long = await shop.api('POST', '/api/board', { jobId: J, kind: 'INFO', body: 'x'.repeat(1901) });
    assert.deepEqual([long.status, long.body.error], [400, 'The message is too long (1901 chars). Max 1900.']);

    // S3: the truck preview without Finder.
    await shop.waitFor(() => { const j = shop.job(J); return j.status === 'delivering' && j.report; }, { what: `${J} delivering`, jobId: J });
    const preview = await shop.api('POST', '/api/reveal', { jobId: J, what: 'truck', open: false });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.ok, true);
    assert.ok(path.isAbsolute(preview.body.path) && fs.existsSync(preview.body.path), preview.body.path);
    assert.deepEqual(revealed, [], 'Finder was not asked');

    await shipAndFinish(shop, J);
    const job = shop.job(J);
    assertAllVerified(job);
    assert.equal(job.qa.round, 2, 'QA checked it again in round 2');
    const extra = job.requirements.find((r) => r.id === added.body.req.id);
    assert.equal(extra.servesReq, lost);
    assert.ok(shop.tasks(J).some((x) => x.reqs.includes(extra.id) && x.status === 'merged'), 'a task served the new requirement');
    assert.equal(shop.notices().filter((n) => n.level === 'owner' && n.text.includes(lost) && /no task/.test(n.text)).length, 1, 'it asked once');
    const statuses = shop.seen('jobs', (j) => j.id === J).map((j) => j.status).filter((s, i, a) => s !== a[i - 1]);
    assert.deepEqual(statuses.slice(statuses.indexOf('qa')), ['qa', 'running', 'qa', 'delivering', 'done']);

    // S5 on the stream: the plan note names the Blueprint, the done note has panel null.
    await shop.waitFor(() => shop.notices().some((n) => n.text === `${J} is done.`), { what: 'the done notice', jobId: J, timeoutMs: 15_000 });
    const owners = shop.notices().filter((n) => n.level === 'owner');
    assert.equal(owners.find((n) => n.text.startsWith(`Plan for ${J}`)).panel, 'blueprint');
    const done = owners.find((n) => n.text === `${J} is done.`);
    assert.ok(Object.hasOwn(done, 'panel') && done.panel === null);
    // S1: a heartbeat comes every 5 s as a data message with a seq.
    await shop.waitFor(() => shop.sse.some((e) => e.type === 'hb'), { what: 'a heartbeat', timeoutMs: 8000 });
    const beats = shop.sse.filter((e) => e.type === 'hb');
    const health = await shop.api('GET', '/api/health');
    assert.ok(beats.every((b) => Number.isInteger(b.seq) && b.seq <= health.body.seq));
    await finish(shop);
  });
});
