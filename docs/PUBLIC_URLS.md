# Public URLs and addresses

Deployed on Render (free) with an UptimeRobot ping; see `docs/DEPLOY_RENDER.md`. A laptop tunnel (`npm run tunnel`) is the standby. Do not restart or redeploy the service during judging.

**Base URL:** `https://agentmarket-public.onrender.com`

| What | URL |
| --- | --- |
| Dashboard and buyer console | `https://agentmarket-public.onrender.com/` |
| Registry (JSON) | `https://agentmarket-public.onrender.com/registry/services` |
| Registry (page) | `https://agentmarket-public.onrender.com/registry/` |
| Atlas (scraping, 0.005) | `https://agentmarket-public.onrender.com/atlas/countries?top=3&by=population` |
| Tremor (data, 0.002) | `https://agentmarket-public.onrender.com/tremor/quakes?country=India&days=7&minMag=4.5` |
| Brief (inference, 0.010, POST) | `https://agentmarket-public.onrender.com/brief/brief` |
| Relay (inference, agent chain, up to 0.010, POST) | `https://agentmarket-public.onrender.com/relay/relay` |
| Relay's wallet and receipts | `https://agentmarket-public.onrender.com/relay/payments` |
| Overquote (test vendor, price lie) | `https://agentmarket-public.onrender.com/overquote/countries` |
| Redirect (test vendor, payTo lie) | `https://agentmarket-public.onrender.com/redirect/quakes` |
| Hollow (test vendor, junk output, POST) | `https://agentmarket-public.onrender.com/hollow/brief` |
| Offline (test vendor, always fails) | `https://agentmarket-public.onrender.com/offline/countries` |
| Check everything is up | `npm run health -- --once` |

Prices are in USDC units (6 decimals): 0.005 USDC = 5,000 units. Facilitator: <https://x402.org/facilitator>. USDC contract: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.

## Wallet addresses (public, Base Sepolia testnet)

These are receive-only identifiers and safe to share. Private keys live only in `.env` on the operator machine.

### Buyer-side wallets (hold test USDC)

| Role | Address |
| --- | --- |
| Beacon (buyer agent) | `0xADb43a17Cb94d4125f45522d815060B58A71dcCb` |
| Spare buyer | `0x4Af8Fd5A3344faA60eaef44770BAAE3Df815a715` |
| Relay (agent chain, also receives payments) | `0xfB30789E655883851E6C944Cd157C5cDBbD989a3` |
| Replay script | `0x034096Fd351812A6cc5F465254793c19ee71ff7D` |

Explorer: `https://sepolia.basescan.org/address/<address>`

### Seller receiving addresses (no private keys exist for these)

The full list is in `config/addresses.json` (Atlas, Tremor, Brief, Overquote, Redirect, Redirect decoy, Hollow, Offline).

## If the tunnel drops

1. Restart it: `npm run tunnel` (or `node scripts/tunnel.js ngrok`).
2. Stop the old stack and run `npm run start:public` again so the listings carry the new URL.
3. Give the judges the new base URL and keep the recorded backup video ready.
