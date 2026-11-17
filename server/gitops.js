/**
 * WorkShop git operations: projects, benches, sync, checks, integrate, ship, diffs, zones.
 * Contract: docs/ARCHITECTURE.md sections 9 and 14b.
 *
 *   canonical repo   <project.path>          target branch; only the hub writes here
 *   integration      <work>/<job>/_int       worktree of canonical on branch ws/<job>/int
 *   bench            <work>/<job>/<task>     git clone --local of canonical, branch "work"
 *   hub clones       <work>/<job>/<task>.rev, _desk/<handle>, _head, _preview: detached at one commit
 *   task refs        refs/workshop/<job>/<task> in canonical, never under refs/heads
 *
 * Every git call runs through execFile with fixed safety flags, a cleaned environment and a
 * timeout. Before the hub runs git in a bench, the bench config is rewritten from the hub template.
 * runSetup and runCheck are the only places that use a shell: their commands come from the job plan.
 * They get an allow-list environment and, in safety 'sandboxed', run under sandbox-exec.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { SECRET_RE } from './shoptalk.js';

/** Folders of hub files inside a bench or a clone. In .git/info/exclude; never committed, in any form. */
export const HUB_PATHS = Object.freeze(['.shop/', '.agents/']);
const HUB_ROOTS = HUB_PATHS.map((p) => p.slice(0, -1)); // ['.shop', '.agents']
const HUB = Object.freeze({ name: 'WorkShop Hub', email: 'hub@workshop.local' });
const AGENT_EMAIL = 'agent@workshop.local';
const WORK = 'work'; // the one local branch of a bench
const SHOP = '.shop'; // hub files inside a bench; never committed
const META = 'workshop.json'; // bench record, kept in <bench>/.git/
const EXCLUDES = ['/.shop/', '/.agents/', '.DS_Store'];
const NO_PUSH = '/dev/null/workshop-benches-do-not-push';
const TAIL_CHARS = 4000;
const STREAM_CHARS = 200 * 1024; // toolkit output cap (section 12c)
const MB = 1024 * 1024;
const DIFF_CAP = 32 * MB; // most diff output that is ever held in memory
const DIFF_DEFAULT_BYTES = 200_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SECRET_ENV = /(^|_)(API_KEY|TOKEN)$/i;
const GIT_ENV_KEEP = /^GIT_(CONFIG_(GLOBAL|SYSTEM|NOSYSTEM)|EXEC_PATH|ATTR_NOSYSTEM)$/;
/** The only variables a setup or check command gets (contract section 9: an allow list, not a block list). */
const COMMAND_ENV = Object.freeze(['HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'TMPDIR', 'PATH']);
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
/** Package caches a sandboxed command may write (relative to HOME). */
const CACHE_DIRS = Object.freeze(['.npm', '.cache', 'Library/Caches', '.pnpm-store', 'Library/pnpm', '.yarn', '.bun/install/cache',
  '.cargo/registry', '.cargo/git', 'go/pkg/mod', '.gradle', '.m2']);
/** The deny-read list of section 10 (relative to HOME); data/run, data/logs and config/ of WorkShop are added from paths. */
const DENY_READ = Object.freeze(['.ssh', '.aws', '.gnupg', '.netrc', '.kube', '.docker', '.config/gh', '.config/gcloud', '.gemini',
  'Library/Keychains', '.claude/.credentials.json', '.config/anthropic']);
/** Agent-config files of a repo: what a CLI started in that folder may load (contract section 9). */
const AGENT_FILE_ZONES = Object.freeze(['.agents/**', '.claude/**', '.mcp.json', '**/GEMINI.md', '**/AGENTS.md', '**/CLAUDE.md']);
const CLONE_NAME = /^(?:[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.rev|_desk\/@?[A-Za-z0-9][A-Za-z0-9_-]{0,63}|_head|_preview)$/;
const TIMEOUTS = Object.freeze({
  short: 60_000, long: 600_000, setup: 900_000, check: 600_000,
  lockWaits: [250, 750, 1500], // waits before retrying a git call that found a lock file
  staleLock: 15_000, // a lock in a bench or an integration worktree older than this was left by a git that got killed
});
const LOCK_BUSY = /Unable to create '(.+\.lock)': File exists/;

/** On every git call: the owner's hooks, editor, signing, colors and helper programs never run or change output. */
const GIT_FLAGS = Object.freeze([
  '-c', 'commit.gpgsign=false', '-c', 'core.editor=true', '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-c', 'color.ui=false',
  '-c', 'merge.conflictStyle=merge', '-c', 'rerere.enabled=false', '-c', 'submodule.recurse=false',
  '-c', 'commit.cleanup=whitespace', // a message line that starts with "#" (or the owner's comment character) is kept
  '-c', 'i18n.commitEncoding=UTF-8', // names and messages are stored as the hub sends them
  '-c', 'core.safecrlf=false', // the owner's line-ending rule converts as usual, but never stops a hub commit
  '-c', 'diff.orderFile=/dev/null', // files in path order
  '-c', 'protocol.file.allow=always', // the hub clones and fetches local folders, whatever the owner's transport rules say
  '-c', 'log.showSignature=false', // git log never starts gpg
  '--literal-pathspecs',
]);
/** Diffs never start external diff or textconv programs, and never hide a submodule link (the owner's diff.ignoreSubmodules). */
const DIFF = Object.freeze(['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none']);
const MERGE_QUIET = Object.freeze(['--no-edit', '--no-stat', '--no-autostash', '--no-verify-signatures']);

const noop = () => {};
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const exists = (file) => fs.access(file).then(() => true, () => false);
const zlist = (text) => text.split('\0').filter(Boolean);
const toList = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);
/** Paths in groups small enough for one command line. */
const chunks = (list, size = 200) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));
/** Is a repo-relative path under one of HUB_PATHS? In any case: macOS disks ignore case, so ".Agents/x" is ".agents/x". */
const isHubPath = (rel) => HUB_ROOTS.includes(String(rel).split('/')[0].toLowerCase());

/* ------------------------------------------------------------------ zones (pure) */

const LIT = 0; // one literal character
const ONE = 1; // "?"  one character, not "/"
const STAR = 2; // "*"  any run of characters without "/"
const DEEP = 3; // "**" any run of characters
const OPT = 4; // start of an optional part: takes no character; the part is entered, or skipped by a jump to state `to`
const zoneCache = new Map();

/** Repo-relative POSIX form: no leading "./" or "/" (in any mix), no doubled slashes, NFC. */
function cleanPath(value) {
  return String(value ?? '').normalize('NFC').replace(/\/{2,}/g, '/').replace(/^(?:\.?\/)+/, '');
}

function cleanPattern(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  const pattern = cleanPath(trimmed);
  return pattern === '' || pattern === '.' ? '**' : pattern; // the repo root means everything
}

/** "src/{api,ui}/**" -> ["src/api/**", "src/ui/**"]. Past 64 alternatives the braces stay literal. */
function expandBraces(pattern) {
  const done = [];
  const todo = [pattern];
  while (todo.length) {
    const current = todo.pop();
    const group = /\{([^{}]*,[^{}]*)\}/.exec(current);
    if (!group || done.length + todo.length >= 64) { done.push(current); continue; }
    const head = current.slice(0, group.index);
    const rest = current.slice(group.index + group[0].length);
    for (const choice of group[1].split(',')) todo.push(head + choice + rest);
  }
  return done;
}

/**
 * One glob as a tiny state machine: a list of tokens. State i waits for toks[i]; state toks.length
 * accepts. An OPT token starts an optional part that is taken as a whole or not at all: "**" + "/"
 * at the start of a segment is zero or more whole directories ("**" + "/b" matches "b" and "x/b",
 * never "ab"), and a bare name has an optional "/**" tail.
 */
function buildMatcher(pattern) {
  const toks = [];
  const body = pattern.replace(/\/+$/, '');
  const below = body !== pattern && !body.endsWith('**'); // "dir/": everything below it ("dir/**/" says that already)
  const bare = body === pattern && !/[*?]/.test(body);
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '*' && body[i + 1] === '*') {
      let end = i;
      while (body[end] === '*') end += 1;
      if ((i === 0 || body[i - 1] === '/') && body[end] === '/') {
        toks.push({ k: OPT, to: toks.length + 3 }, { k: DEEP }, { k: LIT, c: '/' }); // "**/" also matches no directory at all
        i = end;
      } else {
        toks.push({ k: DEEP });
        i = end - 1;
      }
    } else if (ch === '*') toks.push({ k: STAR });
    else if (ch === '?') toks.push({ k: ONE });
    else toks.push({ k: LIT, c: ch });
  }
  if (bare) toks.push({ k: OPT, to: toks.length + 3 }); // a bare name: that file, or everything below that folder
  if (below || bare) toks.push({ k: LIT, c: '/' }, { k: DEEP });
  return toks;
}

function compileZone(raw) {
  const key = String(raw ?? '');
  let matchers = zoneCache.get(key);
  if (matchers) return matchers;
  matchers = [];
  const pattern = cleanPattern(key);
  if (pattern !== null) {
    for (const choice of expandBraces(pattern)) {
      const cleaned = cleanPattern(choice);
      if (cleaned !== null) matchers.push(buildMatcher(cleaned));
    }
  }
  if (zoneCache.size >= 2000) zoneCache.clear(); // bounded: zones repeat, but never grow without limit
  zoneCache.set(key, matchers);
  return matchers;
}

function shareChar(x, y, fold) {
  if (x.k === LIT && y.k === LIT) return fold ? x.c.toLowerCase() === y.c.toLowerCase() : x.c === y.c;
  if (x.k === LIT) return y.k === DEEP || x.c !== '/';
  if (y.k === LIT) return x.k === DEEP || y.c !== '/';
  return true;
}

/** True when some string is accepted by both matchers (search over pairs of states). */
function intersects(a, b, fold = false) {
  const width = a.length + 1;
  const seen = new Set();
  const todo = [[0, 0]];
  while (todo.length) {
    const [i, j] = todo.pop();
    const key = j * width + i;
    if (seen.has(key)) continue;
    seen.add(key);
    const ta = a[i];
    const tb = b[j];
    if (!ta && !tb) return true;
    if (ta?.k === OPT) { todo.push([i + 1, j], [ta.to, j]); continue; } // enter the optional part, or skip all of it
    if (tb?.k === OPT) { todo.push([i, j + 1], [i, tb.to]); continue; }
    if (ta && ta.k >= STAR) todo.push([i + 1, j]); // a star may match nothing
    if (tb && tb.k >= STAR) todo.push([i, j + 1]);
    if (ta && tb && shareChar(ta, tb, fold)) { // both sides take one common character
      const ni = ta.k >= STAR ? i : i + 1;
      const nj = tb.k >= STAR ? j : j + 1;
      if (ni !== i || nj !== j) todo.push([ni, nj]);
    }
  }
  return false;
}

/**
 * True when a repo-relative POSIX path lies inside one of the zones.
 * Globs: "*" stays in one path segment, "**" crosses segments, "?" is one character,
 * "{a,b}" lists choices. "dir/" and a bare name without wildcards cover everything below.
 * Patterns are anchored at the repo root and case-sensitive. "[" and "]" are literal.
 * @param {string} filePath
 * @param {string[]|string} zones
 * @returns {boolean}
 */
export function matchZone(filePath, zones) {
  const file = cleanPath(filePath);
  if (!file) return false;
  const literal = file.split('').map((c) => ({ k: LIT, c }));
  return toList(zones).some((zone) => compileZone(zone).some((matcher) => intersects(matcher, literal)));
}

/**
 * True when some path could match a zone of both lists. Exact for the glob language above,
 * and on the safe side for a case-insensitive disk: names that differ only in case overlap.
 * @param {string[]|string} zonesA
 * @param {string[]|string} zonesB
 * @returns {boolean}
 */
export function zonesOverlap(zonesA, zonesB) {
  const a = toList(zonesA).flatMap(compileZone);
  const b = toList(zonesB).flatMap(compileZone);
  return a.some((x) => b.some((y) => intersects(x, y, true)));
}

/* ------------------------------------------------------------------ small helpers */

/** Runs async jobs one at a time per key. A key leaves the map when its queue drains. */
function createLocks() {
  const tails = new Map();
  return function withLock(key, job) {
    const run = (tails.get(key) ?? Promise.resolve()).then(job);
    const tail = run.then(noop, noop);
    tails.set(key, tail);
    tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return run;
  };
}

/** Keeps the last bytes of a stream, in bounded memory. */
function tailBuffer(maxBytes) {
  let chunks = [];
  let size = 0;
  return {
    push(chunk) {
      chunks.push(chunk);
      size += chunk.length;
      if (size > maxBytes * 2) {
        const kept = Buffer.from(Buffer.concat(chunks).subarray(size - maxBytes));
        chunks = [kept];
        size = kept.length;
      }
    },
    text(maxChars) {
      const text = Buffer.concat(chunks).toString('utf8').slice(-maxChars);
      return /^[\udc00-\udfff]/.test(text) ? text.slice(1) : text; // never start with half a character
    },
  };
}

/** Git's stderr without hint lines. */
function gitText(stderr) {
  return String(stderr ?? '').split('\n').filter((line) => line.trim() && !line.startsWith('hint:')).join('\n').trim();
}

function gitError(cwd, args, err, stderr) {
  const why = err.killed || err.signal ? `was stopped (${err.signal ?? 'timeout'})`
    : err.code === 'ENOENT' ? 'could not start (git is missing, or the folder is gone)'
    : err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'printed too much output'
    : `failed (exit ${err.code})`;
  const text = gitText(stderr);
  const error = new Error(`git ${args[0]} ${why} in ${cwd}${text ? `: ${text}` : ''}`);
  error.name = 'GitError';
  return Object.assign(error, { exitCode: typeof err.code === 'number' ? err.code : null, stderr, args, cwd });
}

/** Safe folder name: lower case, accents on Latin letters dropped, everything but letters and digits becomes "-". */
function slugify(name) {
  const words = String(name ?? '').normalize('NFKD').replace(/(\p{Script=Latin})[\u0300-\u036f]+/gu, '$1').normalize('NFC')
    .toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return [...words].slice(0, 48).join('').replace(/-+$/, '') || 'project';
}

function checkId(id, kind) {
  // "int" in any case: on a disk that ignores case, ws/<job>/INT is the file of the integration ref ws/<job>/int
  if (typeof id !== 'string' || !ID.test(id) || (kind === 'task' && id.toLowerCase() === 'int')) {
    throw new TypeError(`Bad ${kind} id: ${JSON.stringify(id)}`);
  }
  return id;
}

function repoOf(project) {
  if (!project || typeof project.path !== 'string' || !project.path || typeof project.targetBranch !== 'string' || !project.targetBranch) {
    throw new TypeError('A project needs a path and a targetBranch.');
  }
  return path.resolve(project.path);
}

/** A name git accepts as an author: no angle brackets or line breaks, and it starts with a letter or digit. */
function cleanName(name) {
  return String(name ?? '').replace(/[<>\0\r\n]/g, ' ').replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}]+/u, '').trim() || 'Maker';
}

/**
 * Counts the marker lines of a text. hunks: the ">>>>>>>" lines that carry the label git gave the
 * merged-in side ("origin/ws/J1/int", plus ":path" after a rename), so the conflicts of that merge.
 */
function countMarkers(text, theirs) {
  const count = { open: 0, sep: 0, close: 0, hunks: 0 };
  for (const [, marker, rest] of text.matchAll(/^(<{7}|={7}|>{7})(?=\s|$)([^\n]*)/gm)) {
    count[marker[0] === '<' ? 'open' : marker[0] === '=' ? 'sep' : 'close'] += 1;
    const label = rest.trim();
    if (theirs && marker[0] === '>' && (label === theirs || label.startsWith(`${theirs}:`))) count.hunks += 1;
  }
  return count;
}

/** Conflict marker lines in a working file; null when it is gone, not a regular file, binary or huge. */
async function fileMarkers(file, theirs) {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.size > 64 * MB) return null;
  const bytes = await fs.readFile(file);
  if (bytes.subarray(0, 8000).includes(0)) return null;
  return countMarkers(bytes.toString('latin1'), theirs);
}

/**
 * Marker lines a conflicted file may keep after the fix: the ones it had before the merge (a
 * Markdown heading underline, text that shows how git marks a conflict). found: counts taken right
 * after the merge. Each conflict of the merge added one line of each kind.
 */
function keptMarkers(found) {
  if (!found) return { open: 0, sep: 0, close: 0 };
  const added = found.hunks || found.open; // no labelled end line: take every "<<<<<<<" for a conflict
  return { open: Math.max(0, found.open - added), sep: Math.max(0, found.sep - added), close: Math.max(0, found.close - added) };
}

/** What a recorded value allows. A number is the older record form (separator lines only); no record: any separator line. */
function allowedMarkers(kept) {
  if (typeof kept === 'number') return { open: 0, sep: kept, close: 0 };
  if (!kept || typeof kept !== 'object') return { open: 0, sep: Infinity, close: 0 };
  return { open: Number(kept.open) || 0, sep: Number(kept.sep) || 0, close: Number(kept.close) || 0 };
}

