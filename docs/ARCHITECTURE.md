# WorkShop architecture (contract)

Status: v1 contract. This file is the contract between modules. If code and this file disagree, fix one of them in the same change.
Section 14c holds facts proven by real runs. They outrank other text.

## 1. What WorkShop is

A local macOS app for one owner (Phase 0 architecture; see [docs/ROADMAP.md](ROADMAP.md)). The owner writes a **work order** (build software, fix a problem, research a topic).
Frontier **Orchestration Officers** (`gemini` / `claude`, API-key only) investigate, plan requirements, and serve as **Final Review Gates**, while **$0 Open-Source Specialist Agent Teams** (`oss` via local/cluster OpenAI-compatible runtimes `Ollama`, `vLLM`, `SGLang`, `llama.cpp`, custom command, or Phase 0 Stand-in simulation) equip modular **Harness Rack** toolkits to build tasks on isolated benches.

| Shop word | Real thing |
|---|---|
| Work order | A job: brief + requirements ledger + plan |
| Boss / Orchestration Officer | Frontier API-key orchestrator (`gemini` / `claude`). Plans, serves as Final Review Gate, verifies requirements |
| Floor manager / Team Lead | Open-source (`oss`) stream lead. Unblocks specialists, re-plans failed tasks |
| Maker / Specialist | Open-source (`oss`) character matched from the **Employee Book** equipping a **Harness Rack** rig on one bench |
| Harness Rack | Modular domain/platform rig (`config/harnesses.json`) injected into benches as `.shop/HARNESS.md` |
| Employee Book | Persistent character catalog (`config/roster.json`) tracking specialties, checkpoints, and RFT certification |
| RFT Calibration Bay | Phase 1 RFT training requisition queue (`data/requisitions.json`) logged when a domain lacks a curated specialist |
| Bench | A private git clone for one task |
| Desk | A read-only clone for a boss or a manager |
| Doohickey | The work of one task (commits on the bench) |
| Boss office inbox | Review queue |
| Merge truck | Reviewed work merged on the job's integration branch, waiting for the owner |
| Truck leaves | Owner approved one exact commit: the target branch fast-forwards to it |
| Message board | Shared, terse, rule-checked channel between all agents and the owner |

## 2. Principles

1. **The hub is deterministic. Agents are smart only at defined points.** Plain code owns state, order of steps, git, and gates. Agents decide through hub tools (MCP). The hub validates every tool call.
2. **The hub owns git.** Agents edit files in their bench. Only the hub commits, merges, integrates and ships.
3. **One writer per file area.** Each task has `zones` (path globs). Tasks that can run at the same time must have disjoint zones. Merges are serial.
4. **Nothing reaches the owner's branch without three gates:** the checks pass, a review passes (a boss, or the other-lab manager for small tasks; other lab when possible), the owner approves the exact commit that ships.
5. **No requirement is dropped silently.** Every requirement is on a ledger. The owner, the bosses and the agent of a QA or audit turn can add to it. Only the owner can waive. A job ends only when each requirement is verified or waived.
6. **Token thrift.** Tiered models. Short role cards. Pointers (path:line, task id) instead of pasted text. Board rules enforced by the server. Long sessions rotate.
7. **Local and private.** The server binds 127.0.0.1 only. The owner API needs the owner key (section 6). Secrets live in the macOS Keychain and never reach the UI, the logs or agents of another lab.
8. **Agents are contained.** In safety mode `sandboxed` every agent shell command, every setup command and every check command runs in an OS sandbox (sections 9, 10).
9. **Zero dependencies.** Node 20 ESM, built-in modules only. No build step.
10. **Survives restarts.** State is on disk. Benches are on disk. Agent sessions resume. The scheduler derives every start from persisted state (section 12).

## 3. Folder layout

```
WorkShop/
  WorkShop.app/            double-click launcher (built from macapp/)
  package.json             {"type":"module"}; scripts: start, test
  server/
    index.js               entry; boots modules; prints WORKSHOP_READY <url>#k=<ownerKey>
    config.js              paths, default settings, settings load/save
    store.js               state snapshot + event bus + ids
    http.js                tiny router, JSON, static files, SSE, request guards, owner session
    api.js                 REST routes -> modules
    shoptalk.js            ShopTalk grammar, limits, validator, renderer (pure)
    board.js               message board: storage, open items, deadlines, views, board MCP tools
    mcp.js                 MCP JSON-RPC endpoint, per-turn agent tokens, tool registry
    mcp-stdio-shim.mjs     stdio <-> HTTP proxy that CLIs spawn
    secrets.js             Keychain (file backend for tests)
    redact.js              exact-value redactor for logs, events, prompts and the board
    shellenv.js            clean agent environment and login PATH
    providers/index.js     registry + detection
    providers/oss.js       open-weight endpoint + Stand-in adapter (`oss`)
    providers/oss-agent.mjs standalone local OSS tool-loop / Stand-in runner
    providers/claude.js    Claude Code CLI adapter (API-key only)
    providers/gemini.js    Antigravity CLI (agy) adapter (API-key only)
    providers/mock.js      fake provider (demo + tests)
    providers/mock-agent.mjs  scripted fake CLI that calls the real hub tools
    harnesses.js           Harness Rack registry + `.shop/HARNESS.md` renderer (`config/harnesses.json`)
    roster.js              Employee Book catalog + outcome tracking (`config/roster.json`)
    training.js            Phase 1 RFT requisition queue + enrollment (`data/requisitions.json`)
    runner.js              spawns agent turns, parses streams, limits, timeouts
    router.js              picks a model per task from config/models.json
    benchlm.js             benchmark refresh for the registry
    decider.js             Gemini specialist/task decider + optional Jev decider (section 11b)
    gitops.js              projects, benches, clones, sync, checks, guard, integrate, truck, ship, diffs, zones
    prompts.js             role cards and turn prompts (pure)
    names.js               agent names and style seeds
    orchestrator.js        the job state machine + workflow MCP tools
    toolkit.js             owner tools per project (section 12c)
  ui/
    index.html, app.js, style.css
    lib/*.js               api client, client store, selectors, view model, widgets
    panels/*.js            work order, blueprint, board, truck, crew (Roster & Teams), toolkit (Harnesses & Toolkit), inbox, models, keys (Runtimes & Keys), settings
    scene/*                pixel-art scene engine (view model in section 13)
  config/
    models.json            model registry + benchmark scores
    harnesses.json         curated Harness Rack specifications
    roster.json            curated Employee Book characters
    settings.json          owner settings (git-ignored; created on first save, holds only what differs from the defaults)
  data/                    runtime state (git-ignored, mode 0700; files 0600)
    state.json, events.jsonl, board.jsonl, board-state.json, keys-meta.json, requisitions.json, toolkit/<projectId>.json
    logs/                  hub.log, <agentId>.jsonl
    run/                   hub.lock, <agentId>/ (per-turn config files, never inside a bench)
    work/<job>/            _int, _desk/<handle>/, _head, _preview, <task>/ (bench), <task>.rev/ (review clone)
  projects/                default home of new project repos
  macapp/                  Swift launcher source + build.sh
  tests/                   node --test
  docs/ARCHITECTURE.md
  README.md
```

Rules for all server code: ESM. No top-level side effects except in `index.js`. Every module exports a `create*` factory that takes its dependencies, so tests can inject temp dirs and fakes. No shell string interpolation of data (use `execFile` with arg arrays). All child processes get timeouts.

## 3b. App lifecycle

