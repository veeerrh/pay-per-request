import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, limitVerdict, taskStartVerdict, ruleSetHash, dryRun, USDC_ADDRESS, type BudgetState, type DryStep, type Accept } from '../src';

const CFG_PATH = join(__dirname, '..', '..', '..', 'config', 'rules.config.json');
const cfg = loadConfig(CFG_PATH);
const state = (o: Partial<BudgetState> = {}): BudgetState => ({
  remaining: 50000n, spentOnSeller: 0n, spentOnCategory: 0n, spentInSession: 0n, spentLastHour: 0n,
  walletBalance: 20_000_000n, callsInTask: 0, elapsedSeconds: 0, ...o,
});

describe('limits (TC-1.3)', () => {
  it('01 over remaining budget', () => {
    const v = limitVerdict(state({ remaining: 3000n }), 10000n, cfg);
    expect(v?.verdict).toBe('REFUSE');
    expect(v?.ruleId).toBe('M-17');
    expect(v?.reason).toContain('10,000');
    expect(v?.reason).toContain('3,000');
  });
  it('02 call ceiling', () => {
    const c = { ...cfg, perCallCeiling: '5000' };
    expect(limitVerdict(state(), 8000n, c)?.ruleId).toBe('M-18');
  });
  it('03 per-seller and per-category caps', () => {
    expect(limitVerdict(state({ spentOnSeller: 48000n }), 5000n, cfg)?.ruleId).toBe('M-19');
    expect(limitVerdict(state({ spentOnCategory: 98000n }), 5000n, cfg)?.ruleId).toBe('M-19');
  });
  it('04 session cap and rolling hour', () => {
    expect(limitVerdict(state({ spentInSession: 1_999_000n }), 5000n, cfg)?.ruleId).toBe('M-58');
    expect(limitVerdict(state({ spentLastHour: 999_000n }), 5000n, cfg)?.reason).toContain('one-hour');
  });
  it('05 balance floor at task start', () => {
    const v = taskStartVerdict(50_000n, 5000n, cfg);
    expect(v?.verdict).toBe('STOP_TASK');
    expect(v?.reason).toContain('missing');
    expect(taskStartVerdict(10_000_000n, 5000n, cfg)).toBeNull();
  });
  it('06 loop limit', () => {
    expect(limitVerdict(state({ callsInTask: 20 }), 1000n, cfg)?.verdict).toBe('STOP_TASK');
  });
  it('allowed purchase passes', () => {
    expect(limitVerdict(state(), 5000n, cfg)).toBeNull();
  });
  it('07 invalid config refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    const bad = JSON.parse(readFileSync(CFG_PATH, 'utf8'));
    bad.sessionCap = '-5';
    writeFileSync(join(dir, 'bad.json'), JSON.stringify(bad));
    expect(() => loadConfig(join(dir, 'bad.json'))).toThrow(/sessionCap/);
  });
});

describe('rule-set hash (TC-1.3)', () => {
  it('08 stable', () => expect(ruleSetHash(cfg)).toBe(ruleSetHash(cfg)));
  it('09 changes with config and with rule code', () => {
    expect(ruleSetHash({ ...cfg, fallbackLimit: 4 })).not.toBe(ruleSetHash(cfg));
    const dir = mkdtempSync(join(tmpdir(), 'rules-'));
    cpSync(join(__dirname, '..', 'src', 'rules'), dir, { recursive: true });
    const before = ruleSetHash(cfg, dir);
    writeFileSync(join(dir, 'price.ts'), readFileSync(join(dir, 'price.ts'), 'utf8') + '\n// changed');
    expect(ruleSetHash(cfg, dir)).not.toBe(before);
  });
});

describe('dry-run (TC-1.3-10)', () => {
  const BUYER = '0xADb43a17Cb94d4125f45522d815060B58A71dcCb';
  const PAY = '0xc4A183e8fA3d4093ec16D580182ae7056C878643';
  const acc = (amount: bigint): Accept => ({ scheme: 'exact', network: 'eip155:84532', asset: USDC_ADDRESS, amount, payTo: PAY, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } });
  const step = (label: string, listed: bigint, asked: bigint): DryStep => ({ label, sellerId: label, category: 'data', listing: { price: listed, payTo: PAY, network: 'eip155:84532', asset: USDC_ADDRESS }, accepts: [acc(asked)] });
  it('returns every verdict, refuses the liar, tracks budget, and imports no signer', () => {
    const r = dryRun([step('liar', 1000n, 10000n), step('honest', 5000n, 5000n), step('big', 10000n, 10000n)], 16000n, cfg, BUYER, 20_000_000n);
    expect(r.map((x) => x.verdict.verdict)).toEqual(['REFUSE', 'ALLOW', 'ALLOW']);
    expect(r[2].remainingAfter).toBe(1000n);
    const src = readFileSync(join(__dirname, '..', 'src', 'dryrun.ts'), 'utf8');
    expect(src).not.toMatch(/from '\.\/signer'|better-sqlite3|fetch\(/);
  });
  it('stops spending when the budget runs out', () => {
    const r = dryRun([step('a', 5000n, 5000n), step('b', 10000n, 10000n)], 12000n, cfg, BUYER, 20_000_000n);
    expect(r[1].verdict.ruleId).toBe('M-17');
  });
});
