# x402 foundation test

Minimal seller + buyer proving the core 402 payment loop before building the full marketplace.

## What's proven already (no funds needed)

- Seller (`seller/index.js`) serves `GET /scrape` behind `@x402/express` payment middleware.
- Unpaid request returns a correct `402` with a `PAYMENT-REQUIRED` header that decodes to exactly the shape in the hackathon spec: `network: eip155:84532`, `asset` = the real Base Sepolia testnet USDC address, `amount: "1000"` for $0.001, `payTo` = the seller wallet.
- Buyer (`buyer/index.js`) using `@x402/fetch` correctly detects the 402, builds a signed EIP-3009 payment payload, and retries automatically — verified by watching it attempt the full round trip (it currently fails at the facilitator's verify step only because the buyer wallet has 0 USDC, which is expected).

## What's left: fund the buyer wallet, then re-run

1. Go to https://faucet.circle.com, select **Base Sepolia**, paste the buyer address below, request testnet USDC. No account needed, ~20 USDC per request.
2. Re-run the buyer. A funded wallet should get a `200` with a `PAYMENT-RESPONSE` header containing a real tx hash, viewable at `https://sepolia.basescan.org/tx/<hash>`.

## Wallets (testnet only — no real value)

```
BUYER_ADDRESS=0xcA8B76fe84fb56201d5d38472c6a1A0c1Ece4818
SELLER_ADDRESS=0xc4A183e8fA3d4093ec16D580182ae7056C878643
```

Private keys live in `seller/.env` and `buyer/.env` (gitignored — never commit these, even though they're testnet-only).

## Running it

```bash
# terminal 1
cd seller && node index.js

# terminal 2 (after funding the buyer wallet)
cd buyer && node index.js
```

## Reusing this for the real marketplace

- `seller/index.js` is the template for all three category sellers — same middleware setup, swap the route handler's business logic and the `price`.
- `buyer/index.js` is the template for the real buyer agent — wrap this payment logic with the registry lookup, price-check-before-sign guard, budget mutex, and ledger logging described in the main blueprint.
- The facilitator (`x402.org/facilitator`) and asset address are already correct for Base Sepolia — don't need to touch them.
