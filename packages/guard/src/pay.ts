import type { Store } from './store/store';
import type { Budget } from './budget';
import type { Signer } from './signer';
import type { RulesConfig } from './config';
import type { ChainReader } from './chain-types';
import type { ListingSnapshot } from './contract/facts';
import type { LedgerStatus } from './contract/verdict';
import { decodePaymentRequired, ParseError, type Accept } from './contract/payment-required';
import { evaluateHeader, compareTerms } from './engine';
import { limitedFetch, HttpError, type HttpResult } from './http';
import { NETWORK, USDC_ADDRESS } from './money';
import type { LogFn } from './redact';

export type ValidateResult = { ok: true; output: unknown } | { ok: false; reason: string; ruleId?: string };
export type ValidateFn = (body: string, ctx: { sellerId: string; category: string }) => ValidateResult;

export interface PayDeps {
  store: Store;
  budget: Budget;
  signer: Signer;
  cfg: RulesConfig;
  log?: LogFn;
  fetch?: typeof fetch;
  chain?: ChainReader;
  validate?: ValidateFn;
}
export interface PayRequest {
  requestId: string;
  taskId: string;
  seller: { id: string; name: string; category: string };
  listing: ListingSnapshot;
  listingHash: string;
  liveListingHash?: string;
  url: string;
  method?: 'GET' | 'POST';
  body?: string;
}
export interface PayResult {
  requestId: string;
  status: LedgerStatus;
  verdict: 'ALLOW' | 'REFUSE' | 'RELEASE' | 'ACCEPT_FLAG' | 'HOLD' | 'STOP_TASK';
  ruleId: string;
  reason: string;
  asked: bigint;
  paid: bigint;
  latencyMs: number;
  txHash: string | null;
  output?: unknown;
  signed: boolean;
}

const tryDecode = (h: string): Accept[] | null => { try { return decodePaymentRequired(h).accepts; } catch { return null; } };

/**
 * THE choke point: every signature goes through here (design 4.3).
 * request -> parse -> pre-sign rules -> re-check -> reserve -> intent -> sign -> retry -> validate -> finalise.
 */
