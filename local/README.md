# WorkShop Personal Overlay (`local/`)

Everything inside `local/` (except this `README.md`) is **git-ignored** so that the public GitHub repository stays clean and universal while your machine runs your personalized RL compute ports, cluster connections, and private fine-tuned specialists.

## What Lives Here (Git-Ignored)

| File | Purpose |
|---|---|
| `local/rl-port.mjs` | Optional Node ESM adapter implementing your machine's local GPU RL loop (MLX / PyTorch / Unsloth / TRL) or custom SSH/API bridge to your remote GPU cluster (DigitalOcean Droplet, Hostinger VPS, RunPod, Lambda, etc.). Auto-discovered by `server/rlport.js`! |
| `local/rl-port.json` | Personal RL port overrides (`mode`, `localUrl`, `remoteUrl`, `providerHint`, SSH/webhook metadata) merged over `settings.rlPort` so `config/settings.json` and public defaults never leak personal IPs or hostnames. |
| `local/roster.json` | Personal RL-certified specialists merged on top of the shipped `config/roster.json` Employee Handbook. |
| `local/harnesses.json` | Personal custom harnesses merged on top of `config/harnesses.json`. |

## Quick Agent Wiring Instructions

To have an AI coding agent wire up your machine's GPU or remote cloud provider to WorkShop's Universal RL Pipeline:

1. Read [`ports/rl/PORT_CONTRACT.md`](../ports/rl/PORT_CONTRACT.md).
2. Copy either [`ports/rl/template-local.mjs`](../ports/rl/template-local.mjs) or [`ports/rl/template-remote.mjs`](../ports/rl/template-remote.mjs) to `local/rl-port.mjs`.
3. Implement `probe()`, `startJob(bundle)`, `pollJob(remoteJobId)`, and `cancelJob(remoteJobId)` for your specific hardware or remote cluster.
4. Open **Settings -> RL Compute Port** in WorkShop and click **Probe Port**.
