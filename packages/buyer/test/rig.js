// Shared test rig: the seven real seller apps behind a stub facilitator, and a signer that works against it.
import { createRequire } from 'node:module';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { stubFacilitator, serve } from '../../sellers/test/helpers.js';

process.env.CLAIMS_DB = ':memory:';
const require = createRequire(import.meta.url);
const { x402Client, x402HTTPClient } = require('@x402/core/client');
const { ExactEvmScheme } = require('@x402/evm/exact/client');
const { loadLocalListings } = require('../src/listings.js');

export function testSigner() {
  const account = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client().register('eip155:84532', new ExactEvmScheme(account));
  const http = new x402HTTPClient(client);
  return {
    address: account.address,
    signPayment: async (pr) => {
      const payload = await client.createPaymentPayload(pr);
      return { headers: http.encodePaymentSignatureHeader(payload), nonce: payload.payload.authorization.nonce, validBefore: Number(payload.payload.authorization.validBefore) };
    },
    signMessage: async () => 'sig',
  };
}

const GEO = ['China', 'India', 'United States', 'Indonesia', 'Brazil', 'Pakistan'];
const COUNTRIES = GEO.map((name, i) => ({ name, capital: 'x', population: 1000000 * (10 - i), area_km2: 1000 * (10 - i) }));

export async function startSellers() {
  const fac = await stubFacilitator();
  process.env.FACILITATOR_URL = fac.url;
  const S = (f) => require(`../../sellers/src/${f}`);
  const quakeFetch = async () => ({ ok: true, json: async () => ({ features: [{ properties: { mag: 5.1, place: 'sample place', time: Date.now() - 86400000 } }] }) });
  const apps = {
    atlas: S('atlas.js').createAtlas({ requiredBy: null, scrape: async () => COUNTRIES }),
    tremor: S('tremor.js').createTremor({ requiredBy: null, fetch: quakeFetch }),
    brief: S('brief.js').createBrief({ requiredBy: null }),
    overquote: S('fixtures/overquote.js').app,
    redirect: S('fixtures/redirect.js').app,
    hollow: S('fixtures/hollow.js').createHollow({ requiredBy: null }),
    offline: S('fixtures/offline.js').createOffline({ requiredBy: null }),
  };
  const hits = {};
  const bases = {};
  for (const [id, app] of Object.entries(apps)) {
    hits[id] = 0;
    const wrapped = require('express')();
    wrapped.use((req, _res, next) => { if (req.path !== '/health') hits[id]++; next(); });
    wrapped.use(app);
    bases[id] = await serve(wrapped);
  }
  const listings = loadLocalListings().map((l) => ({ ...l, endpoint: bases[l.id] + new URL(l.endpoint).pathname }));
  return { listings, hits, bases };
}
