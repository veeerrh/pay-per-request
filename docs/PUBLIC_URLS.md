# Public URLs and addresses

Fill in the **base URL** after the tunnel is up. `npm run tunnel` writes `PUBLIC_BASE_URL` into `.env` for you, then `npm run start:public` starts everything in demo mode and registers the listings with that URL. Quick-tunnel URLs change on every restart: after a restart run `npm run start:public` again and update this file.

**Base URL:** `<fill in after the tunnel is up>`

| What | URL |
| --- | --- |
| Dashboard and buyer console | `<base>/` |
| Registry (JSON) | `<base>/registry/services` |
| Registry (page) | `<base>/registry/` |
| Atlas (scraping, 0.005) | `<base>/atlas/countries?top=3&by=population` |
| Tremor (data, 0.002) | `<base>/tremor/quakes?country=India&days=7&minMag=4.5` |
| Brief (inference, 0.010, POST) | `<base>/brief/brief` |
| Overquote (test vendor, price lie) | `<base>/overquote/countries` |
| Redirect (test vendor, payTo lie) | `<base>/redirect/quakes` |
| Hollow (test vendor, junk output, POST) | `<base>/hollow/brief` |
| Offline (test vendor, always fails) | `<base>/offline/countries` |
| Check everything is up | `npm run health -- --once` |

Prices are in USDC units (6 decimals): 0.005 USDC = 5,000 units. Facilitator: <https://x402.org/facilitator>. USDC contract: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.

## Wallet addresses (public, Base Sepolia testnet)

These are receive-only identifiers and safe to share. Private keys live only in `.env` on the operator machine.

### Buyer-side wallets (hold test USDC)

| Role | Address |
| --- | --- |
| Beacon (buyer agent) | `0xADb43a17Cb94d4125f45522d815060B58A71dcCb` |
| Spare buyer | `0x4Af8Fd5A3344faA60eaef44770BAAE3Df815a715` |
| Replay script | `0x034096Fd351812A6cc5F465254793c19ee71ff7D` |

Explorer: `https://sepolia.basescan.org/address/<address>`

### Seller receiving addresses (no private keys exist for these)

The full list is in `config/addresses.json` (Atlas, Tremor, Brief, Overquote, Redirect, Redirect decoy, Hollow, Offline).

## If the tunnel drops

1. Restart it: `npm run tunnel` (or `node scripts/tunnel.js ngrok`).
2. Stop the old stack and run `npm run start:public` again so the listings carry the new URL.
3. Give the judges the new base URL and keep the recorded backup video ready.
