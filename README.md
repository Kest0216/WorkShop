# WorkShop

**A local pixel-art coding workshop where Frontier AI Officers plan & inspect, and RL-certified open-weight specialist teams do the heavy building for `$0`.**

![WorkShop 16-bit shop floor](docs/progress/macapp-04-running-floor.jpg)

Running big coding projects purely on closed-source APIs burns through tokens fast — and Anthropic and Google strictly prohibit third-party OAuth / consumer subscription mirroring. Meanwhile, merely slapping a system prompt, skill file, or tool list onto an untrained open model produces brittle slop. WorkShop solves both problems cleanly:

- **Orchestration Officers & Final Review Gates (`openai` · `gemini` · `claude`):** Read your request, break it into safe parallel tasks with strict file zones, review finished diffs, and run final QA. **OpenAI** supports its official **Sign in with ChatGPT (OAuth 2.0 + PKCE)** portal flow alongside optional `OPENAI_API_KEY`; **Gemini** and **Claude** run strictly via API keys. Closed-source models act as Officers & Review Gates only — proprietary weights can never enter GPU RL post-training.
- **RL-Certified Open-Weight Specialist Teams (`$0` OSS):** Open-weight models (via Ollama, vLLM, SGLang, llama.cpp, or `[SIM]` Demo Sandbox) are assembled in the **Drag-and-Drop Agent Forge** (**Open-Weight Brain + Harness Rig + Intrinsic Tool Belt**), post-trained via the **Universal RL Compute Port**, and verified at a deterministic **QA Gate** before entering your **Employee Handbook** — costing **`$0` per million tokens** at runtime.

---

## Try It in 60 Seconds

Zero API keys, zero GPUs, and zero `npm install` (WorkShop runs on Node 20+ built-ins only).

1. **Open the Mac app:** Double-click **`WorkShop.app`** (if macOS asks for Desktop access, click **Allow**), or launch the server directly with `npm start` and open the URL printed in your terminal.
2. **Run the demo:** Click **Run demo** on the welcome card. It runs a simulated build for free so you can watch specialists walk to benches, post updates in the unified **Board**, load crates onto the **Truck**, and test the **Approve & Ship (`+1`)** flow.

---

## How an Order Moves Through the Shop

<p align="center">
  <img src="docs/assets/order-pipeline.svg" width="100%" alt="Animated diagram showing how a Work Order moves and branches through WorkShop">
</p>

Here is what happens behind the scenes whenever you submit a **+ Order**:

1. **You drop off an order:** Describe what you want built in plain English, pick a new project or point at an existing git repo, and choose a team size.
2. **Frontier Officer plans it out:** An OpenAI, Gemini, or Claude officer reads your codebase and turns your goal into a checklist of requirements, tasks, and disjoint **file zones** (so parallel builders never edit the same files at once). *If you checked "Show me the plan first", it waits in the **Board Action Deck** and **Blueprint** for your approval before anyone writes code.*
3. **Branch 1 — Certified Employee Handbook (`Team -> Employee Handbook`):** When staffing a task, the router checks your **Employee Handbook** for an RL-certified open-weight specialist matching that domain:
   - **Certified match found:** That character steps up to the bench with their intrinsically trained **Harness Rig** (`.shop/HARNESS.md`) and **Tool Belt**, ranked by verified RL benchmark + your historical ship rating.
   - **No untrained slop:** Untrained models cannot be thrown onto a harness and added to the Handbook directly. If a specialty is missing in a real run, WorkShop queues an **Agent Forge** RL requisition and holds the task until the specialist passes RL + Verification QA (`[SIM]` Demo mode supports zero-GPU workflow testing).
4. **Parallel `$0` OSS benches:** Each task runs in its own isolated git clone inside an OS sandbox. Agents can only touch files in their assigned bench and can ask **Team Leads** or **you** questions (2–4 quick multiple-choice options) in the unified **Board & Action Deck**.
5. **Branch 2 — Automated checks & Review Gate:** When a specialist finishes, the hub runs your project's test command, checks that only allowed files changed, and hands the diff to a Frontier Reviewer:
   - **`FIX` branch:** If tests fail or something looks wrong, it bounces right back to the specialist's bench with numbered fix notes.
   - **`PASS` branch:** The hub merges that task one at a time, re-runs checks to verify the combined repo still passes, and loads a **crate** onto the **Merge Truck**.
