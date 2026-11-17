# WorkShop

A Mac app for one owner (Phase 0 architecture — see [docs/ROADMAP.md](docs/ROADMAP.md)). You write a work order. Frontier **Orchestration Officers** (`gemini` / `claude`, API-key only) investigate, plan, and serve as **Final Review Gates**, while **$0 Open-Source Specialist Agent Teams** (`oss` — local/cluster `Ollama`, `vLLM`, `SGLang`, `llama.cpp`, or Phase 0 Stand-in simulation) equip modular harnesses from the **Harness Rack** to build tasks on isolated benches and load reviewed crates onto a merge truck.

WorkShop enforces zero consumer subscription automation (ToS compliance & predictable spend): heavy coding/iteration stays on `$0` open-weight specialists matched from the **Employee Book**, and uncurated domains automatically queue structured **Phase 1 RFT training requisitions**.

![The shop floor inside the Mac app](docs/progress/macapp-04-running-floor.jpg)

## Start

1. Double-click `WorkShop.app` in this folder.
2. The first time, macOS asks if WorkShop may use the Desktop folder. Click **Allow**. The app's files live here.
3. Click **Run demo**. It uses a fake lab, costs nothing and takes about 3 minutes. Watch a job go from plan to truck, then click **Truck** and **Approve & ship all**.
4. Set up the labs (next section). Then click **+ Work Order** and write your first real work order. Choose **New project**, or **Existing folder** (a git repo with at least one commit). Click **Start**.

Closing the window does not stop the work. Quit with a job running asks: **Keep working** or **Pause and quit**.

## What you need

| Thing | Why | Check |
|---|---|---|
| macOS 14 or newer | The app | |
| Node.js 20 or newer | The hub runs on it | `node --version` |
| git | The hub keeps all work in git | `git --version` |
| Open-weight runtime (`oss`) | Specialist Teams (`$0`): Ollama, vLLM, SGLang, llama.cpp, or built-in Phase 0 Stand-in mode | Configure in **Runtimes & Keys** |
| Antigravity CLI (`agy`) | Gemini Orchestration Officers & Review Gates (API key mode) | `agy --version` |
| Claude Code CLI (`claude`) | Optional Claude cross-check Review Gates (API key mode) | `claude --version` |

WorkShop has no external dependencies. There is no `npm install`.

## Set up the runtimes

Open **Runtimes** (or follow the first-run **Runtime setup** strip on the floor):

1. **Open-Source Agent Team Runtime (`oss`, \$0).** Pick an engine (`ollama`, `vllm`, `sglang`, `llamacpp`, or `command`), enter your base URL (`http://127.0.0.1:11434/v1`), or enable **Phase 0 Stand-in simulation mode** to exercise Harness Rack + Employee Book orchestration locally with zero GPU.
2. **Frontier Officers & Review Gates (`gemini` / `claude`, API-key only).** Choose **Use an API key**, paste your `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` into the Keychain card, and press **Test** (required for safety mode **Sandboxed**). Consumer subscription logins are disabled in Phase 0 for Terms-of-Service safety and predictable costs.

A runtime chip in the top bar turns from **setup** to **ok** (`sim` / `local` for `oss`) once ready. One Frontier officer + `oss` (or Stand-in) is enough to run full teams.

## How a job runs

```
 you            bosses          makers            hub              reviewer          you
  |               |               |                |                  |               |
  | work order -> |               |                |                  |               |
  |               | plan: requirements + tasks     |                  |               |
  |  (approve the plan, if you asked for that)     |                  |               |
  |               | ------------> | build at a bench (own git clone)  |               |
  |               |               | DONE --------> | commit, guard, zone check, tests |
  |               |               |                | ---------------> | PASS or FIX   |
  |               |               |                | merge (one at a time) -> TRUCK   |
  |               | QA: every requirement checked against the merged work             |
  |               | report                         |                  |               |
  |               |               |                |   truck waits  ----------------> |
  |               |               |                | <-- Approve & ship (one exact commit)
  |               |               |                | your branch moves forward to it  |
```

Job states: `queued → planning → (plan_review) → running → qa → delivering → done`. A job can also be `paused` or `cancelled`. One job is on the floor at a time, and a paused job keeps the floor. More orders wait in the queue.

## The crew (Phase 0 Team Architecture)

