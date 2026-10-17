// Live task events. Server-sent events first; if the stream cannot open, drops, or is open but delivers nothing while the server
// has newer events (some proxies and free tunnels buffer SSE), switch to polling GET /api/tasks/:id/poll every 2 seconds.
// Event ids rise, so already-seen events are skipped and the two paths never double-apply an update.
const STALL_MS = 10000;
const POLL_MS = 2000;

export function openTaskEvents(taskId, onEvent, onState) {
  const id = encodeURIComponent(taskId);
  let es = null, closed = false, lastId = 0, stallTimer = null, verifyTimer = null, pollTimer = null, polling = false, busy = false;

  function stop(finished) {
    closed = true;
    clearTimeout(stallTimer); clearInterval(verifyTimer); clearInterval(pollTimer);
    if (es) es.close();
    if (finished) onState('closed');
  }
  function deliver(ev) {
    if (ev.id && ev.id <= lastId) return;
    if (ev.id) lastId = ev.id;
    onEvent(ev);
    if (ev.type === 'done' || ev.type === 'blocked') stop(true);
  }
  async function pollOnce() {
    if (closed || busy) return;
    busy = true;
    try {
      const r = await fetch(`/api/tasks/${id}/poll?after=${lastId}`);
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      onState('polling');
      for (const ev of j.events) { deliver(ev); if (closed) return; }
      // A task restored after a Beacon restart has no event history: build its final state from the snapshot.
      if (j.status !== 'running' && !closed) {
        const s = await (await fetch(`/api/tasks/${id}`)).json();
        deliver({ type: s.status === 'blocked' ? 'blocked' : 'done', status: s.status, notice: s.notice || '', result: s.result, at: s.endedAt || new Date().toISOString(), id: lastId + 1 });
      }
    } catch { if (!closed) onState('reconnecting'); } finally { busy = false; }
  }
  function startPolling() {
    if (closed || polling) return;
    polling = true;
    clearTimeout(stallTimer); clearInterval(verifyTimer);
    if (es) { es.close(); es = null; }
    onState('polling');
    pollOnce();
    pollTimer = setInterval(pollOnce, POLL_MS);
  }

  es = new EventSource(`/api/tasks/${id}/events`);
  stallTimer = setTimeout(startPolling, STALL_MS); // never opened
  es.onopen = () => { clearTimeout(stallTimer); onState('open'); };
  es.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    ev.id = Number(m.lastEventId) || ev.id;
    deliver(ev);
  };
  es.onerror = () => {
    if (closed || polling) return;
    onState('reconnecting');
    clearTimeout(stallTimer);
    stallTimer = setTimeout(startPolling, STALL_MS); // did not recover in time
  };
  // Open but silent: ask the server whether it has events we have not seen. If it does, the stream is being buffered.
  verifyTimer = setInterval(async () => {
    if (closed || polling) return;
    try {
      const j = await (await fetch(`/api/tasks/${id}/poll?after=${lastId}`)).json();
      if (j.events.length) startPolling();
    } catch { /* keep waiting */ }
  }, STALL_MS);

  return () => stop(false);
}
