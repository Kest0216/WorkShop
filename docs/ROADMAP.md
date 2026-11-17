# WorkShop Roadmap: Open-Source Agent Teams, Harnesses & RFT (Phases 0–3)

WorkShop is organized around a cost-sustainable, Terms-of-Service-compliant operating model:

- **No consumer subscription logins.** Automated agent loops run exclusively on API keys for Frontier orchestration/review gates and on open-weight (`oss`) runtimes for heavy execution.
- **Keep Frontier API costs bounded.** Heavy implementation, iteration, and tool loops (which can consume billions of tokens over large builds) run on `$0` open-source models equipped with modular **Harness Rack** toolkits, supervised by a small Frontier **Orchestration Officer** and **Final Review Gate** (plus Gemini decision routing).

---

## Phase 0 — Local Architecture & Scaffolding *(Delivered in this repository)*

Phase 0 establishes the local hub contracts, state stores, UI surfaces, and simulated/local runtime hooks without downloading model weights, provisioning cloud GPU clusters, or running GPU fine-tuning training jobs.

1. **API-Key-Only Frontier Officers & Review Gates**
   - `claude` and `gemini` operate strictly in `apikey` mode (`PUT /api/providers/:id/mode` rejects `subscription`; `loginCommand` is disabled).
   - Frontier models occupy primary `boss` (Orchestration Officer & Final Review Gate) slots in `config/models.json`.
   - `server/decider.js` routes task sizing and specialist matching via Gemini (`GEMINI_API_KEY` or `TYPESAFE_API_KEY`, falling back cleanly to deterministic matching when unkeyed).
2. **Open-Source Agent Team Runtime (`oss`)**
   - `server/providers/oss.js` + `server/providers/oss-agent.mjs` connect to local/cluster OpenAI-compatible inference servers (`Ollama`, `vLLM`, `SGLang`, `llama.cpp`), custom command harnesses, or **Phase 0 Stand-in simulation mode** (`settings.oss.standIn`).
   - Enforces path confinement inside the task bench (`resolveBenchPath`, blocking `.shop`, `.agents`, `.git`, symlinks outside the bench) and bridges dynamic `shop__*` MCP tools.
   - `OSS` models occupy primary `maker` (Specialist) and `manager` (Team Lead) tiers at `$0` per 1M tokens.
3. **The Harness Rack (`config/harnesses.json`, `server/harnesses.js`)**
   - Registry of modular domain/platform harnesses (`fullstack-node`, `systems-debug`, `ui-pixel-craft`, `test-fortress`, `data-algo-lab`, `research-dossier`, `team-lead-coord`).
   - Rendered into each agent's bench as `.shop/HARNESS.md` and injected into system instructions.
   - Configurable via REST (`GET/PUT/POST/DELETE /api/harnesses`), the clickable wall Harness Rack in the 16-bit Workshop scene, and the **Harnesses & Toolkit** drawer.
4. **The Employee Book (`config/roster.json`, `server/roster.js`) & Phase 1 Requisition Queue (`server/training.js`)**
   - Persistent catalog of named specialist characters (`Sprocket`, `Rivet`, `Dovetail`, `Caliper`, `Flux`, `Foreman Ash`, `Foreman Juniper`), each bound to a `baseModel`, optional checkpoint URI, `harnessId`, specialties, sprite seed/gear, and outcome record.
   - When an incoming task requires a domain lacking a curated certified specialist (or using an `uncertified_specialist`), Phase 0:
     1. Assigns the best available OSS fallback + matching Harness Rack so the job finishes locally.
     2. Queues a structured **Phase 1 RFT Training Requisition** (`TR1`, `TR2`, ...) in `data/requisitions.json` with `candidateBaseModel`, `harnessId`, `rewardSignals`, `evalSuite`, and `validityGates`.
   - Managed through REST (`/api/roster`, `/api/requisitions`), the 16-bit **RFT Calibration Bay**, and the **Roster & Teams** panel (`Active Team`, `Employee Book`, `RFT Queue` tabs).

### Explicit Phase 0 Non-Goals
- No downloading or serving open-weight model checkpoints by the WorkShop hub itself.
- No live RL / GRPO / RFT GPU training execution or cloud GPU infrastructure provisioning.

---

## Phase 1 — Automated RL / RFT Fine-Tuning Pipeline *(Future)*

- Build an offline worker/trainer consuming `data/requisitions.json` entries (`status: 'queued_phase1'`).
- Execute trajectory rollouts inside Harness Rack sandboxes (`server/harnesses.js` `rft.rewardSignals` & `rft.evalSuite`) against target open-weight base models.
- Optimize policies with verifiable rewards (`check_cmd_exit_zero`, `diff_minimality`, `zero_hub_path_touch`, `repro_before_fix`).
- Run held-out validity gates (`pass_at_1 >= 0.75`, zero sandbox violations) before writing checkpoint URIs (`oss://<model>-<domain>-rft-v1`) and promoting characters via `/api/requisitions/:id/enroll` to `certification: 'curated'`.

---

## Phase 2 — Specialized Domain & Platform Harnesses *(Future)*

- Expand `config/harnesses.json` from general engineering archetypes into deep platform, framework, and software-specific harnesses (e.g., iOS/Swift, kernel/systems, Rust, SQL/data engineering, browser/Visual QA).
- Pair each harness with isolated verification runners, custom tool adapters, domain reward shapers, and synthetic benchmark tasks.

---

## Phase 3 — Closed-Loop Autonomous Team Assembly & Efficacy Review *(Future)*

- Connect problem intake -> Gemini orchestration officer routing -> Employee Book lookup -> autonomous Phase 1 RFT pipeline trigger on coverage gaps -> checkpoint verification & Employee Book enrollment -> surgical Agent Team execution under Frontier final review gates.
- Track long-horizon first-pass merge rates, rework ratios, harness efficacy, and token-cost savings across completed projects to prune or recalibrate underperforming harnesses and specialists automatically.
