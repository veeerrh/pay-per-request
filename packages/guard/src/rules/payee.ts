import { sameAddress } from '../money';
import { refuse, type AcceptRule } from './types';

// S-06: payTo must equal the listing. A lie here also earns a suspension hint.
export const payToRule: AcceptRule = ({ facts, accept }) =>
  sameAddress(accept.payTo, facts.listing.payTo)
    ? null
    : refuse('S-06', `402 payTo ${accept.payTo} differs from the listed payTo ${facts.listing.payTo}`, { suspend: true });

// S-26 / M-14: never pay ourselves.
export const selfPayRule: AcceptRule = ({ facts, accept }) =>
  sameAddress(accept.payTo, facts.buyerAddress) ? refuse('S-26', 'payTo is the buyer\'s own address (self-payment loop)') : null;