export async function pay(d: PayDeps, r: PayRequest): Promise<PayResult> {
  const f = d.fetch ?? fetch;
  const log: LogFn = d.log ?? (() => undefined);
  const t0 = Date.now();
  const opt = { timeoutMs: d.cfg.requestTimeoutMs, maxBytes: d.cfg.maxBodyBytes };
  const exp = { scheme: 'exact', network: NETWORK, asset: USDC_ADDRESS, payTo: r.listing.payTo, amount: r.listing.price.toString() };
  const termsOf = (a?: Accept) => (a ? { scheme: a.scheme, network: a.network, asset: a.asset, payTo: a.payTo, amount: a.amount.toString() } : null);
  let asked = r.listing.price;
  let actual: ReturnType<typeof termsOf> = null;
  let signed = false;

  const base = { seller: r.seller.name, sellerId: r.seller.id, category: r.seller.category, listed: r.listing.price.toString(), listingHash: r.listingHash, url: r.url };
  d.store.appendEvent({ requestId: r.requestId, taskId: r.taskId, eventType: 'intent', payload: { ...base, asked: asked.toString(), paid: '0', status: 'pending', txHash: null, txConfirmed: false } });

  const done = (status: LedgerStatus, verdict: PayResult['verdict'], ruleId: string, reason: string, extra: Partial<PayResult> & { schema?: unknown } = {}): PayResult => {
    const res: PayResult = { requestId: r.requestId, status, verdict, ruleId, reason, asked, paid: 0n, latencyMs: Date.now() - t0, txHash: null, signed, ...extra };
    const payload = {
      asked: asked.toString(), paid: res.paid.toString(), status, latencyMs: res.latencyMs, txHash: res.txHash, txConfirmed: false, ruleId, reason,
      terms: { expected: exp, actual }, schema: extra.schema ?? { state: 'not_run', detail: '' },
    };
    // A held result is not final: it stays pending until recovery resolves it (M-52).
    d.store.appendEvent({ requestId: r.requestId, taskId: r.taskId, eventType: status === 'pending' ? 'sent' : 'final', payload });
    if (status !== 'pending') d.store.setIntentState(r.requestId, 'done');
    log(status === 'paid' ? 'info' : 'warn', `call ${r.requestId} ${status}`, { seller: r.seller.id, ruleId, reason, asked, paid: res.paid });
    return res;
  };

  /** Unpaid request. Redirects are never followed with a payment header; one same-host hop is allowed here (S-25). */
  const probe = async (): Promise<HttpResult | PayResult> => {
    let url = r.url;
    for (let hop = 0; hop < 2; hop++) {
      let res: HttpResult;
      try {
        res = await limitedFetch(f, url, { method: r.method ?? 'GET', body: r.body, headers: r.body ? { 'content-type': 'application/json' } : {} }, opt);
      } catch (e) {
        const k = e instanceof HttpError ? e.kind : 'network';
        return done('failed', 'RELEASE', k === 'timeout' ? 'S-28' : 'X-11', `seller unreachable before any signature: ${(e as Error).message}`);
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        let same = false;
        try { same = !!loc && new URL(loc, url).host === new URL(r.url).host; } catch { /* malformed location */ }
        if (!same) return done('refused', 'REFUSE', 'S-25', 'seller redirected to another host; no payment header is ever sent across hosts');
        url = new URL(loc as string, url).toString();
        continue;
      }
      return res;
    }
    return done('refused', 'REFUSE', 'S-25', 'too many redirects');
  };
  const isResult = (x: HttpResult | PayResult): x is PayResult => 'requestId' in x;

  // 1. unpaid request
  const first = await probe();
  if (isResult(first)) return first;
  if (first.status !== 402) return done('failed', 'RELEASE', 'X-01', `seller answered ${first.status} instead of 402 Payment Required; nothing was signed`);
  const h1 = first.headers.get('payment-required');
  if (!h1) return done('refused', 'REFUSE', 'S-19', '402 had no PAYMENT-REQUIRED header');
  const acc1 = tryDecode(h1);
  actual = termsOf(acc1?.[0]);
  if (acc1?.[0]) asked = acc1[0].amount; // show what the seller really asked, even when refused

  // 2-3. parse + pre-sign rules against the listing snapshot (M-54)
  const ev = evaluateHeader(h1, {
    listing: r.listing, snapshotHash: r.listingHash, liveListingHash: r.liveListingHash ?? r.listingHash, buyerAddress: d.signer.address,
    config: { maxTimeoutSeconds: d.cfg.maxTimeoutSeconds, oddDropRatioPct: d.cfg.oddDropRatioPct },
  });
  if (ev.decision.verdict !== 'ALLOW' || !ev.chosen) return done('refused', 'REFUSE', ev.decision.ruleId, ev.decision.reason);
  const chosen = ev.chosen;
  asked = chosen.amount;
  actual = termsOf(chosen);

  // S-24: confirm the terms once more right before signing; never sign terms we have not checked.
  const second = await probe();
  if (isResult(second)) return second;
  const h2 = second.headers.get('payment-required');
  const acc2 = second.status === 402 && h2 ? tryDecode(h2) : null;
  if (!acc2 || !acc1 || compareTerms(acc1, acc2)) return done('refused', 'REFUSE', 'S-24', 'the 402 terms changed between requests; nothing was signed');

  // 4-8. reserve, intent, sign, retry, finalise
  const res = await d.budget.withReservation(
    { taskId: r.taskId, requestId: r.requestId, sellerId: r.seller.id, category: r.seller.category, amount: chosen.amount },
    async (): Promise<{ outcome: 'spent' | 'released' | 'held'; value: PayResult }> => {
      try {
        d.store.createIntent({ requestId: r.requestId, taskId: r.taskId, sellerId: r.seller.id, amount: chosen.amount });
      } catch {
        return { outcome: 'released', value: done('refused', 'REFUSE', 'M-51', 'an authorisation already exists for this request id') };
      }
      const rawJson = JSON.parse(Buffer.from(h1, 'base64').toString('utf8')) as { accepts: unknown[] };
      let sp;
      try {
        sp = await d.signer.signPayment({ ...rawJson, accepts: [rawJson.accepts[ev.chosenIndex as number]] });
      } catch (e) {
        return { outcome: 'released', value: done('failed', 'RELEASE', 'M-37', `signing failed: ${(e as Error).message}`) };
      }
      signed = true;
      d.store.setIntentState(r.requestId, 'signed', { nonce: sp.nonce, validBefore: sp.validBefore });
      d.store.appendEvent({ requestId: r.requestId, taskId: r.taskId, eventType: 'signed', payload: { nonce: sp.nonce, validBefore: sp.validBefore } });
      d.store.setIntentState(r.requestId, 'sent');
      d.store.appendEvent({ requestId: r.requestId, taskId: r.taskId, eventType: 'sent', payload: {} });

      let paidRes: HttpResult;
      try {
        paidRes = await limitedFetch(f, r.url, { method: r.method ?? 'GET', body: r.body, headers: { ...(r.body ? { 'content-type': 'application/json' } : {}), ...sp.headers } }, opt);
      } catch (e) {
        // Timeout or network error after signing: the authorisation may still be settled. Hold until it expires (S-28, M-52).
        return { outcome: 'held', value: done('pending', 'HOLD', 'S-28', `no response after signing (${(e as Error).message}); reservation held until the authorisation expires`) };
      }
      if (paidRes.status >= 300 && paidRes.status < 400) {
        return { outcome: 'held', value: done('pending', 'HOLD', 'S-25', 'redirect on the paid request was not followed; reservation held until the authorisation expires') };
      }
      if (paidRes.status !== 200) {
        let used: boolean | undefined;
        try { used = d.chain ? await d.chain.authorizationState(d.signer.address, sp.nonce) : undefined; } catch { used = undefined; }
        if (used === false) return { outcome: 'released', value: done('failed', 'RELEASE', 'S-27', `seller answered ${paidRes.status} after signing; the authorisation is unused on chain, nothing was charged`) };
        return { outcome: 'held', value: done('pending', 'HOLD', 'S-27', `seller answered ${paidRes.status} after signing; ${used ? 'authorisation shows as used, reconcile' : 'chain state unknown'}`) };
      }
      const prHeader = paidRes.headers.get('payment-response');
      if (!prHeader) return { outcome: 'held', value: done('pending', 'HOLD', 'S-29', '200 without PAYMENT-RESPONSE; checking the chain before deciding') };
      let settle: { success?: boolean; transaction?: string } = {};
      try { settle = JSON.parse(Buffer.from(prHeader, 'base64').toString('utf8')); } catch { /* handled below */ }
      if (!settle.success || !settle.transaction) return { outcome: 'held', value: done('pending', 'HOLD', 'S-29', 'unreadable or unsuccessful PAYMENT-RESPONSE; checking the chain before deciding') };
      const txHash = settle.transaction;
      const paid = chosen.amount;
      if (paidRes.truncated) return { outcome: 'spent', value: done('rejected', 'ACCEPT_FLAG', 'S-36', 'response exceeded the size cap; payment already moved', { paid, txHash }) };
      const v = d.validate ? d.validate(paidRes.body, { sellerId: r.seller.id, category: r.seller.category }) : tryJson(paidRes.body);
      if (!v.ok) {
        return { outcome: 'spent', value: done('rejected', 'ACCEPT_FLAG', v.ruleId ?? 'M-27', v.reason, { paid, txHash, schema: { state: 'failed', detail: v.reason } }) };
      }
      return { outcome: 'spent', value: done('paid', 'ALLOW', 'M-17', 'paid and validated', { paid, txHash, output: v.output, schema: { state: 'passed', detail: 'output accepted' } }) };
    },
  );
  if ('verdict' in res) return done('refused', res.verdict.verdict === 'STOP_TASK' ? 'STOP_TASK' : 'REFUSE', res.verdict.ruleId, res.verdict.reason);
  return res.value;
}

function tryJson(body: string): ValidateResult {
  try { return { ok: true, output: JSON.parse(body) }; } catch { return { ok: false, reason: 'response was not valid JSON' }; }
}

export { ParseError };
