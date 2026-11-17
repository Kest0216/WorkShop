// Setup and check commands of server/gitops.js: the allow-list environment, the sandbox-exec profile of safety
// 'sandboxed', redacted tails and the timeouts (docs/ARCHITECTURE.md sections 9 and 12c; review items A13, A32).
// Everything lives in a temp dir. HOME is a fake home there: the "private key" read below is a test file.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGit } from '../server/gitops.js';

const canSandbox = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const FAKE_KEY = 'FAKE-PRIVATE-KEY-0f3a9c-for-tests';
let root;
let home;
let baseEnv;
let ownerEnv;
let shops = 0;

before(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ws-gitops-sbx-')));
  home = path.join(root, 'home');
  await fs.mkdir(path.join(home, '.ssh'), { recursive: true });
  await fs.writeFile(path.join(home, '.ssh', 'id_rsa'), `${FAKE_KEY}\n`);
  await fs.mkdir(path.join(home, '.aws'), { recursive: true });
  await fs.writeFile(path.join(home, '.aws', 'credentials'), `${FAKE_KEY}\n`);
  const plain = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  baseEnv = {
    ...plain, HOME: home, LANG: 'en_US.UTF-8', TERM: 'dumb', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    AWS_SECRET_ACCESS_KEY: 'aws-secret-value', DATABASE_URL: 'postgres://u:p@h/db', SSH_AUTH_SOCK: '/tmp/agent.sock',
    ANTHROPIC_API_KEY: 'sk-ant-not-real', SAFE_LOOKING: 'still-not-passed',
  };
  ownerEnv = { ...baseEnv, GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'o@example.com', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'o@example.com' };
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const there = (file) => fs.lstat(file).then(() => true, () => false);
const owner = (cwd, ...args) => new Promise((resolve, reject) => {
  execFile('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: ownerEnv }, (err, stdout, stderr) => (err ? reject(new Error(stderr)) : resolve(stdout.trim())));
});

/** A module instance over a fresh folder. settings: what getSettings returns. */
async function setup({ settings = { safety: 'sandboxed' }, redactor } = {}) {
  shops += 1;
  const dir = path.join(root, `shop ${shops}`);
  const paths = { projects: path.join(dir, 'projects'), work: path.join(dir, 'data', 'work'), run: path.join(dir, 'data', 'run'), logs: path.join(dir, 'data', 'logs') };
  const folder = path.join(dir, 'folder');
  await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(path.join(paths.run, 'selftest'), { recursive: true });
  await fs.writeFile(path.join(paths.run, 'selftest', 'canary'), 'canary-text\n');
  const git = createGit({ paths, env: baseEnv, getSettings: () => settings, redactor });
  return { dir, paths, folder, git };
}

/** Can this machine reach the internet at all (outside any sandbox)? Then the setup profile must allow it too. */
function online() {
  try {
    execFileSync('/usr/bin/curl', ['-sS', '-m', '5', '-o', '/dev/null', 'https://example.com'], { stdio: 'ignore', timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

describe('command environment (A13)', () => {
  for (const safety of ['trusting', 'sandboxed']) {
    test(`${safety}: only HOME USER LOGNAME SHELL TERM LANG TMPDIR PATH reach the command`, { skip: safety === 'sandboxed' && !canSandbox }, async () => {
      const s = await setup({ settings: { safety } });
      const result = await s.git.runCheck(s.folder, 'env', {});
      assert.equal(result.ok, true, result.tail);
      const names = result.tail.trim().split('\n').map((line) => line.split('=')[0]).filter(Boolean);
      for (const name of names) assert.ok(['HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'TMPDIR', 'PATH', 'PWD', 'SHLVL', '_', 'OLDPWD'].includes(name), name);
      for (const secret of ['aws-secret-value', 'postgres://', '/tmp/agent.sock', 'sk-ant-not-real', 'still-not-passed']) assert.ok(!result.tail.includes(secret), secret);
      assert.match(result.tail, new RegExp(`^HOME=${home}$`, 'm'));
      assert.match(result.tail, /^LANG=en_US\.UTF-8$/m);
      const setupRun = await s.git.runSetup(s.folder, 'env', {});
      assert.ok(!setupRun.tail.includes('aws-secret-value'));
    });
  }

  test('sandboxed: a private temp dir per run, removed afterwards', { skip: !canSandbox }, async () => {
    const s = await setup();
    const result = await s.git.runCheck(s.folder, 'echo "$TMPDIR"; echo x > "$TMPDIR/scratch" && echo wrote', {});
    assert.equal(result.ok, true, result.tail);
    const [tmp, wrote] = result.tail.trim().split('\n');
    assert.equal(wrote, 'wrote');
    assert.notEqual(path.resolve(tmp), path.resolve(baseEnv.TMPDIR ?? os.tmpdir()));
    assert.equal(await there(tmp), false);
  });
});

describe('sandbox profile (A13)', { skip: !canSandbox }, () => {
  test('check: writes only in its folder, the temp dir and the caches; the deny-read list is closed', async () => {
    const s = await setup();
    const inside = await s.git.runCheck(s.folder, 'echo hi > inside.txt && cat inside.txt && mkdir -p "$HOME/.npm/_cache" && echo c > "$HOME/.npm/_cache/x" && echo cached', {});
    assert.deepEqual(inside, { ok: true, code: 0, tail: 'hi\ncached\n' });

    const escape = await s.git.runCheck(s.folder, 'touch ../escape', {});
    assert.equal(escape.ok, false);
    assert.match(escape.tail, /Operation not permitted/);
    assert.equal(await there(path.join(s.dir, 'escape')), false);
    const homeWrite = await s.git.runCheck(s.folder, 'echo x > "$HOME/planted"', {});
    assert.equal(homeWrite.ok, false);
    assert.equal(await there(path.join(home, 'planted')), false);

    for (const cmd of ['cat ~/.ssh/id_rsa', 'cat "$HOME/.aws/credentials"', `cat '${path.join(s.paths.run, 'selftest', 'canary')}'`, 'ls ~/.ssh']) {
      const read = await s.git.runCheck(s.folder, cmd, {});
      assert.equal(read.ok, false, cmd);
      assert.match(read.tail, /Operation not permitted/, cmd);
      assert.ok(!read.tail.includes(FAKE_KEY) && !read.tail.includes('canary-text'), cmd);
    }

    // the same commands unconfined: proof that the sandbox is what stops them
    const loose = await setup({ settings: { safety: 'trusting' } });
    assert.equal((await loose.git.runCheck(loose.folder, 'touch ../escape', {})).ok, true);
    assert.equal(await there(path.join(loose.dir, 'escape')), true);
    assert.match((await loose.git.runCheck(loose.folder, 'cat ~/.ssh/id_rsa', {})).tail, new RegExp(FAKE_KEY));
  });

  test('check: localhost only; setup: the network', async () => {
    const s = await setup();
    const local = await s.git.runCheck(s.folder, `'${process.execPath}' -e "const n=require('net');const v=n.createServer(c=>c.end('pong')).listen(0,'127.0.0.1',()=>{n.connect(v.address().port,'127.0.0.1').on('data',d=>{console.log(String(d));process.exit(0)})})"`, {});
    assert.deepEqual(local, { ok: true, code: 0, tail: 'pong\n' });
    const far = await s.git.runCheck(s.folder, '/usr/bin/curl -sS -m 5 -o /dev/null https://example.com', {});
    assert.equal(far.ok, false);
    if (online()) {
      const fetched = await s.git.runSetup(s.folder, '/usr/bin/curl -sS -m 10 -o /dev/null -w "%{http_code}" https://example.com', {});
      assert.equal(fetched.ok, true, fetched.tail);
    }
    // setup has the same file rules as the check
    const escape = await s.git.runSetup(s.folder, 'touch ../escape-setup', {});
    assert.equal(escape.ok, false);
    assert.equal(await there(path.join(s.dir, 'escape-setup')), false);
  });

  test('12c: runCheck works in the canonical project folder too', async () => {
    const s = await setup();
    const made = await s.git.initProject({ name: 'Canon' });
    assert.deepEqual(await s.git.runCheck(made.path, 'true', {}), { ok: true, code: 0, tail: '' });
    const status = await s.git.runCheck(made.path, 'git status --porcelain && echo listed', {});
    assert.equal(status.ok, true, status.tail);
    assert.equal(await owner(made.path, 'status', '--porcelain'), '');
  });

  test('a missing safety setting means sandboxed', async () => {
    const s = await setup({ settings: undefined });
    const plain = createGit({ paths: s.paths, env: baseEnv });
    assert.equal((await plain.runCheck(s.folder, 'touch ../escape-default', {})).ok, false);
    assert.equal(await there(path.join(s.dir, 'escape-default')), false);
  });
});

describe('redaction and timeouts', () => {
  test('A32: every tail goes through the redactor', async () => {
    const stored = 'stored-key-value-7d1e2f';
    const redactor = { redact: (text) => text.split(stored).join('[redacted]'), hit: (text) => text.includes(stored) };
    const s = await setup({ settings: { safety: canSandbox ? 'sandboxed' : 'trusting' }, redactor });
    const check = await s.git.runCheck(s.folder, `echo "key=${stored}"`, {});
    assert.equal(check.tail, 'key=[redacted]\n');
    const setupRun = await s.git.runSetup(s.folder, `echo "key=${stored}"; exit 2`, {});
    assert.deepEqual(setupRun, { ok: false, code: 2, tail: 'key=[redacted]\n' });

    // the head check tail too
    const made = await s.git.initProject({ name: 'Redact' });
    const project = { id: 'P1', name: 'Redact', path: made.path, targetBranch: 'main', setupCmd: null, checkCmd: `echo "${stored}"` };
    await s.git.startJob(project, 'J1');
    const head = await s.git.headCheck(project, 'J1');
    assert.equal(head.tail, '[redacted]\n');

    // a redactor that throws: no raw text comes out
    const broken = await setup({ settings: { safety: 'trusting' }, redactor: { redact: () => { throw new Error('boom'); }, hit: () => false } });
    const hidden = await broken.git.runCheck(broken.folder, `echo "${stored}"`, {});
    assert.ok(!hidden.tail.includes(stored));
  });

  test('section 9: the check timeout comes from limits.checkTimeoutMin; setup keeps its fixed 15 min', async () => {
    const s = await setup({ settings: { safety: canSandbox ? 'sandboxed' : 'trusting', limits: { checkTimeoutMin: 0.02 } } }); // 1.2 s
    const started = Date.now();
    const slow = await s.git.runCheck(s.folder, 'sleep 5', {});
    assert.equal(slow.code, 124);
    assert.match(slow.tail, /stopped: no result after 1 s/);
    assert.ok(Date.now() - started < 4500);
    const setupRun = await s.git.runSetup(s.folder, 'sleep 2; echo done', {});
    assert.deepEqual(setupRun, { ok: true, code: 0, tail: 'done\n' });
    const passed = await s.git.runCheck(s.folder, 'sleep 3; echo late', { timeoutMs: 6000 }); // the caller's value wins
    assert.equal(passed.ok, true);
  });
});