| Tier | Job | Primary Models (picked by benchmark data) |
|---|---|---|
| Orchestration Officer (`boss`) | Investigates, plans requirements & zones, serves as Final Review Gate, runs QA & report | Gemini 4 Carbon / Claude Fable 5.2 (API-key only) |
| Team Lead (`manager`) | Owns a stream of tasks, unblocks specialists, re-plans blockers (\$0) | Llama 4 Scout 17B / DeepSeek-R1-32B (`oss`) |
| Specialist (`maker`) | Equips a **Harness Rack** rig (`.shop/HARNESS.md`) and builds one task on an isolated bench (\$0) | Qwen3 Coder 32B / DeepSeek-R1-32B / Devstral 24B / Gemma 3 27B / Qwen2.5-VL 32B (`oss`) |

| Crew preset | Officers | Team Leads | Specialists at once |
|---|---|---|---|
| Solo | 1 | 0 | 2 |
| Standard (default) | 1 | 1 | 4 |
| Full | 2 | 2 | 6 |
| Custom | you choose | | |

At most 6 agent turns run at the same time (up to 6 `oss`, 2 `gemini`, 2 `claude`).

The router picks models from `config/models.json` (benchmark data from BenchLM.ai, CC BY-NC 4.0). At assignment time, `server/decider.js` uses your Gemini key (or TypeSafe key, with deterministic fallback) to match each task against the **Employee Book** (`config/roster.json`) and **Harness Rack** (`config/harnesses.json`). Missing/uncertified domain specialties automatically queue a **Phase 1 RFT Training Requisition** (`data/requisitions.json`) while executing cleanly on a Phase 0 OSS fallback.

## Why work does not collide or get lost

These rules are code in the hub, not requests to the agents.

- **The hub owns git.** Agents only edit files. The hub commits, merges and ships.
- **One bench per task.** Each task gets its own clone. No two agents share a working folder.
- **Zones.** Each task lists the paths it may change. Tasks that run at the same time have separate zones. A change outside the zone is refused.
- **Merges go one at a time.** Each merge is tested again on the merged result before the next one starts.
- **Three gates.** The tests pass. A reviewer passes it (the other lab when possible). You approve the exact commit that ships.
- **A ledger of requirements.** Every ask in your brief becomes a numbered requirement. A second lab reads your brief and adds what the plan missed. At the end, QA checks each requirement against the merged work and gives evidence. Only you can waive one. A job cannot end with an open requirement.
- **Your branch only moves forward.** Shipping is a fast-forward to one commit. Nothing is forced. If your branch moved in the meantime, the hub merges that in, tests again and asks you to look again.
- **It survives restarts.** All state is on disk. After a crash the hub picks up where it stopped.

## The message board

All agents and you share one board. The language is **ShopTalk**: a strict one-line head that the hub checks, and a short body in plain technical English.

```
ASK @mgr T4: Which date format does the export use?
ANS re:31: Use ISO 8601. See src/export.js:12.
DONE T4 tests=6/6 acc=3/3: Added the export. See src/export.js.
FIX re:40: 1. src/export.js:31 drops the time zone. Keep it.
DECIDE #build: All dates are UTC from now on.
```

There are 13 kinds: `ASK ANS REQ OK NO INFO BLOCK DONE FAIL PASS FIX DECIDE CANCEL`. The hub refuses a post that breaks the rules: too long, chat, a duplicate, a loop, pasted code, a secret. Agents point at things (`src/a.js:31`, `T12`) instead of pasting them. Each agent sees only the posts it needs. That keeps the token cost low.

A maker can ask the other lab for a second view: `ASK @other`. The hub also does this by itself when a task is stuck.

## Your controls

