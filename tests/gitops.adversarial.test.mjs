// Adversarial tests for server/gitops.js. Real git, temp dirs under os.tmpdir(), nothing outside them.
//
// Every test here failed against the first build of the module, except the ones marked "guard":
// those pin behaviour that a fix must not break. The comment above a test names the defect.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGit, matchZone, zonesOverlap } from '../server/gitops.js';

let root; // everything this file creates lives here
let hubEnv; // the hub and the agents: no git config of the owner, no identity from outside
let ownerEnv; // the human owner, and every read-only assertion
let realGit;
let shops = 0;

before(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ws-gitops-adv-')));
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  hubEnv = { ...base, LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  ownerEnv = {
    ...hubEnv,
    GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.com',
  };
  realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8', env: hubEnv }).trim();
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/* ------------------------------------------------------------------ helpers */

function run(cwd, args, env) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')} failed in ${cwd}: ${stderr || err.message}`));
      else resolve(stdout.replace(/\n$/, ''));
    });
  });
}
const owner = (cwd, ...args) => run(cwd, args, ownerEnv);
/** A maker CLI inside a bench: plain git with the identity of the bench config. */
const agent = (cwd, ...args) => run(cwd, args, hubEnv);

async function put(dir, rel, content) {
  const file = path.join(dir, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}
const read = (dir, rel) => fs.readFile(path.join(dir, rel), 'utf8');
const there = (file) => fs.lstat(file).then(() => true, () => false);
const record = async (benchDir) => JSON.parse(await read(benchDir, '.git/workshop.json'));
/** The ship option for "the truck head the owner sees": ship needs the exact commit (contract section 9). */
const atHead = async (project) => ({ sha: await owner(project.path, 'rev-parse', 'ws/J1/int') });

/** A project (seeded with committed files) with a started job J1. make() gives another module instance (a restart). */
async function shop({ seed = { 'README.md': 'hello\n' }, ...options } = {}) {
  shops += 1;
  const dir = path.join(root, `shop ${shops}`);
  const paths = { projects: path.join(dir, 'projects'), work: path.join(dir, 'data', 'work') };
  const logs = [];
  const make = (more = {}) => createGit({ paths, env: hubEnv, log: (level, msg, data) => logs.push({ level, msg, data }), ...more });
  const git = make(options);
  const made = await git.initProject({ name: 'Demo App' });
  for (const [rel, content] of Object.entries(seed)) await put(made.path, rel, content);
  await owner(made.path, 'add', '-A');
  await owner(made.path, 'commit', '-q', '-m', 'seed');
  const project = { id: 'P1', name: 'Demo App', path: made.path, targetBranch: made.targetBranch, hubCreated: true, setupCmd: null, checkCmd: null };
  const job = await git.startJob(project, 'J1');
  return { dir, paths, logs, make, git, project, job };
}

/** One whole task: bench, edits, hand-in, sync, integrate. */
async function deliver(s, taskId, changes) {
  const bench = await s.git.createBench(s.project, 'J1', taskId, {});
  for (const [rel, content] of Object.entries(changes)) await put(bench.dir, rel, content);
  await s.git.commitAll(bench.dir, `${taskId}: work`, 'Rusty');
  assert.equal((await s.git.syncBench(bench.dir)).ok, true);
  const done = await s.git.integrate(s.project, 'J1', taskId, bench.dir, `${taskId}: merge`);
  assert.equal(done.ok, true, JSON.stringify(done));
  return { ...bench, mergeSha: done.mergeSha };
}

/* ------------------------------------------------------------------ zones */

describe('zones', () => {
  // Defect: the free jump over "**/" could be taken after "**" had already matched text, so
  // "**/b" worked like "**b". A zone "**/index.js" let a maker edit "src/reindex.js".
  test('"**/" stands for whole folders, never for a part of a name', () => {
    const table = [
      ['b', ['**/b'], true],
      ['x/b', ['**/b'], true],
      ['x/y/b', ['**/b'], true],
      ['ab', ['**/b'], false],
      ['abab', ['**/b'], false],
      ['x/ab', ['**/b'], false],
      ['README.md', ['**/README.md'], true],
      ['docs/README.md', ['**/README.md'], true],
      ['docs/OLD-README.md', ['**/README.md'], false],
      ['src/index.js', ['src/**/index.js'], true],
      ['src/a/b/index.js', ['src/**/index.js'], true],
      ['src/reindex.js', ['src/**/index.js'], false],
      ['src/a/reindex.js', ['src/**/index.js'], false],
      ['test/x.js', ['**/test/**'], true],
      ['pkg/test/x.js', ['**/test/**'], true],
      ['latest/x.js', ['**/test/**'], false],
      ['a/b', ['a/**/**/b'], true],
      ['a/xb', ['a/**/**/b'], false],
      ['a.js', ['**/?.js'], true],
      ['ba.js', ['**/?.js'], false],
    ];
    for (const [file, zones, want] of table) {
      assert.equal(matchZone(file, zones), want, `matchZone(${JSON.stringify(file)}, ${JSON.stringify(zones)})`);
    }
    // the same mistake made two plans look like they overlap (the other side has a wildcard, so it is no folder name)
    const apart = [
      [['**/b'], ['a?']],
      [['**/index.js'], ['src/re*.js']],
      [['src/**/api.js'], ['src/my*.js']],
      [['**/test/*'], ['latest/*']],
    ];
    for (const [a, b] of apart) {
      assert.equal(zonesOverlap(a, b), false, `zonesOverlap(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
      assert.equal(zonesOverlap(b, a), false, `zonesOverlap(${JSON.stringify(b)}, ${JSON.stringify(a)})`);
    }
    assert.equal(zonesOverlap(['**/b'], ['x/b']), true);
    assert.equal(zonesOverlap(['**/b'], ['ab']), true); // "ab" may be a folder: ab/b is in both
    assert.equal(zonesOverlap(['**/index.js'], ['src/*.js']), true);
  });

  // Defect: "./" was removed before "/", so "/./src/a.js" became "./src/a.js" and matched no zone.
  test('a leading "./" and "/" are removed in any mix, from paths and from zones', () => {
    for (const file of ['/./src/a.js', './/./src/a.js', '/.//src/a.js', './/src/a.js', './././src/a.js']) {
      assert.equal(matchZone(file, ['src/a.js']), true, file);
      assert.equal(matchZone('src/a.js', [file]), true, `zone ${file}`);
      assert.equal(zonesOverlap([file], ['src/**']), true, `overlap ${file}`);
    }
    assert.equal(matchZone('.hidden/a.js', ['hidden/**']), false); // a leading dot of a name stays
    assert.equal(matchZone('../a.js', ['a.js']), false);
  });

  /** The glob language of the contract as a regular expression (the reference for the next two tests). */
  function reference(raw) {
    const clean = (text) => text.normalize('NFC').replace(/\/{2,}/g, '/').replace(/^(?:\.?\/)+/, '');
    if (!raw.trim()) return { clean, re: null };
    let pattern = clean(raw.trim());
    if (pattern === '' || pattern === '.') pattern = '**';
    const body = pattern.replace(/\/+$/, '');
    const below = body !== pattern && !body.endsWith('**');
    const bare = body === pattern && !/[*?]/.test(body);
    let re = '';
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i];
      if (ch === '*' && body[i + 1] === '*') {
        let end = i;
        while (body[end] === '*') end += 1;
        if ((i === 0 || body[i - 1] === '/') && body[end] === '/') { re += '(?:.*/)?'; i = end; } else { re += '.*'; i = end - 1; }
      } else if (ch === '*') re += '[^/]*';
      else if (ch === '?') re += '[^/]';
      else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return { clean, re: new RegExp(`^${re}${below ? '/.*' : ''}${bare ? '(?:/.*)?' : ''}$`, 's') };
  }
  /** Seeded random words (mulberry32): the same globs on every run. */
  function dice(seed) {
    let state = seed >>> 0;
    const next = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return (tokens, max) => {
      let text = '';
      for (let n = 1 + Math.floor(next() * max); n > 0; n -= 1) text += tokens[Math.floor(next() * tokens.length)];
      return text;
    };
  }

  test('matchZone agrees with a plain reference on 40000 random globs', () => {
    const word = dice(20261115);
    const globTokens = ['a', 'b', 'a', 'b', '/', '/', '*', '**', '?', '**/', '/**', 'ab', '.'];
    const pathTokens = ['a', 'b', '/', 'a', 'b', '.'];
    for (let i = 0; i < 40_000; i += 1) {
      const glob = word(globTokens, 6);
      const file = word(pathTokens, 8);
      const { clean, re } = reference(glob);
      const want = Boolean(re && clean(file) && re.test(clean(file)));
      assert.equal(matchZone(file, [glob]), want, `matchZone(${JSON.stringify(file)}, [${JSON.stringify(glob)}])`);
    }
  });

  // The same defect made zonesOverlap report overlaps that no path can prove (the plan check then
  // orders tasks that could run side by side). An overlap that is missed would be worse: never.
  test('zonesOverlap is exact on 1000 random pairs: every overlap has a path that proves it', () => {
    /** A path that both globs match, or null. Searches all paths over "a", "b", "/" up to 13 characters. */
    function proof(ra, rb, text = '') {
      if (text && !text.endsWith('/') && ra.test(text) && rb.test(text)) return text;
      if (text.length >= 13) return null;
      for (const ch of ['a', 'b', '/']) {
        if (ch === '/' && (text === '' || text.endsWith('/'))) continue;
        const found = proof(ra, rb, text + ch);
        if (found) return found;
      }
      return null;
    }
    const short = [];
    (function build(text) {
      if (text && !text.startsWith('/') && !text.endsWith('/') && !text.includes('//')) short.push(text);
      if (text.length < 7) for (const ch of ['a', 'b', '/']) build(text + ch);
    }(''));
    const word = dice(7);
    const tokens = ['a', 'b', '/', '*', '**', '?', '**/', '/**', 'ab', 'a/'];
    for (let i = 0; i < 1000; i += 1) {
      const one = word(tokens, 4);
      const two = word(tokens, 4);
      const [ra, rb] = [reference(one).re, reference(two).re];
      const said = zonesOverlap([one], [two]);
      const quick = short.find((file) => ra.test(file) && rb.test(file));
      if (quick) assert.equal(said, true, `${JSON.stringify(one)} and ${JSON.stringify(two)} share ${quick}`);
      else if (said) assert.ok(proof(ra, rb), `no path is in both ${JSON.stringify(one)} and ${JSON.stringify(two)}`);
    }
  });
});

/* ------------------------------------------------------------------ ids */

describe('ids', () => {
  // Defect: only the exact id "int" was refused. On a disk that ignores case (the default on a Mac),
  // the branch ws/J1/INT is the same file as the integration branch ws/J1/int: a fetch overwrote it.
  test('a task id that is "int" in another case cannot take the place of the integration branch', async () => {
    const s = await shop();
    const before = await owner(s.project.path, 'rev-parse', 'ws/J1/int');
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    await put(bench.dir, 'x.txt', 'x\n');
    await s.git.commitAll(bench.dir, 'T1: x', 'Rusty');
    for (const id of ['INT', 'Int', 'iNT']) {
      await assert.rejects(s.git.createBench(s.project, 'J1', id, {}), /Bad task id/, id);
      const refused = await s.git.integrate(s.project, 'J1', id, bench.dir, 'must not happen');
      assert.equal(refused.ok, false, id);
      assert.equal(refused.reason, 'error');
      assert.match(refused.detail, /Bad task id/);
    }
    assert.equal(await owner(s.project.path, 'rev-parse', 'ws/J1/int'), before);
    assert.equal(await owner(s.project.path, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'), 'main\nws/J1/int');
  });
});

/* ------------------------------------------------------------------ a git repository inside a bench */

describe('a git repository inside a bench', () => {
  // Defect: "git add -A" stages a folder that has its own .git as a link to a commit (mode 160000).
  // commitAll committed that link, integrate merged it, and the files of the folder were never
  // delivered. No step reported a problem.
  test('a nested repository with commits is refused; its files are delivered once its .git folder is gone', async () => {
    const s = await shop({ seed: { 'a.txt': 'a\n' } });
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    await put(bench.dir, 'app/index.js', 'console.log(1)\n');
    await put(bench.dir, 'other.txt', 'x\n');
    const app = path.join(bench.dir, 'app');
    await agent(app, 'init', '-q'); // what a project generator or a "git clone" leaves behind
    await agent(app, 'add', '-A');
    await owner(app, 'commit', '-q', '-m', 'inner');
    const head = await s.git.headSha(bench.dir);

    await assert.rejects(s.git.commitAll(bench.dir, 'T1: work', 'Rusty'), (err) => {
      assert.match(err.message, /git repository inside it: app\./);
      assert.match(err.message, /rm -rf "app\/\.git"/); // the way out, for the maker
      assert.equal(err.code, 'E_NESTED_REPO');
      assert.deepEqual(err.paths, ['app']);
      return true;
    });
    assert.equal(await s.git.headSha(bench.dir), head); // nothing was committed
    assert.doesNotMatch(await owner(bench.dir, 'ls-files', '-s'), /^160000 /m); // and no link stays staged
    assert.equal(await read(bench.dir, 'app/index.js'), 'console.log(1)\n');
    await assert.rejects(s.git.commitAll(bench.dir, 'T1: again', 'Rusty'), /git repository inside it: app\./); // handing in again changes nothing

    await fs.rm(path.join(app, '.git'), { recursive: true }); // the maker follows the message
    assert.ok(await s.git.commitAll(bench.dir, 'T1: work', 'Rusty'));
    assert.deepEqual((await owner(bench.dir, 'ls-tree', '-r', '--name-only', 'HEAD')).split('\n'), ['a.txt', 'app/index.js', 'other.txt']);
    assert.equal((await s.git.syncBench(bench.dir)).ok, true);
    assert.equal((await s.git.integrate(s.project, 'J1', 'T1', bench.dir, 'T1: merge')).ok, true);
    assert.equal(await read(s.job.integrationDir, 'app/index.js'), 'console.log(1)\n');
  });

  // Defect: the same case without a commit in the nested repository made "git add" fail, and
  // commitAll passed on git's raw text ("does not have a commit checked out"): no way out for the maker.
  test('a nested repository without commits gets the same clear message', async () => {
    const s = await shop({ seed: { 'a.txt': 'a\n' } });
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    await put(bench.dir, 'pkg/new app/main.py', 'print(1)\n');
    await agent(path.join(bench.dir, 'pkg', 'new app'), 'init', '-q');
    await assert.rejects(s.git.commitAll(bench.dir, 'T1: work', 'Rusty'), (err) => {
      assert.match(err.message, /git repository inside it: pkg\/new app\./);
      assert.deepEqual(err.paths, ['pkg/new app']);
      return true;
    });
    await fs.rm(path.join(bench.dir, 'pkg', 'new app', '.git'), { recursive: true });
    assert.ok(await s.git.commitAll(bench.dir, 'T1: work', 'Rusty'));
    assert.match(await owner(bench.dir, 'ls-tree', '-r', '--name-only', 'HEAD'), /^pkg\/new app\/main\.py$/m);
  });

  // Defect: when the agent had committed the link itself, commitAll found nothing to do and the
  // empty link went to review, to the truck and to the owner.
  test('a link that the agent committed itself is found too', async () => {
    const s = await shop({ seed: { 'a.txt': 'a\n' } });
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    await put(bench.dir, 'app/index.js', 'console.log(1)\n');
    const app = path.join(bench.dir, 'app');
    await agent(app, 'init', '-q');
    await agent(app, 'add', '-A');
    await owner(app, 'commit', '-q', '-m', 'inner');
    await agent(bench.dir, 'add', '-A');
    await agent(bench.dir, 'commit', '-q', '-m', 'agent commit, link and all');
    assert.match(await owner(bench.dir, 'ls-tree', 'HEAD'), /^160000 commit [0-9a-f]+\tapp$/m);

    await assert.rejects(s.git.commitAll(bench.dir, 'T1: work', 'Rusty'), /git repository inside it: app\./);
    await fs.rm(path.join(app, '.git'), { recursive: true });
    assert.ok(await s.git.commitAll(bench.dir, 'T1: work', 'Rusty'));
    const tree = await owner(bench.dir, 'ls-tree', '-r', 'HEAD');
    assert.doesNotMatch(tree, /^160000 /m);
    assert.match(tree, /\tapp\/index\.js$/m);
  });

  test('guard: a real submodule, listed in .gitmodules, is not refused', async () => {
    const s = await shop({ seed: { 'a.txt': 'a\n' } });
    const lib = path.join(s.dir, 'lib-repo');
    await fs.mkdir(lib);
    await owner(lib, 'init', '-q', '-b', 'main');
    await put(lib, 'lib.js', 'export {}\n');
    await owner(lib, 'add', '-A');
    await owner(lib, 'commit', '-q', '-m', 'lib');
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    await owner(bench.dir, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', lib, 'vendor/lib');
    assert.ok(await s.git.commitAll(bench.dir, 'T1: add a submodule', 'Rusty'));
    const tree = await owner(bench.dir, 'ls-tree', '-r', 'HEAD');
    assert.match(tree, /^160000 commit [0-9a-f]+\tvendor\/lib$/m);
    assert.match(tree, /\t\.gitmodules$/m);
    assert.equal(await s.git.commitAll(bench.dir, 'T1: nothing new', 'Rusty'), null);
  });
});

/* ------------------------------------------------------------------ hub files and links */

describe('writeShopFiles and links', () => {
  // Defect: only the write path looked for links. A null value (delete) went through a linked
  // folder inside .shop and removed a file outside the bench.
  test('nothing outside the bench is deleted through a linked folder', async () => {
    const s = await shop();
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    const outside = path.join(s.dir, 'outside');
    await put(outside, 'victim.txt', 'keep me\n');
    await fs.symlink(outside, path.join(bench.dir, '.shop', 'logs'));
    await assert.rejects(s.git.writeShopFiles(bench.dir, { '.shop/logs/victim.txt': null }), /through a link/);
    assert.equal(await read(outside, 'victim.txt'), 'keep me\n');
    // a link as the last part is removed itself; what it points at stays
    await fs.symlink(path.join(outside, 'victim.txt'), path.join(bench.dir, '.shop', 'OLD.md'));
    await s.git.writeShopFiles(bench.dir, { '.shop/OLD.md': null, '.shop/not/there.md': null });
    assert.equal(await there(path.join(bench.dir, '.shop', 'OLD.md')), false);
    assert.equal(await read(outside, 'victim.txt'), 'keep me\n');
  });

  // Defect: the hub wrote to "<file>.<pid>.<n>.tmp" with a plain write: a name that an agent can
  // guess. A link planted under that name sent the hub's text to any file the hub may write.
  // (Now the name has a random part, and the temp file is made with "must not exist yet".)
  test('nothing is written through a link planted under the temp name', async () => {
    const s = await shop();
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    const outside = path.join(s.dir, 'outside.txt');
    for (let n = 1; n <= 80; n += 1) await fs.symlink(outside, path.join(bench.dir, '.shop', `NOTE.md.${process.pid}.${n}.tmp`));
    await s.git.writeShopFiles(bench.dir, { '.shop/NOTE.md': 'hub text\n' });
    assert.equal(await read(bench.dir, '.shop/NOTE.md'), 'hub text\n');
    assert.equal(await there(outside), false);
    assert.equal((await fs.lstat(path.join(bench.dir, '.shop', 'NOTE.md'))).isFile(), true);
  });

  // Defect: folders were made with mkdir -p before the link check, so a refused write still
  // left new folders outside the bench.
  test('no folder is made outside the bench before a write is refused', async () => {
    const s = await shop();
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    const outside = path.join(s.dir, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(bench.dir, '.shop', 'logs'));
    await assert.rejects(s.git.writeShopFiles(bench.dir, { '.shop/logs/deep/er/x.txt': 'x' }), /through a link/);
    assert.deepEqual(await fs.readdir(outside), []);
    // guard: real folders still work, also when a file is replaced
    await s.git.writeShopFiles(bench.dir, { '.shop/notes/deep/a.md': 'one' });
    await s.git.writeShopFiles(bench.dir, { '.shop/notes/deep/a.md': 'two', '.shop/notes/b.md': Buffer.from('bytes') });
    assert.equal(await read(bench.dir, '.shop/notes/deep/a.md'), 'two');
    assert.equal(await read(bench.dir, '.shop/notes/b.md'), 'bytes');
    assert.deepEqual((await fs.readdir(path.join(bench.dir, '.shop', 'notes', 'deep'))), ['a.md']); // no temp file left
  });
});

/* ------------------------------------------------------------------ conflicts */

describe('conflict markers', () => {
  // Defect: after a conflict, every "<<<<<<<" or ">>>>>>>" line in the file counted as unresolved.
  // A file that shows such lines as text (documentation, a test fixture) could never be handed in again.
  test('a file that shows conflict markers as text can be resolved', async () => {
    const doc = 'How git marks a conflict:\n\n<<<<<<< yours\nA\n=======\nB\n>>>>>>> theirs\n\nlast line\n';
    const s = await shop({ seed: { 'doc.md': doc } });
    const a = await s.git.createBench(s.project, 'J1', 'T1', {});
    const b = await s.git.createBench(s.project, 'J1', 'T2', {});
    await put(a.dir, 'doc.md', doc.replace('last line', 'last line from A'));
    await put(b.dir, 'doc.md', doc.replace('last line', 'last line from B'));
    await s.git.commitAll(a.dir, 'T1: A', 'Rusty');
    await s.git.commitAll(b.dir, 'T2: B', 'Flux');
    assert.equal((await s.git.syncBench(a.dir)).ok, true);
    assert.equal((await s.git.integrate(s.project, 'J1', 'T1', a.dir, 'T1: merge')).ok, true);

    assert.deepEqual(await s.git.syncBench(b.dir), { ok: false, conflicts: ['doc.md'] });
    assert.deepEqual((await record(b.dir)).conflicts, { 'doc.md': { open: 1, sep: 1, close: 1 } }); // the three lines that are text
    assert.deepEqual(await s.git.syncBench(b.dir), { ok: false, conflicts: ['doc.md'] }); // no fix yet
    // half a fix: one line of the real conflict is left
    await put(b.dir, 'doc.md', doc.replace('last line', 'last line from B\n=======\nlast line from A'));
    assert.deepEqual(await s.git.syncBench(b.dir), { ok: false, conflicts: ['doc.md'] });
    await put(b.dir, 'doc.md', doc.replace('last line', '<<<<<<< HEAD\nlast line from B'));
    assert.equal(await s.git.commitAll(b.dir, 'T2: half', 'Flux'), null);
    // the real fix keeps the text as it was
    const fixed = doc.replace('last line', 'last line from A and B');
    await put(b.dir, 'doc.md', fixed);
    const done = await s.git.syncBench(b.dir);
    assert.equal(done.ok, true);
    assert.equal(done.merged, true);
    assert.deepEqual(await s.git.unresolved(b.dir), []);
    assert.equal((await s.git.integrate(s.project, 'J1', 'T2', b.dir, 'T2: merge')).ok, true);
    assert.equal(await read(s.job.integrationDir, 'doc.md'), fixed);
  });
});

/* ------------------------------------------------------------------ a merge that is cut off */

describe('a merge that is cut off', () => {
  /**
   * A git on PATH that passes everything on to the real git. While the flag file exists, the next
   * "merge" dies the way a killed git does: MERGE_HEAD is written, two files of the other side are
   * in the tree already (one.txt, new-a.txt), the rest is not (two.txt), and git is gone (SIGKILL).
   */
  async function dyingGit(s, { leaveLock = false } = {}) {
    const bin = path.join(s.dir, 'bin');
    const flag = path.join(s.dir, 'die-in-merge');
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, 'git'), [
      '#!/bin/sh',
      'for arg in "$@"; do',
      `  if [ "$arg" = merge ] && [ -f '${flag}' ]; then`,
      `    rm -f '${flag}'`,
      `    theirs=$('${realGit}' rev-parse origin/ws/J1/int)`,
      '    echo "$theirs" > .git/MERGE_HEAD',
      `    '${realGit}' show "$theirs:one.txt" > one.txt`,
      `    '${realGit}' show "$theirs:new-a.txt" > new-a.txt`,
      leaveLock ? '    : > .git/index.lock' : '    :',
      '    kill -9 $$',
      '  fi',
      'done',
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });
    const git = s.make({ env: { ...hubEnv, PATH: `${bin}:${hubEnv.PATH}` }, timeouts: { lockWaits: [10, 10], staleLock: 600_000 } });
    return { git, flag };
  }

  /** T1 is integrated (three files). The bench of T2 is older, has its own commit and is not synced yet. */
  async function twoTasks() {
    const s = await shop({ seed: { 'one.txt': 'one v1\n', 'two.txt': 'two v1\n', 'b.txt': 'b v1\n' } });
    const b = await s.git.createBench(s.project, 'J1', 'T2', {});
    await deliver(s, 'T1', { 'one.txt': 'one v2\n', 'two.txt': 'two v2\n', 'new-a.txt': 'new from A\n' });
    await put(b.dir, 'b.txt', 'b v2\n');
    assert.ok(await s.git.commitAll(b.dir, 'T2: B', 'Flux'));
    return { ...s, b };
  }

  async function assertTruckIsWhole(s) {
    assert.equal(await read(s.job.integrationDir, 'one.txt'), 'one v2\n');
    assert.equal(await read(s.job.integrationDir, 'two.txt'), 'two v2\n', 'the work of T1 must not be undone');
    assert.equal(await read(s.job.integrationDir, 'new-a.txt'), 'new from A\n');
  }

  // Defect: git was stopped in the middle of the merge (timeout, kill). MERGE_HEAD stayed, with
  // half of the files written. The next commitAll or syncBench saw "a merge without conflict
  // markers", concluded it, and the merge commit undid work of another task (two.txt went back to
  // v1 on the integration branch). The hub reported success at every step.
  test('git dies in the middle of the sync merge: the bench is put back at once, and no work of another task is undone', async () => {
    const s = await twoTasks();
    const { git: dying, flag } = await dyingGit(s);
    await fs.writeFile(flag, '');
    const head = await s.git.headSha(s.b.dir);
    await assert.rejects(dying.syncBench(s.b.dir), /git merge was stopped/);

    assert.equal(await s.git.headSha(s.b.dir), head);
    assert.equal(await there(path.join(s.b.dir, '.git', 'MERGE_HEAD')), false, 'no merge stays open');
    assert.equal(await owner(s.b.dir, 'status', '--porcelain'), '', 'the files that the dead git wrote are put back');
    assert.equal((await record(s.b.dir)).merging ?? null, null);

    assert.equal(await s.git.commitAll(s.b.dir, 'T2: again', 'Flux'), null); // nothing of the half merge is committed as the maker's work
    const sync = await s.git.syncBench(s.b.dir);
    assert.equal(sync.ok, true);
    assert.equal(sync.merged, true); // so the hub runs the checks again
    assert.deepEqual(await s.git.changedFiles(s.b.dir), ['b.txt']);
    assert.equal((await s.git.integrate(s.project, 'J1', 'T2', s.b.dir, 'T2: merge', { expectHead: sync.head })).ok, true);
    await assertTruckIsWhole(s);
    assert.equal(await read(s.job.integrationDir, 'b.txt'), 'b v2\n');
  });

  // Same defect after a hub restart: the dead git also left its index.lock, so nothing could be put
  // back at once. The maker even worked on. The next hub must still not conclude the half merge,
  // and must not lose the maker's own uncommitted work while it cleans up.
  test('the hub restarts after a cut-off merge: the half merge is undone, the maker\'s own files stay', async () => {
    const s = await twoTasks();
    const { git: dying, flag } = await dyingGit(s, { leaveLock: true });
    await fs.writeFile(flag, '');
    await assert.rejects(dying.syncBench(s.b.dir), /git merge was stopped/);
    assert.equal(await there(path.join(s.b.dir, '.git', 'MERGE_HEAD')), true); // the lock was in the way of any repair
    assert.equal(await read(s.b.dir, 'one.txt'), 'one v2\n');

    await put(s.b.dir, 'b.txt', 'b v3\n'); // the maker works on
    await put(s.b.dir, 'mine.txt', 'my new file\n');
    await fs.rm(path.join(s.b.dir, '.git', 'index.lock')); // time passes

    const hub = s.make(); // a new hub process
    const sha = await hub.commitAll(s.b.dir, 'T2: more', 'Flux');
    assert.ok(sha);
    assert.equal((await owner(s.b.dir, 'rev-list', '--parents', '-1', 'HEAD')).split(' ').length, 2, 'a plain commit, not a merge');
    assert.deepEqual((await owner(s.b.dir, 'show', '--name-only', '--format=', 'HEAD')).split('\n').sort(), ['b.txt', 'mine.txt']);
    assert.equal(await owner(s.b.dir, 'status', '--porcelain'), '');
    assert.deepEqual(await hub.changedFiles(s.b.dir), ['b.txt', 'mine.txt']); // the zone check sees only the maker's files
    const sync = await hub.syncBench(s.b.dir);
    assert.equal(sync.ok, true);
    assert.equal(sync.merged, true);
    assert.equal((await hub.integrate(s.project, 'J1', 'T2', s.b.dir, 'T2: merge')).ok, true);
    await assertTruckIsWhole(s);
    assert.equal(await read(s.job.integrationDir, 'b.txt'), 'b v3\n');
    assert.equal(await read(s.job.integrationDir, 'mine.txt'), 'my new file\n');
  });

  test('guard: a merge that git refuses leaves the bench and its record as they were', async () => {
    const s = await twoTasks();
    await put(s.b.dir, 'one.txt', 'my uncommitted edit\n');
    await assert.rejects(s.git.syncBench(s.b.dir), /one\.txt/);
    assert.equal(await read(s.b.dir, 'one.txt'), 'my uncommitted edit\n');
    assert.equal((await record(s.b.dir)).merging ?? null, null);
    assert.equal(await owner(s.b.dir, 'status', '--porcelain'), ' M one.txt');
  });
});

/* ------------------------------------------------------------------ locks */

describe('locks', () => {
  // Defect: a stale index.lock of the integration worktree was never removed. Its git folder is
  // <repo>/.git/worktrees/_int, inside the owner's repository, so the "bench only" rule left it
  // there, and every later integrate of the job failed until someone deleted the file by hand.
  test('a stale lock of the integration worktree is removed; a fresh one is waited for and kept', async () => {
    const s = await shop();
    const quick = s.make({ timeouts: { lockWaits: [20, 20, 20], staleLock: 600_000 } }); // wide margins: a slow machine must not change the result
    const bench = await quick.createBench(s.project, 'J1', 'T1', {});
    await put(bench.dir, 'x.txt', 'x\n');
    await quick.commitAll(bench.dir, 'T1: x', 'Rusty');
    const gitDir = await owner(s.job.integrationDir, 'rev-parse', '--absolute-git-dir');
    assert.equal(gitDir, path.join(s.project.path, '.git', 'worktrees', '_int'));
    const lock = path.join(gitDir, 'index.lock');

    await fs.writeFile(lock, ''); // fresh: a git may still be at work
    const blocked = await quick.integrate(s.project, 'J1', 'T1', bench.dir, 'T1: merge');
    assert.equal(blocked.ok, false);
    assert.match(blocked.detail, /index\.lock/);
    assert.equal(await there(lock), true);

    const old = new Date(Date.now() - 3_600_000);
    await fs.utimes(lock, old, old); // left by a git that was killed
    const done = await quick.integrate(s.project, 'J1', 'T1', bench.dir, 'T1: merge');
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(await there(lock), false);
    assert.equal(await read(s.job.integrationDir, 'x.txt'), 'x\n');

    // guard: a worktree of the owner has the same kind of git folder. Its locks stay, however old.
    const mine = path.join(s.dir, 'owner-tree');
    await owner(s.project.path, 'checkout', '-q', '--detach'); // the owner moves "main" to a worktree of their own
    await owner(s.project.path, 'worktree', 'add', '-q', mine, 'main');
    const ownerLock = path.join(await owner(mine, 'rev-parse', '--absolute-git-dir'), 'index.lock');
    await fs.writeFile(ownerLock, '');
    await fs.utimes(ownerLock, old, old);
    const refused = await quick.ship(s.project, 'J1', await atHead(s.project)); // the fast-forward runs where "main" is checked out
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /index\.lock/);
    assert.equal(await there(ownerLock), true);
    await fs.rm(ownerLock);
    assert.equal((await quick.ship(s.project, 'J1', await atHead(s.project))).ok, true);
    assert.equal(await read(mine, 'x.txt'), 'x\n');
  });
});

/* ------------------------------------------------------------------ options */

describe('options', () => {
  // Defect: the options were taken apart in the parameter list. With null, runCheck threw at the
  // call (it must never throw), and integrate and ship rejected (they must always return a result).
  test('null options: runCheck does not throw, integrate and ship do not reject', async () => {
    const s = await shop();
    const bench = await s.git.createBench(s.project, 'J1', 'T1', null);
    await put(bench.dir, 'x.txt', 'x\n');
    await s.git.commitAll(bench.dir, 'T1: x', 'Rusty');
    let check;
    assert.doesNotThrow(() => { check = s.git.runCheck(bench.dir, 'echo hi', null); });
    assert.deepEqual(await check, { ok: true, code: 0, tail: 'hi\n' });
    const merged = await s.git.integrate(s.project, 'J1', 'T1', bench.dir, 'T1: merge', null);
    assert.equal(merged.ok, true, JSON.stringify(merged));
    assert.match(await s.git.truckDiff(s.project, 'J1', null), /^\+x$/m);
    assert.match(await s.git.deliveryDiff(s.project, merged.mergeSha, null), /^\+x$/m);
    const shipped = await s.git.ship(s.project, 'J1', null);
    assert.equal(shipped.ok, false); // no sha: nothing ships (contract section 9), and still no reject
    assert.deepEqual(await s.git.ship(s.project, 'J1', { sha: merged.mergeSha }), { ok: true, sha: merged.mergeSha, left: 0 });
    assert.deepEqual(await s.git.removeJobWork(s.project, 'J1', null), { deleted: ['workshop/J1/T1', 'ws/J1/int'], kept: [] });
    await assert.rejects(s.git.diff(s.project.path, null), /base revision/); // a plain message, not "cannot destructure"
    await assert.rejects(s.git.adoptProject(null), /project folder is required/);
    assert.equal(path.basename((await s.git.initProject(null)).path), 'project'); // no name: the default folder name
  });
});

/* ------------------------------------------------------------------ cleanup */

describe('cleanup', () => {
  // Defect: removeJobWork deleted a ws/<job>/... branch with update-ref while the owner had it
  // checked out (to look at a delivery). The owner's checkout then stood on a branch without
  // commits, with every file staged as new. Task refs are under refs/workshop now (contract A29),
  // so the branch the owner can check out is the integration branch.
  test('removeJobWork keeps a branch that the owner has checked out', async () => {
    const s = await shop({ seed: { 'seed.txt': 's\n' } });
    await deliver(s, 'T1', { 'a.txt': 'A\n' });
    await deliver(s, 'T2', { 'b.txt': 'B\n' });
    assert.equal((await s.git.ship(s.project, 'J1', await atHead(s.project))).ok, true);
    await owner(s.project.path, 'worktree', 'remove', '--force', s.job.integrationDir); // the owner takes over the branch
    await owner(s.project.path, 'checkout', '-q', 'ws/J1/int'); // the owner looks at the truck
    const head = await owner(s.project.path, 'rev-parse', 'HEAD');

    for (const options of [undefined, { force: true }]) {
      const cleaned = await s.git.removeJobWork(s.project, 'J1', options);
      assert.deepEqual(cleaned.kept, ['ws/J1/int'], JSON.stringify(options));
      assert.equal(await owner(s.project.path, 'rev-parse', '-q', '--verify', 'HEAD'), head);
      assert.equal(await owner(s.project.path, 'status', '--porcelain'), '');
    }
    assert.equal(await owner(s.project.path, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/ws/'), 'ws/J1/int');
    assert.equal(await owner(s.project.path, 'for-each-ref', 'refs/workshop/'), ''); // the task refs went at the first call
    await owner(s.project.path, 'checkout', '-q', 'main');
    assert.deepEqual(await s.git.removeJobWork(s.project, 'J1'), { deleted: ['ws/J1/int'], kept: [] }); // free again: removed
  });
});

/* ------------------------------------------------------------------ the integration worktree */

describe('the integration worktree', () => {
  // Defect: integrate cleaned _int with "git clean -f -d". A worktree has no exclude file of its
  // own, so the hub files of a boss desk there (.shop/BLUEPRINT.md, .shop/tasks/) and the CLI files
  // (.agents/) were untracked, and every merge deleted them.
  test('integrate keeps the hub files of a desk in _int, and still removes other leftovers', async () => {
    const s = await shop();
    const desk = s.job.integrationDir;
    await s.git.writeShopFiles(desk, { '.shop/BLUEPRINT.md': 'the plan', '.shop/tasks/T1.md': 'task card' });
    await put(desk, '.agents/mcp_config.json', '{}');
    await put(desk, 'leftover.log', 'from a check\n'); // anything else in the hub-only folder goes
    await put(desk, 'README.md', 'edited by mistake\n');
    await deliver(s, 'T1', { 'x.txt': 'x\n' });
    assert.equal(await read(desk, '.shop/BLUEPRINT.md'), 'the plan');
    assert.equal(await read(desk, '.shop/tasks/T1.md'), 'task card');
    assert.equal(await read(desk, '.agents/mcp_config.json'), '{}');
    assert.equal(await there(path.join(desk, 'leftover.log')), false);
    assert.equal(await read(desk, 'README.md'), 'hello\n');
    assert.equal(await read(desk, 'x.txt'), 'x\n');
    // the hub files never reach a commit or the owner
    assert.equal((await s.git.ship(s.project, 'J1', await atHead(s.project))).ok, true);
    assert.equal(await owner(s.project.path, 'ls-files'), 'README.md\nx.txt');
    assert.equal(await there(path.join(s.project.path, '.shop')), false);
  });
});

/* ------------------------------------------------------------------ benches */

describe('benches', () => {
  // Defect: commitAll took any folder. Called with the project path by mistake, it moved the
  // owner's checkout to a new branch "work", committed the owner's unsaved files as the agent and
  // left a bench record in the owner's .git folder. Only the hub's own bench folders may be changed.
  test('commitAll and syncBench refuse the owner\'s repository and the integration worktree', async () => {
    const s = await shop({ seed: { 'a.txt': 'a\n' } });
    await put(s.project.path, 'owner-wip.txt', 'not committed by the owner\n');
    const head = await owner(s.project.path, 'rev-parse', 'HEAD');
    for (const dir of [s.project.path, s.job.integrationDir, s.paths.work, path.join(s.paths.work, 'J1'), s.dir, '', undefined]) {
      await assert.rejects(s.git.commitAll(dir, 'must not happen', 'Rusty'), /Not a bench/, String(dir));
      await assert.rejects(s.git.syncBench(dir), /Not a bench/, String(dir));
      await assert.rejects(s.git.unresolved(dir), /Not a bench/, String(dir));
    }
    assert.equal(await owner(s.project.path, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(await owner(s.project.path, 'rev-parse', 'HEAD'), head);
    assert.equal(await owner(s.project.path, 'status', '--porcelain'), '?? owner-wip.txt');
    assert.equal(await owner(s.project.path, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'), 'main\nws/J1/int');
    assert.equal(await there(path.join(s.project.path, '.git', 'workshop.json')), false);
    assert.equal(await owner(s.job.integrationDir, 'symbolic-ref', '--short', 'HEAD'), 'ws/J1/int');
    // guard: a bench named through a link is still a bench
    const bench = await s.git.createBench(s.project, 'J1', 'T1', {});
    await fs.symlink(s.paths.work, path.join(s.dir, 'work-link'));
    await put(bench.dir, 'x.txt', 'x\n');
    assert.ok(await s.git.commitAll(path.join(s.dir, 'work-link', 'J1', 'T1'), 'T1: x', 'Rusty'));
    assert.equal((await s.git.syncBench(path.join(s.dir, 'work-link', 'J1', 'T1'))).ok, true);
  });

  // Defect: createBench took any folder with a .git for "the bench of this task after a restart".
  // After a state reset the ids start again (J1, T1): a clone of another project, left in
  // data/work/J1/T1, was handed to the maker of the new task.
  test('createBench does not reuse a clone of another repository', async () => {
    const s = await shop({ seed: { 'mine.txt': 'this project\n' } });
    const other = path.join(s.dir, 'other-repo');
    await fs.mkdir(other);
    await owner(other, 'init', '-q', '-b', 'main');
    await put(other, 'other.txt', 'another project\n');
    await owner(other, 'add', '-A');
    await owner(other, 'commit', '-q', '-m', 'other');
    const place = path.join(s.paths.work, 'J1', 'T1');
    await owner(s.dir, 'clone', '-q', other, place); // what an earlier job with the same ids left behind
    await put(place, 'unsaved.txt', 'old work\n');

    const bench = await s.git.createBench(s.project, 'J1', 'T1', { files: { '.shop/TASK.md': 'new task' } });
    assert.equal(bench.dir, place);
    assert.equal(bench.baseSha, await owner(s.project.path, 'rev-parse', 'ws/J1/int'));
    assert.equal(await read(bench.dir, 'mine.txt'), 'this project\n');
    assert.equal(await there(path.join(bench.dir, 'other.txt')), false);
    assert.equal(await owner(bench.dir, 'config', 'remote.origin.url'), s.project.path);
    assert.equal((await s.git.syncBench(bench.dir)).ok, true);
    // the old folder is kept, out of the way: nothing is deleted
    const kept = (await fs.readdir(path.join(s.paths.work, 'J1'))).filter((name) => name.startsWith('T1.stale-'));
    assert.equal(kept.length, 1);
    assert.equal(await read(path.join(s.paths.work, 'J1', kept[0]), 'unsaved.txt'), 'old work\n');
    assert.ok(s.logs.some((line) => line.level === 'warn' && /another repository/.test(line.msg)));
    // guard: the real bench is reused as before, and removeBench takes the stale folder
    await put(bench.dir, 'loose.txt', 'not committed\n');
    assert.deepEqual(await s.make().createBench(s.project, 'J1', 'T1', {}), { ...bench, setup: null });
    assert.equal(await read(bench.dir, 'loose.txt'), 'not committed\n');
    await s.git.removeBench(path.join(s.paths.work, 'J1', kept[0]));
    assert.deepEqual((await fs.readdir(path.join(s.paths.work, 'J1'))).sort(), ['T1', '_int']);
  });
});

/* ------------------------------------------------------------------ the owner's git settings */

describe('owner git settings', () => {
  /** One hand-in by a hub that reads `settings` as the owner's git config. Every step must work as it does without them. */
  async function handIn(settings) {
    const s = await shop({ seed: { 'a.txt': 'a\n' } });
    const config = path.join(s.dir, 'owner.gitconfig');
    await fs.writeFile(config, settings.replace('<missing file>', path.join(s.dir, 'no-such-file')));
    const git = s.make({ env: { ...hubEnv, GIT_CONFIG_GLOBAL: config } });
    const bench = await git.createBench(s.project, 'J1', 'T1', {});
    await put(bench.dir, 'x.txt', 'x\n');
    await put(bench.dir, 'dos.txt', 'one\r\ntwo\r\n');
    assert.ok(await git.commitAll(bench.dir, 'T1: wörk on x\n\nT1 has a second line.\n# and a third', 'Zoë'));
    assert.equal((await owner(bench.dir, 'log', '-1', '--format=%an|%s%n%b')).trim(), 'Zoë|T1: wörk on x\nT1 has a second line.\n# and a third');
    assert.deepEqual(await git.changedFiles(bench.dir), ['dos.txt', 'x.txt']);
    assert.equal((await git.syncBench(bench.dir)).ok, true);
    const merged = await git.integrate(s.project, 'J1', 'T1', bench.dir, 'T1: merge (Zoë)');
    assert.equal(merged.ok, true, JSON.stringify(merged));
    assert.equal(await owner(s.project.path, 'log', '-1', '--format=%an|%s', merged.mergeSha), 'WorkShop Hub|T1: merge (Zoë)');
    assert.deepEqual((await git.truck(s.project, 'J1')).files.map((file) => file.path), ['dos.txt', 'x.txt']);
    // a git repository inside the bench is still seen
    await put(bench.dir, 'app/index.js', 'console.log(1)\n');
    const app = path.join(bench.dir, 'app');
    await agent(app, 'init', '-q');
    await agent(app, 'add', '-A');
    await owner(app, 'commit', '-q', '-m', 'inner');
    await assert.rejects(git.commitAll(bench.dir, 'T1: app', 'Zoë'), /git repository inside it: app\./);
    assert.doesNotMatch(await owner(bench.dir, 'ls-tree', '-r', 'HEAD'), /^160000 /m);
  }

  // Defects: each of these settings of the owner was in force for the hub's own git calls.
  const settings = [
    // message lines that start with the comment character were dropped ("T12: ..." with commentChar T), or the commit failed as "empty"
    ['commit.cleanup=strip with core.commentChar=T', '[commit]\n\tcleanup = strip\n[core]\n\tcommentChar = T\n'],
    // a stricter transport rule made every clone and fetch fail: "transport \'file\' not allowed"
    ['protocol.file.allow=never', '[protocol "file"]\n\tallow = never\n'],
    // author names and messages were stored as UTF-8 but labelled Latin-1: "Zoë" became "ZoÃ«"
    ['i18n.commitEncoding=ISO-8859-1', '[i18n]\n\tcommitEncoding = ISO-8859-1\n'],
    // "git add" stopped on a file with CRLF line ends: "CRLF would be replaced by LF"
    ['core.autocrlf=input with core.safecrlf=true', '[core]\n\tautocrlf = input\n\tsafecrlf = true\n'],
    // every diff and every commit failed: "failed to read orderfile"
    ['diff.orderFile that is gone', '[diff]\n\torderFile = <missing file>\n'],
    // a nested repository was hidden from the hub (see "a git repository inside a bench")
    ['diff.ignoreSubmodules=all', '[diff]\n\tignoreSubmodules = all\n'],
  ];
  for (const [name, text] of settings) {
    test(`${name} does not reach the hub`, () => handIn(text));
  }
});

/* ------------------------------------------------------------------ load */

describe('load', () => {
  test('guard: eight tasks at once end in one clean truck, and it ships', async () => {
    const s = await shop();
    const ids = Array.from({ length: 8 }, (_, i) => `T${i + 1}`);
    const merges = await Promise.all(ids.map(async (id, i) => {
      const bench = await s.git.createBench(s.project, 'J1', id, { files: { '.shop/TASK.md': id }, authorName: `Maker ${i}` });
      await put(bench.dir, `src/${id}.txt`, `${id}\n`);
      assert.ok(await s.git.commitAll(bench.dir, `${id}: work`, `Maker ${i}`));
      for (let round = 0; round < 40; round += 1) {
        const sync = await s.git.syncBench(bench.dir);
        assert.equal(sync.ok, true, JSON.stringify(sync));
        const done = await s.git.integrate(s.project, 'J1', id, bench.dir, `${id}: merge`, { expectHead: sync.head });
        if (done.ok) return done.mergeSha;
        assert.equal(done.reason, 'stale', JSON.stringify(done)); // another task got in first: sync again
      }
      throw new Error(`${id} was never merged`);
    }));
    assert.equal(new Set(merges).size, 8);
    const chain = (await owner(s.project.path, 'rev-list', '--first-parent', 'main..ws/J1/int')).split('\n');
    assert.deepEqual([...chain].sort(), [...merges].sort()); // one merge per task on the truck, nothing else
    for (const id of ids) assert.equal(await read(s.job.integrationDir, `src/${id}.txt`), `${id}\n`);
    const truck = await s.git.truck(s.project, 'J1');
    assert.equal(truck.behind, 0);
    assert.deepEqual(truck.files.map((file) => file.path).sort(), ids.map((id) => `src/${id}.txt`).sort());
    assert.deepEqual(await s.git.ship(s.project, 'J1', { sha: truck.headSha }), { ok: true, sha: chain[0], left: 0 });
    assert.equal(await owner(s.project.path, 'status', '--porcelain'), '');
    for (const id of ids) assert.equal(await read(s.project.path, `src/${id}.txt`), `${id}\n`);
    assert.deepEqual((await s.git.removeJobWork(s.project, 'J1')).kept, []);
  });
});
