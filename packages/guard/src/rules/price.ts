import { MAX_PRICE } from '../money';
import { fmtUnits, refuse, type AcceptRule, type GlobalRule } from './types';
import type { Verdict } from '../contract/verdict';

const times = (a: bigint, b: bigint): string => {
  const tenths = (a * 10n) / b;
  return tenths % 10n === 0n ? `${tenths / 10n}` : `${tenths / 10n}.${tenths % 10n}`;
};

// M-17: refuse anything above the listed price. Lower is allowed and logged (D-01, S-20).
export const priceRule: AcceptRule = ({ facts, accept }): Verdict => {
  const listed = facts.listing.price;
  const asked = accept.amount;
  if (asked > MAX_PRICE) return refuse('M-17', `402 asked ${fmtUnits(asked)} units, above the 100,000 unit (0.10 USDC) price cap`);
  if (asked > listed) return refuse('M-17', `402 asked ${fmtUnits(asked)} units against a listed ${fmtUnits(listed)} (${times(asked, listed)} times the listed price)`);
  const dropPct = listed === 0n ? 0n : ((listed - asked) * 100n) / listed;
  const odd = asked < listed && dropPct > BigInt(facts.config.oddDropRatioPct);
  return {
    verdict: 'ALLOW',
    ruleId: 'M-17',
    reason: asked < listed ? `402 asks ${fmtUnits(asked)} units, below the listed ${fmtUnits(listed)}` : 'price matches the listing',
    note: asked < listed ? `price delta ${fmtUnits(listed - asked)} units${odd ? '; large drop, flagged as odd' : ''}` : undefined,
  };
};

// M-54 / S-73: judge every 402 against the snapshot taken at task start.
export const snapshotRule: GlobalRule = (facts) =>
  facts.snapshotHash === facts.liveListingHash
    ? null
    : { verdict: 'ALLOW', ruleId: 'M-54', reason: 'listing changed since task start; this task keeps its snapshot', note: 'listing_edited_mid_task' };
