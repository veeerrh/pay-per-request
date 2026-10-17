// Pure reducer for the live task events (Appendix B). The UI never decides whether a payment settled:
// it only shows what the backend events say.
export const STAGES = ['Plan', 'Discover', 'Pay', 'Execute', 'Validate', 'Combine'];
const KEYS = STAGES.map((s) => s.toLowerCase());

export function newTaskState(id) {
  return {
    id, status: 'running', stageIdx: -1, events: [], ledger: new Map(), outputs: [], budget: '0', spent: '0', reserved: '0', remaining: '0',
    paidCalls: 0, services: [], result: null, notice: '', startedAt: null, endedAt: null, lastEventId: 0,
    params: null, choices: [], notes: [], chatTick: 0, lab: new Map(), approvals: new Map(), chainHires: [],
  };
}

export function applyEvent(t, ev) {
  if (ev.id) t.lastEventId = Math.max(t.lastEventId, ev.id);
  switch (ev.type) {
    case 'stage': t.stageIdx = KEYS.indexOf(ev.stage); break;
    case 'activity':
      t.events.unshift({ kind: ev.kind, text: ev.text, at: ev.at });
      if (ev.kind === 'start' && !t.startedAt) t.startedAt = Date.parse(ev.at);
      break;
    case 'ledger': t.ledger.set(ev.entry.id, ev.entry); break;
    case 'ledgerPatch': { const e = t.ledger.get(ev.id); if (e) Object.assign(e, ev.patch); break; }
    case 'metrics': Object.assign(t, { budget: ev.budget, spent: ev.spent, reserved: ev.reserved, remaining: ev.remaining, paidCalls: ev.paidCalls, services: ev.services }); break;
    case 'output': t.outputs.push({ call: ev.call, agent: ev.agent, status: ev.status, output: ev.output }); break;
    case 'plan': t.params = ev.params; break;
    case 'choice': t.choices.push({ category: ev.category, sellerId: ev.sellerId, seller: ev.seller, reason: ev.reason, source: ev.source }); break;
    case 'note': t.notes.push({ agent: ev.agent, category: ev.category, text: ev.text }); break;
    case 'chat': t.chatTick += 1; break; // the chat panel reads the feed from GET /api/tasks/:id/chat
    case 'approval': t.approvals.set(ev.approvalId, { ...(t.approvals.get(ev.approvalId) || {}), ...ev }); break;
    case 'chain': t.chainHires.push({ agent: ev.agent, seller: ev.seller, country: ev.country, paidUnits: ev.paidUnits, txHash: ev.txHash }); break;
    case 'lab_step': t.lab.set(ev.key, { ...(t.lab.get(ev.key) || {}), ...ev, total: ev.total ?? t.lab.get(ev.key)?.total }); break;
    case 'blocked': t.status = 'blocked'; t.notice = ev.notice; t.endedAt = Date.parse(ev.at); break;
    case 'done': t.status = ev.status; t.notice = ev.notice || ''; t.result = ev.result; t.endedAt = Date.parse(ev.at); break;
    default: break;
  }
  return t;
}

/** done, current, upcoming, warn or error, as text and colour. */
export function stageState(t, i) {
  if (!t) return 'upcoming';
  if (t.status === 'blocked') return i === 0 ? 'error' : 'upcoming';
  if (t.status === 'completed') return 'done';
  if (t.status === 'stopped') return i === 5 ? 'warn' : 'done';
  return i < t.stageIdx ? 'done' : i === t.stageIdx ? 'current' : 'upcoming';
}

export const elapsedMs = (t) => (t && t.startedAt ? (t.endedAt || Date.now()) - t.startedAt : 0);
