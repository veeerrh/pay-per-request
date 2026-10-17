# Public deployment on Render (free) with UptimeRobot

What judges must reach over public HTTPS: the **registry** and the **sellers**. They run as one process (`scripts/render-host.js`) on one free Render web service. It holds **no wallet key and no operator token** and refuses to start if either is set. Beacon (the buyer) and all keys stay on your machine.

```
https://<name>.onrender.com/registry/        registry (JSON: /registry/services)
https://<name>.onrender.com/atlas/countries?top=3&by=population
https://<name>.onrender.com/tremor/quakes?country=India&days=7&minMag=4.5
https://<name>.onrender.com/brief/brief      (POST)
https://<name>.onrender.com/overquote|redirect|hollow|offline/...   test vendors
https://<name>.onrender.com/gateway/health   health check (UptimeRobot pings this)
```

Memory: about 135 MB in one process (the same services as separate processes need about 430 MB, more than the 512 MB free limit).

## 1. Deploy on Render (you do the account steps)

1. Sign in at <https://render.com> with GitHub and allow it to read `veeerrh/pay-per-request`.
2. **New > Blueprint**, pick the repo and the branch (`build/di06`, later `main`). Render reads `render.yaml`.
3. When it asks for the three secrets (`ATLAS_GEMINI_API_KEY`, `TREMOR_GEMINI_API_KEY`, `BRIEF_GEMINI_API_KEY`), paste each agent's own key. Leaving one empty is fine: that agent then answers rule-based. **Never** add a wallet key or `OPERATOR_TOKEN`.
4. Deploy. The first build takes a few minutes. When the log says `public host on :... ` and `registry seeded`, open `https://<name>.onrender.com/gateway/health`.
5. If `registry seeded` is not shown (the public URL can need a moment), restart the service once. Seeding is idempotent.

## 2. Keep it awake with UptimeRobot (free)

A free Render service sleeps after about 15 minutes without traffic and takes 30 to 50 seconds to wake. A sleeping seller would fail a judge's first call.

1. Sign up at <https://uptimerobot.com> (free).
2. **Add New Monitor**: type *HTTP(s)*, URL `https://<name>.onrender.com/gateway/health`, interval *5 minutes*.
3. Optionally add a second monitor on `/registry/services` and turn on email alerts.

A five-minute ping keeps the service awake all day. Free Render gives about 750 instance hours per month, enough for one service always on.

## 3. Point Beacon (on your machine) at the public URLs

In `.env` (never committed):

```
PUBLIC_BASE_URL=https://<name>.onrender.com
REGISTRY_URL=https://<name>.onrender.com/registry
BEACON_LOCAL_ROUTES=false
```

Start only the buyer side locally (Beacon and its dashboard), so that every purchase travels over public HTTPS exactly as a judge's buyer would. Then run the unmodified reference buyer against a public seller URL:

```
node scripts/reference-buyer.js "https://<name>.onrender.com/atlas/countries?top=1" SPARE_BUYER_PRIVATE_KEY
```

## Limits to know (be honest with judges if asked)

- **Cold start.** If a ping is missed and the service sleeps, the first request takes 30 to 50 seconds. Warm it up (open `/gateway/health`) shortly before judging.
- **Ephemeral disk.** Free Render storage is wiped on every restart or redeploy. The registry is re-seeded at start, so listings come back. Seller replay-protection records (nonce claims) reset on restart, which only matters for the few seconds a restart lasts; the on-chain authorization is still single use.
- **Ledger.** Beacon's hash-chained ledger lives on your machine, so it is not affected.
- **Uptime is a best effort on a free tier.** Keep the laptop tunnel option (`npm run tunnel -- cloudflared`) as a standby.
- **Not on Vercel.** Vercel runs short serverless functions, not a long-running Node server with local databases. It could only host a static copy of the dashboard, which would still need Beacon reachable.

## Local rehearsal (no Render needed)

```
PORT=10000 PUBLIC_BASE_URL=https://example.test node scripts/render-host.js
node scripts/reference-buyer.js "http://localhost:10000/atlas/countries?top=1" BEACON_PRIVATE_KEY
```

Checked on 2026-10-17: health 200, a real x402 payment settled on Base Sepolia through the single-process host.