/* ------------------------------------------------------------------ path classes (pure) */

const baseName = (rel) => rel.slice(rel.lastIndexOf('/') + 1);

/** The hub deny list of the guard: an added path here is never delivered. */
function deniedPath(rel) {
  const parts = rel.split('/');
  const base = parts[parts.length - 1];
  if (parts.some((part) => part === 'node_modules' || part === '.venv' || part === '__pycache__')) return true;
  if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) return true;
  return /\.(pem|key)$/i.test(base) || base === '.DS_Store';
}

/** A test file by its name or folder. */
function isTestFile(rel) {
  const base = baseName(rel);
  return /(^|\/)(tests?|__tests__|specs?)\//.test(rel) || /\.(test|spec)\.[^.]+$/.test(base)
    || /^test_.+\.py$/.test(base) || /_(test|spec)\.[A-Za-z]+$/.test(base) || /Tests?\.(java|kt|swift|cs)$/.test(base);
}

/** Manifests, test configs and agent-config files: a change here is shown to the reviewer as a flag. */
function isCheckFile(rel) {
  const base = baseName(rel);
  if (rel.startsWith('.github/') || rel.startsWith('.claude/')) return true;
  if (['package.json', 'Makefile', 'makefile', 'GNUmakefile', 'pyproject.toml', 'GEMINI.md', 'AGENTS.md', 'CLAUDE.md', '.mcp.json'].includes(base)) return true;
  return /^(jest|vitest)\.(config|workspace)\.[^/]+$/.test(base);
}

const isAgentFile = (rel) => matchZone(rel, AGENT_FILE_ZONES);

/** A path as git prints it in a patch header: plain, or C-quoted ("a\tb", octal escapes for raw bytes). */
function unquoteGitPath(text) {
  if (!text.startsWith('"')) return text;
  const bytes = [];
  const simple = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let i = 1; i < text.length - 1; i += 1) {
    const ch = text[i];
    if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); continue; }
    const next = text[i + 1];
    if (/[0-7]/.test(next)) { bytes.push(parseInt(text.slice(i + 1, i + 4), 8)); i += 3; } else { bytes.push(simple[next] ?? next.charCodeAt(0)); i += 1; }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** One value for a git config file, quoted so that no character of it can start a new line or section. */
function configValue(value) {
  const text = String(value);
  if (/[\0\n\r]/.test(text)) throw new Error('A git config value may not hold a line break.');
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\t/g, '\\t')}"`;
}

/* ------------------------------------------------------------------ factory */

/**
 * Creates the git module.
 * @param {object} deps
 * @param {{projects:string, work:string, run?:string, logs?:string, config?:string}} deps.paths  from config.paths():
 *   home of new projects and of job work dirs; run, logs and config join the deny-read list of the sandbox
 * @param {(level:string, msg:string, data?:object)=>void} [deps.log]
 * @param {() => object} [deps.getSettings]  settings (safety, limits); missing: the defaults (safety 'sandboxed')
 * @param {{redact(text:string):string, hit(text:string):boolean}} [deps.redactor]  exact-value redactor (server/redact.js)
 * @param {object} [deps.env]       base environment for child processes (default: process.env, read per call)
 * @param {object} [deps.timeouts]  overrides in ms: { short, long, setup, check, lockWaits: number[], staleLock }
 */
