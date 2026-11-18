// Template: Local Machine GPU RL Adapter
// Copy this file to `local/rl-port.mjs` (git-ignored) and wire it to your local Python/MLX/CUDA trainer
// or spawn your local training script via `node:child_process`.
// Read `ports/rl/PORT_CONTRACT.md` for the full Training Bundle and QA Gate contract.

export default {
  async probe() {
    return {
      ok: false,
      mode: 'local',
      backend: 'unconfigured-local-template',
      gpus: [],
      capabilities: ['grpo', 'rft', 'lora'],
      detail: 'Copy ports/rl/template-local.mjs to local/rl-port.mjs and connect your local MLX / CUDA RL runner.',
    };
  },

  async startJob(bundle) {
    throw new Error(`Local RL port is not wired yet for ${bundle.baseModel}. Configure local/rl-port.mjs or start an HTTP trainer at settings.rlPort.localUrl.`);
  },

  async pollJob(_remoteJobId) {
    throw new Error('Local RL port is not wired yet.');
  },

  async cancelJob(_remoteJobId) {
    return { ok: true };
  },
};
