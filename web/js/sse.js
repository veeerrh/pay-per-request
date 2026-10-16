// Live task events over server-sent events. EventSource resends Last-Event-ID by itself when it reconnects,
// and the server replays missed events. We close it ourselves once the task is finished.
export function openTaskEvents(taskId, onEvent, onState) {
  const es = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/events`);
  let closed = false;
  es.onopen = () => onState('open');
  es.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    ev.id = Number(m.lastEventId) || ev.id;
    onEvent(ev);
    if (ev.type === 'done' || ev.type === 'blocked') { closed = true; es.close(); onState('closed'); }
  };
  es.onerror = () => { if (!closed) onState('reconnecting'); };
  return () => { closed = true; es.close(); };
}