export function createGit({ paths, getSettings, redactor, log: logger = noop, env, timeouts: timeoutOverrides } = {}) {
  const timeouts = { ...TIMEOUTS, ...timeoutOverrides };
  const withLock = createLocks();
  const runningChecks = new Set();
  const origins = new Map(); // bench folder -> canonical repo, as the hub last saw it (never read from the bench)
  const headCache = new Map(); // head check results: `${repo}\0${sha}\0${setupCmd}\0${checkCmd}` -> { sha, ok, tail, ms }
  const baseEnv = () => env ?? process.env;
  const settings = () => {
    try {
      const value = typeof getSettings === 'function' ? getSettings() : null;
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  };
  const limit = (key, fallback) => {
    const value = settings().limits?.[key];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const sandboxed = () => settings().safety !== 'trusting'; // anything but an explicit 'trusting' is the safe mode
  const checkTimeoutMs = () => limit('checkTimeoutMin', timeouts.check / 60_000) * 60_000;
  /** Every tail goes through the redactor. A redactor that throws gives no text at all, never the raw text. */
  const redact = (value) => {
    if (!redactor || typeof redactor.redact !== 'function') return value;
    try { return String(redactor.redact(value)); } catch { return '[output hidden: redaction failed]\n'; }
  };
  const secretHit = (value) => {
    if (SECRET_RE.test(value)) return true;
    try { return Boolean(redactor && typeof redactor.hit === 'function' && redactor.hit(value)); } catch { return true; }
  };
  let tmpCount = 0;
  const tmpTag = randomBytes(6).toString('hex'); // not to be guessed, and other than the tag of any other instance
  const tmpName = (file) => `${file}.${process.pid}.${tmpTag}.${(tmpCount += 1)}.tmp`; // unique per write: two writers never share a temp file
  const log = (level, msg, data) => {
    try { logger(level, msg, data); } catch { /* a broken logger must not break git work */ }
  };

  const dirOf = (kind) => {
    const dir = paths?.[kind];
    if (typeof dir !== 'string' || !dir) throw new Error(`createGit needs paths.${kind}`);
    return path.resolve(dir);
  };
  const intBranch = (jobId) => `ws/${checkId(jobId, 'job')}/int`;
  const taskRefOf = (jobId, taskId) => `refs/workshop/${checkId(jobId, 'job')}/${checkId(taskId, 'task')}`;
  const jobDir = (jobId) => path.join(dirOf('work'), checkId(jobId, 'job'));
  const repoKey = (repo) => `repo:${repo}`;
  const dirKey = (dir) => `dir:${path.resolve(dir)}`;
  const metaFile = (dir) => path.join(dir, '.git', META);

  /* ---------- running git ---------- */

  function cleanEnv(forGit) {
    const out = {};
    for (const [key, value] of Object.entries(baseEnv())) {
      if (value == null || SECRET_ENV.test(key)) continue;
      if (forGit && key.startsWith('GIT_') && !GIT_ENV_KEEP.test(key)) continue;
      out[key] = value;
    }
    return out;
  }

  /** The environment of a setup or check command: the allow list only. tmp: the private temp dir of a sandboxed run. */
  function commandEnv(tmp) {
    const base = baseEnv();
    const out = {};
    for (const key of COMMAND_ENV) if (typeof base[key] === 'string' && base[key]) out[key] = base[key];
    if (!out.PATH) out.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    if (tmp) out.TMPDIR = `${tmp}/`;
    return out;
  }

  /** One git process. Never rejects: resolves { err, code (null when git did not exit by itself), stdout, stderr }. */
  function spawnGit(cwd, args, { ident = HUB, timeoutMs = timeouts.short, buffer = false, maxBuffer = 64 * MB, discover = false, input = null }) {
    const started = Date.now();
    const childEnv = Object.assign(cleanEnv(true), {
      LC_ALL: 'C', // plain English messages, whatever the owner's locale
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_AUTHOR_NAME: ident.name,
      GIT_AUTHOR_EMAIL: ident.email,
      GIT_COMMITTER_NAME: ident.name,
      GIT_COMMITTER_EMAIL: ident.email,
    });
    // Never fall through to a repository above cwd (for example the WorkShop folder itself).
    if (!discover) childEnv.GIT_CEILING_DIRECTORIES = path.dirname(path.resolve(cwd));
    return new Promise((resolve) => {
      const spawnOptions = { cwd, env: childEnv, timeout: timeoutMs, maxBuffer, encoding: buffer ? 'buffer' : 'utf8' };
      const child = execFile('git', [...GIT_FLAGS, ...args], spawnOptions, (err, stdout, stderr) => {
        const code = !err ? 0 : typeof err.code === 'number' && !err.killed ? err.code : null;
        log('debug', 'git', { cwd, cmd: args.slice(0, 3).join(' '), code, ms: Date.now() - started });
        resolve({ err, code, stdout, stderr: String(stderr) });
      });
      child.stdin?.on('error', noop);
      child.stdin?.end(input ?? undefined); // only cat-file --batch-check gets input; nothing else ever waits for it
    });
  }

  /** Is the lock in a place that only the hub's benches and integration worktrees use? */
  async function hubLock(lock) {
    const work = await fs.realpath(dirOf('work')).catch(() => null);
    if (!work) return false;
    if (lock.startsWith(work + path.sep) && lock.includes(`${path.sep}.git${path.sep}`)) return true; // inside a bench
    // The git folder of an integration worktree is <repo>/.git/worktrees/<name>. Its file "gitdir" names <work>/<job>/_int/.git.
    const admin = path.dirname(lock);
    if (path.basename(path.dirname(admin)) !== 'worktrees') return false;
    const link = (await fs.readFile(path.join(admin, 'gitdir'), 'utf8').catch(() => '')).trim();
    const tree = link ? await fs.realpath(path.dirname(path.resolve(admin, link))).catch(() => null) : null;
    return Boolean(tree && tree.startsWith(work + path.sep) && path.basename(tree) === '_int');
  }

  /**
   * A lock that is old enough was left by a git that got killed (an agent turn that timed out, a hub
   * that lost power): remove it, but only in a bench or in the git folder of an integration worktree.
   * Every other lock in the owner's repository stays.
   */
  async function clearStaleLock(lock) {
    const stat = await fs.stat(lock).catch(() => null);
    if (!stat || Date.now() - stat.mtimeMs < timeouts.staleLock || !(await hubLock(lock))) return;
    await fs.rm(lock, { force: true });
    log('warn', 'removed a stale git lock', { lock });
  }

  /**
   * Runs git in cwd. Resolves { code, stdout, stderr, overflow } when the exit code is in `ok`
   * ('any' takes every exit code); rejects with a GitError otherwise, on timeout or start failure.
   * A call that finds a lock file waits and tries again: another git may be about to finish.
   */
  async function git(cwd, args, options = {}) {
    const { ok = [0], overflowOk = false } = options;
    for (let attempt = 0; ; attempt += 1) {
      const run = await spawnGit(cwd, args, options);
      const result = { code: run.code ?? 0, stdout: run.stdout, stderr: run.stderr, overflow: false };
      if (!run.err) return result;
      const lock = run.code !== null && attempt < timeouts.lockWaits.length ? LOCK_BUSY.exec(run.stderr)?.[1] : null;
      if (lock) {
        await sleep(timeouts.lockWaits[attempt]);
        if (attempt === timeouts.lockWaits.length - 1) await clearStaleLock(lock);
        continue;
      }
      if (overflowOk && run.err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { ...result, overflow: true };
      if (run.code !== null && (ok === 'any' || ok.includes(run.code))) return result;
      throw gitError(cwd, args, run.err, run.stderr);
    }
  }

  const text = async (cwd, args, opts) => (await git(cwd, args, opts)).stdout.trim();

  /** Full commit sha of a revision, or null when it does not exist. */
  async function sha(cwd, rev) {
    const found = await git(cwd, ['rev-parse', '-q', '--verify', '--end-of-options', `${rev}^{commit}`], { ok: [0, 1] });
    return found.code === 0 ? found.stdout.trim() : null;
  }

  /** Is commit a contained in commit b? With lenient, an unknown commit counts as "no". */
  async function isAncestor(cwd, a, b, lenient = false) {
    const found = await git(cwd, ['merge-base', '--is-ancestor', a, b], { ok: lenient ? 'any' : [0, 1] });
    return found.code === 0;
  }

  const unmergedPaths = async (dir) => zlist((await git(dir, [...DIFF, '--name-only', '--diff-filter=U', '-z'])).stdout);

  /** Commit where head (plus a merge in progress, when asked) forked from baseRef. */
  async function forkBase(dir, baseRef, head = 'HEAD', withPendingMerge = false) {
    const base = await sha(dir, baseRef);
    if (!base) throw new Error(`Unknown base "${baseRef}" in ${dir}`);
    const revs = [base, head];
    const pending = withPendingMerge ? await sha(dir, 'MERGE_HEAD') : null;
    if (pending) revs.push(pending);
    const found = await git(dir, ['merge-base', ...revs], { ok: [0, 1] });
    return found.code === 0 ? found.stdout.trim() : base; // unrelated histories: compare with the base itself
  }

  async function numstat(dir, from, to) {
    const out = (await git(dir, [...DIFF, '--numstat', '--no-renames', '-z', from, to, '--'], { timeoutMs: timeouts.long })).stdout;
    const stat = { files: [], add: 0, del: 0 };
    for (const record of zlist(out)) {
      const [add, del, ...name] = record.split('\t');
      const file = { path: name.join('\t'), add: Number(add) || 0, del: Number(del) || 0 };
      if (add === '-') file.binary = true;
      stat.files.push(file);
      stat.add += file.add;
      stat.del += file.del;
    }
    return stat;
  }

  /* ---------- files ---------- */

  /**
   * Replaces a file in one step: readers never see a half-written file. The temp file is made with
   * "must not exist yet", so the hub never writes through a link that was planted under that name.
   */
  async function replaceFile(file, content) {
    const tmp = tmpName(file);
    try {
      await fs.writeFile(tmp, content, { flag: 'wx' }).catch(async (err) => {
        if (err.code !== 'EEXIST') throw err;
        await fs.rm(tmp, { recursive: true, force: true }); // a leftover or a planted link: remove the entry itself
        await fs.writeFile(tmp, content, { flag: 'wx' });
      });
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(noop);
      throw err;
    }
  }

  /* ---------- bench record ---------- */

  const saveMeta = (dir, meta) => replaceFile(metaFile(dir), `${JSON.stringify(meta, null, 2)}\n`);

  /** The bench record. Rebuilt from git when the file is missing or corrupt (a corrupt file is kept as .bak). */
  async function benchInfo(dir) {
    const file = metaFile(dir);
    try {
      const stat = await fs.lstat(file).catch(() => null);
      if (stat && !stat.isFile()) { // a link or a folder an agent put there: never read through it
        await fs.rm(file, { recursive: true, force: true });
        throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
      }
      const meta = JSON.parse(await fs.readFile(file, 'utf8'));
      if (meta && typeof meta.integrationBranch === 'string') return meta;
      throw new SyntaxError('not a bench record');
    } catch (err) {
      if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
      if (err.code !== 'ENOENT') {
        await fs.rename(file, `${file}.bak`).catch(noop);
        log('warn', 'bench record was corrupt; rebuilt it and kept a .bak copy', { dir });
      }
    }
    const upstream = await text(dir, ['config', '--get', `branch.${WORK}.merge`], { ok: [0, 1] });
    const integrationBranch = upstream.startsWith('refs/heads/')
      ? upstream.slice('refs/heads/'.length)
      : `ws/${path.basename(path.dirname(path.resolve(dir)))}/int`;
    const remote = await sha(dir, `refs/remotes/origin/${integrationBranch}`);
    const head = await sha(dir, 'HEAD');
    const baseSha = remote && head ? await forkBase(dir, remote, head) : remote ?? head;
    const meta = { v: 1, integrationBranch, baseSha, createdAt: Date.now(), setup: null, conflicts: null, rebuilt: true };
    await saveMeta(dir, meta);
    return meta;
  }

  /**
   * Updates the bench record. conflicts: each conflicted path with the marker lines it may keep
   * ({ open, sep, close }: lines that were in the file before the merge).
   * pendingMerge: a conflicted merge started; it stays set until a sync succeeds.
   */
  async function patchMeta(dir, patch) {
    const meta = await benchInfo(dir);
    if (Object.entries(patch).some(([key, value]) => (meta[key] ?? null) !== value)) await saveMeta(dir, { ...meta, ...patch });
  }

  /**
   * Keeps the hub paths and Finder files out of every commit. Nothing is read or written through a link that an
   * agent put at .git/info or .git/info/exclude: such a link is replaced, so no file outside the bench is touched
   * and no content of one is copied into the bench.
   */
  async function writeExclude(dir) {
    const info = path.join(dir, '.git', 'info');
    const folder = await fs.lstat(info).catch(() => null);
    if (folder && !folder.isDirectory()) await fs.rm(info, { force: true });
    await fs.mkdir(info, { recursive: true });
    const file = path.join(info, 'exclude');
    const stat = await fs.lstat(file).catch(() => null);
    const plain = Boolean(stat?.isFile());
    if (stat && !plain) await fs.rm(file, { recursive: true, force: true });
    const have = plain ? await fs.readFile(file, 'utf8').catch(() => '') : '';
    const lines = have.split('\n');
    const missing = EXCLUDES.filter((line) => !lines.includes(line));
    if (!missing.length) return;
    const head = have && !have.endsWith('\n') ? `${have}\n` : have;
    await replaceFile(file, `${head}# WorkShop hub files: never committed\n${missing.join('\n')}\n`);
  }

  /* ---------- conflicts ---------- */

  /**
   * Paths (from a Map path -> marker lines the file may keep) whose working file still has conflict
   * markers. A marker line that was in the file before the merge is not a conflict marker.
   */
  async function markedFiles(dir, wanted) {
    const marked = [];
    for (const [rel, kept] of wanted) {
      const found = await fileMarkers(path.join(dir, rel));
      const allowed = allowedMarkers(kept);
      if (found && (found.open > allowed.open || found.close > allowed.close || found.sep > allowed.sep)) marked.push(rel);
    }
    return marked.sort();
  }

  /** Files of the current or last conflicted merge: the record written at conflict time plus git's unmerged list. */
  async function conflictFiles(dir, unmerged) {
    const meta = await benchInfo(dir);
    const wanted = new Map(Object.entries(meta.conflicts ?? {}));
    for (const rel of unmerged) if (!wanted.has(rel)) wanted.set(rel, undefined);
    return wanted;
  }

  /**
   * Paths that still block a merge in the bench: git's unmerged paths, plus files of the last
   * conflicted merge that still hold "<<<<<<<", "=======" or ">>>>>>>" marker lines.
   * @param {string} benchDir
   * @returns {Promise<string[]>} sorted
   */
  async function unresolved(benchDir) {
    await needBench(benchDir); // the bench record may be rebuilt here: never write one into another repository
    await secureBench(benchDir);
    const unmerged = await unmergedPaths(benchDir);
    const marked = await markedFiles(benchDir, await conflictFiles(benchDir, unmerged));
    return [...new Set([...unmerged, ...marked])].sort();
  }

  /** The error for a git repository inside a bench. The text tells the maker the way out. */
  function nestedRepoError(folders) {
    const error = new Error(`The bench has a git repository inside it: ${folders.join(', ')}. Git would deliver that folder without its files. `
      + `Delete the .git folder inside it (for example: rm -rf "${folders[0]}/.git"), then hand in again.`);
    return Object.assign(error, { code: 'E_NESTED_REPO', paths: folders });
  }

  /**
   * Stages everything except hub files under .shop/ (also when an agent force-added them).
   * Rejects when a folder of the bench holds a git repository of its own (a "git init" or a
   * "git clone" by the agent): git would commit a link to a commit there, and none of its files.
   */
  async function stageAll(dir) {
    await writeExclude(dir);
    try {
      await git(dir, ['add', '-A'], { timeoutMs: timeouts.long });
    } catch (err) {
      // A nested repository without commits makes "git add" fail. Git lists such a folder as one untracked entry that ends with "/".
      const others = await git(dir, ['ls-files', '--others', '--exclude-standard', '-z'], { ok: 'any', timeoutMs: timeouts.long }).catch(() => null);
      const nested = zlist(others?.stdout ?? '').filter((rel) => rel.endsWith('/')).map((rel) => rel.slice(0, -1));
      throw nested.length ? nestedRepoError(nested) : err;
    }
    const known = await sha(dir, `refs/remotes/origin/${(await benchInfo(dir)).integrationBranch}`);
    // A nested repository with commits is staged as a link (mode 160000). Real submodules are listed in .gitmodules.
    const newEntries = [...DIFF, '--cached', '--raw', '--no-renames', '--diff-filter=AT', '-z', known ?? 'HEAD', '--'];
    const raw = zlist((await git(dir, newEntries, { timeoutMs: timeouts.long })).stdout); // ":old new sha sha A", path, ...
    const links = raw.filter((entry, i) => i % 2 === 1 && raw[i - 1].split(' ')[1] === '160000');
    if (links.length) {
      const listed = await git(dir, ['config', '-f', '.gitmodules', '-z', '--get-regexp', '^submodule\\..*\\.path$'], { ok: 'any' });
      const modules = new Set(zlist(listed.stdout).map((entry) => entry.slice(entry.indexOf('\n') + 1)));
      const nested = links.filter((rel) => !modules.has(rel));
      if (nested.length) {
        await git(dir, ['rm', '-q', '-f', '--cached', '--ignore-unmatch', '--', ...nested]); // the link never stays staged; the folder is not touched
        throw nestedRepoError(nested);
      }
    }
    // Hub paths: the index gets the integration version back, so no add, change or delete under them is ever committed.
    // The lists are filtered here, not by a pathspec: on a disk that ignores case, ".Agents/x" is the file ".agents/x",
    // and git pathspecs are case-sensitive.
    const base = known ?? (await sha(dir, 'HEAD'));
    const slow = { timeoutMs: timeouts.long };
    const staged = zlist((await git(dir, ['ls-files', '-z'], slow)).stdout).filter(isHubPath);
    const inBase = base ? zlist((await git(dir, ['ls-tree', '-r', '--name-only', '-z', base], slow)).stdout).filter(isHubPath) : [];
    for (const part of chunks(staged)) await git(dir, ['rm', '-q', '--cached', '--ignore-unmatch', '--', ...part], slow);
    for (const part of chunks(inBase)) await git(dir, ['reset', '-q', base, '--', ...part], { ...slow, ok: [0, 1] });
  }

  /**
   * Ends a merge that is in progress in a bench: refuses while conflict markers remain (git's
   * conflict state stays as it is), else stages all, verifies with unresolved() and commits.
   */
  async function concludeMerge(dir, message, ident) {
    let left = await markedFiles(dir, await conflictFiles(dir, await unmergedPaths(dir)));
    if (!left.length) {
      await stageAll(dir);
      left = await unresolved(dir);
    }
    if (left.length) return { ok: false, conflicts: left };
    await git(dir, ['commit', '-q', '-m', message], { ident, timeoutMs: timeouts.long });
    await patchMeta(dir, { conflicts: null });
    return { ok: true, sha: await sha(dir, 'HEAD') };
  }

  /** The hub only reads branch "work". If the agent moved on to another branch, bring "work" along when that loses nothing. */
  async function ensureOnWork(dir) {
    const current = await text(dir, ['symbolic-ref', '-q', '--short', 'HEAD'], { ok: [0, 1] });
    if (current === WORK) return;
    const work = await sha(dir, `refs/heads/${WORK}`);
    if (work && !(await isAncestor(dir, work, 'HEAD', true))) {
      throw new Error(`The bench is on ${current ? `branch "${current}"` : 'a detached HEAD'} that does not contain branch "${WORK}". `
        + `Finish or abort a rebase, then run: git checkout ${WORK} (and merge your commits into it).`);
    }
    await git(dir, ['checkout', '-q', '-B', WORK], { timeoutMs: timeouts.long });
    log('warn', `bench was on ${current || 'a detached HEAD'}; moved branch "${WORK}" to it`, { dir });
  }

  /**
   * Puts a bench back in order when the hub's last merge there did not come back: git was stopped
   * (timeout, kill) or the hub itself went down. The merge may have written some files and not the
   * rest. If such a state were concluded, the merge commit would undo work of other tasks.
   * So: end the open merge, and put back every file that is equal to its version on the merged-in
   * side (the next merge brings it again). All other files stay: they may be the maker's own work.
   */
  async function healMerge(dir) {
    const cut = (await benchInfo(dir)).merging;
    if (!cut) return;
    const slow = { timeoutMs: timeouts.long };
    if (cut.to && (await sha(dir, 'HEAD')) === cut.head) { // no merge commit and no fast-forward came out of it
      if (await sha(dir, 'MERGE_HEAD')) await git(dir, ['merge', '--abort'], slow); // fails (a lock is left): try again at the next call
      const names = [...DIFF, '--name-only', '--no-renames', '-z'];
      const parts = (list) => Array.from({ length: Math.ceil(list.length / 200) }, (_, i) => list.slice(i * 200, i * 200 + 200));
      let count = 0;
      // Tracked files that differ from HEAD, and not from the merged-in side.
      const dirty = zlist((await git(dir, [...names, '--diff-filter=MD', 'HEAD', '--'], slow)).stdout);
      for (const part of parts(dirty)) {
        const own = new Set(zlist((await git(dir, [...names, cut.to, '--', ...part], slow)).stdout));
        const written = part.filter((rel) => !own.has(rel));
        if (written.length) await git(dir, ['checkout', '-q', 'HEAD', '--', ...written], slow);
        count += written.length;
      }
      // New files of the merged-in side that are in the bench already: untracked, and with the same content.
      const added = new Set(zlist((await git(dir, [...names, '--diff-filter=A', 'HEAD', cut.to, '--'], slow)).stdout));
      const loose = zlist((await git(dir, ['ls-files', '--others', '--exclude-standard', '-z'], slow)).stdout).filter((rel) => added.has(rel));
      for (const part of parts(loose)) {
        const have = (await git(dir, ['hash-object', '--', ...part], slow)).stdout.split('\n');
        const want = new Map(zlist((await git(dir, ['ls-tree', '-z', cut.to, '--', ...part], slow)).stdout)
          .map((entry) => [entry.slice(entry.indexOf('\t') + 1), entry.split(/[ \t]/)[2]]));
        for (const [n, rel] of part.entries()) {
          if (!have[n] || have[n] !== want.get(rel)) continue;
          await fs.rm(path.join(dir, rel), { force: true });
          count += 1;
        }
      }
      log('warn', 'a merge in the bench was cut off; put its files back', { dir, files: count });
    }
    await patchMeta(dir, { merging: null });
  }

  /* ---------- projects ---------- */

  /**
   * Creates a new project repo under paths.projects: safe folder name (name, name-2, ...),
   * branch "main", one empty first commit.
   * @param {{name:string}} input
   * @returns {Promise<{path:string, targetBranch:string}>}
   */
  async function initProject(input) {
    const { name } = input ?? {};
    const home = dirOf('projects');
    await fs.mkdir(home, { recursive: true });
    const slug = slugify(name);
    let dir = null;
    for (let n = 1; !dir && n < 10_000; n += 1) {
      const candidate = path.join(home, n === 1 ? slug : `${slug}-${n}`);
      try {
        await fs.mkdir(candidate);
        dir = candidate;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
    if (!dir) throw new Error(`No free folder name for project "${name}" in ${home}`);
    try {
      await git(dir, ['init', '-q', '--initial-branch=main']);
      await git(dir, ['commit', '-q', '--allow-empty', '-m', `Start ${String(name ?? '').trim() || slug}`]);
    } catch (err) {
      await fs.rm(dir, { recursive: true, force: true }).catch(noop);
      throw err;
    }
    log('info', 'project created', { path: dir });
    return { path: dir, targetBranch: 'main' };
  }

  /**
   * Adopts an existing repo. Read-only: the owner's working tree and refs stay as they are.
   * Refuses a missing folder, a non-repo, a bare repo, a subfolder of a repo, a detached HEAD
   * and a repo without commits.
   * @param {{path:string}} input
   * @returns {Promise<{path:string, targetBranch:string}>} path is the real top folder; targetBranch is the checked-out branch
   */
  async function adoptProject(input) {
    const { path: given } = input ?? {};
    if (typeof given !== 'string' || !given.trim()) throw new Error('A project folder is required.');
    const dir = path.resolve(given);
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`Folder not found: ${dir}`);
    const real = await fs.realpath(dir);
    const inside = await git(real, ['rev-parse', '--is-inside-work-tree'], { ok: 'any', discover: true });
    if (inside.code !== 0) throw new Error(`Not a git repository: ${dir}`);
    if (inside.stdout.trim() !== 'true') {
      throw new Error(`${dir} has no working tree (a bare repository or a .git folder). Choose a normal checkout.`);
    }
    const top = await fs.realpath(await text(real, ['rev-parse', '--show-toplevel'], { discover: true }));
    if (top !== real) throw new Error(`${dir} is a folder inside the git repository ${top}. Choose the top folder of the repository.`);
    const branch = await git(real, ['symbolic-ref', '-q', '--short', 'HEAD'], { ok: 'any' });
    if (branch.code !== 0 || !branch.stdout.trim()) throw new Error(`${dir} has a detached HEAD. Check out a branch first (git switch <branch>).`);
    if (!(await sha(real, 'HEAD'))) throw new Error(`${dir} has no commits yet. Make a first commit, then try again.`);
    const tracked = zlist((await git(real, ['ls-tree', '-r', '--name-only', '-z', 'HEAD'], { timeoutMs: timeouts.long })).stdout);
    return { path: real, targetBranch: branch.stdout.trim(), agentFiles: tracked.filter(isAgentFile).sort() };
  }

  /* ---------- integration branch and worktree ---------- */

  async function integrationReady(repo, dir, branch) {
    try {
      if (!(await exists(path.join(dir, '.git')))) return false;
      if ((await text(dir, ['symbolic-ref', '-q', '--short', 'HEAD'], { ok: [0, 1] })) !== branch) return false;
      const commonDir = async (cwd) => fs.realpath(await text(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
      return (await commonDir(dir)) === (await commonDir(repo));
    } catch {
      return false;
    }
  }

  /** Branch ws/<job>/int at the target head plus its worktree; repairs a missing or broken worktree. Caller holds the repo lock. */
  async function ensureIntegration(project, jobId) {
    const repo = repoOf(project);
    const integrationBranch = intBranch(jobId);
    const integrationDir = path.join(jobDir(jobId), '_int');
    if (await integrationReady(repo, integrationDir, integrationBranch)) return { integrationBranch, integrationDir };
    await fs.rm(integrationDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(integrationDir), { recursive: true });
    let where = ['--', integrationDir, integrationBranch];
    const head = await sha(repo, `refs/heads/${integrationBranch}`);
    if (!head) {
      const target = await sha(repo, `refs/heads/${project.targetBranch}`);
      if (!target) throw new Error(`Target branch "${project.targetBranch}" not found in ${repo}`);
      where = ['--no-track', '-b', integrationBranch, '--', integrationDir, target];
    } else {
      // Right after a restart that lost the folder. Wrong for a new job that got the id of an old one: the caller must not reuse ids.
      log('warn', 'the integration branch was there already; the job goes on from it', { integrationBranch, head });
    }
    // --force also replaces a stale registration of this folder. No "worktree prune" here: that would
    // also drop worktrees of the owner whose folders are only unmounted.
    await git(repo, ['worktree', 'add', '-q', '--force', ...where], { timeoutMs: timeouts.long });
    log('info', 'integration worktree ready', { integrationBranch, integrationDir });
    return { integrationBranch, integrationDir };
  }

  /**
   * The integration worktree is hub-only: drop whatever an interrupted merge or a check left behind.
   * Hub files stay (.shop/ of a boss desk, .agents/ of a CLI): a worktree has no exclude file of its own.
   */
  async function resetIntegration(dir) {
    if (await sha(dir, 'MERGE_HEAD')) await git(dir, ['merge', '--abort'], { ok: 'any' });
    await git(dir, ['reset', '-q', '--hard', 'HEAD'], { timeoutMs: timeouts.long });
    await git(dir, ['clean', '-q', '-f', '-d', '-e', `/${SHOP}/`, '-e', '/.agents/'], { timeoutMs: timeouts.long });
  }

  /**
   * Creates branch ws/<jobId>/int at the target branch head and its worktree at <work>/<jobId>/_int.
   * Idempotent, also across restarts.
   * @returns {Promise<{integrationBranch:string, integrationDir:string}>}
   */
  async function startJob(project, jobId) {
    const repo = repoOf(project);
    checkId(jobId, 'job');
    return withLock(repoKey(repo), async () => {
      const made = await ensureIntegration(project, jobId);
      return { ...made, intSha: await sha(repo, `refs/heads/${made.integrationBranch}`) };
    });
  }

  /* ---------- benches ---------- */

  /** The parts of dir below the work area ([job, ...]), also when one of them is named through a link (/tmp and /private/tmp). */
  async function workParts(dir) {
    const work = path.resolve(dirOf('work'));
    const abs = path.resolve(String(dir ?? ''));
    let parts = path.relative(work, abs).split(path.sep);
    if (parts[0] === '..' || parts.length < 2 || parts.length > 3) {
      const real = (place) => fs.realpath(place).catch(() => place);
      parts = path.relative(await real(work), path.join(await real(path.dirname(abs)), path.basename(abs))).split(path.sep);
    }
    return parts.some((part) => !part || part === '..' || path.isAbsolute(part)) ? null : parts;
  }

  /** Is dir a bench folder <work>/<job>/<task>? Never _int, a clone, or a folder outside the work area. */
  async function isBenchPlace(dir) {
    const parts = await workParts(dir);
    return Boolean(parts && parts.length === 2 && ID.test(parts[0]) && ID.test(parts[1]) && parts[1].toLowerCase() !== 'int');
  }

  /** A folder the hub may delete: a bench, a review clone, a desk, _head, _preview or the refresh scratch clone. Never _int. */
  async function isHubFolder(dir) {
    const parts = await workParts(dir);
    if (!parts || !ID.test(parts[0])) return false;
    if (parts.length === 3) return parts[1] === '_desk' && /^@?[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(parts[2]);
    return parts.length === 2 && (await isBenchPlace(dir) || CLONE_NAME.test(parts[1]) || parts[1] === '_refresh'
      || /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.stale-\d+$/.test(parts[1])); // a clone of another repo that createBench moved aside
  }

  /**
   * commitAll, syncBench and unresolved write in a repository. They must never do that to the owner's repository or to _int.
   * The git folder of a bench must be a real folder: a link or a "gitdir:" file could send the hub's git into another repository.
   */
  async function needBench(dir) {
    if (!(await isBenchPlace(dir))) {
      throw new Error(`Not a bench: ${dir}. The hub commits and merges only in the folders <work>/<job>/<task>.`);
    }
    const gitDir = await fs.lstat(path.join(dir, '.git')).catch(() => null);
    if (gitDir && !gitDir.isDirectory()) throw new Error(`The bench ${dir} has a .git that is not a folder. The hub does not work there.`);
  }

  /* ---------- git config of benches and clones ---------- */

  /** The canonical repo of a bench, from the hub's own records: memory, the job's _int worktree, then the bench record. */
  async function benchOrigin(dir, meta) {
    const known = origins.get(path.resolve(dir));
    if (known) return known;
    const fromInt = await intRepo(path.dirname(path.resolve(dir)));
    if (fromInt) return fromInt;
    return typeof meta?.origin === 'string' && meta.origin ? meta.origin : null;
  }

  /** The canonical repo of a job folder, from its _int worktree (hub-only): <repo>/.git/worktrees/<name> -> <repo>. */
  async function intRepo(jobFolder) {
    const intDir = path.join(jobFolder, '_int');
    const link = await fs.readFile(path.join(intDir, '.git'), 'utf8').catch(() => '');
    const found = /^gitdir: (.+)$/m.exec(link);
    if (!found) return null;
    const common = path.resolve(path.resolve(intDir, found[1].trim()), '..', '..');
    return path.basename(common) === '.git' && (await exists(common)) ? path.dirname(common) : null;
  }

  /**
   * Where the hub reads "tracked on the integration branch" for a folder of the work area: the canonical repo and
   * ws/<job>/int there. Never the refs of the folder itself: an agent can move those. null outside the work area.
   */
  async function trustedIntegration(dir) {
    const parts = await workParts(dir);
    if (!parts || !ID.test(parts[0])) return null;
    const repo = origins.get(path.resolve(dir)) ?? (await intRepo(path.join(dirOf('work'), parts[0])));
    return repo ? { repo, ref: `refs/heads/ws/${parts[0]}/int` } : null;
  }

  /** The few settings of the old config file that describe the repository itself; everything else is dropped. */
  async function keptConfig(dir) {
    const file = path.join(dir, '.git', 'config');
    const pattern = '^(core\\.(repositoryformatversion|filemode|ignorecase|precomposeunicode|symlinks)|extensions\\.(objectformat|refstorage)|user\\.name)$';
    const read = await git(dir, ['config', '-f', file, '-z', '--get-regexp', pattern], { ok: 'any' }).catch(() => null);
    const out = {};
    for (const entry of zlist(read?.stdout ?? '')) {
      const cut = entry.indexOf('\n');
      out[(cut < 0 ? entry : entry.slice(0, cut)).toLowerCase()] = cut < 0 ? '' : entry.slice(cut + 1);
    }
    return out;
  }

  /**
   * Writes the git config of a bench or a hub clone from the hub's template. Nothing of the old file survives except the
   * format of the repository and the bench's author name: no filter, merge driver, alias, include, hook path, fsmonitor,
   * URL rewrite or helper program that an agent put there ever runs in the hub.
   */
  async function writeConfig(dir, { origin, integrationBranch, branch = null, userName }) {
    // A "commondir" file makes git read the config (and refs) of another folder: the template would not apply.
    // Benches and hub clones are plain clones and never have one.
    await fs.rm(path.join(dir, '.git', 'commondir'), { recursive: true, force: true });
    const old = await keptConfig(dir);
    const bool = (key, fallback) => (/^(true|false)$/i.test(old[key] ?? '') ? old[key].toLowerCase() : fallback);
    const version = old['core.repositoryformatversion'] === '1' ? '1' : '0';
    const lines = ['[core]', `\trepositoryformatversion = ${version}`, `\tfilemode = ${bool('core.filemode', 'true')}`, '\tbare = false',
      '\tlogallrefupdates = true', `\tignorecase = ${bool('core.ignorecase', process.platform === 'darwin' ? 'true' : 'false')}`,
      `\tprecomposeunicode = ${bool('core.precomposeunicode', 'true')}`];
    if (old['core.symlinks']) lines.push(`\tsymlinks = ${bool('core.symlinks', 'true')}`);
    lines.push('\thooksPath = /dev/null', '\tfsmonitor = false', '[commit]', '\tgpgsign = false', '[tag]', '\tgpgsign = false');
    const format = old['extensions.objectformat'];
    const refs = old['extensions.refstorage'];
    if (version === '1' && (format || refs)) {
      lines.push('[extensions]');
      if (/^(sha1|sha256)$/.test(format ?? '')) lines.push(`\tobjectformat = ${format}`);
      if (/^(files|reftable)$/.test(refs ?? '')) lines.push(`\trefstorage = ${refs}`);
    }
    lines.push('[remote "origin"]', `\turl = ${configValue(origin)}`, `\tpushurl = ${configValue(NO_PUSH)}`,
      `\tfetch = ${configValue(`+refs/heads/${integrationBranch}:refs/remotes/origin/${integrationBranch}`)}`);
    if (branch) lines.push(`[branch ${configValue(branch)}]`, '\tremote = origin', `\tmerge = ${configValue(`refs/heads/${integrationBranch}`)}`);
    lines.push('[user]', `\tname = ${configValue(cleanName(userName ?? old['user.name']))}`, `\temail = ${configValue(AGENT_EMAIL)}`, '');
    await replaceFile(path.join(dir, '.git', 'config'), lines.join('\n'));
  }

  /** Before the hub runs git in a bench: the bench config is the hub's template again (contract section 9). */
  async function secureBench(dir, userName) {
    let meta = {};
    try {
      if ((await fs.lstat(metaFile(dir))).isFile()) meta = JSON.parse(await fs.readFile(metaFile(dir), 'utf8')) ?? {}; // never through a link
    } catch { /* no record or a corrupt one: benchInfo rebuilds it */ }
    const jobFolder = path.basename(path.dirname(path.resolve(dir)));
    const integrationBranch = ID.test(jobFolder) ? `ws/${jobFolder}/int` : String(meta.integrationBranch ?? '');
    const origin = await benchOrigin(dir, meta);
    if (!origin || !integrationBranch) return; // not a hub bench: nothing to rewrite from
    await writeConfig(dir, { origin, integrationBranch, branch: WORK, userName });
  }

  /**
   * Before the hub runs git in a hub clone (_head, _refresh, a desk, a review clone) after a command or an agent ran
   * there: its config is the hub template again. false when the folder is not one the hub can vouch for.
   */
  async function secureClone(dir) {
    const gitDir = await fs.lstat(path.join(dir, '.git')).catch(() => null);
    if (!gitDir?.isDirectory()) return false;
    const trusted = await trustedIntegration(dir);
    if (!trusted) return false;
    await writeConfig(dir, { origin: trusted.repo, integrationBranch: trusted.ref.slice('refs/heads/'.length), userName: 'Reviewer' });
    return true;
  }

  /**
   * Writes hub files into a bench. Keys are bench-relative paths under .shop/; a null value deletes the file.
   * Nothing is made, written or deleted through a link: a link at .shop is replaced, a link below it is refused.
   * @param {string} benchDir
   * @param {Object<string, string|Buffer|null>} files  for example { '.shop/TASK.md': text }
   */
  async function writeHubFiles(benchDir, files) {
    if (!(await exists(benchDir))) throw new Error(`Bench not found: ${benchDir}`);
    const entries = Object.entries(files ?? {}).map(([name, content]) => {
      const rel = path.posix.normalize(String(name).replaceAll('\\', '/')).replace(/^(?:\.\/)+/, '');
      const top = rel.split('/')[0];
      if (!HUB_ROOTS.includes(top) || rel === top || rel.endsWith('/') || rel.includes('\0')) {
        throw new Error(`Hub files must be inside ${HUB_PATHS.join(' or ')}: ${name}`);
      }
      return { name, rel, top, content };
    });
    // A file or a link in the place of a hub folder is removed; the folder is made new. .shop always exists.
    for (const top of new Set([SHOP, ...entries.filter((e) => e.content != null).map((e) => e.top)])) {
      const root = path.join(benchDir, top);
      const stat = await fs.lstat(root).catch(() => null);
      if (stat && !stat.isDirectory()) await fs.rm(root, { force: true });
      await fs.mkdir(root, { recursive: true });
    }
    for (const { name, rel, top, content } of entries) {
      // Every folder between the hub folder and the file must be a real folder: the hub makes, writes and
      // deletes nothing through a link that an agent put there.
      let folder = benchDir;
      let found = true;
      for (const part of rel.split('/').slice(0, -1)) {
        folder = path.join(folder, part);
        let entry = await fs.lstat(folder).catch(() => null);
        if (!entry && content != null) {
          await fs.mkdir(folder).catch((err) => { if (err.code !== 'EEXIST') throw err; });
          entry = await fs.lstat(folder);
        }
        if (entry && !entry.isDirectory()) throw new Error(`Hub file leaves ${top}/ through a link (or a file is in the way): ${name}`);
        if (!entry) { found = false; break; } // delete: the folder is not there, so the file is not there
      }
      const file = path.join(benchDir, rel);
      if (content != null) await replaceFile(file, content);
      else if (found) await fs.rm(file, { force: true }); // removes a link itself, never what it points at
    }
  }

  /** The integration version in a bench or a hub clone: origin/ws/<job>/int when it is there, else HEAD. */
  async function integrationRev(dir) {
    const refs = (await git(dir, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/ws/'], { ok: 'any' })).stdout;
    const found = refs.split('\n').find((ref) => /^refs\/remotes\/origin\/ws\/[^/]+\/int$/.test(ref));
    return (found && (await sha(dir, found))) || (await sha(dir, 'HEAD'));
  }

  /**
   * Before an agy spawn: removes everything under .agents/ that is not in keep and not tracked on the integration
   * branch. A hooks.json that is not in keep is always removed, tracked or not. Links are removed, never followed.
   * @param {string} dir
   * @param {string[]} keep  paths like '.agents/mcp_config.json' (the files the hub just wrote)
   * @returns {Promise<string[]>} removed paths, sorted
   */
  async function cleanAgentDir(dir, keep) {
    const root = path.join(dir, '.agents');
    const top = await fs.lstat(root).catch(() => null);
    if (!top) return [];
    if (!top.isDirectory()) {
      await fs.rm(root, { force: true });
      return ['.agents'];
    }
    const keepSet = new Set(toList(keep).map((name) => path.posix.normalize(String(name).replaceAll('\\', '/')).replace(/^(?:\.\/)+/, '')));
    // path -> { mode, id } of the integration version. Read in the canonical repo when the folder is in the work area:
    // the refs and objects of the folder itself are the agent's to change.
    const tracked = new Map();
    const trusted = await trustedIntegration(dir);
    const source = trusted ? trusted.repo : (await exists(path.join(dir, '.git'))) ? dir : null;
    const rev = trusted ? await sha(trusted.repo, trusted.ref) : source ? await integrationRev(dir).catch(() => null) : null;
    if (rev) {
      for (const entry of zlist((await git(source, ['ls-tree', '-r', '-z', '--full-tree', rev], { timeoutMs: timeouts.long })).stdout)) {
        const tab = entry.indexOf('\t');
        const [mode, , id] = entry.slice(0, tab).split(' ');
        const rel = entry.slice(tab + 1);
        if (rel.split('/')[0].toLowerCase() === '.agents') tracked.set(`.agents${rel.slice('.agents'.length)}`, { mode, id });
      }
    }
    /** Git's object id of a file's bytes (sha1 or sha256, as the repo uses). */
    const blobId = (bytes, like) => createHash(like.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    const removed = [];
    const walk = async (folder, rel) => {
      let left = 0;
      for (const item of await fs.readdir(folder, { withFileTypes: true })) {
        const name = `${rel}/${item.name}`;
        const full = path.join(folder, item.name);
        if (item.isDirectory()) {
          if (await walk(full, name)) left += 1;
          else await fs.rmdir(full).catch(noop); // nothing kept inside: the empty folder goes too
          continue;
        }
        const want = item.name === 'hooks.json' ? null : tracked.get(name);
        if (keepSet.has(name)) { left += 1; continue; }
        if (want && want.mode === '120000' && item.isSymbolicLink()) { // a tracked link: kept only with the tracked target
          const target = await fs.readlink(full).catch(() => null);
          if (target !== null && blobId(Buffer.from(target), want.id) === want.id) { left += 1; continue; }
        } else if (want && /^100[0-9]{3}$/.test(want.mode) && item.isFile()) { // a tracked file: kept only with the tracked content
          const stat = await fs.lstat(full);
          if (stat.size <= 8 * MB && blobId(await fs.readFile(full), want.id) === want.id) { left += 1; continue; }
        }
        await fs.rm(full, { force: true }); // a link is removed itself, never followed
        removed.push(name);
        if (want && /^100[0-9]{3}$/.test(want.mode)) { // an agent changed a tracked file: the integration version comes back
          const bytes = (await git(source, ['cat-file', 'blob', want.id], { buffer: true, timeoutMs: timeouts.long })).stdout;
          await replaceFile(full, bytes);
          if (want.mode === '100755') await fs.chmod(full, 0o755);
          left += 1;
        }
      }
      return left;
    };
    await walk(root, '.agents');
    return removed.sort();
  }

  /**
   * Merges the target branch into a new bench (catch-up task). A conflict stays in the bench as markers, on record
   * like a conflict of syncBench, so unresolved() lists the files and the next hand-in concludes the merge.
   */
  async function mergeTargetInto(dir, project) {
    const target = project.targetBranch;
    const remote = `origin/${target}`;
    await git(dir, ['fetch', '-q', '--no-tags', '--no-prune', '--no-recurse-submodules', 'origin',
      `+refs/heads/${target}:refs/remotes/${remote}`], { timeoutMs: timeouts.long });
    if (await isAncestor(dir, `refs/remotes/${remote}`, 'HEAD')) return;
    await patchMeta(dir, { target: `refs/remotes/${remote}` }); // the guard tells the owner's content from the maker's
    const title = `Merge ${target} into ${WORK}`;
    const merge = await git(dir, ['merge', '-q', '--no-ff', '--no-log', ...MERGE_QUIET, '-m', title, remote], { ok: 'any', timeoutMs: timeouts.long });
    if (merge.code === 0) return;
    const conflicts = (await unmergedPaths(dir)).sort();
    if (!conflicts.length || !(await sha(dir, 'MERGE_HEAD'))) throw gitError(dir, ['merge', remote], { code: merge.code }, merge.stderr);
    const record = Object.create(null);
    for (const rel of conflicts) record[rel] = keptMarkers(await fileMarkers(path.join(dir, rel), remote));
    await patchMeta(dir, { conflicts: record, pendingMerge: true });
    log('info', 'catch-up bench starts with conflicts', { dir, conflicts });
  }

  /**
   * Creates the bench for a task: git clone --local of the canonical repo at the integration head,
   * on a new branch "work". Sets up the exclude file, writes the .shop files, runs project.setupCmd
   * once and records the base. An existing bench (restart) is reused; its work is never touched.
   * A folder that is a clone of another repository is not this bench: it is moved aside to
   * "<task>.stale-<time>" and a new bench is made.
   * @param {object} project
   * @param {string} jobId
   * @param {string} taskId
   * With mergeTarget the new bench starts with the merge of the target branch in place (a catch-up task):
   * conflict markers stay for the maker, and unresolved() lists them.
   * @param {{files?:object, authorName?:string, setup?:boolean, setupTimeoutMs?:number, mergeTarget?:boolean}} [options]
   * @returns {Promise<{dir:string, baseSha:string, setup:{ok:boolean, code:number, tail:string}|null}>} setup: result of setupCmd when it ran now
   */
  async function createBench(project, jobId, taskId, options) {
    const { files, authorName, setup = true, setupTimeoutMs = timeouts.setup, mergeTarget = false } = options ?? {};
    const repo = repoOf(project);
    const integrationBranch = intBranch(jobId);
    const dir = path.join(jobDir(jobId), checkId(taskId, 'task'));
    return withLock(dirKey(dir), async () => {
      let meta = null;
      let made = false;
      const gitDir = await fs.lstat(path.join(dir, '.git')).catch(() => null);
      if (gitDir) {
        const read = await git(dir, ['config', '-f', path.join(dir, '.git', 'config'), '--get', 'remote.origin.url'], { ok: 'any' }).catch(() => null);
        const origin = gitDir.isDirectory() ? (read?.stdout ?? '').trim() : '(not a git folder)';
        const real = (place) => fs.realpath(place).catch(() => path.resolve(place));
        if (!gitDir.isDirectory() || (origin && (await real(origin)) !== (await real(repo)))) {
          // A clone of another repository is in the way (the ids were used before, for another project).
          // It is not this task's bench: keep it, out of the way, and make a new bench.
          const aside = `${dir}.stale-${Date.now()}`;
          await fs.rename(dir, aside);
          log('warn', 'the bench folder held a clone of another repository; moved it aside', { dir, aside, origin });
        } else {
          origins.set(path.resolve(dir), repo);
          await secureBench(dir, authorName || undefined);
          meta = await benchInfo(dir);
          await writeExclude(dir);
        }
      }
      if (!meta) {
        if (!(await sha(repo, `refs/heads/${integrationBranch}`))) {
          throw new Error(`Integration branch ${integrationBranch} not found in ${repo}. Call startJob first.`);
        }
        const tmp = path.join(path.dirname(dir), `.${taskId}.tmp`);
        await fs.rm(dir, { recursive: true, force: true });
        await fs.rm(tmp, { recursive: true, force: true });
        await fs.mkdir(path.dirname(dir), { recursive: true });
        try {
          // --template= : no hooks get installed. The bench config keeps the agent's own git use free of the
          // owner's hooks, signing, identity and file-watch daemon, and blocks pushes: only the hub moves work out.
          const clone = () => git(path.dirname(dir), [
            'clone', '-q', '--local', '--single-branch', '--branch', integrationBranch, '--origin', 'origin', '--template=',
            '--config', 'core.hooksPath=/dev/null', '--config', 'core.fsmonitor=false', '--config', 'commit.gpgsign=false',
            '--config', `user.name=${cleanName(authorName)}`, '--config', `user.email=${AGENT_EMAIL}`,
            '--config', `remote.origin.pushurl=${NO_PUSH}`, '--', repo, tmp,
          ], { timeoutMs: timeouts.long });
          try {
            await clone();
          } catch (err) {
            // A local clone links the object files of the repo. Another git process that writes objects there at
            // the same moment can make one link fail. That is a race, not a broken repo: try once more.
            if (!/failed to (create link|copy file)/.test(String(err?.message ?? err))) throw err;
            log('info', 'bench clone met a moving object file; trying again', { dir });
            await fs.rm(tmp, { recursive: true, force: true });
            await clone();
          }
          await git(tmp, ['branch', '-m', WORK]);
          await writeConfig(tmp, { origin: repo, integrationBranch, branch: WORK, userName: authorName });
          await writeExclude(tmp);
          const baseSha = await sha(tmp, 'HEAD');
          meta = { v: 1, jobId, taskId, integrationBranch, origin: repo, baseSha, createdAt: Date.now(), setup: null, conflicts: null };
          await saveMeta(tmp, meta);
          await fs.rename(tmp, dir); // the bench appears complete or not at all
        } catch (err) {
          await fs.rm(tmp, { recursive: true, force: true }).catch(noop);
          throw err;
        }
        origins.set(path.resolve(dir), repo);
        made = true;
        log('info', 'bench created', { dir, baseSha: meta.baseSha });
      }
      // A reused bench without work of its own gets the merge too: the hub may have stopped right after the clone.
      const fresh = made || ((await sha(dir, 'HEAD')) === meta.baseSha && !(await sha(dir, 'MERGE_HEAD')));
      if (mergeTarget && fresh) await mergeTargetInto(dir, project);
      await writeHubFiles(dir, files);
      let setupResult = null;
      const setupCmd = String(project.setupCmd ?? '').trim();
      if (setup && setupCmd && !meta.setup) {
        setupResult = await runSetup(dir, setupCmd, { timeoutMs: setupTimeoutMs });
        await saveMeta(dir, { ...(await benchInfo(dir)), setup: { cmd: setupCmd, ok: setupResult.ok, code: setupResult.code, at: Date.now() } });
        if (!setupResult.ok) log('warn', 'bench setup command failed', { dir, code: setupResult.code });
      }
      return { dir, baseSha: meta.baseSha, setup: setupResult };
    });
  }

  /**
   * Commits everything in the bench except .shop/, as the agent. Works when the agent committed some
   * or all of its work itself. While a merge is in progress it concludes the merge, but only when no
   * conflict markers are left.
   * Rejects with a message for the maker when conflict markers of a stash pop or cherry-pick are
   * left, and when a folder of the bench is a git repository of its own (err.code 'E_NESTED_REPO').
   * Rejects for a folder that is not a bench: the owner's repository is never committed to.
   * @returns {Promise<string|null>} the new commit sha, or null when nothing was committed
   */
  async function commitAll(benchDir, message, authorName) {
    await needBench(benchDir);
    return withLock(dirKey(benchDir), async () => {
      const ident = { name: cleanName(authorName), email: AGENT_EMAIL };
      const title = String(message ?? '').trim() || 'WorkShop: save work';
      await secureBench(benchDir);
      await healMerge(benchDir);
      if (await sha(benchDir, 'MERGE_HEAD')) {
        const done = await concludeMerge(benchDir, title, ident);
        return done.ok ? done.sha : null;
      }
      await ensureOnWork(benchDir);
      // Conflicts of a stash pop or cherry-pick: never commit their markers.
      const stuck = await markedFiles(benchDir, new Map((await unmergedPaths(benchDir)).map((rel) => [rel, undefined])));
      if (stuck.length) throw new Error(`Conflict markers are left in: ${stuck.join(', ')}. Resolve them, then hand in again.`);
      await stageAll(benchDir);
      const clean = await git(benchDir, [...DIFF, '--cached', '--quiet'], { ok: [0, 1] });
      if (clean.code === 0) return null;
      await git(benchDir, ['commit', '-q', '-m', title], { ident, timeoutMs: timeouts.long });
      return sha(benchDir, 'HEAD');
    });
  }

  /**
   * Files the bench changed since it forked from baseRef: committed, uncommitted and untracked work
   * (deleted and renamed-away paths included). Use baseRef(benchDir) so that work merged in from the
   * integration branch does not count.
   * @returns {Promise<string[]>} sorted repo-relative paths
   */
  async function changedFiles(benchDir, baseRef) {
    if (await isBenchPlace(benchDir)) await needBench(benchDir).then(() => secureBench(benchDir));
    const base = await forkBase(benchDir, baseRef ?? benchBaseRef(benchDir), 'HEAD', true);
    const tracked = zlist((await git(benchDir, [...DIFF, '--name-only', '--no-renames', '-z', base, '--'], { timeoutMs: timeouts.long })).stdout);
    const untracked = zlist((await git(benchDir, ['ls-files', '--others', '--exclude-standard', '-z'], { timeoutMs: timeouts.long })).stdout);
    return [...new Set([...tracked, ...untracked])].filter((rel) => !isHubPath(rel)).sort(); // hub paths are never committed, so never a change
  }

  /**
   * Brings the integration head into the bench: fetch from origin, merge into "work".
   * A merge left in progress by an earlier conflict is concluded first; that fails while markers remain.
   * A merge that was cut off (git stopped, hub down) is never concluded: it is undone and done again.
   * Rejects when git refuses the merge (uncommitted files in the way) and for a folder that is not a bench.
   * @returns {Promise<{ok:true, head:string, merged:boolean}|{ok:false, conflicts:string[]}>}
   */
  async function syncBench(benchDir) {
    await needBench(benchDir);
    return withLock(dirKey(benchDir), async () => {
      await secureBench(benchDir);
      await healMerge(benchDir);
      const info = await benchInfo(benchDir);
      const remote = `origin/${info.integrationBranch}`;
      const title = `Merge ${info.integrationBranch} into ${WORK}`;
      let merged = Boolean(info.pendingMerge); // a conflicted merge was concluded since the last good sync
      if (await sha(benchDir, 'MERGE_HEAD')) {
        const done = await concludeMerge(benchDir, title, HUB);
        if (!done.ok) return { ok: false, conflicts: done.conflicts };
        merged = true;
      } else if (info.conflicts) {
        // The agent ended the merge itself. The files that were conflicted must still be free of markers.
        const left = await markedFiles(benchDir, new Map(Object.entries(info.conflicts)));
        if (left.length) return { ok: false, conflicts: left };
      }
      await ensureOnWork(benchDir);
      await git(benchDir, ['fetch', '-q', '--no-tags', '--no-prune', '--no-recurse-submodules', 'origin',
        `+refs/heads/${info.integrationBranch}:refs/remotes/${remote}`], { timeoutMs: timeouts.long });
      const before = await sha(benchDir, 'HEAD');
      const theirs = await sha(benchDir, `refs/remotes/${remote}`);
      if (before && theirs && (await isAncestor(benchDir, theirs, before))) { // nothing new on the integration branch
        await patchMeta(benchDir, { conflicts: null, pendingMerge: null });
        return { ok: true, head: before, merged };
      }
      // On record until git comes back: a merge that is cut off half-way must never pass for a finished one (see healMerge).
      await patchMeta(benchDir, { merging: { head: before, to: theirs } });
      let merge;
      try {
        merge = await git(benchDir, ['merge', '-q', '--ff', ...MERGE_QUIET, '-m', title, remote], { ok: 'any', timeoutMs: timeouts.long });
      } catch (err) { // git was stopped, or did not start
        await healMerge(benchDir).catch(noop); // not possible now (a lock is left): the next call does it
        throw err;
      }
      if (merge.code !== 0) {
        const conflicts = (await unmergedPaths(benchDir)).sort();
        if (conflicts.length && (await sha(benchDir, 'MERGE_HEAD'))) {
          const record = Object.create(null);
          for (const rel of conflicts) record[rel] = keptMarkers(await fileMarkers(path.join(benchDir, rel), remote));
          await patchMeta(benchDir, { conflicts: record, pendingMerge: true, merging: null });
          log('info', 'bench sync hit conflicts', { benchDir, conflicts });
          return { ok: false, conflicts };
        }
        await healMerge(benchDir).catch(noop); // git refused, or failed half-way: no merge stays open
        throw gitError(benchDir, ['merge', remote], { code: merge.code }, merge.stderr);
      }
      const head = await sha(benchDir, 'HEAD');
      await patchMeta(benchDir, { conflicts: null, pendingMerge: null, merging: null });
      return { ok: true, head, merged: merged || head !== before };
    });
  }

  /** Real path of a folder that may not exist yet (the part that exists is resolved). */
  async function realish(place) {
    const abs = path.resolve(place);
    const real = await fs.realpath(abs).catch(() => null);
    if (real) return real;
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(await realish(parent), path.basename(abs));
  }

  /**
   * The hub sandbox profile (sandbox-exec, SBPL) for a setup or check command. Paths go in as -D parameters, never into
   * the profile text. Writes: the folder, the private temp dir and the package caches. No read of the deny-read list.
   * Keychain services are closed. Network: everything for setup, localhost only for check.
   */
  async function sandboxArgs(kind, dir, tmp, { protectGit = false } = {}) {
    const defs = [];
    const param = (value) => {
      const key = `P${defs.length / 2}`;
      defs.push('-D', `${key}=${value}`);
      return `(param "${key}")`;
    };
    const homes = [...new Set([baseEnv().HOME, (() => { try { return os.userInfo().homedir; } catch { return null; } })()]
      .filter((home) => typeof home === 'string' && path.isAbsolute(home)))];
    const realHomes = await Promise.all(homes.map(realish));
    const writable = [dir, tmp, ...(realHomes[0] ? await Promise.all(CACHE_DIRS.map((rel) => realish(path.join(realHomes[0], rel)))) : [])];
    const hubDirs = ['run', 'logs', 'config'].map((key) => paths?.[key]).filter((place) => typeof place === 'string' && place);
    const denied = [...realHomes.flatMap((home) => DENY_READ.map((rel) => path.join(home, rel))), ...(await Promise.all(hubDirs.map(realish)))];
    const lines = [
      '(version 1)',
      '(allow default)',
      '(deny file-write*)',
      `(allow file-write* ${writable.map((place) => `(subpath ${param(place)})`).join(' ')}`
        + ' (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper")'
        + ' (regex #"^/dev/fd/[0-9]+$") (regex #"^/dev/ttys[0-9]+$"))',
      denied.length ? `(deny file-read* file-write* ${denied.map((place) => `(subpath ${param(place)})`).join(' ')})` : '',
      // A folder whose .git the hub does not rewrite before its own git runs there (the canonical repo, toolkit
      // "Run checks"): a filter or hook path written into it would run in the hub, outside the sandbox.
      protectGit ? `(deny file-write* (subpath ${param(path.join(dir, '.git'))}))` : '',
      '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.secd"))',
      // No way out through another process that is not in the sandbox: Launch Services (open), Apple Events
      // (osascript) and launchd jobs (launchctl).
      '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.coreservices.appleevents")'
        + ' (global-name "com.apple.lsd.open") (global-name "com.apple.lsd.modifydb"))',
      '(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/bin/launchctl")'
        + ' (literal "/usr/bin/automator") (literal "/usr/bin/shortcuts"))',
    ];
    if (kind === 'check') {
      lines.push('(deny network-outbound)', '(allow network-outbound (remote ip "localhost:*"))',
        '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
        `(allow network-outbound (remote unix-socket (subpath ${param(dir)})) (remote unix-socket (subpath ${param(tmp)})))`);
    }
    return [...defs, '-p', lines.join('\n')];
  }

  /**
   * Runs a setup or check command with /bin/sh -c in dir. Output of stdout and stderr is combined.
   * Environment: the allow list only (HOME USER LOGNAME SHELL TERM LANG TMPDIR PATH). In safety 'sandboxed' the
   * command runs under sandbox-exec with the hub profile of its kind and a private temp dir; when sandbox-exec is
   * missing the command does not run. On timeout the whole process group is killed: code 124, and the tail ends
   * with a "[stopped: ...]" line. The tail is redacted. Never rejects.
   * options.onOutput(text): the output as it comes, in whole lines, redacted (the toolkit streams it). It stops after
   * options.maxStreamChars (default 200 KB) with one "[output cut ...]" line. options.tailChars: the size of the
   * returned tail (default 4000, at most 200 KB).
   */
  async function runCommand(kind, dir, cmd, options) {
    const timeoutMs = options?.timeoutMs; // options may be missing or null: this function never throws
    const fallback = kind === 'setup' ? timeouts.setup : checkTimeoutMs();
    const limitMs = Math.min(Number(timeoutMs) > 0 ? Number(timeoutMs) : fallback, 2 ** 31 - 1); // a missing or broken value is not "no time at all"
    const command = String(cmd ?? '').trim();
    if (!command) return { ok: true, code: 0, tail: '' };
    if (typeof dir !== 'string' || !dir) { // never fall back to the hub's own folder
      return { ok: false, code: -1, tail: '[could not start: no folder given]\n' };
    }
    let file = '/bin/sh';
    let args = ['-c', command];
    let tmp = null;
    if (sandboxed()) {
      try {
        await fs.access(SANDBOX_EXEC, fs.constants.X_OK);
        tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ws-cmd-')));
        const protectGit = !(await isHubFolder(dir).catch(() => false)); // no work area known: not a hub folder
        args = [...(await sandboxArgs(kind, await realish(dir), tmp, { protectGit })), '/bin/sh', '-c', command];
        file = SANDBOX_EXEC;
      } catch (err) {
        if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(noop);
        log('warn', 'sandboxed command not started', { dir, kind, error: err.message });
        return { ok: false, code: -1, tail: `[could not start: the sandbox is not available (${err.code ?? err.message})]\n` };
      }
    }
    const tailChars = Math.min(Number(options?.tailChars) > 0 ? Math.floor(Number(options.tailChars)) : TAIL_CHARS, STREAM_CHARS);
    const stream = typeof options?.onOutput === 'function' ? lineStream(options.onOutput, Number(options?.maxStreamChars) > 0 ? Number(options.maxStreamChars) : STREAM_CHARS) : null;
    const result = await spawnCommand(dir, file, args, commandEnv(tmp), limitMs, { tailChars, onData: stream?.push });
    stream?.end();
    if (tmp) await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(noop);
    return { ...result, tail: redact(result.tail) };
  }

  /** Whole lines of output to fn(text), redacted, at most maxChars in all. */
  function lineStream(fn, maxChars) {
    const decoder = new StringDecoder('utf8'); // a character split across two chunks stays whole
    let pending = '';
    let sent = 0;
    let cut = false;
    const send = (text) => {
      if (cut || !text) return;
      if (sent + text.length > maxChars) {
        text = `${text.slice(0, Math.max(0, maxChars - sent))}\n[output cut after ${maxChars} characters]\n`;
        cut = true;
      }
      sent += text.length;
      try { fn(text); } catch (err) { log('warn', 'command output listener failed', { error: err.message }); }
    };
    return {
      push(chunk) {
        pending += decoder.write(chunk);
        const at = pending.lastIndexOf('\n');
        if (at < 0) {
          if (pending.length > 64 * 1024) { send(redact(pending)); pending = ''; }
          return;
        }
        send(redact(pending.slice(0, at + 1)));
        pending = pending.slice(at + 1);
      },
      end() {
        pending += decoder.end();
        if (pending) send(redact(pending));
        pending = '';
      },
    };
  }

  /** One command process in its own group; see runCommand. */
  function spawnCommand(dir, file, args, childEnv, limitMs, { tailChars = TAIL_CHARS, onData = null } = {}) {
    return new Promise((resolve) => {
      const output = tailBuffer(tailChars * 4);
      const started = Date.now();
      let child = null;
      let timer = null;
      let grace = null;
      let timedOut = false;
      let settled = false;
      const killGroup = () => {
        if (!(child?.pid > 1)) return; // never started: there is no group to signal
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is already gone */ }
      };
      const finish = (exitCode, signal, note) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        runningChecks.delete(killGroup);
        let code = typeof exitCode === 'number' ? exitCode : signal ? 128 + (os.constants.signals[signal] ?? 0) : -1;
        if (timedOut) {
          code = 124;
          note = `stopped: no result after ${Math.round(limitMs / 1000)} s`;
        }
        const tail = `${output.text(tailChars)}${note ? `\n[${note}]\n` : ''}`.slice(-tailChars);
        log(code === 0 ? 'debug' : 'info', 'check finished', { dir, code, timedOut, ms: Date.now() - started });
        resolve({ ok: code === 0, code, tail });
      };
      try {
        child = spawn(file, args, { cwd: dir, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        finish(-1, null, `could not start: ${err.message}`);
        return;
      }
      runningChecks.add(killGroup);
      timer = setTimeout(() => { timedOut = true; killGroup(); }, limitMs);
      for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', output.push);
        if (onData) stream.on('data', onData);
        stream.on('error', noop); // a broken pipe must not take the hub down
      }
      child.on('error', (err) => finish(-1, null, `could not start: ${err.message}`));
      child.on('exit', (exitCode, signal) => {
        killGroup(); // children the command left behind would keep the pipes open, and leak
        grace = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(exitCode, signal);
        }, 2000);
      });
      child.on('close', (exitCode, signal) => finish(exitCode, signal));
    });
  }

  /**
   * Runs a check command (checkCmd, the toolkit's "Run checks") in dir: sandbox profile 'check' in safety 'sandboxed'.
   * Timeout: options.timeoutMs, else limits.checkTimeoutMin. Works in any folder: a bench, a clone, the project folder.
   * @param {string} dir
   * @param {string|null} cmd  null or empty: nothing to run, ok
   * @param {{timeoutMs?:number, onOutput?:(text:string)=>void, tailChars?:number, maxStreamChars?:number}} [options]
   * @returns {Promise<{ok:boolean, code:number, tail:string}>} tail: last 4000 chars (or tailChars), redacted
   */
  function runCheck(dir, cmd, options) {
    return runCommand('check', dir, cmd, options);
  }

  /**
   * Runs a setup command (setupCmd) in dir: sandbox profile 'setup' (full network) in safety 'sandboxed', fixed timeout
   * of 15 min unless options.timeoutMs. Then puts back every tracked file the command changed (git checkout -- .),
   * so a rewritten lockfile never ends up in a delivery. Ignored and new files stay.
   * @returns {Promise<{ok:boolean, code:number, tail:string}>}
   */
  async function runSetup(dir, cmd, options) {
    const result = await runCommand('setup', dir, cmd, options);
    if (!String(cmd ?? '').trim() || typeof dir !== 'string' || !dir) return result;
    try {
      if (await exists(path.join(dir, '.git'))) {
        // The command could write .git/config (a filter, a hook path): the hub's git must never run what it put there.
        let safe = true;
        if (await isBenchPlace(dir)) await needBench(dir).then(() => secureBench(dir));
        else if (await isHubFolder(dir)) safe = await secureClone(dir);
        if (safe) await git(dir, ['checkout', '-q', '--', '.'], { ok: 'any', timeoutMs: timeouts.long });
        else log('warn', 'tracked files not restored after setup: the clone has no hub record', { dir });
      }
    } catch (err) {
      log('warn', 'could not restore tracked files after setup', { dir, error: err.message });
    }
    return result;
  }

  /**
   * Size of the committed work of a bench on top of baseRef (three-dot: from the fork point to HEAD).
   * @returns {Promise<{files:{path:string, add:number, del:number, binary?:boolean}[], add:number, del:number}>}
   */
  async function diffStat(benchDir, baseRef) {
    if (await isBenchPlace(benchDir)) await needBench(benchDir).then(() => secureBench(benchDir));
    const head = await sha(benchDir, 'HEAD');
    return numstat(benchDir, await forkBase(benchDir, baseRef ?? benchBaseRef(benchDir), head), head);
  }

  /**
   * Unified diff of what head adds on top of base (three-dot: from their fork point to head).
   * Binary files are named, not dumped. Output over maxBytes (default 200 kB) is cut, with a last line
   * that says how many bytes are missing. At most 32 MB is read: past that the line says "more than".
   * @param {string} dir
   * @param {{base:string, head?:string, path?:string|string[], maxBytes?:number}} options
   * @returns {Promise<string>}
   */
  async function diff(dir, options) {
    const { base, head, path: only, maxBytes } = options ?? {};
    if (!base) throw new TypeError('diff needs a base revision');
    const to = await sha(dir, head ?? 'HEAD');
    if (!to) throw new Error(`Unknown revision "${head}" in ${dir}`);
    const from = await forkBase(dir, base, to);
    const wanted = maxBytes == null || maxBytes === '' ? DIFF_DEFAULT_BYTES : Number(maxBytes); // a query string value is fine
    const limit = wanted === Infinity ? DIFF_CAP : wanted >= 0 ? Math.floor(wanted) : DIFF_DEFAULT_BYTES;
    const files = toList(only).filter((file) => typeof file === 'string' && file !== '');
    const args = [...DIFF, '--no-color', '-M', '--unified=3', '--src-prefix=a/', '--dst-prefix=b/', from, to, '--', ...files];
    const out = await git(dir, args, { buffer: true, maxBuffer: DIFF_CAP, overflowOk: true, timeoutMs: timeouts.long });
    const bytes = out.stdout;
    if (bytes.length <= limit && !out.overflow) return bytes.toString('utf8');
    let cut = Math.min(limit, bytes.length);
    const lineEnd = cut > 0 ? bytes.lastIndexOf(10, cut - 1) : -1;
    if (lineEnd >= 0 && lineEnd >= cut - 4096) cut = lineEnd + 1; // end on a whole line when one is near
    else while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut -= 1; // never split a UTF-8 character
    const kept = bytes.toString('utf8', 0, cut);
    const gap = !kept || kept.endsWith('\n') ? '' : '\n';
    return `${kept}${gap}[diff truncated: ${out.overflow ? 'more than ' : ''}${bytes.length - cut} bytes cut]\n`;
  }

  /* ---------- integrate, truck, ship ---------- */

  /**
   * Merges a bench into the integration branch. Serial per project.
   * Invariant: the bench head must already contain the current integration head, else 'stale'.
   * Then: fetch bench "work" into canonical as ws/<jobId>/<taskId>, merge it --no-ff in _int.
   * A repeated call for a bench head that is already merged returns the same merge (already: true).
   * A bench without commits of its own merges nothing: mergeSha is the integration head (empty: true).
   * @param {object} project
   * @param {string} jobId
   * @param {string} taskId
   * @param {string} benchDir
   * @param {string} message  merge commit message
   * @param {{expectHead?:string}} [options]  expectHead: the bench head that passed checks; another head is 'stale'
   * @returns {Promise<{ok:true, mergeSha:string, empty?:boolean, already?:boolean}|{ok:false, reason:'stale'|'conflict'|'error', detail:string}>}
   */
  async function integrate(project, jobId, taskId, benchDir, message, options) {
    const refuse = (reason, detail) => {
      log(reason === 'error' ? 'warn' : 'info', 'integrate refused', { jobId, taskId, reason, detail });
      return { ok: false, reason, detail };
    };
    try {
      const expectHead = options?.expectHead; // options may be missing or null: this function never rejects
      const repo = repoOf(project);
      const intRef = `refs/heads/${intBranch(jobId)}`;
      const taskRef = taskRefOf(jobId, taskId);
      return await withLock(repoKey(repo), () => withLock(dirKey(benchDir), async () => {
        if (await isBenchPlace(benchDir)) {
          await needBench(benchDir);
          origins.set(path.resolve(benchDir), repo);
          await secureBench(benchDir);
        }
        const { integrationDir } = await ensureIntegration(project, jobId);
        const intSha = await sha(repo, intRef);
        const benchHead = await sha(benchDir, `refs/heads/${WORK}`);
        if (!benchHead) return refuse('error', `The bench ${benchDir} has no branch "${WORK}".`);
        // Merged by an earlier call, but the hub stopped before it could record that: give the same answer.
        const since = await git(repo, ['rev-list', '--first-parent', '--parents', `${benchHead}..${intSha}`], { ok: 'any' });
        const earlier = since.code === 0 && since.stdout.split('\n').map((line) => line.split(' ')).find((commit) => commit[2] === benchHead);
        if (earlier) return { ok: true, mergeSha: earlier[0], already: true };
        if (expectHead && expectHead !== benchHead) return refuse('stale', `The bench head is ${benchHead}, not the checked ${expectHead}.`);
        if (!(await isAncestor(benchDir, intSha, benchHead, true))) {
          return refuse('stale', `The bench does not contain the integration head ${intSha}. Sync the bench, run the checks, then integrate.`);
        }
        await git(repo, ['fetch', '-q', '--no-tags', '--no-prune', '--no-recurse-submodules', '--no-write-fetch-head', '--',
          path.resolve(benchDir), `+refs/heads/${WORK}:${taskRef}`], { timeoutMs: timeouts.long });
        const taskSha = await sha(repo, taskRef);
        if (taskSha !== benchHead || !(await isAncestor(repo, intSha, taskSha))) {
          return refuse('stale', 'The bench changed during integration. Sync and check it again.');
        }
        // Nothing to merge. No empty commit either: it would make every other bench stale.
        if (taskSha === intSha) return { ok: true, mergeSha: intSha, empty: true };
        await resetIntegration(integrationDir);
        const title = String(message ?? '').trim() || `Merge ${taskId}`;
        const mergeArgs = ['merge', '-q', '--no-ff', '--no-log', ...MERGE_QUIET, '-m', title, taskSha];
        const merge = await git(integrationDir, mergeArgs, { ok: 'any', timeoutMs: timeouts.long });
        if (merge.code !== 0) {
          const conflicts = await unmergedPaths(integrationDir).catch(() => []);
          await resetIntegration(integrationDir).catch(noop);
          if (conflicts.length) return refuse('conflict', conflicts.join('\n'));
          return refuse('error', gitText(merge.stderr) || `git merge failed (exit ${merge.code})`);
        }
        const mergeSha = await sha(integrationDir, 'HEAD');
        log('info', 'integrated', { jobId, taskId, mergeSha });
        return { ok: true, mergeSha };
      }));
    } catch (err) {
      return refuse('error', err.message);
    }
  }

  /**
   * What waits on the truck: commits and files on the integration branch that the target branch lacks.
   * behind > 0 means the target moved, so a ship will be refused.
   * @returns {Promise<{ahead:number, behind:number, files:{path:string, add:number, del:number}[], add:number, del:number}>}
   */
  async function truck(project, jobId) {
    const repo = repoOf(project);
    const target = await sha(repo, `refs/heads/${project.targetBranch}`);
    const head = await sha(repo, `refs/heads/${intBranch(jobId)}`);
    if (!target) throw new Error(`Target branch "${project.targetBranch}" not found in ${repo}`);
    if (!head) throw new Error(`Integration branch ${intBranch(jobId)} not found in ${repo}`);
    const [behind, ahead] = (await text(repo, ['rev-list', '--left-right', '--count', `${target}...${head}`])).split(/\s+/).map(Number);
    const stat = await numstat(repo, await forkBase(repo, target, head), head);
    return { headSha: head, ahead, behind, files: stat.files, add: stat.add, del: stat.del };
  }

  /**
   * Is commit goal on the first-parent chain of head (head itself, a delivery merge, a refresh merge, or an older commit
   * of the main line)? The walk from head along first parents stops at the parents of goal, so it stays short.
   */
  async function onFirstParentChain(repo, goal, head) {
    if (goal === head) return true;
    if (!(await isAncestor(repo, goal, head))) return false;
    const parents = (await text(repo, ['rev-list', '--parents', '-n', '1', goal])).split(' ').slice(1);
    const walk = await text(repo, ['rev-list', '--first-parent', head, ...(parents.length ? ['--not', ...parents] : [])], { timeoutMs: timeouts.long });
    return walk.split('\n').includes(goal);
  }

  /** Branches that are checked out in a worktree whose folder exists: Map of full ref name -> folder. */
  async function checkedOut(repo) {
    const found = new Map();
    let dir = null;
    for (const line of (await git(repo, ['worktree', 'list', '--porcelain', '-z'])).stdout.split('\0')) {
      if (line.startsWith('worktree ')) dir = line.slice('worktree '.length);
      if (!line.startsWith('branch ') || !dir) continue;
      const ref = line.slice('branch '.length);
      if (!found.has(ref) && (await exists(dir))) found.set(ref, dir);
    }
    return found;
  }

  /**
   * Owner approved: fast-forwards the target branch to the integration head, or to upToSha
   * (a commit on the integration branch). Never forces. Where the target branch is checked out,
   * git merge --ff-only runs there, and git refuses if local changes are in the way.
   * A target that already holds the commit is a success without changes.
   * @param {object} project
   * @param {string} jobId
   * @param {{sha:string}} options  the exact commit the owner saw: required, on the first-parent chain of the integration head
   * @returns {Promise<{ok:true, sha:string, left:number, already?:boolean}|{ok:false, reason:string}>} left: first-parent merges after sha
   */
  async function ship(project, jobId, options) {
    const refuse = (reason) => {
      log('warn', 'ship refused', { jobId, reason });
      return { ok: false, reason };
    };
    try {
      const wanted = options?.sha; // options may be missing or null: this function never rejects
      const repo = repoOf(project);
      const branch = intBranch(jobId);
      const targetRef = `refs/heads/${project.targetBranch}`;
      if (typeof wanted !== 'string' || !wanted.trim()) return refuse('Ship needs the exact commit to ship (sha). Nothing was changed.');
      // A commit id only: a branch name or "HEAD" would ship whatever is there now, not what the owner saw.
      if (!/^[0-9a-f]{4,64}$/i.test(wanted.trim())) return refuse(`"${wanted.trim().slice(0, 80)}" is not a commit sha. Ship needs the exact commit the owner saw. Nothing was changed.`);
      return await withLock(repoKey(repo), async () => {
        const target = await sha(repo, targetRef);
        if (!target) return refuse(`Target branch "${project.targetBranch}" not found in ${repo}.`);
        const head = await sha(repo, `refs/heads/${branch}`);
        if (!head) return refuse(`Integration branch ${branch} not found in ${repo}.`);
        const goal = await sha(repo, wanted.trim());
        if (!goal) return refuse(`Unknown commit ${wanted}.`);
        if (!(await onFirstParentChain(repo, goal, head))) {
          return refuse(`Commit ${wanted} is not on the integration branch ${branch} (only a delivery or refresh merge on its main line ships).`);
        }
        const left = Number(await text(repo, ['rev-list', '--first-parent', '--merges', '--count', `${goal}..${head}`]));
        if (await isAncestor(repo, goal, target)) return { ok: true, sha: goal, left, already: true };
        if (!(await isAncestor(repo, target, goal))) {
          const extra = await text(repo, ['rev-list', '--count', `${goal}..${target}`]);
          return refuse(`Branch "${project.targetBranch}" moved: it has ${extra} commit(s) that the truck does not have, `
            + 'so it cannot fast-forward. Nothing was changed.');
        }
        const where = (await checkedOut(repo)).get(targetRef) ?? null;
        if (where) {
          const dirty = zlist((await git(where, ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=no', '--ignore-submodules=none'],
            { timeoutMs: timeouts.long })).stdout).map((entry) => entry.slice(3));
          if (dirty.length) {
            return refuse(`The checkout of "${project.targetBranch}" in ${where} has local changes: ${dirty.slice(0, 20).join(', ')}`
              + `${dirty.length > 20 ? ', ...' : ''}. Commit or stash them, then ship again. Nothing was changed.`);
          }
        }
        const move = where
          ? await git(where, ['merge', '-q', '--ff-only', ...MERGE_QUIET, goal], { ok: 'any', timeoutMs: timeouts.long })
          : await git(repo, ['update-ref', '-m', `WorkShop: ship ${jobId}`, targetRef, goal, target], { ok: 'any' });
        if (move.code !== 0) return refuse(gitText(move.stderr) || `git could not fast-forward (exit ${move.code}).`);
        if ((await sha(repo, targetRef)) !== goal) {
          return refuse(`Branch "${project.targetBranch}" did not move: the checkout in ${where ?? repo} changed during the ship. Try again.`);
        }
        log('info', 'shipped', { jobId, sha: goal, branch: project.targetBranch, left });
        return { ok: true, sha: goal, left };
      });
    } catch (err) {
      return refuse(err.message);
    }
  }

  /* ---------- hub clones, reset, saved work ---------- */

  /** Fetches the bench head of a task into canonical as refs/workshop/<job>/<task>. Caller holds the repo lock. */
  async function fetchBenchRef(repo, jobId, taskId, benchDir) {
    if (!(await exists(path.join(benchDir, '.git')))) return null;
    await needBench(benchDir);
    origins.set(path.resolve(benchDir), repo);
    await secureBench(benchDir);
    const ref = taskRefOf(jobId, taskId);
    await git(repo, ['fetch', '-q', '--no-tags', '--no-prune', '--no-recurse-submodules', '--no-write-fetch-head', '--',
      path.resolve(benchDir), `+refs/heads/${WORK}:${ref}`], { timeoutMs: timeouts.long });
    return ref;
  }

  /**
   * A hub clone at one exact commit: made new, or reset when it is there (HEAD moves, untracked files go, ignored files
   * stay). The config is the hub's template, the exclude file holds the hub paths. Caller holds the lock of dir.
   */
  async function cloneAt(project, jobId, dir, rev, { files, stripAgentFiles = false, fetchTarget = false, benchDir = null, taskId = null, pristine = false } = {}) {
    const repo = repoOf(project);
    const integrationBranch = intBranch(jobId);
    const slow = { timeoutMs: timeouts.long };
    let want = await sha(repo, rev);
    if (!want && benchDir && taskId) { // a review clone of work that is still only in the bench
      await withLock(repoKey(repo), () => fetchBenchRef(repo, jobId, taskId, benchDir));
      want = await sha(repo, rev);
    }
    if (!want) throw new Error(`Unknown commit ${rev} in ${repo}`);
    const gitDir = await fs.lstat(path.join(dir, '.git')).catch(() => null);
    let fresh = false;
    if (!gitDir?.isDirectory()) {
      if (!(await sha(repo, `refs/heads/${integrationBranch}`))) throw new Error(`Integration branch ${integrationBranch} not found in ${repo}. Call startJob first.`);
      const tmp = path.join(path.dirname(dir), `.${path.basename(dir)}.tmp`);
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(tmp, { recursive: true, force: true });
      await fs.mkdir(path.dirname(dir), { recursive: true });
      try {
        await git(path.dirname(dir), ['clone', '-q', '--local', '--no-checkout', '--single-branch', '--branch', integrationBranch,
          '--origin', 'origin', '--template=', '--config', 'core.hooksPath=/dev/null', '--config', 'core.fsmonitor=false',
          '--config', `remote.origin.pushurl=${NO_PUSH}`, '--', repo, tmp], slow);
        await fs.rename(tmp, dir);
      } catch (err) {
        await fs.rm(tmp, { recursive: true, force: true }).catch(noop);
        throw err;
      }
      fresh = true;
    }
    await writeConfig(dir, { origin: repo, integrationBranch, userName: 'Reviewer' });
    await writeExclude(dir);
    const refspecs = [`+refs/heads/${integrationBranch}:refs/remotes/origin/${integrationBranch}`, `+refs/workshop/${jobId}/*:refs/remotes/origin/workshop/*`];
    if (fetchTarget) refspecs.push(`+refs/heads/${project.targetBranch}:refs/remotes/origin/${project.targetBranch}`);
    await git(dir, ['fetch', '-q', '--no-tags', '--prune', '--no-recurse-submodules', 'origin', ...refspecs], slow);
    if (!(await sha(dir, want))) await git(dir, ['fetch', '-q', '--no-tags', '--no-recurse-submodules', 'origin', want], { ...slow, ok: 'any' });
    if (!(await sha(dir, want))) throw new Error(`Commit ${want} cannot be fetched into ${dir}`);
    if (!fresh) {
      // files an earlier strip hid: make git look at them again, so the reset brings them back
      const hidden = zlist((await git(dir, ['ls-files', '-v', '-z'], slow)).stdout).filter((entry) => entry.startsWith('S ')).map((entry) => entry.slice(2));
      for (let i = 0; i < hidden.length; i += 200) await git(dir, ['update-index', '-q', '--no-skip-worktree', '--', ...hidden.slice(i, i + 200)]);
      await git(dir, ['reset', '-q', '--hard'], { ...slow, ok: 'any' }); // also ends a merge an agent started here
    }
    await git(dir, ['checkout', '-q', '-f', '--detach', want], slow);
    await git(dir, ['clean', '-q', '-f', '-f', '-d', ...(pristine ? ['-x'] : [])], slow); // pristine: ignored files of an earlier run go too
    if (stripAgentFiles) {
      const tracked = zlist((await git(dir, ['ls-files', '-z'], slow)).stdout).filter(isAgentFile);
      for (let i = 0; i < tracked.length; i += 200) await git(dir, ['update-index', '-q', '--skip-worktree', '--', ...tracked.slice(i, i + 200)]);
      for (const rel of [...new Set([...tracked, '.agents', '.claude', '.mcp.json', 'GEMINI.md', 'AGENTS.md', 'CLAUDE.md'])]) {
        await fs.rm(path.join(dir, rel), { recursive: true, force: true });
      }
    }
    await writeHubFiles(dir, files);
    return { dir };
  }

  /**
   * Makes (or resets) a hub clone at one exact commit for a reviewer, a desk, the head check or the owner's preview.
   * A review clone ('<task>.rev') of work that is not in canonical yet first fetches the bench into
   * refs/workshop/<job>/<task>. stripAgentFiles removes .agents/, .claude/, GEMINI.md, AGENTS.md, CLAUDE.md and .mcp.json
   * from the working tree (git status stays clean).
   * @param {object} project
   * @param {string} jobId
   * @param {string} name  '<task>.rev' | '_desk/<handle>' | '_head' | '_preview'
   * @param {string} rev   commit
   * @param {{files?:object, stripAgentFiles?:boolean}} [options]
   * @returns {Promise<{dir:string}>}
   */
  async function makeClone(project, jobId, name, rev, options) {
    repoOf(project);
    const label = String(name ?? '');
    if (!CLONE_NAME.test(label) || /^int\.rev$/i.test(label)) throw new TypeError(`Bad clone name: ${JSON.stringify(name)}`);
    if (typeof rev !== 'string' || !rev.trim()) throw new TypeError('makeClone needs a commit');
    const dir = path.join(jobDir(jobId), ...label.split('/'));
    const taskId = label.endsWith('.rev') ? label.slice(0, -'.rev'.length) : null;
    const benchDir = taskId ? path.join(jobDir(jobId), taskId) : null;
    return withLock(dirKey(dir), () => cloneAt(project, jobId, dir, rev.trim(), { ...(options ?? {}), benchDir, taskId }));
  }

  /**
   * Puts a bench at one commit on branch "work": reset --hard and clean -fd. Ignored files (node_modules, .shop) stay.
   * An open merge ends; the conflict record is cleared.
   */
  async function resetBench(benchDir, rev) {
    await needBench(benchDir);
    return withLock(dirKey(benchDir), async () => {
      await secureBench(benchDir);
      const want = await sha(benchDir, String(rev ?? ''));
      if (!want) throw new Error(`Unknown commit ${rev} in ${benchDir}`);
      const slow = { timeoutMs: timeouts.long };
      await git(benchDir, ['reset', '-q', '--hard'], { ...slow, ok: 'any' }); // ends a merge in progress
      await git(benchDir, ['checkout', '-q', '-f', '-B', WORK, want], slow);
      await git(benchDir, ['clean', '-q', '-f', '-d'], slow);
      await patchMeta(benchDir, { conflicts: null, pendingMerge: null, merging: null });
    });
  }

  /** True when the bench is on branch "work" at rev, with no merge open and no change (ignored files aside). */
  async function cleanAt(benchDir, rev) {
    await needBench(benchDir);
    return withLock(dirKey(benchDir), async () => {
      await secureBench(benchDir);
      const want = await sha(benchDir, String(rev ?? ''));
      if (!want || (await sha(benchDir, 'HEAD')) !== want || (await sha(benchDir, 'MERGE_HEAD'))) return false;
      if ((await text(benchDir, ['symbolic-ref', '-q', '--short', 'HEAD'], { ok: [0, 1] })) !== WORK) return false;
      const status = await git(benchDir, ['status', '--porcelain', '-z', '--untracked-files=all', '--ignore-submodules=none'], { timeoutMs: timeouts.long });
      return status.stdout === '';
    });
  }

  /**
   * Saves the work of a bench before its folder goes (cancel): commitAll, then fetch "work" into canonical as
   * refs/workshop/<job>/<task>. A commit that cannot be made (conflict markers) is logged; the committed work is saved.
   * @returns {Promise<string|null>} the ref, or null for a bench without commits of its own
   */
  async function saveBench(project, jobId, taskId, benchDir, authorName) {
    const repo = repoOf(project);
    taskRefOf(jobId, taskId);
    await needBench(benchDir);
    origins.set(path.resolve(benchDir), repo);
    try {
      await commitAll(benchDir, `${taskId}: work saved by WorkShop`, authorName);
    } catch (err) {
      log('warn', 'saveBench could not commit everything; saving the committed work', { benchDir, error: err.message });
    }
    return withLock(repoKey(repo), () => withLock(dirKey(benchDir), async () => {
      await secureBench(benchDir);
      const head = await sha(benchDir, `refs/heads/${WORK}`);
      if (!head) return null;
      const base = (await sha(benchDir, `refs/remotes/origin/${intBranch(jobId)}`)) ?? (await benchInfo(benchDir)).baseSha;
      if (base && (head === base || (await isAncestor(benchDir, head, base, true)))) return null;
      const ref = await fetchBenchRef(repo, jobId, taskId, benchDir);
      log('info', 'bench saved', { benchDir, ref });
      return ref;
    }));
  }

  /* ---------- guard ---------- */

  /** Sizes of blobs by sha (cat-file --batch-check). */
  async function blobSizes(dir, shas) {
    const sizes = new Map();
    const list = [...new Set(shas)].filter((id) => /^[0-9a-f]{40,64}$/.test(id));
    for (let i = 0; i < list.length; i += 5000) {
      const part = list.slice(i, i + 5000);
      const out = (await git(dir, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
        { input: `${part.join('\n')}\n`, timeoutMs: timeouts.long })).stdout;
      for (const line of out.split('\n')) {
        const [id, type, size] = line.split(' ');
        if (type === 'blob') sizes.set(id, Number(size));
      }
    }
    return sizes;
  }

  /** Changes from..to as raw records: { status, path, sha (new blob, or null for a delete) }. */
  async function rawChanges(dir, from, to) {
    const out = zlist((await git(dir, [...DIFF, '--raw', '--no-abbrev', '--no-renames', '-z', from, to, '--'], { timeoutMs: timeouts.long })).stdout);
    const changes = [];
    for (let i = 0; i + 1 < out.length; i += 2) {
      const [, , , newSha, status] = out[i].split(' ');
      changes.push({ status: status[0], path: out[i + 1], sha: status[0] === 'D' || /^0+$/.test(newSha) ? null : newSha });
    }
    return changes;
  }

  /**
   * Added lines of a patch that match the board's secret scan or a stored key or live token. Returns 'path:line'
   * pointers, never the text. Also the paths that the patch adds (new file mode).
   */
  function scanPatch(patch) {
    const hits = [];
    const added = [];
    let file = null;
    let line = 0;
    let fresh = false;
    for (const row of patch.split('\n')) {
      if (row.startsWith('diff --git ')) { file = null; fresh = false; continue; }
      if (row.startsWith('new file mode ')) { fresh = true; continue; }
      if (row.startsWith('+++ ')) {
        const name = row.slice(4);
        file = name === '/dev/null' ? null : unquoteGitPath(name).replace(/^b\//, '');
        if (file && fresh) added.push(file);
        continue;
      }
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
      if (hunk) { line = Number(hunk[1]); continue; }
      if (row.startsWith('+') && file) {
        if (secretHit(row.slice(1, 20_001))) hits.push(`${file}:${line}`);
        line += 1;
      }
    }
    return { hits: [...new Set(hits)], added };
  }

  /** Does a commit of base..head hold content the guard refuses (a denied path, a secret, a file over the size limit)? */
  async function historyTainted(dir, base, head, allowLarge) {
    const range = [`${base}..${head}`];
    const history = await git(dir, ['log', '-p', '-m', '--first-parent', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color',
      '--unified=0', '--format=%x00', '--src-prefix=a/', '--dst-prefix=b/', ...range, '--'],
    { maxBuffer: DIFF_CAP, overflowOk: true, timeoutMs: timeouts.long });
    if (history.overflow) return true; // too much to look at: rewrite to be safe
    const { hits, added } = scanPatch(history.stdout);
    if (hits.length || added.some(deniedPath)) return true;
    if (allowLarge) return false; // a boss allowed large files: their size is no reason to rewrite
    const raw = zlist((await git(dir, ['log', '--raw', '--no-abbrev', '-m', '--first-parent', '--no-renames', '-z', '--format=', ...range, '--'],
      { timeoutMs: timeouts.long })).stdout);
    const blobs = raw.filter((entry) => entry.startsWith(':')).map((entry) => entry.split(' ')[3]);
    const maxFile = limit('maxFileMb', 1) * MB;
    return [...(await blobSizes(dir, blobs)).values()].some((size) => size > maxFile);
  }

  /** Added-line pointers ('path:line') of the unified diff from..to that match the secret scan. */
  async function patchHits(dir, from, to) {
    const patch = await git(dir, [...DIFF, '--no-color', '--no-renames', '--unified=0', '--src-prefix=a/', '--dst-prefix=b/', from, to, '--'],
      { maxBuffer: DIFF_CAP, overflowOk: true, timeoutMs: timeouts.long });
    return scanPatch(patch.stdout).hits;
  }

  /**
   * The target branch head that a catch-up bench merged in (createBench mergeTarget), when the bench holds it and
   * the fork point does not: that content is the owner's, not the maker's. null otherwise.
   */
  async function mergedTarget(dir, meta, base, head) {
    if (typeof meta.target !== 'string' || !meta.target.startsWith('refs/remotes/origin/')) return null;
    const theirs = await sha(dir, meta.target);
    if (!theirs || !(await isAncestor(dir, theirs, head, true)) || (await isAncestor(dir, theirs, base, true))) return null;
    return theirs;
  }

  /**
   * The hand-in guard over the whole change since the fork point. Run it after commitAll.
   *   denied: an added path on the hub deny list   large: a file or the delivery over the limits (unless allowLarge)
   *   unsafe: an added line with key-like text or the exact value of a stored key or live token   empty: no change
   * In a catch-up bench the owner's own target content (equal to the merged target branch) is not the maker's change.
   * Refused content that is already in a bench commit is never delivered: the next hand-in that passes rewrites the
   * bench branch as one commit on its fork point (squashed: true); a merged target branch stays a parent of it.
   * @param {string} benchDir
   * @param {string} [baseRef]  default baseRef(benchDir)
   * @param {{allowLarge?:boolean}} [options]
   * @returns {Promise<{ok:true, flags:{empty:boolean, testsDeleted:number, checkFiles:string[]}, squashed?:boolean}
   *   |{ok:false, why:'denied'|'large'|'unsafe'|'empty', detail:string, flags?:object}>}
   */
  async function guard(benchDir, baseRef, options) {
    await needBench(benchDir);
    const allowLarge = Boolean(options?.allowLarge);
    return withLock(dirKey(benchDir), async () => {
      await secureBench(benchDir);
      const head = await sha(benchDir, 'HEAD');
      if (!head) throw new Error(`The bench ${benchDir} has no commit.`);
      const base = await forkBase(benchDir, baseRef ?? benchBaseRef(benchDir), head);
      const all = await rawChanges(benchDir, base, head);
      const meta = await benchInfo(benchDir);
      const theirs = all.length ? await mergedTarget(benchDir, meta, base, head) : null;
      // The maker's own change: paths that differ from the fork point and, in a catch-up bench, from the target too.
      const vsTarget = theirs ? new Map((await rawChanges(benchDir, theirs, head)).map((c) => [c.path, c])) : null;
      const changes = vsTarget ? all.filter((c) => vsTarget.has(c.path)) : all;
      const flags = {
        empty: all.length === 0,
        testsDeleted: changes.filter((c) => c.status === 'D' && isTestFile(c.path)).length,
        checkFiles: changes.map((c) => c.path).filter(isCheckFile).sort(),
      };
      const refuse = async (why, detail) => {
        if (why !== 'empty') await patchMeta(benchDir, { tainted: true }); // the refused content is in a bench commit now
        log('info', 'guard refused', { benchDir, why });
        return { ok: false, why, detail, ...(why === 'empty' ? { flags } : {}) };
      };
      if (!all.length) {
        const open = (await sha(benchDir, 'MERGE_HEAD')) ? await unmergedPaths(benchDir).catch(() => []) : [];
        return refuse('empty', open.length
          ? `No changes found in your bench. A merge is still open; conflict markers are left in: ${open.join(', ')}. Resolve them, then hand in again.`
          : 'No changes found in your bench.');
      }
      const denied = changes.filter((c) => c.status === 'A' && (!vsTarget || vsTarget.get(c.path).status === 'A') && deniedPath(c.path)).map((c) => c.path);
      if (denied.length) return refuse('denied', `These paths must not be delivered (hub deny list): ${denied.join(', ')}. Delete them, then hand in again.`);
      const sizes = await blobSizes(benchDir, changes.map((c) => c.sha).filter(Boolean));
      const maxFile = limit('maxFileMb', 1);
      const maxTotal = limit('maxDeliveryMb', 5);
      const maxFiles = limit('maxDeliveryFiles', 500);
      if (!allowLarge) {
        const big = changes.filter((c) => c.sha && (sizes.get(c.sha) ?? 0) > maxFile * MB).map((c) => c.path);
        const total = changes.reduce((sum, c) => sum + (c.sha ? sizes.get(c.sha) ?? 0 : 0), 0);
        if (big.length) return refuse('large', `Files over ${maxFile} MB: ${big.join(', ')}.`);
        if (total > maxTotal * MB) return refuse('large', `The delivery is ${(total / MB).toFixed(1)} MB, over the limit of ${maxTotal} MB.`);
        if (changes.length > maxFiles) return refuse('large', `The delivery changes ${changes.length} files, over the limit of ${maxFiles}.`);
      }
      let hits = await patchHits(benchDir, base, head);
      if (theirs && hits.length) { // lines that the target branch has already are the owner's
        const own = new Set(await patchHits(benchDir, theirs, head));
        hits = hits.filter((hit) => own.has(hit));
      }
      if (hits.length) {
        return refuse('unsafe', `Key-like text or a stored secret value in: ${hits.slice(0, 20).join(', ')}${hits.length > 20 ? ', ...' : ''}. Remove it, then hand in again.`);
      }
      if (!(await sha(benchDir, 'MERGE_HEAD')) && (meta.tainted || (await historyTainted(benchDir, base, head, allowLarge)))) {
        // One commit on the fork point with exactly the guarded tree: the refused content is in no commit that leaves
        // the bench. A merged target branch stays a parent, so the owner's commits keep their history.
        const [subject, author] = (await text(benchDir, ['log', '-1', '--format=%s%x00%an', head])).split('\0');
        const message = `${subject || 'WorkShop: work'}\n\nOne commit made by the WorkShop hub: refused content was removed from the bench history.`;
        const parents = theirs ? ['-p', base, '-p', theirs] : ['-p', base];
        const squash = await text(benchDir, ['commit-tree', `${head}^{tree}`, ...parents, '-m', message],
          { ident: { name: cleanName(author), email: AGENT_EMAIL }, timeoutMs: timeouts.long });
        await git(benchDir, ['reset', '-q', '--soft', squash], { timeoutMs: timeouts.long });
        await patchMeta(benchDir, { tainted: null });
        log('info', 'guard rewrote the bench branch as one commit', { benchDir });
        return { ok: true, flags, squashed: true };
      }
      if (meta.tainted) await patchMeta(benchDir, { tainted: null });
      return { ok: true, flags };
    });
  }

  /**
   * Marks the bench history as holding refused content (the orchestrator refused the hand-in, for example for a
   * file outside the zones). The next hand-in that the guard passes is then squashed into one commit on the fork
   * point, as after a guard refusal, so the refused content never leaves the bench.
   * @param {string} benchDir
   */
  async function taintBench(benchDir) {
    await needBench(benchDir);
    return withLock(dirKey(benchDir), async () => {
      await patchMeta(benchDir, { tainted: true });
      log('info', 'bench marked tainted', { benchDir });
    });
  }

  /* ---------- head check and truck refresh ---------- */

  const headKey = (repo, commit, project) => [repo, commit, String(project.setupCmd ?? '').trim(), String(project.checkCmd ?? '').trim()].join('\0');

  /** Head check results in memory, bounded: the oldest go first. */
  function rememberHead(key, result) {
    headCache.delete(key);
    headCache.set(key, result);
    while (headCache.size > 256) headCache.delete(headCache.keys().next().value);
  }

  /** The commit a hub clone is detached at, read from its HEAD file without running git there; null when unclear. */
  async function cloneHead(dir) {
    const file = path.join(dir, '.git', 'HEAD');
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile() || !(await fs.lstat(path.join(dir, '.git')))?.isDirectory()) return null;
    const value = (await fs.readFile(file, 'utf8').catch(() => '')).trim();
    return /^[0-9a-f]{40,64}$/.test(value) ? value : null;
  }

  /** setupCmd then checkCmd in a clone that is at one commit. A missing command is a pass. */
  async function checkClone(dir, project) {
    const started = Date.now();
    const setup = await runSetup(dir, project.setupCmd, { timeoutMs: timeouts.setup });
    if (!setup.ok) return { ok: false, tail: `${setup.tail}\n[setup failed with exit code ${setup.code}]\n`.slice(-TAIL_CHARS), ms: Date.now() - started };
    const check = await runCheck(dir, project.checkCmd, { timeoutMs: checkTimeoutMs() });
    return { ok: check.ok, tail: check.tail, ms: Date.now() - started };
  }

  /**
   * The head check: a pristine clone of the integration head at <work>/<job>/_head, setupCmd, then checkCmd.
   * Cached per sha (and commands): a second call at the same head returns the result without a run; so does a
   * project.headCheck for that sha. { force:true } runs again (the baseline gate runs the check twice).
   * @returns {Promise<{sha:string, ok:boolean, tail:string, ms:number}>}
   */
  async function headCheck(project, jobId, options) {
    const repo = repoOf(project);
    const commit = await sha(repo, `refs/heads/${intBranch(jobId)}`);
    if (!commit) throw new Error(`Integration branch ${intBranch(jobId)} not found in ${repo}`);
    const key = headKey(repo, commit, project);
    const dir = path.join(jobDir(jobId), '_head');
    // A result counts only while _head is at that commit: the QA turn runs there, on the tree that was checked.
    const cached = async () => {
      if (options?.force) return null;
      const stored = project.headCheck;
      const found = headCache.get(key) ?? (stored && stored.sha === commit && typeof stored.ok === 'boolean'
        ? { sha: commit, ok: stored.ok, tail: String(stored.tail ?? ''), ms: Number(stored.ms) || 0 } : null);
      return found && (await cloneHead(dir)) === commit ? found : null;
    };
    return withLock(dirKey(dir), async () => {
      const known = await cached();
      if (known) return known;
      await cloneAt(project, jobId, dir, commit, { pristine: true });
      const run = await checkClone(dir, project);
      const result = { sha: commit, ok: run.ok, tail: run.tail, ms: run.ms };
      rememberHead(key, result);
      log('info', 'head check', { jobId, sha: commit, ok: result.ok, ms: result.ms });
      return result;
    });
  }

  /**
   * The target branch moved: merges it into a scratch clone of the integration head and runs the head check there.
   * Clean and green: _int fast-forwards to that merge. Conflict or red check: _int does not change.
   * @returns {Promise<{ok:true, sha:string, commits:{sha:string, subject:string}[]}|{ok:false, reason:'conflict'|'check', files?:string[], tail?:string}>}
   */
  async function refreshTruck(project, jobId) {
    const repo = repoOf(project);
    const intRef = `refs/heads/${intBranch(jobId)}`;
    const targetRef = `refs/heads/${project.targetBranch}`;
    return withLock(repoKey(repo), async () => {
      const head = await sha(repo, intRef);
      const target = await sha(repo, targetRef);
      if (!head) throw new Error(`Integration branch ${intBranch(jobId)} not found in ${repo}`);
      if (!target) throw new Error(`Target branch "${project.targetBranch}" not found in ${repo}`);
      if (await isAncestor(repo, target, head)) return { ok: true, sha: head, commits: [] };
      const listed = await git(repo, ['log', '-z', '--format=%H%x09%s', '-n', '200', `${head}..${target}`], { timeoutMs: timeouts.long });
      const commits = zlist(listed.stdout).map((entry) => {
        const tab = entry.indexOf('\t');
        return { sha: entry.slice(0, tab), subject: entry.slice(tab + 1) };
      });
      const dir = path.join(jobDir(jobId), '_refresh');
      try {
        return await withLock(dirKey(dir), async () => {
          await cloneAt(project, jobId, dir, head, { fetchTarget: true, pristine: true });
          const remote = `origin/${project.targetBranch}`;
          const title = `Merge ${project.targetBranch} into ${intBranch(jobId)}`;
          const merge = await git(dir, ['merge', '-q', '--no-ff', '--no-log', ...MERGE_QUIET, '-m', title, remote], { ok: 'any', timeoutMs: timeouts.long });
          if (merge.code !== 0) {
            const files = (await unmergedPaths(dir).catch(() => [])).sort();
            if (!files.length) throw gitError(dir, ['merge', remote], { code: merge.code }, merge.stderr);
            log('info', 'truck refresh hit conflicts', { jobId, files });
            return { ok: false, reason: 'conflict', files };
          }
          const mergeSha = await sha(dir, 'HEAD');
          const run = await checkClone(dir, project);
          if (!run.ok) {
            log('info', 'truck refresh: red check', { jobId, sha: mergeSha });
            return { ok: false, reason: 'check', tail: run.tail };
          }
          // Into canonical, then _int fast-forwards (its files move with it). The setup and check commands could
          // change the clone's .git (config, HEAD): the config is the hub's again, and only the recorded merge moves.
          if (!(await secureClone(dir))) throw new Error(`The refresh clone ${dir} has no hub record.`);
          const scratchRef = `refs/workshop/${jobId}/_refresh`;
          await git(dir, ['update-ref', 'refs/heads/workshop-refresh', mergeSha]);
          await git(repo, ['fetch', '-q', '--no-tags', '--no-prune', '--no-recurse-submodules', '--no-write-fetch-head', '--',
            dir, `+refs/heads/workshop-refresh:${scratchRef}`], { timeoutMs: timeouts.long });
          try {
            if ((await sha(repo, scratchRef)) !== mergeSha) throw new Error('The refresh merge did not reach the project repository.');
            const { integrationDir } = await ensureIntegration(project, jobId);
            await resetIntegration(integrationDir);
            await git(integrationDir, ['merge', '-q', '--ff-only', ...MERGE_QUIET, mergeSha], { timeoutMs: timeouts.long });
          } finally {
            await git(repo, ['update-ref', '-d', scratchRef], { ok: 'any' });
          }
          if ((await sha(repo, intRef)) !== mergeSha) throw new Error('The integration branch did not move to the refresh merge.');
          // The checked clone becomes _head: the cached result and the folder the QA turn uses are the same tree.
          const headDir = path.join(jobDir(jobId), '_head');
          await withLock(dirKey(headDir), async () => {
            await git(dir, ['update-ref', '-d', 'refs/heads/workshop-refresh'], { ok: 'any' });
            await fs.rm(headDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            await fs.rename(dir, headDir);
            rememberHead(headKey(repo, mergeSha, project), { sha: mergeSha, ok: true, tail: run.tail, ms: run.ms });
          });
          log('info', 'truck refreshed', { jobId, sha: mergeSha, commits: commits.length });
          return { ok: true, sha: mergeSha, commits };
        });
      } finally {
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(noop);
      }
    });
  }

  /* ---------- cleanup and small extras ---------- */

  /**
   * Deletes a bench folder. Only <work>/<job>/<task> folders are accepted, never _int or anything outside the work area.
   * @param {string} dir
   */
  async function removeBench(dir) {
    const abs = path.resolve(String(dir ?? ''));
    if (!(await isHubFolder(abs))) throw new Error(`Refusing to remove ${abs}: not a bench or a hub clone inside ${path.resolve(dirOf('work'))}`);
    origins.delete(abs);
    await withLock(dirKey(abs), () => fs.rm(abs, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  }

  /**
   * Cleans up after a job: removes the integration worktree and the job's work folder (desks, _head, _preview,
   * benches, review clones), the task refs refs/workshop/<jobId>/* and the integration branch ws/<jobId>/int.
   * keepInt keeps the integration branch (a cancelled job with a loaded truck). keepRefs keeps the saved task refs
   * refs/workshop/<jobId>/* (Ship or Discard of a cancelled job: the integration branch goes, the saved benches stay
   * until Delete). A branch that the owner has checked out is always kept. Branches ws/<jobId>/<task> of an older hub
   * version go too, but without force only when they are on the target branch.
   * @param {object} project
   * @param {string} jobId
   * @param {{force?:boolean, keepInt?:boolean, keepRefs?:boolean}} [options]
   * @returns {Promise<{deleted:string[], kept:string[]}>} short ref names ('workshop/J1/T1', 'ws/J1/int')
   */
  async function removeJobWork(project, jobId, options) {
    const force = Boolean(options?.force);
    const keepInt = Boolean(options?.keepInt);
    const keepRefs = Boolean(options?.keepRefs);
    const repo = repoOf(project);
    const dir = jobDir(jobId);
    return withLock(repoKey(repo), async () => {
      const result = { deleted: [], kept: [] };
      const repoThere = await exists(path.join(repo, '.git'));
      if (repoThere) await git(repo, ['worktree', 'remove', '--force', '--', path.join(dir, '_int')], { ok: 'any' });
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      for (const place of origins.keys()) if (place.startsWith(dir + path.sep)) origins.delete(place);
      if (!repoThere) return result;
      const saved = keepRefs ? [] : (await text(repo, ['for-each-ref', '--format=%(refname)', `refs/workshop/${jobId}/`])).split('\n').filter(Boolean);
      for (const ref of saved) {
        await git(repo, ['update-ref', '-d', ref]);
        result.deleted.push(ref.slice('refs/'.length));
      }
      const target = await sha(repo, `refs/heads/${project.targetBranch}`);
      const intRef = `refs/heads/${intBranch(jobId)}`;
      const refs = (await text(repo, ['for-each-ref', '--format=%(refname)', `refs/heads/ws/${jobId}/`])).split('\n').filter(Boolean)
        .sort((a, b) => (a === intRef) - (b === intRef)); // the integration branch last
      const inUse = refs.length ? await checkedOut(repo) : new Map(); // deleting a checked-out branch would break that checkout
      for (const ref of refs) {
        const name = ref.slice('refs/heads/'.length);
        const allowed = ref === intRef ? !keepInt : force || (target && (await isAncestor(repo, ref, target)));
        if (!inUse.has(ref) && allowed) {
          await git(repo, ['update-ref', '-d', ref]);
          result.deleted.push(name);
        } else {
          result.kept.push(name);
        }
      }
      log('info', 'job work removed', { jobId, ...result });
      return result;
    });
  }

  /**
   * The integration ref inside a bench ("origin/ws/<job>/int"): the base for zone checks, diff stats
   * and reviews. Synchronous.
   * @param {string} benchDir
   * @returns {string}
   */
  function benchBaseRef(benchDir) {
    try {
      const meta = JSON.parse(readFileSync(metaFile(benchDir), 'utf8'));
      if (meta && typeof meta.integrationBranch === 'string') return `origin/${meta.integrationBranch}`;
    } catch { /* no record: use the folder layout <work>/<job>/<task> */ }
    return `origin/ws/${path.basename(path.dirname(path.resolve(benchDir)))}/int`;
  }

  /** Commit sha of HEAD in a bench, the integration worktree or the canonical repo; null when there is none. */
  const headSha = async (dir) => sha(dir, 'HEAD');

  /** Diff of the whole truck: what the integration branch adds to the target branch. Options: { path, maxBytes }. */
  const truckDiff = async (project, jobId, options = {}) => diff(repoOf(project), {
    ...options, base: `refs/heads/${project.targetBranch}`, head: `refs/heads/${intBranch(jobId)}`,
  });

  /** Diff of one delivery: its merge commit against the integration branch just before it. Options: { path, maxBytes }. */
  const deliveryDiff = async (project, mergeSha, options = {}) => diff(repoOf(project), { ...options, base: `${mergeSha}^`, head: mergeSha });

  /** Kills every check that is still running (hub shutdown). */
  function shutdown() {
    for (const kill of [...runningChecks]) kill();
  }

  return {
    initProject, adoptProject, startJob, createBench, makeClone, writeHubFiles, cleanAgentDir, commitAll, changedFiles, guard, taintBench,
    syncBench, unresolved, runSetup, runCheck, resetBench, cleanAt, headCheck, diffStat, diff, integrate, truck, refreshTruck,
    ship, saveBench, removeBench, baseRef: benchBaseRef, headSha, removeJobWork, truckDiff, deliveryDiff, shutdown,
    writeShopFiles: writeHubFiles, // older name; the callers move to writeHubFiles
    matchZone, zonesOverlap, HUB_PATHS,
  };
}
