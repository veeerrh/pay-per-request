import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';

export type EventType = 'intent' | 'signed' | 'sent' | 'final' | 'confirmed' | 'ruleset_changed' | 'session_started';

export interface LedgerEvent {
  seq: number;
  sessionId: string;
  requestId: string | null;
  taskId: string | null;
  eventType: EventType;
  ts: string;
  payload: Record<string, unknown>;
  ruleSetHash: string;
  prevHash: string;
  hash: string;
}
export interface ChainStatus {
  ok: boolean;
  rows: number;
  headHash: string;
  brokenAt?: number;
}
export interface IntentInput {
  requestId: string;
  taskId: string;
  sellerId: string;
  nonce?: string;
  validBefore?: number;
  amount: bigint;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, started_at TEXT NOT NULL, start_block INTEGER, rule_set_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ledger_events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, request_id TEXT, task_id TEXT,
  event_type TEXT NOT NULL, ts TEXT NOT NULL, payload TEXT NOT NULL,
  rule_set_hash TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ledger_session ON ledger_events(session_id, seq);
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger_events BEGIN SELECT RAISE(ABORT,'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger_events BEGIN SELECT RAISE(ABORT,'ledger is append-only'); END;
CREATE TABLE IF NOT EXISTS intents(request_id TEXT PRIMARY KEY, task_id TEXT, session_id TEXT, seller_id TEXT,
  nonce TEXT, valid_before INTEGER, amount TEXT, state TEXT NOT NULL, created_at TEXT NOT NULL);
`;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const canon = (o: unknown): string => canonicalize(o) as string;

/** Hash covers everything except the hash itself (M-62). */
function rowHash(r: Omit<LedgerEvent, 'seq' | 'hash'>): string {
  return sha(r.prevHash + canon({ sessionId: r.sessionId, requestId: r.requestId, taskId: r.taskId, eventType: r.eventType, ts: r.ts, payload: r.payload, ruleSetHash: r.ruleSetHash }));
}

export class Store {
  readonly db: Database.Database;
  sessionId = '';
  constructor(
    path: string,
    private ruleSetHash: string,
    private now: () => Date = () => new Date(),
  ) {
    this.db = new Database(path);
    this.db.exec(SCHEMA);
    const last = this.db.prepare('SELECT id FROM sessions ORDER BY rowid DESC LIMIT 1').get() as { id: string } | undefined;
    this.sessionId = last ? last.id : this.newSession();
  }

  close(): void { this.db.close(); }
  setRuleSetHash(h: string): void { this.ruleSetHash = h; }

  /** Records the chain block at which this session began (used by reconciliation). Set once. */
  setSessionStartBlock(block: number, sessionId: string = this.sessionId): void {
    this.db.prepare('UPDATE sessions SET start_block=? WHERE id=? AND start_block IS NULL').run(block, sessionId);
  }
  sessionStartBlock(sessionId: string = this.sessionId): number | null {
    return ((this.db.prepare('SELECT start_block FROM sessions WHERE id=?').get(sessionId) as { start_block: number | null } | undefined)?.start_block) ?? null;
  }

  /** New ledger chain with empty reputation basis. Old sessions stay stored and verifiable (M-66). */
  newSession(startBlock?: number): string {
    const id = `s_${randomUUID()}`;
    this.db.prepare('INSERT INTO sessions(id, started_at, start_block, rule_set_hash) VALUES (?,?,?,?)').run(id, this.now().toISOString(), startBlock ?? null, this.ruleSetHash);
    this.sessionId = id;
    this.appendRaw('session_started', null, null, { ruleSetHash: this.ruleSetHash });
    return id;
  }

  private head(sessionId: string): { hash: string; ruleSetHash: string } {
    const r = this.db.prepare('SELECT hash, rule_set_hash AS ruleSetHash FROM ledger_events WHERE session_id=? ORDER BY seq DESC LIMIT 1').get(sessionId) as { hash: string; ruleSetHash: string } | undefined;
    return r ?? { hash: sha(`genesis:${sessionId}`), ruleSetHash: this.ruleSetHash };
  }

  private appendRaw(eventType: EventType, requestId: string | null, taskId: string | null, payload: Record<string, unknown>): LedgerEvent {
    const prev = this.head(this.sessionId);
    const base = { sessionId: this.sessionId, requestId, taskId, eventType, ts: this.now().toISOString(), payload, ruleSetHash: this.ruleSetHash, prevHash: prev.hash };
    const hash = rowHash(base);
    const info = this.db
      .prepare('INSERT INTO ledger_events(session_id, request_id, task_id, event_type, ts, payload, rule_set_hash, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(base.sessionId, requestId, taskId, eventType, base.ts, canon(payload), base.ruleSetHash, base.prevHash, hash);
    return { seq: Number(info.lastInsertRowid), ...base, hash };
  }

  /** Appends one event. If the rule set changed since the last row, logs that first (S-86, M-63). */
  appendEvent(e: { requestId: string; taskId: string; eventType: EventType; payload: Record<string, unknown> }): LedgerEvent {
    return this.db.transaction(() => {
      const prev = this.head(this.sessionId);
      if (prev.ruleSetHash !== this.ruleSetHash) this.appendRaw('ruleset_changed', null, null, { from: prev.ruleSetHash, to: this.ruleSetHash });
      return this.appendRaw(e.eventType, e.requestId, e.taskId, e.payload);
    })();
  }

  events(sessionId: string = this.sessionId): LedgerEvent[] {
    const rows = this.db.prepare('SELECT * FROM ledger_events WHERE session_id=? ORDER BY seq').all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      seq: r.seq as number, sessionId: r.session_id as string, requestId: r.request_id as string | null, taskId: r.task_id as string | null,
      eventType: r.event_type as EventType, ts: r.ts as string, payload: JSON.parse(r.payload as string), ruleSetHash: r.rule_set_hash as string,
      prevHash: r.prev_hash as string, hash: r.hash as string,
    }));
  }

  /** Recomputes every hash and link. A break reports the sequence number of the first bad row (A-19). */
  verifyChain(sessionId: string = this.sessionId): ChainStatus {
    let prev = sha(`genesis:${sessionId}`);
    const evs = this.events(sessionId);
    for (const e of evs) {
      if (e.prevHash !== prev || rowHash(e) !== e.hash) return { ok: false, rows: evs.length, headHash: prev, brokenAt: e.seq };
      prev = e.hash;
    }
    return { ok: true, rows: evs.length, headHash: prev };
  }

  /** Folds events per request into the current ledger entry (statuses: paid, refused, failed, rejected, pending). */
  listEntries(sessionId: string = this.sessionId): Array<Record<string, unknown>> {
    const byReq = new Map<string, Record<string, unknown>>();
    for (const e of this.events(sessionId)) {
      if (!e.requestId) continue;
      let cur = byReq.get(e.requestId);
      if (!cur) {
        cur = { id: e.requestId, callNo: byReq.size + 1, taskId: e.taskId, time: e.ts, status: 'pending', txConfirmed: false, ruleSetHash: e.ruleSetHash };
        byReq.set(e.requestId, cur);
      }
      if (e.eventType === 'confirmed') { cur.txConfirmed = true; Object.assign(cur, e.payload); continue; }
      Object.assign(cur, e.payload);
      if (e.eventType === 'final') cur.ruleSetHash = e.ruleSetHash;
    }
    return [...byReq.values()];
  }

  createIntent(i: IntentInput): void {
    // PRIMARY KEY on request_id: a second live authorisation for the same request fails (M-51).
    this.db
      .prepare('INSERT INTO intents(request_id, task_id, session_id, seller_id, nonce, valid_before, amount, state, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(i.requestId, i.taskId, this.sessionId, i.sellerId, i.nonce ?? null, i.validBefore ?? null, i.amount.toString(), 'intent', this.now().toISOString());
  }

  setIntentState(requestId: string, state: string, extra: { nonce?: string; validBefore?: number } = {}): void {
    this.db.prepare('UPDATE intents SET state=?, nonce=COALESCE(?, nonce), valid_before=COALESCE(?, valid_before) WHERE request_id=?').run(state, extra.nonce ?? null, extra.validBefore ?? null, requestId);
  }

  getIntent(requestId: string): { requestId: string; state: string; nonce: string | null; validBefore: number | null; amount: bigint; sellerId: string } | undefined {
    const r = this.db.prepare('SELECT * FROM intents WHERE request_id=?').get(requestId) as Record<string, unknown> | undefined;
    return r && { requestId, state: r.state as string, nonce: r.nonce as string | null, validBefore: r.valid_before as number | null, amount: BigInt(r.amount as string), sellerId: r.seller_id as string };
  }

  /** Unfinished purchases of ONE session (the current one by default), so recovery never writes into the wrong chain. */
  unfinishedIntents(sessionId: string = this.sessionId): Array<{ requestId: string; taskId: string; sellerId: string; nonce: string | null; validBefore: number | null; amount: bigint; state: string }> {
    const rows = this.db.prepare("SELECT * FROM intents WHERE state IN ('intent','signed','sent') AND session_id=? ORDER BY created_at").all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ requestId: r.request_id as string, taskId: r.task_id as string, sellerId: r.seller_id as string, nonce: r.nonce as string | null, validBefore: r.valid_before as number | null, amount: BigInt(r.amount as string), state: r.state as string }));
  }
}
