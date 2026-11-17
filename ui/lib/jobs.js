// Job actions that more than one panel offers.
//
//   confirmCancel(ctx, job) -> Promise<boolean>      the one confirm dialog for "Cancel the job"
//   runCancel(ctx, job, button) -> Promise<job|undefined>
//       POST /api/jobs/:id/cancel. The hub answers only when the turns and hub steps of the job have ended: that can take
//       up to about 20 s. So the button stays busy, and a note says so at once.

import * as ui from './widgets.js';

const enc = encodeURIComponent;

export function confirmCancel(ctx, job) {
  const id = job && job.id ? job.id : String(job);
  const queued = job && job.status === 'queued';
  return ctx.confirm({
    title: `Cancel ${id}?`,
    text: queued ? `${id} waits in the queue. Nothing was built for it yet. This cannot be undone.`
      : 'The crew stops. The hub saves every bench, but nothing more is built. Crates that are on the truck stay there: you can still ship or discard them. This cannot be undone.',
    okLabel: queued ? 'Cancel the work order' : 'Cancel the job', cancelLabel: 'Keep it', danger: true,
  });
}

export function runCancel(ctx, job, button) {
  const id = job && job.id ? job.id : String(job);
  const queued = job && job.status === 'queued';
  return ui.busy(button, async () => {
    if (!queued) ctx.toast(`Stopping the crew of ${id}. The turns that run now end first. This can take up to half a minute.`);
    const res = await ctx.api.post(`/api/jobs/${enc(id)}/cancel`, {}, { timeoutMs: 90000 });
    if (!res) return res;
    const left = ctx.sel.loadedDeliveries(ctx.store, id).length;
    ctx.toast(queued ? `${id} is cancelled. It left the queue.` : `${id} is cancelled.${left ? ` ${ui.fmt.plural(left, 'crate stays', 'crates stay')} on the truck: ship or discard ${left === 1 ? 'it' : 'them'}.` : ''}`);
    if (ctx.store.refreshInbox) ctx.store.refreshInbox();
    return res;
  });
}
