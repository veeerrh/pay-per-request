// THE ONLY MODULE THAT TOUCHES A PRIVATE KEY (M-37). The planner and the web bundle never import this.
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';

export interface SignedPayment {
  headers: Record<string, string>; // PAYMENT-SIGNATURE header(s) to attach to the paid retry
  nonce: string;
  validBefore: number;
}

export interface Signer {
  readonly address: string;
  /** `paymentRequired` is the raw 402 JSON, already reduced to the single accepts[] entry we approved. */
  signPayment(paymentRequired: Record<string, unknown>): Promise<SignedPayment>;
  signMessage(message: string): Promise<string>;
}

/**
 * Signs with the standard x402 v2 client and the exact EVM scheme (@x402/core 2.28.0, @x402/evm 2.28.0):
 * x402Client.createPaymentPayload() builds the EIP-3009 transferWithAuthorization and
 * x402HTTPClient.encodePaymentSignatureHeader() turns it into the PAYMENT-SIGNATURE header.
 */
export function createSigner(envName = 'BEACON_PRIVATE_KEY'): Signer {
  const key = process.env[envName];
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${envName} is missing or malformed`);
  const account = privateKeyToAccount(key as `0x${string}`);
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { x402Client, x402HTTPClient } = require('@x402/core/client');
  const { ExactEvmScheme } = require('@x402/evm/exact/client');
  const client = new x402Client().register('eip155:84532', new ExactEvmScheme(account));
  const http = new x402HTTPClient(client);
  return {
    address: account.address,
    async signPayment(paymentRequired) {
      const payload = await client.createPaymentPayload(paymentRequired);
      const auth = payload.payload?.authorization;
      if (!auth) throw new Error('signer produced no EIP-3009 authorization');
      return { headers: http.encodePaymentSignatureHeader(payload), nonce: String(auth.nonce), validBefore: Number(auth.validBefore) };
    },
    signMessage: (message) => account.signMessage({ message }),
  };
}

/** Test double. Records every call so tests can prove a refusal never reached the signer. */
export class FakeSigner implements Signer {
  address = '0xADb43a17Cb94d4125f45522d815060B58A71dcCb';
  calls: Array<Record<string, unknown>> = [];
  async signPayment(pr: Record<string, unknown>): Promise<SignedPayment> {
    this.calls.push(pr);
    const nonce = '0x' + randomBytes(32).toString('hex');
    return { headers: { 'PAYMENT-SIGNATURE': 'fake-signature-' + nonce.slice(2, 10) }, nonce, validBefore: Math.floor(Date.now() / 1000) + 60 };
  }
  async signMessage(m: string): Promise<string> { return `fake:${m.length}`; }
}
