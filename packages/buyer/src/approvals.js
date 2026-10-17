// NOTE: the request id travels as `approvalId`: `id` on a task event is the event counter.
// Human approval for large calls (design M-23, M-57). Off unless a task sets a limit. When a call would cost more than the limit,
// the task waits here, BEFORE the guard is asked to sign anything and before any money is reserved. The person approves or
// declines in the dashboard; no answer in time counts as a decline (the safe default). This module never signs or pays.

function createApprovals({ timeoutMs = 120_000, now = () => Date.now() } = {}) {
  const pending = new Map(); // `${taskId}:${id}` -> { resolve, timer, info }
  let seq = 0;

  /**
   * Asks for a decision and resolves with 'approved', 'declined' or 'expired'.
   * info: { sellerId, seller, category, priceUnits, thresholdUnits } (strings or numbers; shown to the person)
   */
  function request(taskId, info, emit = () => {}) {
    const id = `a${++seq}`;
    const key = `${taskId}:${id}`;
    const expiresAt = new Date(now() + timeoutMs).toISOString();
    const base = { type: 'approval', approvalId: id, sellerId: info.sellerId, seller: info.seller, category: info.category, priceUnits: String(info.priceUnits), thresholdUnits: String(info.thresholdUnits) };
    return new Promise((resolve) => {
      const finish = (status) => {
        const p = pending.get(key);
        if (!p) return false;
        clearTimeout(p.timer);
        pending.delete(key);
        emit({ ...base, status, at: new Date(now()).toISOString() });
        resolve(status);
        return true;
      };
      const timer = setTimeout(() => finish('expired'), timeoutMs);
      pending.set(key, { finish, info: base });
      emit({ ...base, status: 'pending', expiresAt, at: new Date(now()).toISOString() });
    });
  }

  /** Records the person's answer. Returns { ok: true } or { ok: false, error }. A second answer or a late one is refused. */
  function decide(taskId, id, decision) {
    if (decision !== 'approve' && decision !== 'decline') return { ok: false, error: 'decision must be approve or decline' };
    const p = pending.get(`${taskId}:${id}`);
    if (!p) return { ok: false, error: 'no pending approval with that id (already answered or expired)' };
    p.finish(decision === 'approve' ? 'approved' : 'declined');
    return { ok: true };
  }

  const list = (taskId) => [...pending.entries()].filter(([k]) => k.startsWith(`${taskId}:`)).map(([, v]) => v.info);
  /** Declines everything still waiting for a task (used when a task ends or fails). */
  function cancelTask(taskId) { for (const [k, v] of [...pending.entries()]) if (k.startsWith(`${taskId}:`)) v.finish('declined'); }

  return { request, decide, list, cancelTask, timeoutMs };
}

module.exports = { createApprovals };
