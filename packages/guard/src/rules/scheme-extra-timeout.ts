import { refuse, type AcceptRule } from './types';

export const schemeRule: AcceptRule = ({ accept }) =>
  accept.scheme === 'exact' ? null : refuse('S-16', `402 used payment scheme "${accept.scheme}", only "exact" is supported`);

// S-22: a wrong EIP-712 domain can make a signature mean something else, so the extra block must match USDC.
export const extraRule: AcceptRule = ({ accept }) => {
  const x = accept.extra;
  if (x.name !== 'USDC' || x.version !== '2') return refuse('S-22', 'extra block does not match the expected USDC EIP-3009 values (name USDC, version 2)');
  if (x.assetTransferMethod !== undefined && x.assetTransferMethod !== 'eip3009') {
    return refuse('S-22', `extra.assetTransferMethod is "${String(x.assetTransferMethod)}", expected eip3009`);
  }
  return null;
};

// S-23: a long timeout keeps a signed authorisation valid for a long time.
export const timeoutRule: AcceptRule = ({ facts, accept }) =>
  accept.maxTimeoutSeconds > 0 && accept.maxTimeoutSeconds <= facts.config.maxTimeoutSeconds
    ? null
    : refuse('S-23', `maxTimeoutSeconds ${accept.maxTimeoutSeconds} is outside the allowed range 1..${facts.config.maxTimeoutSeconds}`);
