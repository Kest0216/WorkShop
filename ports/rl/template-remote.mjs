// Template: Remote Compute Cluster RL Adapter (DigitalOcean Droplet, Hostinger VPS, RunPod, Lambda, SSH Tunnel)
// Copy this file to `local/rl-port.mjs` (git-ignored) if your remote cluster uses a provider-specific API or SSH command
// instead of the standard Universal HTTP Port (`GET /health`, `POST /jobs`, `GET /jobs/:id`).
// Store any secret API key or bearer token in macOS Keychain under `rl-port` (`RL_PORT_TOKEN`) via Settings -> API Keys Vault.

export default {
  async probe({ settings, token }) {
    const url = settings?.rlPort?.remoteUrl || '';
    return {
      ok: Boolean(url && token),
      mode: 'remote',
      backend: settings?.rlPort?.providerHint || 'remote-cluster-template',
      gpus: [],
      capabilities: ['grpo', 'rft', 'lora'],
      detail: url
        ? `Template ready to bridge to ${url} (${token ? 'token set' : 'no RL_PORT_TOKEN set'})`
        : 'Set Remote Cluster URL in Settings -> RL Compute Port or customize local/rl-port.mjs.',
    };
  },

  async startJob(bundle, { settings, token }) {
    const base = String(settings?.rlPort?.remoteUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('Set Remote Cluster URL in Settings -> RL Compute Port first.');
    const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const res = await fetch(`${base}/jobs`, { method: 'POST', headers, body: JSON.stringify(bundle) });
    if (!res.ok) throw new Error(`Remote RL cluster returned HTTP ${res.status}`);
    return res.json();
  },

  async pollJob(remoteJobId, { settings, token }) {
    const base = String(settings?.rlPort?.remoteUrl || '').replace(/\/+$/, '');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch(`${base}/jobs/${encodeURIComponent(remoteJobId)}`, { headers });
    if (!res.ok) throw new Error(`Remote RL poll returned HTTP ${res.status}`);
    return res.json();
  },

  async cancelJob(remoteJobId, { settings, token }) {
    const base = String(settings?.rlPort?.remoteUrl || '').replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    await fetch(`${base}/jobs/${encodeURIComponent(remoteJobId)}/cancel`, { method: 'POST', headers }).catch(() => {});
    return { ok: true };
  },
};