6. **Final QA, Your Call & Owner Agent Ratings (`+1 / -1 / 0`):** Open **Truck**, inspect any diff line-by-line, and make the call:
   - **Approve & Ship (`+1`):** Fast-forwards your branch cleanly and awards **`+1`** to each crate's specialist.
   - **Deny / Request Changes (`-1`):** Logs **`-1`** on the specialist with your exact reason in the Handbook's **`Why? · Owner Rating Log`** — so even if a model gamed static benchmarks, you can see *why* an agent performs well or poorly over real work.
   - **Discard (`0` · neutral):** Drops accidental or unwanted work with **zero** rating penalty.

---

## Gamified Agent Forge & Universal RL Compute Port

Open **Team -> Agent Forge & Armory** to build new specialists robustly:

1. **Drag & Drop on the Anvil:**
   - **Slot 1 — Brain (Open-Weight Only):** Drop an open-weight `oss` model (e.g., `Qwen3 Coder 32B`, `DeepSeek R1 32B`, `Devstral 24B`, or any custom HuggingFace/Ollama weight). Closed-source models (`OpenAI`, `Gemini`, `Claude`) are visually and API-locked from the Forge because proprietary weights cannot be exported to a GPU cluster.
   - **Slot 2 — Harness Rig:** Drop a rig from the **Harness Rack** (or build a new `.shop/HARNESS.md` protocol + verifiable reward spec).
   - **Slot 3 — Intrinsic Tool Belt:** Equip built-in or custom agent tools so RL trajectory rollouts train directly with those tool schemas.
2. **Send Through the Universal RL Port (`Settings -> RL Compute Port`):**
   - **Local Machine GPU:** Connect Apple Silicon MLX or local CUDA/PyTorch/Unsloth via personal `local/rl-port.mjs` or a local HTTP daemon (`ports/rl/template-local.mjs`).
   - **Remote Compute Cluster:** Offload RL jobs to a DigitalOcean GPU Droplet, Hostinger VPS, RunPod, or any HTTPS endpoint (`ports/rl/template-remote.mjs`) using a Keychain-stored `RL_PORT_TOKEN`.
   - **1-Click Agent Wiring:** Click **Copy Agent Prompt to Wire My Port** to hand a ready-made prompt referencing [`ports/rl/PORT_CONTRACT.md`](ports/rl/PORT_CONTRACT.md) to your coding agent so it wires your exact GPU or remote host automatically.
   - **`[SIM]` Demo Sandbox:** Test the full Forge -> RL -> QA -> Handbook loop on any laptop with zero GPUs (enrolled agents carry an explicit `[SIM]` badge and never silently pose as production GPU checkpoints).
3. **Deterministic Verification & QA Gate:** Before any trained checkpoint enters the **Employee Handbook**, WorkShop verifies `evalScore >= 75`, `pass@1 >= 75%`, `0` sandbox/hub-path violations, and `>= 90%` tool schema compliance. Checkpoints that fail QA are rejected (`rejected_qa`).

---

## Setting Up Runtimes & Keys

Open **Settings -> Runtimes & Keys** in the top bar (or use the **Quick setup** card on the floor). You only need **`$0` OSS** plus **one** Frontier Officer runtime to run real jobs:

