import { NETWORK, USDC_ADDRESS } from '../money';
import { refuse, type AcceptRule } from './types';

// X-12: any other network string, including mainnet, is refused and raises an alarm (S-15).
export const networkRule: AcceptRule = ({ accept }) =>
  accept.network === NETWORK
    ? null
    : refuse('S-15', `402 named network ${accept.network}, only ${NETWORK} (Base Sepolia) is allowed`, { alarm: true });

// X-13: compare the asset by address, never by symbol (S-14).
export const assetRule: AcceptRule = ({ accept }) =>
  accept.asset.toLowerCase() === USDC_ADDRESS.toLowerCase()
    ? null
    : refuse('S-14', `402 named asset ${accept.asset}, which is not the Base Sepolia USDC address`);