| Panel | What you do there |
|---|---|
| **+ Work Order** | Write a work order. Start a job, or queue it. See all jobs |
| **Inbox** | Everything that waits for you, in one list: questions, the truck, a plan to approve, a sign-in |
| **Blueprint** | The plan: requirements, tasks, decisions. Pause, resume, cancel. Add or waive a requirement |
| **Board** | Read the board. Post to any agent |
| **Truck** | The reviewed work. Read the report, look at each change, ship all or ship up to one crate, or ask for changes |
| **Roster** (`crew`) | Live **Active Team** tree, persistent **Employee Book** (`config/roster.json`), and **Phase 1 RFT Queue** (`data/requisitions.json`) — opened by the 16-bit RFT Calibration Bay |
| **Harnesses** (`toolkit`) | **Harness Rack** (modular OSS workflows/tools/RFT specs injected as `.shop/HARNESS.md`) and per-project **Project Tools** — opened by the wall Harness Rack and pegboard |
| **Models** | The model table (`$0 (local)` OSS specialists + Frontier officers) and benchmark scores |
| **Runtimes** (`keys`) | OSS engine/Stand-in config, Frontier API-key-only status, and Keychain API keys |
| **Settings** | Safety mode, crew default, who reviews, how long a question waits for you |

On a narrow window some labels get shorter (**+ Order**, **Tools**), and **Models**, **Keys**, **Settings** and **Toolkit** fold into **More**.

**Here / Away.** A boss may ask you a question with 2 to 4 options and a default. With **Here**, the hub waits 30 minutes, then takes the default. With **Away**, it takes the default at once. Either way the question stays in the Inbox, and you can overturn the default later.

## Safety and cost

- **Sandboxed** is the default safety mode. Every shell command of every agent runs in an OS sandbox. It can write only in its own bench. It cannot read `~/.ssh`, cloud credentials, the Keychain or WorkShop's own secrets. **Trusting** turns the sandbox off. Use it only if you must.
- **Keys** live in the macOS Keychain. They never reach the page, the logs or the board.
- **Local only.** The hub listens on `127.0.0.1` and needs an owner key that only the app holds.
- **Cost.** Open-source Specialist & Stand-in turns cost `$0`. Frontier Orchestration Officer & Review Gate turns run on API keys (`billedUsd`), guarded by each work order's budget (default $20).
- **Sleep.** While a job runs the Mac stays awake. A closed lid still sleeps. The job goes on when the Mac wakes.

## Folders

```
WorkShop.app     the app (double-click)
server/          the hub (providers/oss*, harnesses.js, roster.js, training.js, decider.js)
ui/              the page and the 16-bit pixel scene
config/          models.json, harnesses.json, roster.json, settings.json
data/            state, logs, working clones, requisitions.json (git-ignored, made on first start)
projects/        new projects are made here
macapp/          the app's Swift source and build script
tests/           node --test suite
docs/            ROADMAP.md, ARCHITECTURE.md (the full contract), DESIGN-REVIEW.md
```

## For developers

```bash
node server/index.js --labs mock --secrets file --port 0 --data /tmp/ws/data --config /tmp/ws/config --projects /tmp/ws/projects
```

That starts the hub with the fake lab only and prints `WORKSHOP_READY http://127.0.0.1:<port>/#k=<key>`. Open that address in a browser. Without the three folder flags the hub uses the app's own `data/`, `config/` and `projects/`. Then it refuses to start while the app runs: one hub per data folder.

```bash
node --test tests/
```

That runs the whole suite. It never starts a real agent. Two extra test files run the real `claude` binary against a fake local API, so they use no tokens. They are off by default: set `WORKSHOP_CLI_TESTS=1` to include them.

```bash
bash macapp/build.sh
```

That rebuilds `WorkShop.app`. It needs `swiftc` (Xcode or the Command Line Tools). A build that changes the app makes macOS ask again for the Desktop folder.

## If something goes wrong

| You see | Do this |
|---|---|
| "WorkShop needs Node.js 20 or newer" | Install Node.js 20 or newer, then click **Try Again** |
| A lab chip says **setup** | Open **Keys**. The lab card says which step is missing |
| The job chip says **queued** and nothing runs | No lab can run a boss now. Hover the chip for the reason. Open **Keys**, or wait for the limit to reset |
| A job is **paused** after a restart | Every normal hub stop pauses the job. Open **Blueprint** and click **Resume** |
| The page says **Locked** | Use the app window. The address only works with the app's key |
| An agent seems stuck | Open **Crew**, click **Log**. You can **Stop** the task, then **Retry with note**, also on the other lab |
| You want to start over | Quit the app and delete the `data` folder. Your project folders, `config/` and Keychain keys stay. The hub forgets its jobs, the board and its list of projects |

Logs: `data/logs/hub.log`, `data/logs/launcher.log`, and one file per agent.