1. **`$0` Open-Weight Runtime (`oss`):**
   - **Zero-GPU Stand-in:** Check **Enable Stand-in simulation ($0)** and click **Save & Probe**, or
   - **Local / Cluster Server:** Run [Ollama](https://ollama.com) (`ollama pull qwen2.5-coder:32b && ollama serve`), vLLM, SGLang, or llama.cpp at `http://127.0.0.1:11434/v1` and click **Save & Probe**.
2. **Frontier Officer & Review Gate (Pick Any One):**
   - **OpenAI:** Click **Continue with ChatGPT** to sign in through OpenAI's official OAuth 2.0 + PKCE portal flow (`$0` billed token spend), *or* choose **Use API key** and save `OPENAI_API_KEY`.
   - **Gemini (`agy`) or Claude (`claude`):** Click **Use API key**, save `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` in the macOS Keychain Vault (only the last 4 characters ever return to the UI), click **Re-check**, and run the 1-click **Test**.
3. **Optional Dollar Cap:** In **+ Order** or **Settings -> Shop Rules & Limits**, set a **Frontier API budget in USD** (applies to metered API-key turns; ChatGPT subscription and OSS turns bill `$0`).

---

## Public GitHub Repo vs. Personal Machine Overlay (`local/`)

WorkShop is designed as universal public scaffolding while keeping your personal RL connections, private cluster endpoints, and forged checkpoints strictly on your machine:

- **Tracked Public Scaffolding:** `ports/rl/PORT_CONTRACT.md`, `ports/rl/template-local.mjs`, `ports/rl/template-remote.mjs`, and baseline `config/*.json`.
- **Git-Ignored Personal Overlay (`local/*`):**
  - `local/rl-port.mjs` & `local/rl-port.json` — Your personal local GPU or Droplet/Hostinger RL adapter and endpoint config.
  - `local/roster.json` — Your personally forged specialists, checkpoints, and `+1 / -1 / 0` rating history.
  - `local/harnesses.json` — Your private custom harnesses.
  - Secrets (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `RL_PORT_TOKEN`, OAuth tokens) live exclusively in **macOS Keychain**.

---

## Quick Tour of the Consolidated 6-Item Taskbar

| Topbar Button / Floor Prop | What you do there |
|---|---|
| **1 · + Order** *(front counter)* | Start a job, adjust team size, set a Frontier dollar cap, or run the zero-token demo |
| **2 · Board** *(Command Board & Action Deck)* | Unified **Owner Action Deck** (questions, plan approvals, ready trucks, manual verdicts, paused jobs) pinned above the live ShopTalk feed (`All` · `Action Needed` · `Live Feed`) |
| **3 · Blueprint** | Live progress: checklist of requirements, tasks grouped by status, baseline check results, pause/resume |
| **4 · Truck** | Diff-by-diff inspection, final report, **Approve & Ship (`+1`)**, **Deny / Request Changes (`-1`)**, or **Discard (`0` neutral)** |
| **5 · Team** *(Floor · Handbook · Agent Forge)* | **Active Floor** live logs, **Employee Handbook** (RL benchmarks + owner `+1/-1/0` ratings & history), and the **Drag-and-Drop Agent Forge & Armory** (`Open-Weight Brains & Benchmarks`, `Harness Rack`, `Agent Tools & Project Tool Wall`) |
| **6 · Settings** | **Runtimes & Keys** (OpenAI **Continue with ChatGPT** SIWC, Gemini/Claude API keys, Local OSS, Keychain Vault), **RL Compute Port** (Local GPU, Droplet/Hostinger/RunPod Cluster, 1-click Agent Wiring Prompt, `local/` overlay), and **Shop Rules & Limits** |

*See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for module contracts and [docs/ROADMAP.md](docs/ROADMAP.md) for the multi-phase roadmap.*

---

## Requirements & Handy Commands

- **macOS 14+** (for `WorkShop.app` / Keychain), **Node.js 20+**, and **git**.
- Optional for Frontier Officers: **OpenAI** (ChatGPT sign-in or API key), **Antigravity CLI** (`agy` + `GEMINI_API_KEY`), and/or **Claude Code CLI** (`claude` + `ANTHROPIC_API_KEY`).

```bash
# Start the hub server directly (prints your local browser URL)
npm start

# Start a scratch sandbox hub with the built-in mock runtime only
node server/index.js --labs mock --secrets file --port 0 --data /tmp/ws/data --config /tmp/ws/config --projects /tmp/ws/projects

# Run the automated test suite (no external tokens used)
npm test

# Rebuild WorkShop.app after modifying macapp/ Swift sources (requires Command Line Tools)
bash macapp/build.sh
```

<details>
<summary>Quick troubleshooting & project folders</summary>

- **Folders:** `WorkShop.app` (Mac launcher), `server/` (hub, providers & RL port), `ui/` (6-panel UI & 16-bit scene), `ports/rl/` (Universal RL Port contract & templates), `local/` (git-ignored personal overlay), `config/` (`models.json`, `harnesses.json`, `roster.json`), `data/` (local state, logs, task clones — git-ignored), `projects/` (new repos), `tests/` (`node --test` suites).
- **Job stuck in `queued`?** No Frontier Officer runtime is ready yet — open **Settings -> Runtimes & Keys**, sign in with ChatGPT or save one Gemini/Claude API key (or click **Run demo** for zero-key testing).
- **Task held waiting on a specialist?** In real runs, every specialist must be RL-certified in the **Employee Handbook** — open **Team -> Agent Forge & Armory** to train and verify the queued specialty.
- **Job `paused` after closing or restarting?** Safe restarts pause active jobs automatically; open **Blueprint** (or **Board -> Action Needed**) and click **Resume**.
- **Page says `Locked`?** Re-open from **`WorkShop.app`** or use the full URL containing `#k=...` printed by `npm start`.
- **Want a fresh slate?** Quit WorkShop and delete `data/` (your `projects/`, `config/`, `local/` overlays, and macOS Keychain keys stay untouched).
- **Logs:** `data/logs/hub.log`, `data/logs/launcher.log`, and live per-agent logs in **Team -> Active Floor**.

</details>
