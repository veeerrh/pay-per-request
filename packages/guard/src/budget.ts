import type { Store } from './store/store';
import type { RulesConfig } from './config';
import { limitVerdict, type BudgetState } from './rules/limits';
import type { Verdict } from './contract/verdict';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks(task_id TEXT PRIMARY KEY, budget TEXT NOT NULL, session_id TEXT NOT NULL, opened_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reservations(
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, seller_id TEXT NOT NULL,
  category TEXT NOT NULL, amount TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('reserved','spent','released')), created_at TEXT NOT NULL);
`;

export interface ReserveArgs {
  taskId: string;
  requestId: string;
  sellerId: string;
  category: string;
  amount: bigint;
}
export type ReserveResult = { ok: true; id: number } | { ok: false; verdict: Verdict };
export type Outcome<T> = { outcome: 'spent' | 'released' | 'held'; value: T };
export interface Totals { budget: bigint; spent: bigint; reserved: bigint; remaining: bigint }

/**
 * Subtract first, then sign (M-15). reserve() runs in one synchronous SQLite transaction, with no await
 * between the checks and the insert, so parallel calls cannot overspend (P-06).
 */
export class Budget {
  constructor(
    protected store: Store,
    protected cfg: RulesConfig,
    protected walletBalance: () => bigint = () => 1_000_000_000_000n,
    protected now: () => Date = () => new Date(),
  ) {
    store.db.exec(SCHEMA);
  }

  openTask(taskId: string, budget: bigint): void {
    this.store.db.prepare('INSERT INTO tasks(task_id, budget, session_id, opened_at) VALUES (?,?,?,?)').run(taskId, budget.toString(), this.store.sessionId, this.now().toISOString());
  }

  totals(taskId: string): Totals {
    const t = this.store.db.prepare('SELECT budget FROM tasks WHERE task_id=?').get(taskId) as { budget: string } | undefined;
    if (!t) throw new Error(`unknown task ${taskId}`);
    const rows = this.store.db.prepare('SELECT amount, state FROM reservations WHERE task_id=?').all(taskId) as Array<{ amount: string; state: string }>;
    let spent = 0n, reserved = 0n;
    for (const r of rows) {
      if (r.state === 'spent') spent += BigInt(r.amount);
      else if (r.state === 'reserved') reserved += BigInt(r.amount);
    }
    const budget = BigInt(t.budget);
    return { budget, spent, reserved, remaining: budget - spent - reserved };
  }

  private stateFor(a: ReserveArgs): BudgetState {
    const db = this.store.db;
    const tot = this.totals(a.taskId);
    const live = "state IN ('spent','reserved')";
    const sum = (sql: string, ...p: unknown[]): bigint => (db.prepare(sql).all(...p) as Array<{ amount: string }>).reduce((s, r) => s + BigInt(r.amount), 0n);
    const hourAgo = new Date(this.now().getTime() - 3_600_000).toISOString();
    const task = db.prepare('SELECT opened_at FROM tasks WHERE task_id=?').get(a.taskId) as { opened_at: string };
    return {
      remaining: tot.remaining,
      spentOnSeller: sum(`SELECT amount FROM reservations WHERE task_id=? AND seller_id=? AND ${live}`, a.taskId, a.sellerId),
      spentOnCategory: sum(`SELECT amount FROM reservations WHERE task_id=? AND category=? AND ${live}`, a.taskId, a.category),
      spentInSession: sum(`SELECT r.amount FROM reservations r JOIN tasks t ON t.task_id=r.task_id WHERE t.session_id=? AND r.${live}`, this.store.sessionId),
      spentLastHour: sum(`SELECT amount FROM reservations WHERE ${live} AND created_at>=?`, hourAgo),
      walletBalance: this.walletBalance(),
      callsInTask: (db.prepare(`SELECT COUNT(*) AS n FROM reservations WHERE task_id=? AND ${live}`).get(a.taskId) as { n: number }).n,
      elapsedSeconds: Math.floor((this.now().getTime() - new Date(task.opened_at).getTime()) / 1000),
    };
  }

  /** Synchronous and atomic. Never signs anything. */
  reserve(a: ReserveArgs): ReserveResult {
    return this.store.db.transaction((): ReserveResult => {
      const dup = this.store.db.prepare('SELECT 1 FROM reservations WHERE request_id=?').get(a.requestId);
      if (dup) return { ok: false, verdict: { verdict: 'REFUSE', ruleId: 'M-51', reason: 'an authorisation already exists for this request id' } };
      const verdict = limitVerdict(this.stateFor(a), a.amount, this.cfg);
      if (verdict) return { ok: false, verdict };
      const info = this.store.db
        .prepare("INSERT INTO reservations(task_id, request_id, seller_id, category, amount, state, created_at) VALUES (?,?,?,?,?,'reserved',?)")
        .run(a.taskId, a.requestId, a.sellerId, a.category, a.amount.toString(), this.now().toISOString());
      return { ok: true, id: Number(info.lastInsertRowid) };
    }).immediate();
  }

  private setState(id: number, to: 'spent' | 'released'): void {
    const r = this.store.db.prepare("UPDATE reservations SET state=? WHERE id=? AND state='reserved'").run(to, id);
    if (r.changes === 1) return;
    // Idempotent: asking for the state it is already in is fine. A conflicting terminal state is a real bug.
    if (this.stateOf(id) !== to) throw new Error(`reservation ${id} is not in the reserved state`);
  }
  commit(id: number): void { this.setState(id, 'spent'); }
  release(id: number): void { this.setState(id, 'released'); }
  reservationFor(requestId: string): { id: number; state: string } | undefined {
    return this.store.db.prepare('SELECT id, state FROM reservations WHERE request_id=?').get(requestId) as { id: number; state: string } | undefined;
  }
  stateOf(id: number): string { return (this.store.db.prepare('SELECT state FROM reservations WHERE id=?').get(id) as { state: string }).state; }

  /**
   * Reserves, runs fn, then commits, releases or holds. A throw always releases (M-16, S-42).
   * 'held' keeps the money reserved until crash recovery resolves it (M-52).
   */
  async withReservation<T>(a: ReserveArgs, fn: (reservationId: number) => Promise<Outcome<T>>): Promise<{ verdict: Verdict } | { value: T; outcome: Outcome<T>['outcome'] }> {
    const r = this.reserve(a);
    if (!r.ok) return { verdict: r.verdict };
    let settled = false;
    try {
      const out = await fn(r.id);
      if (out.outcome === 'spent') { this.commit(r.id); settled = true; }
      else if (out.outcome === 'released') { this.release(r.id); settled = true; }
      else settled = true; // held
      return { value: out.value, outcome: out.outcome };
    } finally {
      if (!settled && this.stateOf(r.id) === 'reserved') this.release(r.id);
    }
  }
}

/** At most n jobs in flight (max_concurrency, M-22). */
export async function runWithConcurrency<T>(n: number, jobs: Array<() => Promise<T>>): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, jobs.length)) }, worker));
  return results;
}
