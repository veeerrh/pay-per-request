require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const { privateKeyToAccount } = require("viem/accounts");
const { x402Client, x402HTTPClient } = require("@x402/core/client");
const { decodePaymentRequiredHeader, decodePaymentResponseHeader } = require("@x402/core/http");
const { ExactEvmScheme } = require("@x402/evm/exact/client");
const ledger = require("../shared/ledger");

const registry = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "registry.json"), "utf8"));
const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY);

function findService(key) {
  const svc = registry.services.find((s) => s.key === key);
  if (!svc) throw new Error(`unknown service key: ${key}`);
  return svc;
}

function toUnits(priceUsdcStr) {
  return BigInt(Math.round(parseFloat(priceUsdcStr) * 1e6));
}

function makeHttpClient() {
  const client = x402Client.fromConfig({
    schemes: [{ network: registry.network, client: new ExactEvmScheme(account) }],
  });
  return new x402HTTPClient(client);
}

/**
 * Full guarded call: price-check -> budget-check -> sign -> settle -> schema-check -> ledger.
 * budgetState is a mutable { remaining: bigint-as-string } shared across calls in one test run.
 */
async function guardedCall(serviceKey, { testCase, budgetState } = {}) {
  const svc = findService(serviceKey);
  const start = Date.now();
  const expectedUnits = toUnits(svc.price_usdc);

  const base = {
    time: new Date().toISOString(),
    test_case: testCase || "-",
    buyer: account.address,
    seller: svc.payTo,
    service: svc.key,
    listed_price_units: expectedUnits.toString(),
  };

  // Step 1: unpaid request to get the 402
  const firstRes = await fetch(svc.url);
  if (firstRes.status !== 402) {
    const entry = {
      ...base,
      amount_paid_units: "0",
      status: "failed",
      tx_hash: null,
      latency_ms: Date.now() - start,
      notes: `expected 402, got ${firstRes.status}`,
    };
    ledger.append(entry);
    return { ok: false, reason: "unexpected_status", entry };
  }

  const headerVal = firstRes.headers.get("PAYMENT-REQUIRED");
  const paymentRequired = decodePaymentRequiredHeader(headerVal);
  const terms = paymentRequired.accepts[0];

  // Step 2: price / network / asset / payTo check against the registry listing
  const priceOk = terms.amount === expectedUnits.toString();
  const networkOk = terms.network === registry.network;
  const assetOk = terms.asset.toLowerCase() === registry.asset.toLowerCase();
  const payToOk = terms.payTo.toLowerCase() === svc.payTo.toLowerCase();

  if (!priceOk || !networkOk || !assetOk || !payToOk) {
    const mismatches = [];
    if (!priceOk) mismatches.push(`amount: listed ${expectedUnits}, asked ${terms.amount}`);
    if (!networkOk) mismatches.push(`network: listed ${registry.network}, asked ${terms.network}`);
    if (!assetOk) mismatches.push(`asset: listed ${registry.asset}, asked ${terms.asset}`);
    if (!payToOk) mismatches.push(`payTo: listed ${svc.payTo}, asked ${terms.payTo}`);
    const entry = {
      ...base,
      amount_paid_units: "0",
      status: "refused",
      tx_hash: null,
      latency_ms: Date.now() - start,
      notes: `price-check failed -- ${mismatches.join("; ")}`,
    };
    ledger.append(entry);
    return { ok: false, reason: "price_check_failed", entry };
  }

  // Step 3: budget check (reserve before attempting payment)
  if (budgetState) {
    const remaining = BigInt(budgetState.remaining);
    if (remaining < expectedUnits) {
      const entry = {
        ...base,
        amount_paid_units: "0",
        status: "refused",
        tx_hash: null,
        latency_ms: Date.now() - start,
        notes: `budget exceeded -- remaining ${remaining} units, call needs ${expectedUnits} units`,
      };
      ledger.append(entry);
      return { ok: false, reason: "budget_exceeded", entry };
    }
    budgetState.remaining = (remaining - expectedUnits).toString();
  }

  // Step 4: sign and retry with payment
  const httpClient = makeHttpClient();
  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  const headers = httpClient.encodePaymentSignatureHeader(paymentPayload);
  const secondRes = await fetch(svc.url, { headers });

  if (secondRes.status !== 200) {
    // release the reservation -- no charge happened
    if (budgetState) budgetState.remaining = (BigInt(budgetState.remaining) + expectedUnits).toString();
    let bodyText = "";
    try {
      bodyText = JSON.stringify(await secondRes.json());
    } catch {}
    const entry = {
      ...base,
      amount_paid_units: "0",
      status: "failed",
      tx_hash: null,
      latency_ms: Date.now() - start,
      notes: `seller/facilitator rejected payment -- status ${secondRes.status} ${bodyText}`,
    };
    ledger.append(entry);
    return { ok: false, reason: "settlement_failed", entry };
  }

  const paymentResponseHeader = secondRes.headers.get("PAYMENT-RESPONSE");
  const settle = paymentResponseHeader ? decodePaymentResponseHeader(paymentResponseHeader) : null;
  const body = await secondRes.json();

  // Step 5: output schema check
  const missingFields = (svc.requiredFields || []).filter((f) => body[f] === undefined);

  if (missingFields.length > 0) {
    const entry = {
      ...base,
      amount_paid_units: expectedUnits.toString(),
      status: "paid_output_rejected",
      tx_hash: settle?.transaction || null,
      latency_ms: Date.now() - start,
      notes: `output missing required fields: ${missingFields.join(", ")} -- data discarded, seller reputation lowered`,
    };
    ledger.append(entry);
    return { ok: false, reason: "bad_output", entry, body };
  }

  const entry = {
    ...base,
    amount_paid_units: expectedUnits.toString(),
    status: "paid",
    tx_hash: settle?.transaction || null,
    latency_ms: Date.now() - start,
    notes: null,
  };
  ledger.append(entry);
  return { ok: true, entry, body };
}

