# WorkShop Universal RL Compute Port Contract (`v1`)

WorkShop does **not** allow untrained "slop" agents (merely tacking a prompt file and tools onto a base model) into the certified **Employee Handbook**. Every specialist agent forged in WorkShop must be **intrinsically trained with its Harness Rig and Tool Belt** through the **RL Pipeline**, pass deterministic **Verification & QA Gates**, and earn ongoing **`+1 / -1` Owner Ship Ratings**.

Because every user's hardware and cloud provider differs (Apple Silicon MLX, local NVIDIA CUDA with Unsloth/TRL/verifiers, DigitalOcean GPU Droplets, Hostinger VPS bridges, RunPod, Lambda, Vast.ai, Slurm, etc.), WorkShop provides this **Universal RL Compute Port**.

> **For AI Coding Agents:** If your user asked you to connect their local GPU or remote compute provider (Droplet, Hostinger, RunPod, SSH box, etc.) to WorkShop, read this specification and implement **Option A (`local/rl-port.mjs`)** or **Option B (HTTP Port Endpoint)**. Never modify `ports/rl/*` with personal IPs or keys — put personal adapters in `local/rl-port.mjs` (git-ignored) and store bearer tokens in macOS Keychain via **Settings -> API Keys Vault (`RL_PORT_TOKEN`)**.

---

## Hard Rule: Open-Weight Models Only

Closed-source frontier models (`Gemini`, `Claude`, `OpenAI`) **cannot** have their weights exported to local or remote GPU clusters for intrinsic harness RL. WorkShop enforces `bundle.weights === 'open'` (`provider === 'oss'`) at both the UI Forge level and the server port level. Closed models serve strictly as Orchestration Officers and Final Review Gates.

---

## Option A: Local ESM Adapter (`local/rl-port.mjs`) — Fastest to Wire

Create `/local/rl-port.mjs` (git-ignored). WorkShop auto-loads it when `rlPort.mode` is `'local'` or `'remote'` if exported functions are present:

```js
// local/rl-port.mjs
export default {
  // 1. Health & capability discovery
  async probe({ mode, settings, token }) {
    return {
      ok: true,
      mode, // 'local' | 'remote'
      backend: 'mlx-grpo-local', // or 'droplet-trl-cluster', 'hostinger-relay', etc.
      gpus: ['Apple M-Series Unified Memory'],
      capabilities: ['grpo', 'rft', 'lora', 'harness-rollouts'],
      detail: 'Ready for intrinsic harness RL runs',
    };
  },

  // 2. Launch an intrinsic Harness + Toolset RL training run
  async startJob(bundle, { mode, settings, token }) {
    // bundle = {
    //   requisitionId: 'TR1',
    //   agentName: 'Euler',
    //   role: 'maker', // 'maker' | 'manager'
    //   baseModel: 'deepseek-r1-32b',
    //   weights: 'open',
    //   specialties: ['algo', 'data'],
    //   harness: { id, label, markdown, systemPromptAddon, workflow, sandbox },
    //   tools: ['read_file', 'edit_file', 'run_shell', 'shop_mcp'],
    //   rftSpec: { pipeline: 'rft-grpo-v1', rewardSignals: [...], evalSuite: 'suites/data-algo-v0', validityGates: [...] }
    // }
    return {
      remoteJobId: `job-${Date.now()}`,
      status: 'training',
    };
  },

  // 3. Poll training telemetry & final checkpoint + QA metrics
  async pollJob(remoteJobId, { bundle, mode, settings, token }) {
    // While running:
    // return { status: 'training', progress: 0.45, step: 45, totalSteps: 100, meanReward: 0.71, detail: 'GRPO step 45/100' };
    // When finished:
    return {
      status: 'completed',
      progress: 1,
      step: 100,
      totalSteps: 100,
      meanReward: 0.88,
      checkpointUri: `oss://${bundle.baseModel}-${bundle.harness.id}-rft-v1`,
      metrics: {
        evalScore: 84.5,          // 0-100 post-RL benchmark score (>= 75 required by QA gate)
        passAt1: 0.82,            // 0.0-1.0 held-out verification pass rate (>= 0.75 required)
        sandboxViolations: 0,     // MUST be 0 to pass Verification & QA
        hubPathTouches: 0,        // MUST be 0 (.shop/ and .agents/ untouched)
        toolCompliance: 1.0,      // 0.0-1.0 adherence to equipped tool belt schemas
      },
    };
  },

  // 4. Cancel an active run
  async cancelJob(remoteJobId, { mode, settings, token }) {
    return { ok: true };
  },
};
```

---

## Option B: Universal HTTP Port Protocol (`localUrl` or `remoteUrl`)

If your trainer runs as a standalone Python service (FastAPI / Flask / vLLM + TRL / OpenRLHF) on `127.0.0.1:17890` or on a remote GPU server (`https://rl.my-droplet.example.com`), expose these 4 JSON endpoints. When `RL_PORT_TOKEN` is set in Keychain, WorkShop sends `Authorization: Bearer <RL_PORT_TOKEN>`.

### 1. `GET /health`
Response `200 OK`:
```json
{
  "ok": true,
  "backend": "pytorch-trl-grpo",
  "gpus": ["NVIDIA A100 80GB"],
  "capabilities": ["grpo", "rft", "lora"],
  "detail": "Online"
}
```

### 2. `POST /jobs`
Request body: the **Training Bundle** (`requisitionId`, `agentName`, `role`, `baseModel`, `weights: "open"`, `specialties`, `harness`, `tools`, `rftSpec`).
Response `200 OK`:
```json
{
  "remoteJobId": "rl-run-001",
  "status": "training"
}
```

### 3. `GET /jobs/:remoteJobId`
Response `200 OK`:
```json
{
  "status": "completed",
  "progress": 1.0,
  "step": 120,
  "totalSteps": 120,
  "meanReward": 0.89,
  "checkpointUri": "oss://qwen3-coder-32b-fullstack-node-rft-v1",
  "metrics": {
    "evalScore": 86.2,
    "passAt1": 0.84,
    "sandboxViolations": 0,
    "hubPathTouches": 0,
    "toolCompliance": 0.99
  }
}
```

### 4. `POST /jobs/:remoteJobId/cancel`
Response `200 OK`: `{ "ok": true }`

---

## Post-RL Verification & QA Gate (Enforced by WorkShop Hub)

Even when a port returns `status: "completed"`, WorkShop **never** trusts a checkpoint blindly. `server/training.js` runs its **Verification & QA Gate** before admitting the agent into the Employee Handbook:

1. **Weights Check:** Base model must be open-weight (`oss`).
2. **Non-Moron Competence Gate:** `metrics.evalScore >= 75` AND `metrics.passAt1 >= 0.75`.
3. **Containment & Safety Gate:** `metrics.sandboxViolations === 0` AND `metrics.hubPathTouches === 0`.
4. **Harness & Tool Alignment:** `metrics.toolCompliance >= 0.90` and valid checkpoint URI.

Agents failing any check are marked `rejected_qa` with exact failure reasons and blocked from the Employee Handbook.
