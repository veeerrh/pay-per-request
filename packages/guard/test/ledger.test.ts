import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store';

const mk = (rs = 'rs1') => new Store(':memory:', rs);
const ev = (s: Store, id: string, type: any, payload: Record<string, unknown> = {}) => s.appendEvent({ requestId: id, taskId: 't1', eventType: type, payload });

describe('ledger store (TC-2.1)', () => {
  it('01 append 100 and verify', () => {
    const s = mk();
    for (let i = 0; i < 100; i++) ev(s, `r${i}`, 'intent', { n: i });
    const c = s.verifyChain();
    expect(c.ok).toBe(true);
    expect(c.rows).toBe(101); // plus session_started
    expect(c.headHash).toHaveLength(64);
  });
  it('02 append-only enforced', () => {
    const s = mk();
    ev(s, 'r1', 'intent');
    expect(() => s.db.prepare('UPDATE ledger_events SET payload=?').run('{}')).toThrow(/append-only/);
    expect(() => s.db.prepare('DELETE FROM ledger_events').run()).toThrow(/append-only/);
  });
  it('03 tamper detection reports the sequence number', () => {
    const s = mk();
    for (let i = 0; i < 10; i++) ev(s, `r${i}`, 'intent', { amount: '5000' });
    s.db.exec('DROP TRIGGER ledger_no_update');
    const target = s.events()[5];
    s.db.prepare('UPDATE ledger_events SET payload=? WHERE seq=?').run('{"amount":"1"}', target.seq);
    const c = s.verifyChain();
    expect(c.ok).toBe(false);
    expect(c.brokenAt).toBe(target.seq);
  });
  it('04 removed row detected', () => {
    const s = mk();
    for (let i = 0; i < 10; i++) ev(s, `r${i}`, 'intent');
    s.db.exec('DROP TRIGGER ledger_no_delete');
    const evs = s.events();
    s.db.prepare('DELETE FROM ledger_events WHERE seq=?').run(evs[4].seq);
    const c = s.verifyChain();
    expect(c.ok).toBe(false);
    expect(c.brokenAt).toBe(evs[5].seq);
  });
  it('05 fold to a paid entry', () => {
    const s = mk();
    ev(s, 'r1', 'intent', { seller: 'Atlas', listed: '5000', asked: '5000', paid: '0' });
    ev(s, 'r1', 'signed', { nonce: '0xabc' });
    ev(s, 'r1', 'sent');
    ev(s, 'r1', 'final', { status: 'paid', paid: '5000', txHash: null });
    const e = s.listEntries();
    expect(e).toHaveLength(1);
    expect(e[0].status).toBe('paid');
    expect(e[0].callNo).toBe(1);
  });
  it('06 unfinished intent is pending', () => {
    const s = mk();
    ev(s, 'r1', 'intent', { seller: 'X' });
    ev(s, 'r1', 'signed');
    expect(s.listEntries()[0].status).toBe('pending');
  });
  it('07 one intent per request id', () => {
    const s = mk();
    const i = { requestId: 'r1', taskId: 't1', sellerId: 'atlas', amount: 5000n };
    s.createIntent(i);
    expect(() => s.createIntent(i)).toThrow(/UNIQUE|constraint/i);
  });
  it('08 new session starts a fresh chain, old one still verifies', () => {
    const s = mk();
    ev(s, 'r1', 'intent');
    const old = s.sessionId;
    const oldHead = s.verifyChain(old).headHash;
    const fresh = s.newSession();
    expect(fresh).not.toBe(old);
    expect(s.listEntries()).toHaveLength(0);
    expect(s.verifyChain(fresh).ok).toBe(true);
    expect(s.verifyChain(old)).toMatchObject({ ok: true, headHash: oldHead });
    expect(s.listEntries(old)).toHaveLength(1);
  });
  it('09 rule-set change is logged, earlier rows keep their hash', () => {
    const s = mk('rsA');
    ev(s, 'r1', 'intent');
    s.setRuleSetHash('rsB');
    ev(s, 'r2', 'intent');
    const evs = s.events();
    expect(evs.some((e) => e.eventType === 'ruleset_changed')).toBe(true);
    expect(evs.find((e) => e.requestId === 'r1')!.ruleSetHash).toBe('rsA');
    expect(evs.find((e) => e.requestId === 'r2')!.ruleSetHash).toBe('rsB');
    expect(s.verifyChain().ok).toBe(true);
  });
  it('10 survives restart', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'led-')), 'b.db');
    const a = new Store(f, 'rs1');
    ev(a, 'r1', 'intent');
    const head = a.verifyChain().headHash;
    a.close();
    const b = new Store(f, 'rs1');
    expect(b.verifyChain()).toMatchObject({ ok: true, headHash: head });
    expect(b.listEntries()).toHaveLength(1);
  });
  it('confirmed event flips txConfirmed without editing history', () => {
    const s = mk();
    ev(s, 'r1', 'final', { status: 'paid', txHash: '0x' + 'a'.repeat(64) });
    ev(s, 'r1', 'confirmed', { txConfirmed: true });
    expect(s.listEntries()[0].txConfirmed).toBe(true);
    expect(s.verifyChain().ok).toBe(true);
  });
});