/**
 * Low-level replay test helper: signs ONE payment payload and sends it to the
 * server twice (sequentially or in parallel), bypassing the auto-retry wrapper
 * so the exact same signature is reused both times.
 */
async function replaySend(serviceKey, { testCase, parallel = false, copies = 2 } = {}) {
  const svc = findService(serviceKey);
  const firstRes = await fetch(svc.url);
  const headerVal = firstRes.headers.get("PAYMENT-REQUIRED");
  const paymentRequired = decodePaymentRequiredHeader(headerVal);
  const expectedUnits = toUnits(svc.price_usdc);

  const httpClient = makeHttpClient();
  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  const headers = httpClient.encodePaymentSignatureHeader(paymentPayload);

  const base = {
    buyer: account.address,
    seller: svc.payTo,
    service: svc.key,
    listed_price_units: expectedUnits.toString(),
  };

  async function attempt(i) {
    const start = Date.now();
    const res = await fetch(svc.url, { headers });
    const latency_ms = Date.now() - start;
    let settle = null;
    let status;
    let amountPaid = "0";
    let notes = null;
    if (res.status === 200) {
      const h = res.headers.get("PAYMENT-RESPONSE");
      settle = h ? decodePaymentResponseHeader(h) : null;
      status = "paid";
      amountPaid = expectedUnits.toString();
    } else {
      let bodyText = "";
      try {
        bodyText = JSON.stringify(await res.json());
      } catch {}
      status = "failed";
      notes = `replay attempt #${i} rejected -- status ${res.status} ${bodyText}`;
    }
    const entry = {
      time: new Date().toISOString(),
      test_case: testCase || "-",
      ...base,
      amount_paid_units: amountPaid,
      status,
      tx_hash: settle?.transaction || null,
      latency_ms,
      notes: notes || (i === 1 ? "first use of this signed payment" : `replay attempt #${i} of the same signed payment`),
    };
    ledger.append(entry);
    return { httpStatus: res.status, entry };
  }

  const results = [];
  if (parallel) {
    const all = await Promise.all(Array.from({ length: copies }, (_, i) => attempt(i + 1)));
    results.push(...all);
  } else {
    for (let i = 1; i <= copies; i++) {
      results.push(await attempt(i));
    }
  }
  return results;
}

module.exports = { guardedCall, replaySend, account, registry, toUnits };
