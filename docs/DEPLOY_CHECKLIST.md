# Deployment checklist against the brief

Status: **Ready** = done and verified here. **After deploy** = can only be proven once the Render address exists (do it right after the first deploy). **You** = needs your account or wallet.

## Rules that touch deployment

| Brief requirement | Status | How it is met / what to do |
| --- | --- | --- |
| Sellers and registry reachable over public HTTPS throughout judging | After deploy | Render service (`render.yaml`) plus an UptimeRobot ping every 5 minutes. Standby: laptop tunnel. Do not restart or redeploy during judging. |
| Testnet only, no mainnet | Ready | Startup guard refuses any network except Base Sepolia (`eip155:84532`) in every start path, including `render-host.js`. |
| Fresh testnet wallets, no key in repo, web bundle or logs | Ready | Keys only in Render secrets and local `.env`. `npm run scan` (gitleaks on full history, tracked files, web bundle, logs) passes. The seller code cannot read the wallet key: it is removed from the host process before any seller loads. After deploy: re-run the scan against the live bundle (`/js/*`) and read the Render logs once for stray values. |
| Prices at most 0.10 USDC | Ready | Registry rejects listings above the cap; rule M-17 and the per-call ceiling refuse anything higher. |
| Scraping only sites that allow it | Ready | Atlas checks robots.txt and scrapes the scrapethissite sandbox. |
| Judged tests run over x402 v2 on Base Sepolia, one transfer per paid request | Ready | x402 v2 SDK in every seller; verified on chain in the judged-test run (`docs/evidence/JUDGED_TESTS.md`, 9 of 9). |

## Stretch goals (extra credit)

| Stretch goal | Status | Evidence |
| --- | --- | --- |
| Spending policies with human approval above a threshold | Ready | `packages/buyer/test/approval.test.js` (9 tests); live approve run on the local stack |
| Metered pricing for inference | Ready | `packages/sellers/test/metered.test.js` (4 tests), ledger rows show listed 0.010, asked 0.006 |
| Agent chain (a seller hires sellers and pays them from what it earns) | After deploy and funding | `packages/buyer/test/chain.test.js`, `packages/sellers/test/relay.test.js`; the live paid chain run needs Relay's wallet funded (see `docs/DEPLOY_RENDER.md`) |
| Bazaar discovery metadata | Ready (metadata only) | `packages/sellers/test/bazaar.test.js`; testnet facilitator has no catalog, so no public listing |
| MCP/A2A, escrow, second network | Not built | listed in the README |

## Deliverables

| Deliverable | Status | Where |
| --- | --- | --- |
| Repository with README and one command that starts everything | Ready | `npm run start` (local) and `node scripts/render-host.js` (Render). |
| Public URLs for the registry, the dashboard and each seller | After deploy | Fill `docs/PUBLIC_URLS.md` with the `onrender.com` address (dashboard `/`, registry `/registry/`, sellers `/atlas`, `/tremor`, `/brief`, test vendors). |
| Testnet addresses of every wallet | Ready | `docs/PUBLIC_URLS.md` and `config/addresses.json`. The replay and spare wallets still need faucet USDC (**You**: <https://faucet.circle.com>, Base Sepolia). |
| Three example tasks, each needing all three categories | Ready | `config/tasks.json` (served at `/api/examples`, shown as chips on the Explore page). |
| Architecture diagram: where payments are checked, signed, verified, settled | Ready | `docs/architecture.md`. |
| 5-minute demo, then a viva | You | `docs/DEMO.md`, `docs/VIVA.md`; record the backup video from the final deployed run. |

## What the judges will do, and what must hold on the live address

| Judge test | Needs from the deployment |
| --- | --- |
| Happy path (change the numbers of one of the 3 tasks) | Public dashboard reachable; Beacon wallet funded (at least 0.1 test USDC). |
| Reconciliation | Do not restart the service: the ledger lives on its disk. Reconcile uses the public RPC (`https://sepolia.base.org`). |
| Budget (0.012 at concurrency 1, then 5) | Works from the dashboard (budget and concurrency fields). |
| Price check (reference sellers with a 0.010 ask or a different payTo) | Registry accepts public registrations (open, rate limited to 30 per hour per address) and Beacon can reach the judge's HTTPS seller. Private or non-HTTPS endpoints are refused by design in demo mode. |
| Replay, seller failure | Sellers behind the public HTTPS address; verified locally; after deploy run the Fraud Lab replay step once. |
| Junk output | Judge's reference seller registered in the registry. Beacon flags it and buys elsewhere. |
| Standard client | A judge's unmodified buyer pays `https://<name>.onrender.com/atlas/...` (402 then paid 200, checked locally with the reference buyer). Our buyer pays a judge's seller listed in the registry. The Direct URL box is no longer on the Explore page; the API still supports it for judges who ask. |
| Key hygiene | `npm run scan` clean; operator token and keys are Render secrets. |

## Run these once right after the first deploy

1. `GET /gateway/health` shows `"mode":"full"` and `"beacon":true`.
2. Run an example task from the public dashboard and open one ledger transaction link on Basescan.
3. `node scripts/reference-buyer.js "https://<name>.onrender.com/atlas/countries?top=1" SPARE_BUYER_PRIVATE_KEY` (fund the spare wallet first).
4. Fraud Lab: run all suspects; check that the proof check says "matched".
5. `node scripts/health.js https://<name>.onrender.com --once` (all 9 endpoints should be healthy), then fill in `docs/PUBLIC_URLS.md`.
6. Add the UptimeRobot monitor, and stop touching the service.