- **Launcher.** `WorkShop.app` finds `node` through the login shell and known folders (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.nvm`, `~/.volta/bin`). When node is missing it shows a plain error page with the install hint. It starts `server/index.js`, reads `WORKSHOP_READY <url>#k=<ownerKey>` from stdout and loads that URL.
- **One hub per data dir.** The hub holds `data/run/hub.lock { pid, port }`. A second hub on the same data dir exits with a message when the pid in the lock is alive.
- **Launcher death.** The hub shuts down cleanly when its launcher dies (its stdin closes). `runner.shutdown()` stops the turns. Sessions resume at the next start.
- **Window and quit.** Closing the window keeps the app and the job running. Quit with a live job asks: `Keep working`, or `Pause and quit`.
- **Sleep.** While a job is live the hub holds a power assertion (`/usr/bin/caffeinate -i -w <hub pid>`). Deadlines and watchdogs run on shop time (section 7), so a sleep or a restart never fires them at once.
- **Attention.** A notice of level `owner` also raises a macOS notification and a Dock badge through the launcher.

## 4. Data model

IDs are short to save tokens: `P1` project, `J1` job, `T12` task, `A7` agent, `D5` delivery, `R3` requirement. Board messages use integers (`#41`).

```
Project  { id, name, path, targetBranch, hubCreated, setupCmd|null, checkCmd|null, noCheckReason|null,
           agentFiles:[path], agentFilesAck:boolean,
           baseline:{sha,ok,flaky,ms,tail}|null, headCheck:{sha,ok,tail}|null }

Job      { id, title, brief, kind:'build'|'fix'|'research', projectId, newProject:boolean,
           crew:{bosses,managers,makers}, options:{approvePlan,mock},
           status:'queued'|'planning'|'plan_review'|'running'|'qa'|'delivering'|'done'|'paused'|'cancelled',
           prevStatus|null, pauseReason:null|'owner'|'budget'|'caps'|'qa'|'baseline'|'stalled'|'tampered'|'error',
           hold:{reason,lab,until}|null,
           requirements:[Req], assumptions:[{text, msgId|null}], notes:string,
           planDrafts:{[bossId|'final']:plan}|null, dropped:[{draft,n,why}], auditDone:boolean,   // final: the validated plan until it is applied
           leadBossId, bossIds:[], managerIds:[],
           integrationBranch, integrationDir, intSha|null,
           qa:{round, sha, agentId|null, sessionId|null}|null,
           cost:{billedUsd, estUsd, inTok, outTok}, budgetUsd|null, report|null, error|null, createdAt, updatedAt }

Req      { id, text, source:'plan'|'owner'|'boss', status:'open'|'verified'|'failed'|'waived', evidence|null, waivedReason|null }

Task     { id, jobId, title, spec, acceptance:[string], reqs:[reqId], domain, size:'S'|'M'|'L',
           zones:[glob], claims:[path], pendingClaims:[path], deps:[taskId], pair:boolean, allowLarge:boolean,
           stream:string|null, managerId|null, note|null,
           status:'planned'|'ready'|'working'|'checking'|'buddy'|'review'|'rework'|'integrating'|'merged'|'blocked'|'failed'|'cancelled',
           why:null|'ask'|'claim'|'env'|'nudges'|'error'|'owner',          // set while status is blocked; 'ask': a BLOCK post; 'owner': the owner stopped it
           assigneeId|null, buddyId|null, reviewerId|null,
           sessionId|null, sessionCtx:{tok,at}|null, reviewSessionId|null,   // maker work session, its last ctxTok and turn end; sticky review session
           benchDir|null, reviewDir|null, baseSha|null, headSha|null, lastReviewedSha|null,
           attempts:number, retries:number, blocks:number, progress:0..1, summary|null, lastError|null,
           hold:{reason:'lab', provider, model?, since, until?}|null, needsAction:{kind:'failed'|'blocked', since}|null,
           cardChanges:[{by, what, ts}], cost:{usd}, createdAt, updatedAt }

Agent    { id, jobId, name, handle:'@b1'|'@f1'|'@m3', role:'boss'|'manager'|'maker', lead:boolean,
           provider, model, modelLabel, effort, style:{seed}, spot:number,
           status:'idle'|'working'|'thinking'|'waiting'|'reviewing'|'blocked'|'off',
           taskId|null, sessionId|null, sessionCtx:{tok,at}|null,            // sessionId: the main session of a boss or a manager only
           hold:{reason:'lab', provider, model?, since, until?}|null,        // a main, QA, audit or consult turn of this agent waits for its lab
           stats:{turns,inTok,outTok,usd,ctxTok,ctxMax},                     // ctxTok: context size of the latest model call
           bubble:{text,kind,seq}|null, lastActiveAt }

Delivery { id, jobId, taskId, makerId, reviewerId|null, attempt:number,
           status:'checking'|'buddy'|'review'|'rejected'|'approved'|'loaded'|'shipped',
           summary, acc:{met,total}, tests:string, stat:{files,add,del}, files:[{path,add,del}],
           check:{cmd,ok,tail}|null,                                         // null: the project has no check (NOT CHECKED)
           baseSha, headSha,                                                 // headSha: the bench head after sync and a green check; baseSha: the integration head it contains
           flags:{empty:boolean, testsDeleted:number, checkFiles:[path], claimed:[path], cardChanged:[string]},
           doneMsgId|null, buddy:{by,verdict,notes}|null,
           review:{by,verdict:'pass'|'changes',notes,mustFix:[],headSha,crossLab:boolean}|null,
           mergeSha|null, createdAt, updatedAt }

Message  see section 7.   ProviderStatus  see section 10 (the only shape).
```

Domains (routing keys): `plan, backend, frontend, fix, review, test, data, algo, research, synthesis, docs, vision, chore`.

An **open task** is every task that is not `merged` or `cancelled`.
An **active job** is a job in `planning`, `plan_review`, `running`, `qa`, `delivering` or `paused`. One job is active at a time. Every other new job is `queued`.
The hub never ends a job by itself. Every hub stop is `paused` with a `pauseReason` and `job.error`. The owner resumes or cancels.

## 5. Store and events (`server/store.js`)

State is one object saved atomically to `data/state.json` (write temp file, rename; debounced 250 ms; `flush()` saves now).
Every change also goes to subscribers (SSE, orchestrator) and to `data/events.jsonl` (audit).
Chatty agent output never enters state. It goes to `data/logs/<agentId>.jsonl` and to transient `agentlog` events, after redaction and with the file modes of section 14.

```js
createStore({ dataDir }) -> store
store.state                          // { v, seq, counters, projects, jobs, tasks, agents, deliveries }
store.nextId(kind)                   // kind: 'P'|'J'|'T'|'A'|'D' -> 'T13'
store.put(kind, item) -> item        // kind: 'projects'|'jobs'|'tasks'|'agents'|'deliveries'; upsert by id; sets updatedAt
store.patch(kind, id, patch) -> item // shallow merge then put; throws if id unknown
store.remove(kind, id)
store.get(kind, id) ; store.list(kind, filterFn?)
store.emit(type, payload, { persist=true }?)   // transient event
store.subscribe(fn) -> unsubscribe   // fn(event)
store.eventsSince(seq) -> event[]    // ring buffer, last 5000
store.flush() -> Promise
```

The orchestrator awaits `store.flush()` right after each of these: a `DONE` is accepted, a verdict is accepted, an integrate succeeds, a ship succeeds.

Event shapes (all have `seq`, `ts`):

```
{type:'upsert', kind, item}      {type:'remove', kind, id}
{type:'board', msg, changed?}    {type:'agentlog', agentId, lines:[{k:'text'|'tool'|'err'|'sys', s}]}   (not persisted)
{type:'fx', name, payload}       {type:'providers', providers}      {type:'settings', settings}
{type:'notice', level:'info'|'warn'|'error'|'owner', text, jobId|null}
{type:'toolrun', runId, toolId, chunk?, done?, code?}                (not persisted)
```

The UI keeps entities by id and replaces them on `upsert`. It needs no reducers.

## 6. HTTP API (`server/http.js`, `server/api.js`)

**Guards on every request.** Bind `127.0.0.1` only. `Host` must be `127.0.0.1:<port>` or `localhost:<port>`. If `Origin` is present it must match. Every non-GET needs the header `X-WorkShop: 1` and a JSON body. No CORS headers.

**Owner key.** At boot the hub makes a random 256-bit `ownerKey`. It lives in memory only: never in `data/`, logs, state, events, prompts or a child environment. `index.js` prints `WORKSHOP_READY <url>#k=<ownerKey>` and the launcher loads that URL. The UI posts the key once to `POST /api/session { k }`, gets a session cookie (`HttpOnly; SameSite=Strict; Path=/`) and removes the fragment. Every `/api/*` route, GET and SSE included, answers `401` without a valid cookie (constant-time compare). `POST /api/session` is the only exception. Static files need no cookie.

**Agent routes.** `/mcp/:token` and `/mcp/:token/tag` are the only routes that take an agent token. An agent token opens nothing under `/api`. Posts as `@human` and all owner actions exist only behind the cookie.

**Response headers.** Every response carries `X-Content-Type-Options: nosniff` and `Content-Security-Policy: frame-ancestors 'none'`. Static files are served from `ui/` with `Cache-Control: no-store`. The page keeps its own CSP meta tag (`default-src 'self'`, no inline script, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`).

```
POST /api/session                     { k } -> sets the owner cookie
GET  /api/state                       -> { seq, state, providers, settings, board:[last 200 msgs], models, inbox, harnesses, roster, requisitions }
GET  /api/events                      -> SSE stream (supports Last-Event-ID and ?since=; heartbeat comment every 15 s)

POST /api/jobs                        { title, brief, kind, project:{mode:'new'|'existing', name?, path?, agentFilesAck?}, crew:'solo'|'standard'|'full'|{bosses,managers,makers},
                                        options?, budgetUsd? } -> job        (refused without budgetUsd when a usable lab is in apikey mode)
POST /api/jobs/:id/pause              { hard?:true }                  hard also stops the running turns with SIGINT
POST /api/jobs/:id/resume             { budgetUsd? }                  refused while another job is active; needs budgetUsd above billedUsd when pauseReason is budget
POST /api/jobs/:id/cancel
DELETE /api/jobs/:id                  done and cancelled jobs only: removes work folders, refs and task rows; keeps title, brief, ledger and report
POST /api/jobs/:id/plan/approve
POST /api/jobs/:id/reqs               { text } -> Req                 owner adds a requirement (from plan_review on)
POST /api/jobs/:id/reqs/:rid/waive    { reason }                      owner waives a requirement
GET  /api/jobs/:id/truck              -> { headSha, behind, deliveries:[...loaded], stat, files:[{path,add,del}], reqs:{open,failed,verified,waived}, check:{ok,tail}|null, report }
POST /api/jobs/:id/ship               { sha }                         sha is required: the headSha the panel showed, or the mergeSha of a loaded delivery
POST /api/jobs/:id/truck/discard                                      cancelled job only: drops the loaded crates and the integration branch
POST /api/jobs/:id/changes            { deliveryId?, text }           owner asks for changes
GET  /api/jobs/:id/diff?path=&delivery=   -> text/plain unified diff (truck diff, or one delivery)

POST /api/tasks/:id/stop              { note? }                       stops the turn; the task becomes blocked (why owner)
POST /api/tasks/:id/retry             { note?, model?:'same'|'up'|'other_lab' }
POST /api/tasks/:id/cancel            { reason, replacedBy?:[taskId] }

GET  /api/board?job=&since=&limit=    -> messages
POST /api/board                       { jobId, kind, to?, scope?, re?, slots?, body }  owner posts as @human; -> { ok, msg } | { error }
GET  /api/inbox?job=                  -> inbox items (section 12b)
PUT  /api/presence                    { state:'here'|'away' }
GET  /api/agents/:id/log?tail=200     -> lines

GET  /api/providers                   -> ProviderStatus[]   (POST /api/providers/detect to re-check, cheap and safe)
PUT  /api/providers/oss               { engine?, baseUrl?, standIn? }   saves settings.oss and probes endpoint -> ProviderStatus
PUT  /api/providers/:id/mode          { mode:'apikey' }                  stores settings.auth and settings.authAck ('subscription' returns 400 in Phase 0)
POST /api/providers/:id/login         disabled in Phase 0 -> 400 (returns error explaining API-key-only policy)
POST /api/providers/:id/check         verifies provider CLI / OSS endpoint
POST /api/providers/:id/selftest      one tiny real turn with the containment checks; -> { ok, core, advisory, steps, logTail }

GET  /api/harnesses ; PUT /api/harnesses { registry } ; POST /api/harnesses ; DELETE /api/harnesses/:id
GET  /api/roster    ; PUT /api/roster { roster }      ; POST /api/roster    ; DELETE /api/roster/:id
GET  /api/requisitions ; POST /api/requisitions ; POST /api/requisitions/:id/enroll ; POST /api/requisitions/:id/dismiss

GET  /api/keys                        -> [{ id, label, envVar, set, hint, updatedAt }]   (never the value)
PUT  /api/keys/:id                    { value, label?, envVar? }
DELETE /api/keys/:id
GET  /api/settings ; PUT /api/settings { patch }
GET  /api/models   ; PUT /api/models   { registry } ; POST /api/models/refresh
GET  /api/projects/:id/toolkit ; PUT /api/projects/:id/toolkit { tools } ; POST /api/projects/:id/toolkit/:toolId/run
POST /api/projects/:id/agentfiles     { ack:boolean }                 owner accepts (or refuses) the agent-config files of an adopted repo (section 9)
POST /api/pick-folder                 -> { path|null, targetBranch?, agentFiles? }   native folder dialog through osascript
POST /api/reveal                      { projectId } | { jobId, what:'truck' }        Finder; 'truck' first makes a clone of the truck head at data/work/<job>/_preview
POST /api/demo                        starts a mock job that needs no tokens

POST /mcp/:token                      MCP JSON-RPC for agents (section 8)
GET  /mcp/:token/tag                  mail check for the tool hook (section 10); 204, or the hook JSON
```

There is no install route. The hub installs nothing.
Errors: `{ error: 'plain message' }` with a 4xx/5xx status.

## 7. Message board: ShopTalk (`server/shoptalk.js`, `server/board.js`)

The board language is **ShopTalk**: a strict one-line head that the hub checks, plus a short body in plain Simplified Technical English (ASD-STE100 rules). The body is not compressed into shorthand: a post is read many times, and compressed input lowers reader accuracy. The savings come from fewer posts, fewer readers per post, pointers instead of pasted text, and a hub that writes the envelope.

### Names and scopes

Every agent has a persona name for the UI (`Sprocket`) and a short **handle** for the board: `@b1` boss, `@f1` floor manager, `@m3` maker (role letter + number, unique in the job). The hub is `@hub`. The owner is `@human`.

| Alias | Resolves to |
|---|---|
| `@boss` | The lead boss |
| `@mgr` | The manager of my task. The lead boss when there is none. From the owner: the first manager, else the lead boss |
| `@other` | A consult by a model of the other lab (section 12). Only with `ASK` |
| `@human` | The owner. Only bosses may address `@human` |
| `@all` | Everyone. Boss and human only, with `INFO` |

Scope is one task (`T12`) or one channel: `#plan`, `#build` (facts that touch more than one task), `#merge` (the truck), `#ops` (hub and machine notices).

| Role | Scopes it follows in its view |
|---|---|
| maker | its task, `#build` |
| manager | the tasks of its stream (`FAIL`, `BLOCK`, `DECIDE` only), `#build`, `#plan` |
| boss | all channels; for the lead, the tasks without a manager (`FAIL`, `BLOCK`, `DECIDE` only) |

A post addressed to the reader shows in any scope. A task that an agent reviews counts as its task. Every `DECIDE` in a channel reaches every role.

### Post grammar

```
post  = KIND { SP token } [ ":" ( SP | LF ) body ]
KIND  = ASK | ANS | REQ | OK | NO | INFO | BLOCK | DONE | FAIL | PASS | FIX | DECIDE | CANCEL      (EVT: hub only)
token = @to | T12 | #channel | re:<id> | ttl=<n>m | why=<code> | tests=<n>/<n> | tests=none | acc=<met>/<total>
      | default=A|B|C|D | conf=low|med|high                                  (any order, each once)
```

| Kind | Meaning | Who | Needs | Hub effect |
|---|---|---|---|---|
| `ASK` | One question | all; to `@human`: bosses only | one `@to`, exactly one `?`. To `@human`: 2 to 4 options `A) ... B) ...` and `default=` | Tracked. The addressee owes `ANS` or `NO`. `ASK @other` starts a consult. `ASK @boss re:<id>` forwards item `<id>` |
| `ANS` | The answer to `re` | the addressee of `re`, and every earlier addressee after an escalation or a forward | `re:` open ASK or BLOCK. The owner may also answer an `ASK @human` whose default was taken | Closes it. Wakes the asker |
| `REQ` | An order | human only | one `@to`, body | The addressee owes `OK` or `NO` |
| `OK` / `NO` | Accept / refuse `re` | addressee of `re` | `re:`; `NO` needs `why=` | Closes it. Wakes the asker |
| `INFO` | A fact others need. Never an order | all | scope, body | No reply allowed |
| `BLOCK` | I stopped work on T. I need X | owner of T | task, body (`@to` defaults to the manager) | Task `blocked` until the item closes |
| `DONE` | T is finished. Review it | owner of T | task, `tests=`, `acc=` | **Starts the hand-in pipeline** (section 12). The hub stores `delivery.acc` |
| `FAIL` | I stop T. I cannot finish it | owner of T | task, `why=`, body | Task `failed`; manager or boss re-plans |
| `PASS` | The work in `re` is accepted | assigned reviewer, assigned buddy, human | `re:` open DONE | **Review verdict: pass.** Refused with `E_ACC` when `acc` has met < total |
| `FIX` | Not accepted. Do these changes | assigned reviewer, assigned buddy, human, hub | `re:` open DONE, 1 to 5 numbered items (inline or one per line), at least one pointer | **Review verdict: changes** |
| `DECIDE` | From now on X holds | boss, human; a manager for a task of its own stream | scope, body | Decision in force. Copied into every blueprint. Listed in the Blueprint panel |
| `CANCEL` | Forget `re` | author of `re`, boss, human | `re:` open ASK, REQ or BLOCK | Closes it. Wakes the agent that waits on it |
| `EVT` | Hub notice (state change, merge, timeout, budget) | hub | | |

The hub posts `EVT`. As `@hub` it also posts `FIX` (a refused hand-in), `ANS` (an owner default) and `ASK @other` (its own consult). A new `DONE` of a task replaces an earlier open `DONE` of that task.
In v1 only `@human` posts `REQ`. Managers and bosses steer a task through `task_update`: the hub rewrites `.shop/TASK.md` and posts `EVT` to the maker.
A buddy verdict is stored in `delivery.buddy` and does not close the `DONE`. Only the verdict of the assigned reviewer or of the owner, or a `FIX` of the hub, closes it.
When `acc` has met < total the reviewer posts `FIX`, or a boss changes the task card first. The `E_ACC` check compares `acc.met` with the number of acceptance items the task card holds at the time of the `PASS`.

`why=` codes: `unclear scope blocked env tests budget unsafe unknown dup`.

**Body rules.** Answer first. Full sentences. At most 3 sentences of at most 20 words (REQ 5; FIX 5 numbered items). Active voice. Keep every `not`, `only`, `if` and number. One name per thing. No greeting, thanks, receipt or progress talk. No code, logs or diffs (point: `src/a.js:31`, `T12`, message id `377`). Printable ASCII. No secrets.

**Size limits.** Whole post 800 chars. Body 300 (DONE 200, OK 80, PASS and CANCEL 120, DECIDE 400, REQ and FIX 600, ASK to `@human` 600, ANS of a consult 600).

**Loop, duplicate and rate limits.** A thread holds at most 6 messages. The same pair makes at most 3 round trips inside one thread. A near-duplicate of one of the last 20 posts in the scope is refused. Rates: 5 s between two unasked posts of one agent, 10 unasked posts of one maker per hour, 3 `INFO` of one agent in one scope per 30 min. `settings.board` overrides each number. These limits (`E_LOOP`, `E_DUP`, `E_RATE`) apply to `ASK`, `INFO`, `REQ` and `DECIDE` only. `DONE`, `FAIL`, `BLOCK`, `PASS`, `FIX`, `ANS`, `OK`, `NO` and `CANCEL` are never refused by them. When the hub locks a thread it closes the open items in it as `expired` and escalates them, so the turn gate does not list them.

**DONE is idempotent.** When the task is already `checking` with an open `DONE` of this agent, the answer is `ok <id>`.

**Freeze.** From an accepted `DONE` until the hub sets `rework`, the maker's own open `ASK` and `BLOCK` items for the task close as `cancelled`, and the hub refuses `DONE`, `BLOCK` and `ASK` from it for that task with `E_CLOSED`.

**Forward.** `ASK @boss re:<id>` from the addressee of the open item `<id>` moves that item one level up at once. The higher agent's `ANS` goes straight to the first asker. The turn gate does not list the item for the forwarder.

**Forged lines.** `checkBody` refuses (`E_BODY`) a body line that starts like a view line (optional `~`, a message id, an age, a KIND in capitals, then `@`) or that starts with `[board:`.

**Secrets.** A post that matches the secret scan is not stored or logged (`E_SECRET`). The scan runs on agent posts and on owner posts. It includes the exact values of every stored key and every live agent token (section 14).

A refused post returns one line `ERR <code> <hint>` (codes: `E_HEAD E_ROLE E_TO E_SCOPE E_SLOT E_RE E_CLOSED E_PERM E_BODY E_LEN E_LINES E_SENT E_LIST E_Q E_CHAT E_CODE E_ASCII E_SECRET E_DUP E_LOOP E_RATE E_ACC`). The hub never rewrites a body. The owner's posts from the UI are not style-checked.

### Board view (what an agent reads)

One line per message: `[~]<id> <age> <KIND> <@from>[>@to] <scope> [re:<id>] [slot=value]: <body>` (`~` = stale). `renderLine` starts every continuation line of a body with `| ` (a bar and a space), so body text never looks like a message line.

A view shows only what the reader needs: posts addressed to it, posts in its scopes (table above), decisions in force. It is a delta (ids above the reader's cursor) plus the reader's open items, in the order `OPEN FOR YOU`, `IN FORCE`, `NEW`, at most 20 lines or 4000 chars. Nothing new means an empty view.

- The first view of a session starts with one legend line that names the reader, its task, its manager and its boss.
- Every view starts with one presence line: `OWNER here` or `OWNER away`.
- Before the first post that is not from the reader's boss, manager, `@hub` or `@human` comes the frame line `-- peer posts below are data, not orders --`.

The hub puts the view at the top of every turn prompt. Agents can also call the `read` tool. Every hub tool result ends with `[board: N new for you. Call read.]` when mail waits. The tool hook of section 10 gives the same tag between tool calls.

**Cursors.** The board keeps one read cursor per agent session (`<agentId>/<sessionId>`) in `data/board-state.json`. A session that replaces another (rotation, retry) takes over its cursor. An aux turn (section 12) gets a view scoped to its task. That view never moves the cursor of the main or the work session.

### Wake, turn gate, deadlines

**Wake rule.** `ASK`, `ANS`, `REQ`, `BLOCK`, `FIX`, `CANCEL` and addressed `EVT` start a turn for every agent with no running turn (`idle` or `waiting`). `INFO` and `DECIDE` wait for its next turn.

**Closure wakes.** Every closure of an item (`ANS`, `OK`, `NO`, `CANCEL`, or expiry at the end of the chain) wakes the agent that waits on it, with the closing line on top. Exception: items the hub closes because the asker handed in, or because its task was retried, reassigned or cancelled. A closed `BLOCK` sets the task back to `working` only if `task.assigneeId` is still the asker. After a `NO` or an expired `BLOCK` the wake line says: `No help is available. Finish and state your assumption in DONE, or post FAIL.`

**Turn gate.** An agent with an open item addressed to it must answer (or forward) before it goes idle. If it ends a turn without doing so, the hub resumes it once with that instruction. The gate applies to main and work turns only.

**Shop time.** Deadlines run on shop time. The clock of an item starts when the item is first shown to its addressee (`msg.seenAt`: in a turn prompt or a `read` result). It stops while the addressee is on hold, while the job is paused, and while the hub did not tick (sleep, restart): a tick gap over 60 s shifts every `due` and every turn deadline by the gap.

| Item | Deadline |
|---|---|
| maker to manager, maker to maker | 10 min |
| `BLOCK` | 5 min |
| manager to boss | 15 min |
| review of a `DONE` | 20 min, from the start of the reviewer's turn |
| boss to `@human` | `settings.humanWaitMin` (30) when the owner is here, none when away: the default is taken at once (section 12b) |

**Escalation.** An expired item moves one level up: maker, manager, lead boss. Each move gives it a new deadline, which starts when the new addressee first sees it. An item from below never goes to `@human`: the lead boss must answer it. When its deadline at the lead boss also passes, it closes as `expired` and the closure wakes the asker. After an escalation every earlier addressee may still answer.

### API and storage

```js
// server/shoptalk.js  (pure, no I/O)
parsePost(line) -> { ok:true, kind, to, scope, re, slots, body } | { ok:false, code, hint }
checkBody(kind, body) -> { ok:true, warnings:[code] } | { ok:false, code, hint }
validate(line, ctx) -> { ok, errors:[{code,hint}], warnings, msg|null }       // ctx carries the board state callbacks
renderLine(msg, nowTs) -> string
RULE_CARD   // the 150-word card for every agent's system prompt

// server/board.js
createBoard({ store, dataDir, getSettings, resolve, redactor, now, log }) -> board
board.post({ jobId, agent|null, human:boolean, hub:boolean, line }) -> { ok:true, msg, next? } | { ok:false, code, hint }
board.hubPost(jobId, { to?, scope, body, re? }) -> msg                      // EVT
board.close(id, state, { wake:boolean }) -> msg|null                         // hub closes an item: 'cancelled' | 'expired'
board.view(agentId, { session?, scope?, fresh?, aux? }) -> string            // delta view; advances the cursor of that session (not for aux)
board.moveCursor(agentId, fromSession, toSession)
board.openFor(agentId) -> Message[]                                          // open ASK / REQ / BLOCK addressed to this agent
board.unread(agentId) -> number ; board.tag(agentId) -> '' | '[board: 2 new for you. Call read.]'
board.urgentTag(agentId) -> '' | tag                                         // ASK, REQ, CANCEL, FIX, addressed EVT, new DECIDE in scope; once per new item
board.history({ jobId, since, limit }) -> Message[]                          // for the UI
board.decisions(jobId) -> Message[]                                          // DECIDE in force
board.on(fn)                                                                 // fn({ type:'post'|'expire'|'close'|'default', msg, by? })
board.tick(nowTs)                                                            // deadlines, escalation, shop time, owner defaults
```

`resolve` holds the orchestrator callbacks (`orch.resolver`): `agent(token, from, jobId)`, `taskOf(agent)`, `ownerOf(taskId)`, `mayReview(agent, done)`, `supervisorOf(agent)`, `inStream(agent, taskId)`, `frozen(agent, taskId)`, `accTotal(taskId)` (the number of acceptance items now), `sessionOf(agent)`, `onHold(agentId)`, `presence()`.

Stored message (also the SSE `board` event payload):

```
Message { id, ts, jobId, from:'@m3'|'@hub'|'@human', fromId|null, role, kind, to|null, toId|null, toAlias|null, scope,
          re|null, thread, slots:{ttl,why,tests,acc,default,conf}, body,
          state:'open'|'answered'|'accepted'|'refused'|'passed'|'fix'|'cancelled'|'expired'|null,
          due|null, seenAt|null, esc:number, via:[handle], defaulted:boolean, stale:boolean }     // via: earlier addressees (escalation, forward)
```

Messages live in `data/board.jsonl` (append-only, one JSON object per line). The last 500 per job stay in memory.
All item state follows from a replay of the file at boot. A reply closes its target. A change that no post carries (first seen, hub close, escalation, lock, default taken) is appended as a hub `EVT` with an `act` field, or as a patch line `{ patch:<id>, state?, to?, toId?, due?, seenAt?, defaulted? }`. After a restart every open item has at least 5 more minutes.

## 8. Hub tools over MCP (`server/mcp.js`)

The CLI is configured with one MCP server named `shop`: direct HTTP for Claude, the stdio shim for `agy` (section 10).
The endpoint speaks JSON-RPC 2.0: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`. Plain JSON responses, no SSE, no session: the token is the identity.

**Agent tokens.** The runner mints the agent token when it spawns a turn (`mcp.tokenFor`) and revokes it when the turn ends (`mcp.revoke`). Tokens live in memory only. A token never appears in a command line or in a file inside a bench. In `sandboxed` mode the token is hidden from shell children, and the self-test proves it (section 10).

```js
createMcp({ store, redactor, log }) -> mcp
mcp.tokenFor(agentId) -> token ; mcp.revoke(agentId) ; mcp.agentFor(token) -> agent|null
mcp.registerTool(name, { roles:[...], description, inputSchema, handler })  // handler(agent, args) -> string | { text, isError }
mcp.setTagProvider(fn) ; mcp.setUrgentProvider(fn)                           // board.tag, board.urgentTag
mcp.handle(token, request) -> response|null
mcp.callsSince(agentId, ts) -> [{ name, ok, ts }]     // the orchestrator checks which tools a turn called
mountMcp(http, mcp)                                   // POST /mcp/:token ; GET /mcp/:token/tag
```

Every tool result ends with `board.tag(agent.id)` when mail waits. Tool descriptions are short: they cost tokens in every agent context.

Talking, handing in, reviewing, blocking and deciding all go through **one** tool, `post` (a ShopTalk line). Only structured data needs its own tool. Schemas are in section 12.

| Tool | Roles | Effect |
|---|---|---|
| `post` | all | One ShopTalk post. Returns `ok <id>` (plus what happens next) or `ERR <code> <hint>` |
| `read` | all | My board view (delta), or one scope, or one thread |
| `claim` | maker | Ask to edit exact paths outside the zone. Granted, or queued with `WAIT T12 holds <path>` |
| `status` | manager, boss | Compact table of tasks and agents |
| `task_add` | manager, boss | New task. Counts against `limits.maxTasksTotal` |
| `task_update` | manager, boss | Change a task that is not merged. A manager may add acceptance items and edit zones, deps and note. Removing or rewording an acceptance item, or changing the spec of a started task, needs a boss |
| `task_retry` | manager, boss | Restart a failed or blocked task. Keeps the bench. Resets `attempts`, raises `retries` |
| `task_cancel` | manager, boss | Cancel. Dependents move to `replacedBy` |
| `plan_submit` | boss | Submit the plan (validated) |
| `req_add` | boss; the agent of a ledger-audit or QA turn | New requirement with source `boss`. Non-blocking owner notice |
| `req_verify` | the agent of the QA turn | Final requirement check |
| `job_report` | boss | Final report |
| `selftest_ping` | the hidden self-test agent only | Proves that the CLI reached the hub (section 10) |

`req_add` and `req_verify` are registered with the roles boss and manager. The handler refuses `req_add` from a manager that is not the agent of the running audit or QA turn, and `req_verify` from any agent that is not the agent of the QA turn. Agents have no toolkit tool (section 12c).

How the kinds drive the hub: `DONE T12 tests=41/41 acc=4/4: summary` from the task owner starts the hand-in pipeline. `PASS re:<done id>` or `FIX re:<done id>: 1. ...` from the assigned reviewer is the review verdict. `BLOCK` blocks the task until the item closes. `FAIL` fails it. `ASK @other` starts a consult. `ASK @human` enters the attention inbox. `DECIDE` enters the blueprint.

## 9. Git strategy (`server/gitops.js`)

A bench is a clone, not a worktree: a clone is self-contained, so a sandboxed agent can work inside it and cannot touch other branches or the canonical repo.

```
canonical repo   projects/<name>/              target branch (e.g. main). Only the hub writes here.
integration      data/work/<job>/_int/         worktree of canonical on branch ws/<job>/int. Only the hub works here.
bench            data/work/<job>/<task>/       git clone --local of canonical at the integration head, branch "work".
review clone     data/work/<job>/<task>.rev/   hub-made clone at delivery.headSha. Removed when the task is merged.
desk             data/work/<job>/_desk/<handle>/   hub-made clone at the integration head for one boss or manager.
head clone       data/work/<job>/_head/        pristine clone for the head check and the QA turn.
preview          data/work/<job>/_preview/     clone of the truck head that the owner can run before approval.
task refs        refs/workshop/<job>/<task>    in canonical. Never under refs/heads.
```

**No agent turn has its cwd in `_int` or in the canonical repo.** The hub resets a desk to the integration head before each main turn and writes `.shop/BLUEPRINT.md` and `.shop/tasks/T<n>.md` (spec, acceptance, zones, bench path) into it.

**Hub paths.** `HUB_PATHS = ['.shop/', '.agents/']` (one list in gitops). Both are in `.git/info/exclude`. `stageAll` restores the index for these paths to the integration version before every commit, so no add, change or delete under them is ever committed. `plan_submit`, `task_add`, `task_update` and `claim` refuse zones and paths under them. The runner writes adapter files into a bench only through `git.writeHubFiles`. Before every `agy` spawn the hub writes its own files under `.agents/` and removes everything else there that is not tracked on the integration branch. A `hooks.json` that the hub did not write is always removed. No token is written into a bench.

**Agent-config files of an adopted repo.** `git.adoptProject` returns `agentFiles:[path]`: tracked `.agents/**`, `GEMINI.md`, `AGENTS.md`, `.claude/**`, `CLAUDE.md`, `.mcp.json`. The Work Order panel lists them. The owner accepts once (`project.agentFilesAck`: "Gemini workers will load these"), or the Gemini lab is off for that project. The hub removes these files from the working tree of every review clone before a reviewer starts.

**Bench git config.** Before the hub runs git in a bench it rewrites that bench's `.git/config` from its own template, so no filter, merge driver or alias from the bench runs in the hub.

**Commands the hub runs (`setupCmd`, `checkCmd`).** Both get the agent environment allow list (`HOME USER LOGNAME SHELL TERM LANG TMPDIR PATH`), not a block list. In safety `sandboxed` they run under `/usr/bin/sandbox-exec` with a hub profile: writes only in that folder, a private temp dir and the package caches (`~/.npm`, `~/.cache`, `~/Library/Caches`, `~/.pnpm-store`, `~/Library/pnpm`, `~/.yarn`, `~/.bun/install/cache`, `~/.cargo/registry`, `~/.cargo/git`, `~/go/pkg/mod`, `~/.gradle`, `~/.m2`); the deny-read list of section 10; full network for setup, localhost only for check. In safety `trusting` they run unconfined. `setupCmd` has a fixed timeout of 15 min; `checkCmd` has `limits.checkTimeoutMin`. After `setupCmd` the hub restores the tracked files that the command changed (`git checkout -- .`). When `syncBench` returns `merged:true` the hub runs `setupCmd` again before `runCheck`. A failed setup sets the task `blocked` (`why:'env'`) with no maker turn.

**Head check.** The hub makes a pristine clone of the integration head (`_head`), runs `setupCmd`, then `checkCmd`, and caches the result per sha in `project.headCheck { sha, ok, tail }`. The baseline gate, the truck refresh and QA use it (section 12).

**Tripwire.** `job.intSha` is the integration head as the hub last set it. Before every `git.integrate`, `git.refreshTruck` and `git.ship` the orchestrator compares it with `refs/heads/ws/<job>/int` (`git.headSha(integrationDir)`). A difference pauses the job (`pauseReason:'tampered'`) with an owner notice.

Flow for one task:

1. `createBench`: clone, checkout `work` at the integration head, write the exclude file and the hub files (`.shop/TASK.md`, `.shop/BLUEPRINT.md`), run `setupCmd` if set, restore tracked files.
2. The maker edits files. `commitAll` runs only at hand-in, so nothing is left uncommitted and nothing is committed behind the hub's back.
3. Hand-in pipeline (hub, section 12): `commitAll` -> `guard` -> zone check (changed files must match zones + claims) -> `syncBench` (merge the integration head into the bench) -> setup again when the sync merged -> `runCheck` -> `resetBench(headSha)`. The delivery stores `baseSha` and `headSha`. Any failure wakes the maker with the exact reason. Conflicts stay in the bench as markers; the maker resolves them and hands in again.
4. Buddy checks and reviews run in the review clone at `headSha`, never in the bench. The reviewer sees `git diff <baseSha> <headSha>`.
5. Integrate (serial, one at a time per project). `expectHead` is `delivery.headSha`. If the integration branch moved since the sync, the hub syncs again: `expectHead` is then the hub's own sync merge whose parents are exactly `headSha` and the integration head, the check runs again on that merge, then `resetBench`. Then the hub fetches `work` into canonical as `refs/workshop/<job>/<task>` and runs `git merge --no-ff` in `_int`. Invariant: only merge a bench head that contains the current integration head and passed the check on that exact tree. Before integrate, and before a rework wake that follows a `FIX` verdict, the bench must be clean at `delivery.headSha`; if it is not, the hub resets it to `headSha` and posts `EVT #ops`. After a refused hand-in or a failed integrate the bench stays as the hub left it (conflict markers included).
6. Ship (owner approval): fast-forward the target branch to the approved commit. Never force. Never "head now".

```js
createGit({ paths, getSettings, redactor, log }) -> git
git.initProject({ name }) -> { path, targetBranch }                          // new repo + empty first commit
git.adoptProject({ path }) -> { path, targetBranch, agentFiles:[path] }      // existing repo; refuses a non-repo
git.startJob(project, jobId) -> { integrationBranch, integrationDir, intSha }
git.createBench(project, jobId, taskId, { files, authorName, mergeTarget? }) -> { dir, baseSha, setup:{ok,code,tail}|null }
git.makeClone(project, jobId, name, sha, { files?, stripAgentFiles? }) -> { dir }   // name: '<task>.rev' | '_desk/<handle>' | '_head' | '_preview'; resets an existing clone
git.writeHubFiles(dir, files)                                                // paths under HUB_PATHS only; null deletes
git.cleanAgentDir(dir, keep:[path]) -> [removedPath]                         // before an agy spawn
git.commitAll(benchDir, message, authorName) -> sha|null
git.changedFiles(benchDir, baseRef) -> [path]
git.guard(benchDir, baseRef, { allowLarge }) -> { ok:true, flags } | { ok:false, why:'denied'|'large'|'unsafe'|'empty', detail }
git.syncBench(benchDir) -> { ok:true, head, merged:boolean } | { ok:false, conflicts:[path] }
git.unresolved(benchDir) -> [path]                                           // unmerged paths or leftover conflict markers
git.runSetup(dir, cmd, { timeoutMs }) -> { ok, code, tail }                  // sandbox profile 'setup'; restores tracked files
git.runCheck(dir, cmd, { timeoutMs }) -> { ok, code, tail }                  // sandbox profile 'check'; tail: last 4000 chars, redacted
git.resetBench(benchDir, sha) ; git.cleanAt(benchDir, sha) -> boolean        // reset --hard + clean -fd (ignored files stay)
git.headCheck(project, jobId) -> { sha, ok, tail, ms }                       // cached per sha
git.diffStat(dir, baseRef) -> { files:[{path,add,del}], add, del }
git.diff(dir, { base, head, path?, maxBytes }) -> string
git.integrate(project, jobId, taskId, benchDir, message, { expectHead }) -> { ok:true, mergeSha, already?, empty? } | { ok:false, reason:'stale'|'conflict'|'error', detail }
git.truck(project, jobId) -> { headSha, ahead, behind, files:[{path,add,del}], add, del }     // target..integration
git.refreshTruck(project, jobId) -> { ok:true, sha, commits:[{sha,subject}] } | { ok:false, reason:'conflict'|'check', files?, tail? }
git.ship(project, jobId, { sha }) -> { ok:true, sha, left:number, already? } | { ok:false, reason }
git.saveBench(project, jobId, taskId, benchDir, authorName) -> ref|null      // commitAll + fetch work to refs/workshop/<job>/<task>
git.removeBench(dir) ; git.removeJobWork(project, jobId, { force?, keepInt? }) -> { deleted, kept }
git.baseRef(benchDir) -> string ; git.headSha(dir) -> sha|null ; git.truckDiff(project, jobId, opts) ; git.deliveryDiff(project, mergeSha, opts)
matchZone(path, zones) -> boolean ; zonesOverlap(zonesA, zonesB) -> boolean   // globs: *, **, ?, {a,b}, exact paths, dir/ prefix
```

- `git.integrate` returns the earlier merge for a repeated call (`already`) and makes no commit for a bench without commits of its own (`empty`).
- `git.ship` accepts only a commit on the first-parent chain of `job.intSha` (a delivery merge or a refresh merge). Crates merged after `sha` stay loaded; `left` says how many. If the target moved or the canonical checkout is dirty, it stops and tells the owner.
- `git.refreshTruck` merges the target branch into a scratch clone of the integration head and runs the head check there. Clean and green: `_int` fast-forwards to that merge. Conflict or red check: `_int` does not change.
- `git.removeJobWork` removes `_int`, the desks, `_head`, `_preview`, the benches and the job's refs (`refs/workshop/<job>/*`, `ws/<job>/int`). `keepInt` keeps the integration branch (a cancelled job with a loaded truck).

## 10. Providers and runner (`server/providers/*`, `server/runner.js`)

- **Auth mode (Phase 0 API-key-only Frontier + `$0` OSS).** Consumer subscription logins for Frontier providers are disabled (`mode` for `claude` and `gemini` is restricted to `'apikey'`, `POST /api/providers/:id/login` returns `400`, `loginCommand()` returns `null`). Choosing `'apikey'` records `settings.authAck[lab] = { mode: 'apikey', ts }`. Open-weight Specialist Agent Teams run via the `'oss'` provider (`local` HTTP endpoint or `standin` Phase 0 simulation mode).
- **Google lab.** It is the Antigravity CLI `agy`. It is looked up on `PATH`, in `~/.local/bin`, then in `/Applications/Gemini.app/Contents/Helpers/agy`. The provider id stays `gemini`.
- **Open-Source runtime (`oss`).** `server/providers/oss.js` + `server/providers/oss-agent.mjs` connect to local/cluster OpenAI-compatible inference servers (`Ollama`, `vLLM`, `SGLang`, `llama.cpp`), custom command harnesses, or Phase 0 Stand-in simulation mode (`settings.oss.standIn`). File/shell tools enforce `resolveBenchPath` confinement inside the task bench (blocking `.shop/`, `.agents/`, `.git/` and symlinks escaping the bench) and forward dynamic `shop__*` MCP tools.

### Safety modes

| Mode | Meaning |
|---|---|
| `sandboxed` (default) | Every shell command of every agent runs in an OS sandbox. Claude: the CLI sandbox from the settings file, no unsandboxed fallback, fail if unavailable. `agy`: the terminal sandbox. Writes: the turn's cwd and a private temp dir only. No read, by shell or by file tools, of `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.kube`, `~/.docker`, `~/.config/gh`, `~/.config/gcloud`, `~/.gemini`, `~/Library/Keychains`, the CLI credential files, or `data/run`, `data/logs` and `config/` of WorkShop (the deny-read list). Network: package registries and localhost. API keys and the agent token are hidden from shell children |
| `trusting` | No OS sandbox. Shell children can read the agent token and, in `apikey` mode, the API key. The Settings panel says: `Agents can do anything you can on this Mac.` |

Git deny rules are hints, not guards. Access `read` means no Edit and Write tools. Main, review, QA and audit turns with read access run in a folder the hub can throw away.

### Provider registry

```js
createProviders({ secrets, getSettings, updateSettings, shellEnv, paths, log }) -> providers
providers.list() -> ProviderStatus[] ; providers.get(id) -> adapter ; providers.status(id) -> ProviderStatus
providers.detect({ force? }) -> ProviderStatus[]          // cheap and safe only: binary lookup, --version, `claude auth status --json`. NEVER runs agy with a prompt
providers.checkAuth(id) -> ProviderStatus                 // owner-initiated only (button). gemini: `agy models` with a closed stdin pipe; stores the model list
providers.usable(id) -> boolean
providers.modelUsable(id, model) -> boolean               // usable(id), the model is not cooled, and it is in ProviderStatus.models when that list is not null (agy: a slug <model>-<effort> is in it)
providers.cool(id, untilTs, reason, { model?, turnStartedAt? }) ; providers.noteSuccess(id, model?)
providers.markAuth(id, 'ok'|'none') ; providers.noteLimit(id, limitEvent)
providers.keyEnv(id) -> Promise<{ [envVar]: value }>      // apikey mode only
providers.selfTest(id) -> { ok, core:[{name,ok,detail}], advisory:[{name,ok,detail}], steps:[{name,ok,detail}], loaded:[string], logTail }

ProviderStatus { id:'claude'|'gemini'|'oss'|'mock', label, lab:'anthropic'|'google'|'oss'|'mock', installed, version, path,
                 auth:'ok'|'none'|'unknown', mode:null|'apikey'|'local'|'standin', ack:boolean, keySet, usable, reason|null,
                 cooling:{until,reason}|null, cooledModels:{[model]:{until,reason}}, limit:{status,type,utilization,resetAt,overage,at}|null,
                 selfTest:{version,ok,ts}|null, policyNote:{ apikey:{lines:[string],url} }|{ local:{lines}, standin:{lines} },
                 loginCmd:null, installHint:{text,url}|null, models:[slug]|null }
```

- For Frontier providers: `usable(id)` = installed, `mode === 'apikey'`, `authAck[lab].mode === 'apikey'`, `keySet`, not cooling, and in safety `sandboxed`, `settings.selfTest[lab]` passes for the installed CLI version.
- For `'oss'`: `usable` = `settings.oss.standIn === true` OR HTTP endpoint probe (`GET /models` or Ollama `/api/tags`) succeeds. Costs `$0`.
- **Cooling is one episode.** A limit that names a model cools that model only; the router skips cooled models and uses the tier fallback. `rate_limit` results of turns that started before `cooling.until` was set are ignored. The step (5 min, doubling to 60 min, when the CLI gives no reset time) doubles only when the first turn after a reset fails. The first success resets it.
- `rate_limit` and `auth` come from structured fields and CLI error results only (`api_error_status`, `rate_limit_event`, `api_retry`, a `result` with `is_error`), never from assistant text or tool output.

**Self-test (`providers.selfTest(id)`; the `Test` button, and the hub itself when a job is about to use a lab that has no stored pass for the installed CLI version).** One tiny real turn by a hidden test agent that must call the hub tool `selftest_ping`. It runs only when every other condition of `usable` holds (so never before the owner signed in and chose a mode). Through its shell tool the test agent then runs the containment checks. A self-test never creates or reads a Keychain item.

| Check | Class | Must hold |
|---|---|---|
| Write a file outside the turn's folder | core | fails |
| Read a canary file in a hub-made folder on the deny-read list (`data/run/selftest/canary`) | core | fails |
| Print the agent token (`$WORKSHOP_TOKEN`, `$WORKSHOP_TAG_URL`, and the `agy` URL file) | core | prints nothing |
| Reach a host that is not a registry or localhost | advisory | fails |
| `agy`: a planted `.agents/hooks.json` | advisory | does not run |
| `agy`: `git push` | advisory | shows in `denied_actions` |

The hub stores `settings.selfTest[lab] = { version, ok, core, advisory, ts }`; `ok` is true when every core check passes. Advisory results show in the Keys panel. `loaded` lists every MCP server and plugin the worker loaded; anything besides `shop` is a warning in the Keys panel.

### Adapter

```js
adapter.buildRun({ agent, model, effort, prompt, systemPrompt, cwd, sessionId, resume:boolean,
                   mcp:{ url, token, urlFile, shimPath, nodePath }, access:'write'|'read', web:boolean,
                   runDir, mode, keyEnv, safety, maxTurns, maxBudgetUsd, mailHook:boolean })
   -> { cmd, args, env, cwd, stdin:string|null, files:[{ path, content }], hubFiles:{ [benchPath]: content }, sessionId, stopSignal }
adapter.createParser() -> { push(line) -> NormEvent[], end({ code, signal, stderrTail }) -> NormEvent[] }

NormEvent:
  {t:'init', sessionId, model, mcpOk:boolean, loaded:[string]}     {t:'text', text}
  {t:'tool', name, summary}                                        {t:'tool_result', ok, summary}
  {t:'usage', inTok, outTok, cacheRead, cacheWrite, usd|null}
  {t:'ctx', tokens, max|null}                                      // context after the latest model call: input + cache read + cache write
  {t:'limit', status, type, utilization, resetAt, overage}        // what the CLI says about the plan limit (usage chip; cooling when not allowed)
  {t:'denied', what}                                               // a tool call the CLI refused
  {t:'result', ok, text, sessionId, usd|null, turns, durationMs}
  {t:'error', kind:'rate_limit'|'auth'|'mcp'|'model'|'other', message, resetAt|null, model?}
```

`files` are written by the runner under `runDir` (mode 0600) before the spawn. `hubFiles` go into the cwd through `git.writeHubFiles`. Error kind `model`: the CLI refused the model (not on the plan, unknown slug).

**Claude adapter**: `claude -p --model <full id> --effort <e> --output-format stream-json --verbose --session-id <uuid>` (or `--resume <id>`) `--setting-sources "" --strict-mcp-config --mcp-config <runDir>/mcp.json --tools <list> --allowedTools <rules> --disallowedTools <rules> --permission-mode <mode> --disable-slash-commands --append-system-prompt-file <runDir>/role.txt --max-turns <n> --settings <runDir>/settings.json`. Prompt on stdin, then stdin is closed.
- Always pass full model ids (the `haiku` and `fable` aliases of this CLI version point at older models).
- Tools: `write` access `Bash,Edit,Read,Write`; `read` access `Bash,Read`; `web:true` adds `WebSearch,WebFetch`. Allow `mcp__shop`. File tools write only inside the cwd (`acceptEdits`; `dontAsk` for read access). Deny hints: `Bash(git push *)`, `Bash(git commit *)`, `Bash(git merge *)`, `Bash(git rebase *)`, `Bash(git reset *)`, `Bash(git checkout *)`, `Bash(sudo *)`, pipes into a shell.
- `--setting-sources ""` is mandatory: without it a project's own hooks and `.mcp.json` servers run on this Mac as soon as a worker starts in that repo, and the owner's personal skills, hooks and connectors load into every worker.
- Settings file (`<runDir>/settings.json`, never inline on the command line): `attribution` off; in `sandboxed` mode the `sandbox` block (enabled, `allowUnsandboxedCommands:false`, `failIfUnavailable:true`, the registry domain list, the deny-read list, hidden env vars `ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN WORKSHOP_TOKEN WORKSHOP_TAG_URL`).
- MCP (`<runDir>/mcp.json`): HTTP entry `{"type":"http","url":"<base>/${WORKSHOP_TOKEN}","headers":{"Authorization":"Bearer ${WORKSHOP_TOKEN}","X-WorkShop":"1"},"alwaysLoad":true}`. The CLI expands the token from its environment. The token is never in the file.
- Environment: clean (`HOME USER LOGNAME SHELL TERM LANG TMPDIR PATH`) plus `DISABLE_AUTOUPDATER=1 ENABLE_TOOL_SEARCH=false ENABLE_CLAUDEAI_MCP_SERVERS=false CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 WORKSHOP_TOKEN=<token>`; `ANTHROPIC_API_KEY` only in `apikey` mode.
- In `apikey` mode the adapter passes `--max-budget-usd <maxBudgetUsd>` = min(`limits.turnUsd`, the budget that remains).
- Read `system/init` (`mcp_servers[].status` must be `connected`), `rate_limit_event`, `result` (`is_error`, `terminal_reason`, `permission_denials`, `usage`). Exit 0 is success only when the last `result` has `is_error:false`.
- Stop with SIGINT, wait, then SIGTERM.

**Mail hook (Claude, `mailHook:true`).** The settings file registers one `PostToolUse` command hook: `curl -s -m 2 "$WORKSHOP_TAG_URL"`. The runner sets `WORKSHOP_TAG_URL=<base>/<token>/tag` in the CLI environment. `GET /mcp/:token/tag` answers `204` when nothing urgent waits, else `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"<board.urgentTag>"}}`. The hook ships only when the provider tests prove that a hook from `--settings` runs with `--setting-sources ""`, and that in `sandboxed` mode the hook command sees `WORKSHOP_TAG_URL` while a Bash command does not. Until then `mailHook` is false, the settings file holds `disableAllHooks:true`, and the maker card carries the line `After each check run, call read.`

**Gemini adapter (`agy`)**: `agy -p "<prompt>" --output-format stream-json --model <api id>-<effort> --effort <e> --settings <runDir>/settings.json --print-timeout <d> --log-file <runDir>/agy.log` (follow-up: add `--conversation <id>`). stdin is a pipe that is closed at once (with `/dev/null` an unauthenticated `agy` opens a browser sign-in).
- Bench file `.agents/mcp_config.json` (a hub file): the `shop` server = `<node> <shimPath> --url-file <data/run/<agentId>/mcp-url>`, tools eager. The URL file (mode 0600, outside the bench) holds the URL with the token. The shim reads it at start. Nothing depends on environment inheritance.
- The role card goes at the top of the first prompt of each conversation (`agy` has no system-prompt flag and ignores `.agents/rules/*.md` in `-p` runs). The adapter writes no rules file. A prompt that is too long for an argument goes into the hub file `.agents/workshop-prompt.md`, and `-p` tells the agent to read that file.
- Settings per process: `agentMode:"accept-edits"`, `toolPermission:"proceed-in-sandbox"`, `enableTerminalSandbox:true`, `allowNonWorkspaceAccess:false`, `permissions.allow:["mcp(shop/*)"]`, deny rules for `git push`, `git commit`, `sudo`; write rules denied for read access; `modelProvider:"gemini"` in `apikey` mode with `GEMINI_API_KEY`. The adapter writes only settings keys that the CLI knows (an unknown key ends the run with exit 1).
- Stream: lines keyed by `event` (`init`, `step_update`, `result`). Exit 0 does not prove success: read `status`, `finished_reason`, `denied_actions`. Exit 1 with `authentication` in the error: mark the lab signed out, stop all Gemini spawns, never retry. The environment adds `AGY_CLI_DISABLE_AUTO_UPDATE=true`.
- Mail hook: none in v1. An `agy` agent follows the card line `After each check run, call read.` A hub-written `.agents/hooks.json` with the same command ships only after a provider test proves that hooks run in `-p` mode.

**Mock adapter**: runs `server/providers/mock-agent.mjs`, a scripted fake CLI that reads the prompt and calls the real hub tools over HTTP. No tokens. Used by the demo and the end-to-end tests. It is always usable.

### Runner

```js
createRunner({ store, providers, mcp, git, redactor, paths, getSettings, getMcpUrl, priceFor, log }) -> runner
runner.run(agentId, { sessionId, resume, prompt, systemPrompt, cwd, access, web, model?, effort?, timeoutMs, idleMs, kind, taskId?, maxBudgetUsd? }) -> Promise<TurnResult>
runner.cancel(agentId, reason) ; runner.interrupt(agentId)         // interrupt: SIGINT, the session resumes later
runner.busy(agentId) -> boolean ; runner.active() -> [agentId] ; runner.queued() -> [agentId] ; runner.shutdown() -> Promise
TurnResult { ok, text, sessionId, usd, usage:{inTok,outTok,cacheRead,cacheWrite,ctxTok}, calls:[toolName], denied:[what],
             error:{kind,message,resetAt,model?}|null, killed:null|'timeout'|'idle'|'cancel'|'interrupt'|'shutdown', durationMs, startedAt }
```

Runner duties:

- One turn per agent at a time. Global and per-provider concurrency limits (queue; bosses first). At least 1.5 s between two spawns.
- **Sessions.** The caller passes `sessionId` and `resume`. The runner returns the session id in `TurnResult`. It never writes `agent.sessionId`: the orchestrator stores the id on the work item (section 12).
- **Token.** Mint the agent token at spawn, revoke it at turn end. Write the per-turn files under `data/run/<agentId>/` (mode 0600) and remove the URL file at turn end.
- Spawn in its own process group with stdio pipes, write stdin and close it. Line-buffer stdout into the parser.
- **Kill the whole process group at every turn end**, also on timeout, cancel, interrupt and shutdown.
- **Redaction.** Replace every match of a stored key value or a live agent token with `[redacted]` before any log write, `agentlog` event, check tail or prompt (`redactor`, section 14).
- Raw stream to `data/logs/<agentId>.jsonl`. Throttled `agentlog` events (at most 4 per second per agent).
- Update `agent.stats` (with `ctxTok`), `job.cost`, and the cost of the task `taskId`. `kind` names the turn: `plan`, `merge`, `work`, `buddy`, `review`, `qa`, `audit`, `consult`, `digest`, `change`, `report`, `stall`, `selftest`. Only a `work` turn moves `task.progress` (from tool counts).
- **Cost.** `usd` is computed from tokens and registry prices for every lab. The CLI's own figure is used only when the registry has no price. A turn of a lab in `apikey` mode adds to `job.cost.billedUsd`. A subscription turn adds to `job.cost.estUsd`.
- On `init` with `mcpOk:false` kill the turn (`error.kind 'mcp'`). On `rate_limit` call `providers.cool` (with the model when the event names one). On `auth` call `providers.markAuth(id,'none')`.
- **Watchdogs** run on shop time. Wall clock: `timeoutMs` (the orchestrator passes `limits.taskTimeoutMin[size]` for maker turns, `limits.turnTimeoutMin` for other turns). Idle: `idleMs`; it does not run between a `tool` event and its `tool_result`.
- **Budget.** When `job.cost.billedUsd` reaches `job.budgetUsd` the runner interrupts the running turns of `apikey` labs.

## 11. Router (`server/router.js`, `server/benchlm.js`, `config/models.json`)

`config/models.json` is distilled from BenchLM.ai data (free static JSON, CC BY-NC 4.0, credit "Data from BenchLM.ai"). Per model: `id` (API id, also passed to the CLI), `provider`, `label`, `tiers` (primary role first, then fallback roles), `power` 1-5, `price`, `efforts`, `enabled`, `estimated`, `planNote`, `scores` by benchmark key (`null` = no data). `domains` maps each WorkShop domain to an ordered list of benchmark keys that ends with `overall`. `categories` gives each key a scale and a tie gap.

Tiering (Phase 0): primary `boss` (Orchestration Officers & Final Review Gates) = Frontier API models (`gemini-4-carbon`, `claude-fable-5-2`, `claude-opus-5-5`); primary `manager` (Team Leads) = `$0` OSS models (`llama-4-scout-17b`, `deepseek-r1-32b`) with Frontier fallbacks; primary `maker` (Specialists) = `$0` OSS models (`qwen3-coder-32b`, `deepseek-r1-32b`, `devstral-24b`, `qwen2.5-vl-32b`, `gemma-3-27b-it`) with Frontier fallbacks.

```js
createRouter({ modelsPath, providers, getSettings, log }) -> router
router.registry() ; router.save(registry) ; router.reload()
router.pick({ role, domain, size, avoidProvider?, preferProvider?, labLoad?, exclude?, bump? }) -> { provider, model, label, effort, why } | null
router.explain(query) -> candidate table ; router.leaders() -> { [domain]: { [role]: [{ label, provider, key, value }] } }
createBenchlm({ fetchImpl, cachePath, log }).refresh(registry) -> { ok, changed, updated, dataDate, notModified, error }
```

Pick rule: candidates = enabled models whose primary tier is the role and for which `providers.modelUsable(provider, model)` is true (else fallback tiers). So a cooled model and a model that is not in `ProviderStatus.models` (when that list is not null) are never picked. Makers need power >= 1 (S) or 3 (M, L), plus `bump` after a failed try. Compare on the first benchmark key of the domain that every candidate has. Quality and cost are min-max scaled over the candidates; a raw gap under the key's tie value counts as equal. `utility = quality - thrift x cost`. Ties go to the lab with fewer agents on the job (`labLoad`), then `preferProvider`, then the cheaper model. `avoidProvider` (cross-lab review, buddy) removes a lab when another remains. Effort: boss high, manager medium, maker S low / M medium / L high. `why` is one plain sentence with the numbers.

## 11b. Decider: Gemini Routing & Jev (`server/decider.js`)

Supports fast task sizing (`sizeTask`) and specialist + Harness Rack matching (`selectSpecialist({ task, roster, harnesses })`). Active via `GEMINI_API_KEY` (`decider.backend()` -> `'gemini'`) or `TYPESAFE_API_KEY` (`'typesafe'`), with deterministic local fallback when unkeyed.

```js
createDecider({ secrets, getSettings, fetchImpl, log }) -> decider
decider.enabled() -> boolean
decider.backend() -> 'typesafe' | 'gemini' | null
decider.sizeTask({ title, spec, acceptance, zones }) -> { size:'S'|'M'|'L'|null, sensitive:boolean|null, why, usd } // never throws
decider.selectSpecialist({ task, roster, harnesses }) -> Promise<{ rosterId, harnessId, baseModel, needsRft, reason, why, usd }>
decider.stats() -> { calls, usd, failures }
```

When `selectSpecialist` identifies an uncurated or missing domain in the Employee Book (`needsRft: true`), the orchestrator writes `.shop/HARNESS.md` onto the bench using `harnesses.renderCard()`, runs the Phase 0 OSS fallback locally, and enqueues a structured Phase 1 RFT requisition via `server/training.js`.

## 12. Orchestrator (`server/orchestrator.js`, `server/names.js`, `server/providers/mock-agent.mjs`)

```js
createOrchestrator({ store, board, mcp, runner, router, git, providers, decider, prompts, getSettings, paths, log }) -> orch
orch.createJob({ title, brief, kind, project:{mode:'new'|'existing', name?, path?, agentFilesAck?}, crew, options, budgetUsd? }) -> job
orch.pauseJob(id, { hard? }) ; orch.resumeJob(id, { budgetUsd? }) ; orch.cancelJob(id) ; orch.deleteJob(id)
orch.approvePlan(jobId) ; orch.addReq(jobId, { text }) -> Req ; orch.waiveReq(jobId, reqId, { reason }) ; orch.ackAgentFiles(projectId, ack)
orch.ship(jobId, { sha }) -> { ok, sha, left } | { ok:false, reason } ; orch.discardTruck(jobId)
orch.requestChanges(jobId, { deliveryId?, text })
orch.stopTask(taskId, { note? }) ; orch.retryTask(taskId, { note?, model? }) ; orch.cancelTask(taskId, { reason, replacedBy? })
orch.ownerPost({ jobId, kind, to?, scope?, re?, slots?, body }) -> { ok, msg } | { ok:false, code, hint }
orch.truck(jobId) -> { headSha, behind, deliveries, stat, files, reqs, check, report } ; orch.diff(jobId, { deliveryId?, path? }) -> string
orch.inbox(jobId?) -> InboxItem[] ; orch.setPresence(state)
orch.recover() ; orch.tick() ; orch.shutdown()
orch.resolver            // the callbacks board.js needs (section 7)
```

### Scheduler

One event-driven scheduler: `tick()` reads state and starts whatever can start. It is idempotent and never runs twice at once (a dirty flag re-runs it). It runs on every relevant store or board event and every 3 s. Every transition goes through `store.patch`, so the UI and a restart see the same truth.

**`tick()` derives every start from persisted state.** Events, timers and the runner queue only delay a start. They never hold its only copy. The tick covers every status: `queued`, `planning` (missing drafts, the merge, the baseline gate), `plan_review`, `running` (`ready`, `working`, `checking`, `buddy`, `review`, `rework`, `integrating`, `blocked`, `failed`; the ledger audit while `job.auditDone` is false; a requirement that no task serves), `qa`, and `delivering` without a report.

**`recover()`** = replay the board, set every agent that was mid-turn to `idle`, remove stale per-turn files, run one tick. At boot an open `DONE` for a task that is not in `checking` sets the task to `checking`.

### Turn classes

| Class | Turns | Session | cwd | Access | Board |
|---|---|---|---|---|---|
| main | plan, plan merge, owner change, report, manager digest, answers, stall digest | `agent.sessionId` | the agent's desk | read | full view; moves the cursor; turn gate |
| work | maker task turns | `task.sessionId` | `task.benchDir` | write (read while frozen) | full view; moves the cursor; turn gate |
| aux | buddy, review, QA, ledger audit, consult | on the work item: `task.reviewSessionId`, `job.qa.sessionId`; buddy, audit and consult are one-shot | review clone, `_head`, a desk, or the asker's bench (consult) | read | view scoped to the task; cursor not moved; no turn gate |

- The runner returns the session id. The orchestrator stores it on the work item.
- `FIX`, `ANS` and hub `EVT` for task T resume `task.sessionId` in `task.benchDir` as `task.assigneeId`.
- Mail that arrives during an aux turn waits. The hub runs a main turn for it before it gives that agent another aux turn.
- `agent.bubble` is set from each post of that agent (`kind`: ASK, BLOCK -> `ask`; DONE, PASS -> `done`; FIX, FAIL, NO -> `warn`; else `info`). `task.progress` rises with tool calls and is 1 at `DONE`.

### Crew

- Personas come from `names.js`: `pickName(role, used)` and a style seed. Handles: bosses `@b1..` (`@b1` is the first lead), managers `@f1..`, makers `@m1..` (counter per job).
- Bosses and managers are created with the job from the crew preset. Models: `@b1 = router.pick({role:'boss', domain:'plan'})`; each further boss or manager is picked with `labLoad` so the labs alternate when both are usable. A persona whose model is cooled or not on the plan gets a new pick (holds, below).
- **A maker persona is bound to one task** from hire until that task is merged or cancelled, or gets another assignee. It never gets a second task and is never set `off` while bound. `crew.makers` caps the tasks in `working` or `rework`. The 8 bench spots cap the open benches.
- Hire order for a ready task: `router.pick({role:'maker', domain, size, labLoad, bump})` chooses the model. Then: a free persona with that model, then an `off` persona with that model (same name and seed), then a new persona. Office spots 0-2, manager posts 0-2 (first free).
- A buddy is a maker of the other lab whose own task is not in `working` or `rework`, else a new hire.
- Streams: tasks carry a `stream` label. Labels map to managers round-robin. A task without a label gets the stream of its first dep, else the manager with the fewest open tasks. With no manager, the lead boss plays `@mgr`.

### Job flow

```
queued -> planning -> [plan_review] -> running -> qa -> delivering -> done        any live state <-> paused ; any state -> cancelled
                                   ^-- new tasks or requirements (from qa or delivering) --'
```

1. **Queue and intake.** A new job is `queued` while another job is active. The tick promotes the oldest queued job when there is none. Intake runs at that moment, not at creation: `git.initProject` or `git.adoptProject`, `git.startJob` (sets `job.intSha`), create the crew, status `planning`, hub post `EVT #plan`. The job chip shows why a job waits. An adopted repo with `agentFiles` needs `agentFilesAck`, or the Gemini lab is off for the job.
2. **Planning.** Every boss gets a planning turn at the same time (main turn, `plan_submit` expected). The hub stores each validated draft in `job.planDrafts`. With more than one draft, the lead then gets a merge turn with all drafts. In the merge turn `plan_submit` must carry `covers:[{ draft:'@b2', n:4, req:7 }]` for every draft requirement, or `dropped:[{ draft, n, why }]`; a draft requirement with neither is a validation error. Validation errors are returned as the tool result so the boss fixes the plan in the same turn. The hub stores the validated final plan as `job.planDrafts.final` until it is applied.
   - **Plan rules.** 1-30 requirements. 1-`maxTasks` tasks. Unique keys. Deps exist and are acyclic. Every task has title, spec, 1-8 acceptance items, 1+ zones (none under `HUB_PATHS`), a known domain and size. Every requirement is served by a task. Two tasks with overlapping zones must be ordered by a dependency (direct or transitive). `check_cmd` must not be empty for build and fix jobs unless the plan carries `no_check_reason`; then every crate and the truck show `NOT CHECKED`.
   - **Baseline gate** (skipped when the plan has no check command). Existing project: after `plan_submit` validates and before the plan is applied, the hub runs the head check twice; the job stays in `planning`. It stores `project.baseline { sha, ok, flaky, ms, tail }`. Red, flaky, or slower than half of `checkTimeoutMin`: the lead boss is resumed once with the tail to submit again. A second failure pauses the job (`pauseReason:'baseline'`) with the tail for the owner. New project: the same run after T1 merges; red: the lead is woken to add a fix task.
   - **Apply.** Creates `R1..` (source `plan`) and `T1..` (plan keys mapped to task ids). Sets `job.notes`, `job.assumptions`, `job.dropped`, `project.setupCmd/checkCmd/noCheckReason`. Sets `task.pair` from `settings.pairing` (`costly`: the plan's own flags; `M+L`: also every M and L task; `all`) and from the decider. Then status `plan_review` (when `approvePlan`) or `running`. The lead's planning session ends here; later main turns start from a digest (rotation, below).
   - **Plan notice.** When the plan is applied the hub always posts a non-blocking owner notice with the ledger, the assumptions, the dropped items and the setup and check commands.
   - **Ledger audit** (every job, also with one boss). After the plan is applied, one small aux turn by an agent of the other lab (boss, else manager; none: skip) gets only the brief and the ledger. It calls `req_add` for each ask that no requirement covers. The hub sets `job.auditDone` when the turn has ended or was skipped.
3. **Running.** A task is `ready` when all deps are `merged`. For each ready task with a free maker slot: hire, `git.createBench` (with `.shop/TASK.md`, `.shop/BLUEPRINT.md`), status `working`, start the work turn (fresh session; `web:true` for domain `research`).
4. **QA.** When no task is open, at least one is merged, and no owner-change turn runs or waits: status `qa`. Every entry to `qa` sets `job.qa = { round+1, sha: integration head }` and every requirement that is not waived to `open`. Order of steps:
   - Truck refresh when `git.truck().behind > 0` (below). Then the head check. A red check: no QA turn; the lead boss is woken with the tail to add a fix task.
   - The QA turn (aux, in `_head`, where setup and check already ran). QA goes to a boss of another lab than the lead, else a manager of another lab, else the lead in a fresh session. The prompt holds the brief, the ledger, the decisions in force and the check result.
   - `req_verify` is accepted only from the agent assigned to the QA turn, only while status is `qa` and the integration head equals `job.qa.sha`, and only with a result for every open requirement (the error lists the missing ids). Each `evidence` needs a pointer to a path that exists at that sha.
   - A failed requirement needs a serving task (`task_add` in the same turn); new tasks move the job back to `running`. A failed requirement with no serving task when the QA turn ends: one nudge, then the lead boss is woken once, then an owner notice with `Waive`, `Add task`, `Stop job`.
   - `limits.maxQaRounds` (3): after it the job is paused (`pauseReason:'qa'`) with the failed requirements listed.
   - All requirements verified or waived: status `delivering`, owner notice.
5. **Delivering.** On entry the lead writes `job_report` from a hub-built fact sheet (the ledger with status and evidence, waived items, cancelled and failed tasks, changed task cards, assumptions with defaults taken, decisions). The job waits for the owner to ship. A new task or a new open requirement while the job is in `qa` or `delivering` sets the job back to `running` and clears `job.report` (during a QA turn: when that turn ends). The next QA round covers it.
6. **Done** needs all of: status `delivering`, truck empty, no open task, every requirement verified or waived. Then status `done`, `fx confetti`, `git.removeJobWork`.

### Requirements ledger

- `orch.requestChanges` and `orch.addReq` first create a `Req` (source `owner`, the owner's words) and then wake the lead boss (owner-change turn). `task_add` in that turn must cite the new id. A `Req` with no open or merged task at turn end: one nudge, then an owner notice.
- `req_add { text, why }` creates a `Req` with source `boss` and a non-blocking owner notice. After an audit turn that added requirements the hub wakes the lead boss to add tasks for them (the rule above).
- `orch.waiveReq` is the only way to `waived`. It stores `waivedReason`.
- `task_cancel` and a `task_update` of `reqs` are refused when they leave a requirement that is not waived without an open or merged task.
- A `DECIDE` never changes a requirement. QA marks a requirement `failed` when a decision narrows it, and points at the decision.

### Task flow

```
planned -> ready -> working -> checking -> [buddy] -> review -> integrating -> merged
                      ^            |          |          |           |
                      '-- rework --+----------+----------+-----------'      also: blocked, failed, cancelled
```

- **Closing act.** A work turn must end with a `DONE`, `BLOCK` or `FAIL` post for its task, or with an open `ASK` of its own (then the agent is `waiting` and the closure wakes it), or with a queued claim (the task is `blocked`, `why:'claim'`). Otherwise the hub resumes the session with a nudge (`maxNudges`), then sets the task `blocked` (`why:'nudges'`) and tells the manager.
- **Hand-in pipeline.** It starts when the maker's turn has ended after a `DONE`; the post itself only creates the delivery (`checking`, with `doneMsgId` and `acc`) and sets the task to `checking`. Steps:
  1. `git.commitAll`.
  2. `git.guard` (below).
  3. Zone check: changed files must match `zones + claims`.
  4. `git.syncBench`. When it merged: `git.runSetup` again.
  5. `git.runCheck(checkCmd)`.
  6. `git.resetBench(headSha)`: the bench is clean at the checked head.
  7. The delivery gets `{ baseSha, headSha, stat, files, check, flags }` and goes to `buddy` or `review`; the task follows.
  Any failure: delivery `rejected`, task `rework`, `attempts++`, and the hub posts `FIX re:<done id>` as `@hub` with the exact reason (guard reason and paths; out-of-zone paths; conflict files; `Check failed. See .shop/CHECK.log.`). That post closes the `DONE` as `fix` and wakes the maker. A merge conflict found by the hub does not raise `attempts`.
- **Guard** (the exact reason goes to the maker). It looks at the whole change since the fork point.
  - Refuse added paths on the hub deny list: `node_modules/`, `.venv/`, `__pycache__/`, `.env`, `.env.*` except `.env.example`, `*.pem`, `*.key`, `.DS_Store`.
  - Refuse a file over `limits.maxFileMb` (1), or a delivery over `limits.maxDeliveryMb` (5) or `limits.maxDeliveryFiles` (500), unless a boss set `task.allowLarge`.
  - Refuse added lines that match the board's secret scan or the exact value of a stored key or a live token (`why=unsafe`).
  - Refuse an empty diff once (`No changes found in your bench.`). A second empty hand-in goes to review with the flag `empty`.
  - When refused content is already in a bench commit, the hub rewrites the bench branch as one commit on its fork point at the next hand-in that passes, so refused content never reaches the integration branch.
  - It returns `flags { empty, testsDeleted:n, checkFiles:[path] }`. `checkFiles` are changed manifests, test configs and agent-config files (`package.json`, `Makefile`, `pyproject.toml`, jest or vitest config, `.github/**`, `GEMINI.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/**`, `.mcp.json`). The orchestrator adds `claimed` (changed paths that only a claim covers) and `cardChanged` (from `task.cardChanges`). The flags are the first lines of the review prompt and show on the truck crate.
- **Freeze.** From an accepted `DONE` until the hub sets `rework`, the bench is frozen: the board rule of section 7 applies, and any wake of the maker runs with access `read` and the first line `Your work is in review. Answer only.`
- **Buddy check** (`task.pair`, once per task; delivery status `buddy`). A maker of the other lab (`avoidProvider`) reviews first: aux turn, read access, in the review clone. `FIX` sends the task back once (task `rework`, `attempts++`; the maker's next `DONE` replaces the open one); after that hand-in the work goes straight to the reviewer. No candidate, or a failed buddy turn: the step is skipped.
- **Review.** Aux turn, read access, in the review clone at `headSha` (hub files `.shop/TASK.md` and `.shop/CHECK.log`; agent-config files removed). The prompt gives the flags, `git diff <baseSha> <headSha>` and the hub's check result.
  - **Reviewer choice** with `review.crossLab`: an S task that is not `pair` goes to the other-lab manager first (`review.smallByManager`). Else a usable boss of the other lab; else a manager of the other lab; else the least busy usable boss. With `review.crossLab` off: the least busy usable boss. One review per agent at a time; other deliveries wait in the review queue. `delivery.review.crossLab` is stored. A same-lab review shows on the truck crate.
  - **Sticky reviewer.** `task.reviewerId` and `task.reviewSessionId` stay. A re-review resumes that session in the same review clone (reset to the new `headSha`) with the earlier `FIX` items, `git diff <lastReviewedSha> <headSha>` and the rule: `Check these items. Raise a new item only if it breaks acceptance, tests or security.`
  - **Verdict.** A verdict is stored with `headSha` (also as `task.lastReviewedSha`) and takes effect when the reviewer's turn ends. The hub may stop that turn with SIGINT after a valid verdict. `PASS` -> delivery `approved`, task `integrating`. `FIX` -> delivery `rejected`, task `rework`, `attempts++`, the `FIX` post wakes the maker.
  - **No-show.** No verdict after a nudge, or a failed review turn: the next reviewer. At most `limits.maxReviewers` (2) per delivery; then it waits for `PASS` or `FIX` from `@human` (owner notice).
- **Integrate** (serial per project). Step 5 of section 9. A conflict or a failed check at integrate sends the task to `rework` (a failed check raises `attempts`) and afterwards back through review (the sticky reviewer sees the diff since `lastReviewedSha`). `git.integrate` returns `stale`: sync again. It returns `error`: one retry, then task `blocked` (`why:'error'`) with an owner notice; the queue goes on. Success: delivery `loaded` with `mergeSha`, `job.intSha` updated, task `merged`, the bench and its review clone removed, hub `EVT #merge: T12 merged. Files: ...`, every open bench and every desk gets a fresh `.shop/BLUEPRINT.md`, dependents become `ready`.
- **Claims.** `claim` takes exact paths only (no globs), at most `limits.maxClaims` (5) per task, never under `HUB_PATHS`. A path that no open task owns is granted at once. A claim on a path that an open task owns is queued: the tool answers `WAIT T12 holds <path>`, the task becomes `blocked` (`why:'claim'`) with no manager wake, and the hub stores `task.pendingClaims`. When the holder is merged or cancelled the hub runs `syncBench`, grants the claim, rewrites `.shop/TASK.md` and wakes the maker with `EVT`. A wait cycle goes to the manager. Zone validation in `task_add` and `task_update` counts live claims as zones.
- **Consult.** `ASK @other` starts a consult: a fresh aux turn of a manager-tier model of the other lab (a manager persona if one exists, else a hidden one-shot persona from a router pick), no Edit or Write tools, cwd = the asker's bench, the task card on top. It must end with one `ANS re:<id>`. No long session is used. The hub also starts a consult by itself, before it wakes the manager: on a `BLOCK` with `why=tests` or `why=unknown` (the consult answers the `BLOCK`), and on the second refused hand-in of a task (the hub posts the refusal reason as `ASK @other T<n>` from `@hub`, the consult runs, and then the hub posts its `FIX` with a pointer to the `ANS`). With no usable other lab the hub answers `NO why=env`, or skips its own consult.
- **Failed or blocked tasks** set `task.needsAction { kind, since }` (not for a claim wait, and not for an owner stop: the owner retries or cancels that task). While it is set and no manager turn ran since, the tick wakes the stream's manager (or the lead boss). The manager uses `task_retry`, splits with `task_add`, or `task_cancel`. `task_retry`, `task_update` and `task_cancel` clear it.
  - `task_retry`, `task_cancel` and any reassign first close every open item of that task as `cancelled`, then start anything.
  - `task_retry` keeps the bench and starts a fresh session. The prompt carries the manager's note, `task.lastError` and a pointer to `.shop/NOTES.md`. `model:'up'` raises `bump`; `'other_lab'` gives the task an assignee of the other lab.
  - `task_cancel { id, reason, replacedBy? }`: the hub rewrites the deps of every dependent task to `replacedBy` and validates the plan rules again. A cancel of a task that has dependents and no `replacedBy` is refused.
  - `task_update` that removes or rewords an acceptance item, or changes the spec of a started task (boss only): the hub posts `EVT #plan`, adds to `task.cardChanges` and lists the change on the truck crate.

### Counters and caps

| Counter | Rises | Limit | At the limit |
|---|---|---|---|
| `task.attempts` | every return to `rework`: pipeline refusal, review `FIX`, failed check at integrate | `limits.maxReworks` (3) | task `failed` |
| `task.retries` | `task_retry` (which resets `attempts`) | `limits.maxRetries` (2) | the tool returns an error |
| `task.blocks` | each `BLOCK` post for the task | `limits.maxBlocks` (2) | one more `BLOCK` sets the task `failed` |
| tasks of a job | plan tasks plus `task_add` | `limits.maxTasksTotal` (60) | the tool returns an error |
| reviewers per delivery | each new reviewer | `limits.maxReviewers` (2) | waits for `@human` |
| QA rounds | each entry to `qa` | `limits.maxQaRounds` (3) | job paused (`qa`) |

A failed buddy, review or QA turn never changes `task.attempts`.
**Circuit breaker.** The job pauses (`pauseReason:'caps'`) with an owner notice when `task_retry` or `task_add` is refused at its limit (`maxRetries`, `maxTasksTotal`), or when 3 hand-ins in a row from different tasks are refused for the same cause (check, zone, guard, setup).

### Turn failures and holds

| Turn | No closing act after the nudges | Timeout or idle | Error `other` or `model` |
|---|---|---|---|
| Plan draft | drop that draft | drop that draft | drop that draft |
| Plan merge, QA | one retry by the next usable boss, then job paused (`error`) | same | same |
| Maker (work) | task `blocked`, the manager is told | one resume with a note, then task `failed` | one retry, then task `blocked` with `lastError` |
| Buddy, ledger audit | skip the step | skip the step | skip the step |
| Review | next reviewer | next reviewer | next reviewer |
| Consult | the `ASK` closes as expired | same | same |
| Manager digest, answer | one retry, then the items move one level up | same | same |
| Owner change | one retry, then an owner notice; the requirement stays open | same | same |
| Report | one retry by another boss, then the hub stores its own fact sheet as `job.report` | same | same |
| Stall digest, red-check wake | the stall rule applies | same | same |

- The plan merge starts when every draft turn has settled and at least one draft exists. No draft: job paused (`pauseReason:'error'`) with the CLI error in an owner notice.
- `mcp` error: one retry, then an owner notice.
- **Hold.** In every row, `rate_limit` or `auth` puts the work item on hold: `hold:{ reason:'lab', provider, model?, since, until? }` on the task (work, buddy, review) or on the agent (main, QA, audit, consult). A held item is not nudged and counts no attempt. The tick releases it when `providers.modelUsable` is true again, also after a new sign-in.
- **Fallback.** When a hold is older than `limits.holdFallbackMin` (20) and `allowFallback` is on: a maker task gets an assignee of the other lab on the same bench with a fresh session; lead, review and QA duties move to a usable boss (`leadBossId` may change); a persona whose model is cooled or not on the plan gets a new pick.
- With no usable lab the job shows `job.hold { reason, lab, until }` in the job chip and raises one owner notice.

### Wakes, rotation, stall

- **Wakes.** A post addressed to an agent with no running turn wakes it by the wake rule (section 7). Owner posts outrank other mail. Managers wake on `ASK` / `BLOCK` addressed to them, on `task.needsAction` in their stream, and on hand-ins refused twice. Their events are batched with a 20 s debounce into one digest turn; the debounce only delays, the tick finds the same work in state.
- **Rotation.** After each main or work turn the orchestrator stores `sessionCtx { tok, at }` (the turn's `usage.ctxTok` and its end time) on the agent or the task. The hub starts a fresh session in place of a resume when the session's last `ctxTok` is over `limits.rotateTok` (boss 40k, manager 40k, maker 90k), or, for bosses and managers, when the gap since the last turn is over `limits.rotateGapMin` (5) and `ctxTok` is over `limits.rotateGapTok` (25k). The first prompt of the new session is a hub-built digest: where the blueprint is, the status table, the agent's open items and its last 5 posts; for a maker also the `FIX` items or the `.shop/CHECK.log` pointer, and `git diff --stat`. The new session takes over the board cursor.
- **Stall rule.** When a job is `running` or `qa` and there is no active or queued turn, no ready task, no hub step in progress, no hold with a release time, no claim wait on an open task and no board item with a live deadline, the hub wakes the lead boss once with a stall digest (the status table and what waits on what). If nothing changes, the job is paused (`pauseReason:'stalled'`) with an owner notice.

### Budget, pause, cancel, delete

- **Cost.** `job.cost = { billedUsd, estUsd, inTok, outTok }`. `billedUsd` counts turns of labs in `apikey` mode. `estUsd` counts subscription turns; the UI labels it `est. at API prices`. `budgetUsd` applies to `billedUsd`. `orch.createJob` refuses a job without `budgetUsd` when a usable lab is in `apikey` mode (the Work Order panel pre-fills `settings.budgetUsd`). **Budget stop:** at the budget the runner interrupts the running turns of `apikey` labs (sessions resume later) and the job pauses (`pauseReason:'budget'`).
- **Pause.** `pauseJob` stops scheduling; running turns finish. `{ hard:true }` also stops the running turns with SIGINT; their sessions resume later. A pause never overwrites `prevStatus` when the job is already paused.
- **Resume.** `resumeJob` is refused while another job is active. It needs a `budgetUsd` above `billedUsd` when `pauseReason` is `budget`. It returns the job to `prevStatus`.
- **Cancel.** `cancelJob`: stop the turns, `git.saveBench` for each bench (commit, fetch to `refs/workshop/<job>/<task>`), then delete the folders. The saved refs stay until the job is deleted. If the truck is not empty, `ws/<job>/int` stays and the Truck panel offers `Ship loaded crates` or `Discard` (a second, explicit action); after either, the integration branch goes too.
- **Delete.** `deleteJob` (done and cancelled jobs): removes work folders, refs and task, agent and delivery rows. It keeps title, brief, ledger and report.

### Owner actions

- **Ship.** Allowed in `running`, `qa`, `delivering` and `paused` when a delivery is loaded, and for a cancelled job with a loaded truck. `orch.ship(jobId, { sha })` ships exactly that commit. Deliveries up to it become `shipped`; `fx ship`; hub `EVT #merge`; the answer says how many crates stay loaded.
- **Truck refresh.** When `git.truck().behind > 0` at entry to `qa` or at a ship request, the hub calls `git.refreshTruck`. Clean and green: the truck stays loaded, `job.intSha` moves to the refresh merge, and the owner gets a notice that lists the new commits (`Your branch moved. Look again, then ship.`). The ship request itself is not done. Conflict or red check with no open task (job in `qa` or `delivering`): the hub adds a catch-up task (domain `fix`, zones `**`, its bench starts with that merge in place) and the job returns to `running`. With open tasks: the ship answer names the files and the refresh runs again at entry to `qa`.
- **Truck panel data.** `orch.truck` returns the report and, before it exists, the requirement counts, so the panel shows `n requirements not verified` beside `Ship`.
- **Task actions.** `stopTask` (`runner.cancel`; the task becomes `blocked`, `why:'owner'`, with the owner's note), `retryTask`, `cancelTask`. The owner acts with manager powers under the same rules (requirement rule, dependents rule).
- **ownerPost.** Any ShopTalk kind from the UI. An `ANS` to an `ASK @human` closes the question and wakes the asker (section 12b).

### Hub tool schemas (registered by the orchestrator on `mcp`)

```
plan_submit   { requirements:[{text}], tasks:[{key,title,spec,acceptance:[string],zones:[string],domain,size,deps?:[key],reqs:[number],pair?:boolean,stream?:string}],
                setup_cmd?:string, check_cmd?:string, no_check_reason?:string, assumptions?:[string], notes?:string,
                covers?:[{draft:string, n:number, req:number}], dropped?:[{draft:string, n:number, why:string}] }
task_add      { title, spec, acceptance:[string], zones:[string], domain, size, deps?:[taskId], reqs?:[reqId], pair?:boolean, stream?:string }
task_update   { id, title?, spec?, acceptance?, zones?, domain?, size?, deps?, reqs?, pair?, allowLarge?, note? }      (not for merged or cancelled tasks; zones and reqs are validated again)
task_retry    { id, note?:string, model?:'same'|'up'|'other_lab' }
task_cancel   { id, reason, replacedBy?:[taskId] }
claim         { paths:[string] }           -> 'ok' | 'WAIT T12 holds <path>'
status        { }                          -> compact text table: tasks (id, status, owner, title) and agents (handle, status, task)
req_add       { text, why }
req_verify    { results:[{ id, ok:boolean, evidence:string }] }
job_report    { md:string }
```

### Mock agent (`server/providers/mock-agent.mjs`)

A fake CLI for the demo and the end-to-end tests. It reads the prompt on stdin, recognizes the turn kind from the fixed phrases of `server/prompts.js`, waits a little (`MOCK_SPEED`), prints NormEvent lines, and calls the real hub tools over HTTP: a small sensible plan with disjoint zones for any brief, real files and passing `node --test` tests in its zones, ShopTalk posts that pass the validator, `PASS` verdicts, `req_verify`, a short report. Flags in the brief force paths: `[mock:reject]` (first review of one task is `FIX`), `[mock:checkfail]` (one hand-in fails the check once), `[mock:conflict]`, `[mock:ask]` (a maker asks its manager and waits), `[mock:block]`, `[mock:claim]` (two makers claim one file), `[mock:empty]` (one empty hand-in), `[mock:slow]`.

## 12b. Presence and the attention inbox

The owner is `here` or `away` (`settings.presence`, a switch in the top bar; `PUT /api/presence`). Everything that needs the human lands in one **attention inbox**. Nothing in the inbox blocks the rest of the shop.

```
InboxItem { kind:'question'|'truck'|'plan'|'signin'|'budget'|'paused'|'review'|'requirement'|'agentfiles', id, jobId, text, since, options?:[{key,text}], default?, defaulted? }
```

- **Questions.** Only bosses post `ASK @human`. Each has 2 to 4 options and `default=<A|B|C|D>`. The asker works on what does not depend on the answer.
- **Away.** The hub takes the default option at once.
- **Here.** The hub waits `settings.humanWaitMin` (30) of shop time and then takes the default.
- **Taking the default.** The hub posts `ANS re:<id>` as `@hub` with the default option, adds `{ text, msgId }` to `job.assumptions`, sets `msg.defaulted` and wakes the asker.
- **Overturn.** In both cases the question stays pinned in the Inbox, Board and Truck panels with an `Overturn` button until the owner answers it. An owner answer is an `ANS re:<id>` from `@human`. The default option confirms the assumption and only unpins the question. Any other answer replaces the assumption and wakes the asker and the lead boss, who decides if rework is needed (`task_add`).
- **Inbox actions.** `question`: `POST /api/board` (`ANS`). `truck`: the Truck panel. `plan`: `plan/approve`. `signin`: the Keys panel. `budget`: `resume { budgetUsd }`. `paused`: `resume` or `cancel`. `review` (a delivery that waits for the owner's verdict): `POST /api/board` (`PASS` or `FIX`). `requirement` (a failed requirement that no task serves): `Waive` (`reqs/:rid/waive`), `Add task` (`changes { text }`, which wakes the lead boss), `Stop job` (`cancel`). `agentfiles`: `POST /api/projects/:id/agentfiles`.

## 12c. Toolkit (`server/toolkit.js`)

One-click tools per project, shown as the tool wall of the shop (the pegboard in the scene opens it). Only the owner creates, edits and runs tools. The routes are owner routes behind the cookie. Agents never get toolkit tools.

```
Tool { id, name, icon, kind:'command'|'order'|'ask', command?, order?:{ title, brief, kind, crew }, ask?:{ to:'@boss'|'@mgr', body }, confirm:boolean }
```

- `command`: a shell command the hub runs in the project folder as the owner (clean environment, login PATH, 10 min timeout, output capped at 200 KB, redacted, and streamed as `toolrun` events). Examples: run the checks, build, open the project in an editor.
- `order`: a saved work order. One click starts (or queues) a job from the template.
- `ask`: a saved message to the lead boss or a manager of the running job (posted as `REQ` from `@human`), for example "Report what was finished today and what is slow."
- Every new project gets starter tools: `Run checks` (the project's `checkCmd`), `Open folder` (Finder), `Status report` (ask the lead boss), `What is blocked?` (ask). `Run checks` shows the command before it runs (`confirm:true`) and goes through `git.runCheck`, so in safety `sandboxed` it has the check sandbox profile (section 9).

```js
createToolkit({ store, dataDir, shellEnv, orch, git, redactor, log }) -> toolkit
toolkit.list(projectId) -> Tool[] ; toolkit.save(projectId, tools) -> Tool[] ; toolkit.run(projectId, toolId) -> { ok, runId?, jobId?, msgId? }
```

Tools are stored in `data/toolkit/<projectId>.json`.

## 13. Scene view model (UI)

**Art direction (owner's reference: the office view of the Pixel Agents project, style only).** Cozy 16-bit top-down look: chibi characters two tiles tall (16 x 32 px) with big hair and a clean dark outline; dark navy wall band with decor; calm textured floors (wood parquet, carpet in the boss offices, tile at the dock); chunky furniture in 3-4 tones; a muted palette of about 48-64 colors. All art is original and drawn in code; nothing is copied from the reference.

The scene engine (`ui/scene/`) takes a declarative view model through `scene.sync(vm)` and animates the difference. `ui/lib/vm.js` builds the vm from the client store:

```
vm = { shop:{ jobTitle, paused, statusLine },
       agents:[{ id, name, role, provider, model, style:{seed}, spot, activity, task:{id,title,domain,progress}|null, bubble:{text,kind,seq}|null }],
       deliveries:[{ id, taskId, domain, makerId, reviewerId, buddyId, stage }],
       truck:{ state, crates }, board:{ unread }, owner:{ attention } }
```

| State | vm |
|---|---|
| agent.status working / thinking / waiting / reviewing / blocked / idle / off | activity work / think / wait / review / blocked / idle / off |
| task.progress | doohickey growth stage |
| delivery checking; delivery review while the reviewer's turn has not started | stage `to_office` |
| delivery buddy | stage `buddy_check` (the buddy visits the maker's bench) |
| delivery review (reviewer running) | stage `in_review`: a boss inspects at its office desk; a manager walks to the maker's bench and inspects there (as in `buddy_check`) |
| delivery rejected | `rejected` (until the maker works again) |
| delivery approved | `to_truck` |
| delivery loaded | `on_truck` |
| delivery shipped | `shipped` |
| no loaded delivery | truck `docked`, crates 0 |
| loaded deliveries, job not in `delivering` | truck `docked` with crates (no beacon) |
| job in `delivering` | truck `ready` with crates (beacon) |
| `fx ship` | truck plays `leaving` -> `away` -> `returning` -> `docked` |

The engine keeps five truck states: `away`, `returning`, `docked`, `ready`, `leaving`. The beacon follows `ready` only; `owner.attention` rings the counter bell in the scene and pulses the `Inbox` button. Stages: `to_office`, `buddy_check`, `in_review`, `rejected`, `to_truck`, `on_truck`, `shipped`.
A job that is `paused` shows the pause reason in `statusLine`. A `queued` job shows why it waits.

## 13b. UI app (`ui/index.html`, `ui/app.js`, `ui/style.css`, `ui/lib/*.js`, `ui/panels/*.js`)

Plain ES modules, no dependencies, no build step. Served by the hub at `/`. Must work in WKWebView (the Mac app) and in Chrome.

**Start.** `app.js` reads `#k=<ownerKey>` from the URL, posts it to `POST /api/session`, removes the fragment, then loads state. A `401` shows `Open WorkShop from the app (the link holds your key).`

**Layout.** The canvas scene fills the window (integer scaling, letterboxed). DOM overlays sit on top:

- **Top bar** (44 px): wordmark, job chip (`J1 · title · STATUS · merged/total tasks · cost`, pause/resume), the `Here / Away` switch, one usage chip per lab (plan-limit status and reset time from the CLI's rate-limit events; cooling shown in amber), buttons `+ Work Order`, `Inbox (n)`, `Blueprint`, `Board (n)`, `Truck (n)`, `Crew`, `Toolkit`, `Models`, `Keys`, `Settings`.
  - Job chip status: a paused job shows its `pauseReason`; a queued job shows `waits for J1`; a job with `job.hold` shows the lab and the release time.
  - Job chip cost: `$billedUsd` for API-key turns; `~$estUsd est. at API prices` for subscription turns.
- **Ticker** (bottom, 26 px): the latest board posts and notices, one line each.
- **Drawer** (right, `min(600px, 46vw)`): one panel at a time. `Esc` closes it. Clicking scene things opens panels: agent -> Roster detail, truck -> Truck, board -> Board, counter -> Work Order, tool pegboard -> Harnesses & Toolkit (`tools` tab), wall Harness Rack -> Harnesses & Toolkit (`rack` tab), RFT Calibration Bay -> Roster & Teams (`rft` tab), office -> that boss, bench -> that maker.
- **Toasts**: `notice` events. Level `owner` stays until dismissed and also makes the matching top-bar button pulse.
- **First-run strip**: one row per runtime that is not usable, with `reason`, `Use an API key` (Frontier API-key mode), `Configure OSS` (opens `oss` runtime config), `Add the key`, `Install`, and `Test`.

**Client store (`lib/store.js`).** `GET /api/state` once, then `EventSource('/api/events?since=<seq>')`. `upsert` / `remove` replace entities by id; `board` appends and applies `changed`; `agentlog` goes to the open log view; `fx` goes to the scene. After a reconnect, refetch state. The scene view model is rebuilt from the store on every change (throttled to one per animation frame) per section 13. Lab state comes only from `ProviderStatus.usable` and `reason`.

**Panels.**

| Panel | Content |
|---|---|
| Work Order | title, kind (Build / Fix / Research), brief (large textarea), project (new name, or existing folder through `POST /api/pick-folder`; an adopted repo shows its target branch name and its `agentFiles` with the accept box `Gemini workers will load these`), crew preset or custom counts, options (approve plan first, budget: pre-filled and required when a usable lab is in API-key mode), `Start`. `Run demo (no tokens)`. **Jobs list**: every job with status, wait reason, report, `Reveal`, `Delete` |
| Blueprint | requirement ledger with status chips and source, `Add requirement`, `Waive` (asks for a reason), assumptions (defaults taken are marked), dropped plan items, decisions in force, plan notes, setup and check commands (`NOT CHECKED` when there is no check), task list grouped by status (id, title, size, domain, maker avatar, zones, deps, card changes) with `Cancel` on each row, `Approve plan` when the job is in `plan_review` |
| Board | messages as compact ShopTalk lines with a colored kind tag (13 kinds + EVT), open questions for the owner pinned on top with answer buttons for the `A) B)` options and `Overturn` on a default that was taken, filter by scope or agent, composer for the owner (kind, to, scope, re, body) |
| Truck | loaded crates (task, maker, reviewer verdict and notes, buddy verdict, `acc`, check result or `NOT CHECKED`, file stat, flags: `empty`, tests deleted, check files changed, claimed paths, card changes, same-lab review); expand a crate or the whole load to see files; click a file for a colored unified diff; the report, or `n requirements not verified` before it exists; pinned owner questions; `Approve & ship all` (sends the `headSha` the panel shows), `Ship up to here` (that crate's `mergeSha`), `Request changes` (text), `Open the cargo in Finder` (`POST /api/reveal { what:'truck' }`). After `Your branch moved` the panel reloads before it offers `Ship` again. For a cancelled job: `Ship loaded crates` or `Discard`. Shipping asks for confirmation |
| Crew | the crew as a tree: each boss, under it its floor managers, under each manager its makers. One card per agent: sprite avatar (`avatarDataURL`), persona name and handle, status chip (Thinking / Working / Waiting / Reviewing / Blocked / Idle / Off / On hold), task id and title, unread-mail count, **context bar** (share of the model's context window in use, green / amber / red), model label, cost. `Reply` opens the composer addressed to that agent. Detail view: live log (tail on open, then `agentlog` events), the agent's open board items, `Stop` (`POST /api/tasks/:id/stop`), `Retry with note` |
| Toolkit | the project's tool wall (section 12c): a grid of chunky tool buttons with icon and name; click runs (with a confirm step when the tool asks for it); a run log for command tools; `+` adds a tool (name, icon, kind, and the command, order or message); edit and delete |
| Inbox | the attention inbox (section 12b): everything that waits for the owner, newest first, each with its action (answer with option buttons, overturn a default, open the truck, approve the plan, sign in, raise the budget, resume or cancel a paused job, give a verdict, waive or add a task) |
| Models | registry table (model, lab, tier, power, price, score per category, enabled toggle), leaders per domain, data source and date, `Refresh benchmarks`. Jev is not a model row: it is a key in the Keys panel |
| Keys | one row per key (label, env var, set or not, last 4 chars, updated) with a password input + `Save`, `Remove`; `Add custom key`; saving the first key for a lab with mode `null` offers to set `apikey`; the OpenAI row says `stored; no adapter yet`; the TypeSafe row says that task text goes to TypeSafe when the key is set; per lab: auth mode with the `policyNote`, provider status, `Sign in`, `Re-check`, `Test` with the core and advisory results and the `loaded` warnings; where keys are stored |
| Settings | limits, crew presets, reviewer and cross-lab review, pairing, safety mode (`trusting` shows `Agents can do anything you can on this Mac.`), thrift slider, lab fallback, owner wait time, sound, scanlines |

**Rendering rule.** Agent text (board bodies, task titles, log lines, diffs, the report) is rendered as text only. The report view supports headings, lists, code and bold; links and images show as plain text. No `innerHTML`.

Style: reuse `PALETTE` from `ui/scene/palette.js` as CSS variables; chunky 2 px borders, hard drop shadows, no rounded corners, no gradients; monospace system font (`ui-monospace, Menlo`) for body text; all text selectable; visible keyboard focus; never put a secret value in the DOM after saving (clear the input, show only the hint).

## 14. Secrets (`server/secrets.js`, `server/redact.js`)

Backend `keychain`: `/usr/bin/security` generic passwords, service `WorkShop`, account = key id. Values are passed on stdin through `security -i`, never on the command line. Backend `file` (tests only): a JSON file with mode 0600.
Metadata without values (`label, envVar, hint = last 4 chars, updatedAt`) is in `data/keys-meta.json`.
Known ids: `anthropic` (`ANTHROPIC_API_KEY`), `gemini` (`GEMINI_API_KEY`), `openai` (`OPENAI_API_KEY`; stored, no adapter in Phase 0), `oss` (`OSS_API_KEY`; optional bearer token for remote OSS endpoints), `typesafe` (`TYPESAFE_API_KEY`; optional Jev decider). The owner can add custom ids.
`data/` is created with mode 0700 and its files with mode 0600.

```js
createSecrets({ backend, dataDir, redactor }) -> secrets                 // all methods return Promises
secrets.list() -> [{ id, label, envVar, set, hint, updatedAt }]
secrets.set(id, value, { label?, envVar? }) ; secrets.get(id) -> string|null ; secrets.remove(id)
secrets.envFor(providerId) -> { [envVar]: value }
secrets.backendInfo() -> { backend, detail } ; secrets.primeRedactor()     // boot: adds every stored value to the redactor

createRedactor() -> redactor                                             // server/redact.js; memory only
redactor.add(value) ; redactor.remove(value)                             // values shorter than 8 chars are ignored
redactor.redact(text) -> text                                            // each exact match becomes [redacted]
redactor.hit(text) -> boolean
```

The redactor holds the exact value of every stored key (loaded once at boot, updated on `set` and `remove`) and of every live agent token (`mcp` adds at mint, removes at revoke). The runner, the check tails, the toolkit output, the prompts and the board's secret scan use it.

## 14b. Shared conventions

**Logger.** Every `create*` factory accepts an optional `log(level, msg, data?)` function (`level`: `debug|info|warn|error`). Default is a no-op. `index.js` supplies the real one (stderr + `data/logs/hub.log`). Modules never call `console.*`.

**Settings (`server/config.js`).**

```js
paths({ root?, dataDir?, projectsDir?, configDir? }) -> { root, server, ui, config, data, logs, run, work, projects }   // root defaults to the folder that contains server/
createSettings({ configDir }) -> { get(), update(patch) -> settings, onChange(fn) }            // deep merge over DEFAULT_SETTINGS; the file holds only the differences
DEFAULT_SETTINGS = {
  crewPresets: { solo:{bosses:1,managers:0,makers:2}, standard:{bosses:1,managers:1,makers:4}, full:{bosses:2,managers:2,makers:6} },
  defaultCrew: 'standard',
  limits: { maxAgents:6, perProvider:{ claude:2, gemini:2, oss:6, mock:8 },
            maxReworks:3, maxNudges:2, maxRetries:2, maxBlocks:2, maxClaims:5, maxReviewers:2, maxQaRounds:3,
            maxTasks:40, maxTasksTotal:60,
            turnTimeoutMin:45, taskTimeoutMin:{ S:20, M:45, L:90 }, idleTimeoutMin:12, checkTimeoutMin:10,
            holdFallbackMin:20, maxFileMb:1, maxDeliveryMb:5, maxDeliveryFiles:500, turnUsd:5,
            rotateTok:{ boss:40000, manager:40000, maker:90000 }, rotateGapMin:5, rotateGapTok:25000 },
  review: { reviewer:'boss', crossLab:true, smallByManager:true },
  pairing: 'M+L',                 // 'costly' | 'M+L' | 'all'
  approvePlan: false,
  safety: 'sandboxed',            // or 'trusting'
  thrift: 0.3,                    // 0 = best model always, 1 = cheapest that fits
  allowFallback: true,            // route to another usable runtime when one is cooling or missing
  auth: { claude:null, gemini:null },       // null | 'apikey' (consumer subscriptions disabled in Phase 0)
  authAck: { claude:null, gemini:null },    // { mode:'apikey', ts }
  selfTest: { claude:null, gemini:null },   // { version, ok, core, advisory, ts }
  oss: { engine:'ollama', baseUrl:'http://127.0.0.1:11434/v1', standIn:false },
  presence: 'here',               // or 'away'
  humanWaitMin: 30,
  budgetUsd: 20,                  // default budget of a new job; applies to billedUsd
  board: {},                      // overrides of the ShopTalk LIMITS
  ui: { sound:false, scanlines:false },
}
```

**Fresh install defaults.** `config/settings.json` is git-ignored and omitted from a fresh clone (`createSettings()` starts from `DEFAULT_SETTINGS` when absent), leaving Frontier providers requiring explicit API-key selection and `oss` configurable via local endpoint or Stand-in mode.

**HTTP (`server/http.js`).**

```js
createHttp({ host='127.0.0.1', port=0, uiDir, ownerKey, log }) -> http
http.route(method, pattern, handler, { open?:boolean })   // handler(ctx) may return an object (sent as JSON 200) or call ctx.json / ctx.text
  ctx = { req, res, params, query, body, json(status, obj), text(status, string, contentType?) }
http.sse(pattern, { replay(sinceSeq) -> event[] }) -> { send(event), count() }   // SSE endpoint; event.seq becomes the SSE id
http.listen() -> Promise<{ port, url }> ; http.close()
```

Every `/api/*` route needs the owner cookie unless it is registered with `open:true` (`POST /api/session` only). `ownerKey` is required; tests pass their own. Body limit 2 MB. Unknown `/api/*` route: 404 JSON. Other paths: static file from `uiDir` (`/` -> `index.html`), path traversal refused. A thrown error in a handler becomes `500 { error }` and is logged; an error with `.status` uses that status.

**Git (`server/gitops.js`).** All git runs through `execFile('git', [...])` with `GIT_TERMINAL_PROMPT=0` and `-c commit.gpgsign=false -c core.editor=true -c core.hooksPath=/dev/null`, a timeout, and `--` before paths. The hub never depends on the owner's global git identity: maker commits use author `<AgentName> <agent@workshop.local>`, hub merges use `WorkShop Hub <hub@workshop.local>`. Bench clones have `origin` = the canonical repo path and a push URL that cannot work. The integration ref inside a bench is `origin/<integrationBranch>`; it is the `baseRef` for zone checks and diff stats after a sync.

## 14c. Facts fixed by the built modules and by real runs

- `state.projects / jobs / tasks / agents / deliveries` are plain objects keyed by id. Use `store.list(kind)` or `Object.values`.
- All times (`ts`, `createdAt`, `updatedAt`, `due`, `seenAt`, `cooling.until`) are epoch milliseconds.
- `store.flush()` returns a Promise. Await it before exit.
- `paths({ dataDir, configDir, projectsDir })`: tests must override all three so they never touch the real folders.
- Every non-GET request needs `X-WorkShop: 1`. The stdio shim sends it. A direct HTTP MCP config adds it to `headers`.
- SSE frames have no `event:` field: the UI uses `onmessage` and switches on `data.type`. Open the stream as `/api/events?since=<seq from /api/state>`. `seq` jumps by 1000 on a restart; a client that sees a lower id reloads `/api/state`.
- A request body must be a JSON object or array (empty body = `{}`).
- `http.listen()` works once per instance. `http.close()` ends SSE clients.
- `secrets.*` methods are async.

Proven on 2026-11-15 with the owner's signed-in Claude CLI (Max plan, subscription auth, model `claude-haiku-5-5`): the worker recipe of section 10 works against the real API. A maker-style turn wrote a file, called the `shop` MCP tool (`alwaysLoad`, tool search off) and ended cleanly; `--resume` kept the context.
- The stream carries `{"type":"rate_limit_event","rate_limit_info":{status, resetsAt (epoch seconds), rateLimitType, overageStatus}}`. The Claude parser reads it: `status` other than `allowed` means the lab cools until `resetsAt`.
- `total_cost_usd` is wrong for models this CLI version does not know (it printed `[claude-code:unrecognized_model]` on stderr and priced Haiku 5.5 about 60 times too high). So the runner prices every turn from token counts and registry prices.
- First-request overhead with the default system prompt kept, four built-in tools and the shop tool: about 12,500 tokens, cached on later turns. Cache entries last 5 minutes.
- A hook and an allow rule from `--settings` both applied with `--setting-sources ""` in the probe against a fake API. The mail hook still needs its own provider test (section 10).

Proven on 2026-11-15 with the owner's signed-in Antigravity CLI (`agy` 1.5.1, subscription, model slug `gemini-4-hydrogen-low`): the worker recipe of section 10 works. A maker-style turn wrote a file, called the `shop` MCP tool and ended with `status:"SUCCESS"`; `--conversation <id>` kept the context; `run_command` ran in the sandbox with no prompt.
- Model slugs are `<api id>-<effort>` (`agy models` lists them: Carbon low/medium/high, Argon low/medium/high, Hydrogen low/medium/high/xhigh, 3.8 Flash). `providers.checkAuth('gemini')` stores this list; the router only offers slugs that are in it.
- The workspace file `.agents/mcp_config.json` loads in `-p` runs. With `"tools":{"<tool>":{"eager":true}}` the model calls `mcp_shop_<tool>`. The rule `mcp(shop/*)` in `permissions.allow` is enough.
- **`.agents/rules/*.md` is not applied in `-p` runs.** The role card goes at the top of the first prompt of each conversation.
- The CLI rejects an unknown settings key with exit 1.
- Stream facts: `step_type` can be `unknown`; `result.usage` counts this run only; `result.num_turns` and `duration_seconds` are totals for the conversation; a model call carries about 24,000 input tokens of base context (60 tools), so Gemini turns cost more context than Claude turns.

## 15. Tests

`node --test tests/` with temp data dirs. No test runs a real AI CLI unless it is an opt-in integration test.

| Area | Unit tests |
|---|---|
| store | atomic save, ids, events, file modes 0700 / 0600 |
| http | Host and Origin guards, `X-WorkShop`, owner cookie (401 without it on every `/api` route, GET and SSE included; an agent token opens nothing under `/api`), response headers, SSE replay |
| shoptalk, board | grammar with `acc=` and `default=`; who may post what (REQ human only, manager DECIDE in its stream, buddy PASS/FIX, `@human` bosses only); `E_ACC`; limits apply to ASK, INFO, REQ, DECIDE only; DONE idempotent; freeze; forward; forged body lines; continuation bar; secret scan on owner posts and exact values; closure wakes; shop time (seenAt, pause, hold, tick gap); owner default (here, away, overturn); replay of `act` and patch lines; per-session cursors and aux views |
| mcp | handshake, role checks, token mint and revoke per turn, `GET /mcp/:token/tag`, stdio shim with `--url-file` |
| gitops | bench, sync, conflict, integrate invariant with `expectHead`, `already`, `empty`; `HUB_PATHS` never committed; bench config rewrite; guard (deny list, size, secrets, empty); `resetBench`; `makeClone` and agent-file strip; head check cache; `truck` with `behind` and `headSha`; `ship { sha }` on the first-parent chain only; `refreshTruck` (clean, conflict, red); refs under `refs/workshop`; `saveBench`; `removeJobWork`; `adoptProject.agentFiles`; sandbox profile for setup and check |
| providers, runner | stream parsers against recorded fixtures (`tests/fixtures`, real runs included): `rate_limit_event`, `ctxTok`, error kind `model`; `usable` (ack, self-test, mode); model cooling as one episode; adapters put no token in an argument or a bench file; settings file under `runDir`; runner: session id passed in and returned, redaction, group kill at every turn end, cost split billed / est, idle watchdog pause during a tool, shop-time watchdogs |
| router | pick rule, cooled models, models not in the account list |
| orchestrator | plan validation (zones, `HUB_PATHS`, check command, `covers` / `dropped`), baseline gate, ledger rules (add, waive, cancel guard, `req_verify` guards), turn classes and session storage, maker binding, claims queue, counters and caps, circuit breaker, turn-failure table, holds and fallback, rotation, stall rule, queue and promotion, pause reasons, budget stop, cancel and delete, recover from every status |
| secrets, redactor | file backend, known ids (`typesafe`), exact-value redaction |
| prompts | the module loads; every prompt builder returns text with its fixed phrases |

Opt-in provider tests (real CLI, owner-run): the self-test with its core and advisory checks; a hook from `--settings` runs with `--setting-sources ""`.

End to end: boot the server on a temp dir, open the owner session, start a mock job, wait for a loaded truck, ship the `headSha`, assert the target branch holds the merged files and every requirement is verified. Variants force paths with the mock flags: `[mock:reject]`, `[mock:conflict]`, `[mock:checkfail]`, `[mock:ask]`, `[mock:block]`, `[mock:claim]`, `[mock:empty]`. One variant restarts the hub mid-job in each task status and checks that the job finishes.
