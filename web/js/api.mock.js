// Canned data for building the UI without a backend (?mock=1). Never used in the demo.
// Every ledger row here is marked demo data and no transaction hash is invented.
const SERVICES = [
  ['atlas', 'Atlas', 'scraping', '5000'], ['tremor', 'Tremor', 'data', '2000'], ['brief', 'Brief', 'inference', '10000'],
  ['overquote', 'Overquote', 'scraping', '2000'], ['redirect', 'Redirect', 'data', '1000'], ['hollow', 'Hollow', 'inference', '8000'], ['offline', 'Offline', 'scraping', '4000'],
].map(([id, name, category, price]) => ({
  id, name, category, price, description: `Sample ${category} agent (mock).`, endpoint: `https://mock.invalid/${id}`, method: 'GET', network: 'eip155:84532',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', payTo: '0x0000000000000000000000000000000000000000', inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
  labels: ['atlas', 'tremor', 'brief'].includes(id) ? [] : ['test-vendor'], listingHash: 'mock', version: 1, status: 'active', probe: { matches: true, reason: null },
  reputation: { attempts: 0, clean: 0, headline: null, score: 0.5, medianLatencyMs: null, medianPrice: null, status: 'probation' },
}));
const LEDGER = [{
  id: 'mock-1', callNo: 1, taskId: 'mock', time: new Date().toISOString(), buyer: 'Scout', seller: 'Overquote', sellerId: 'overquote', category: 'scraping', listed: '2000', asked: '20000', paid: '0',
  status: 'refused', latencyMs: 140, txHash: null, txConfirmed: false, ruleId: 'M-17', reason: 'Demo row: 402 asked 20,000 units against a listed 2,000.', listingHash: 'mock', ruleSetHash: 'mock',
  terms: { expected: { scheme: 'exact', network: 'eip155:84532', asset: 'USDC', payTo: '0x0', amount: '2000' }, actual: { scheme: 'exact', network: 'eip155:84532', asset: 'USDC', payTo: '0x0', amount: '20000' } }, schema: { state: 'not_run', detail: '' }, receipt: null, source: 'mock',
}];
const wait = (v) => new Promise((r) => setTimeout(() => r(v), 150));

export function mock(live) {
  const off = () => Promise.reject(Object.assign(new Error('Mock mode: tasks are disabled.'), { status: 0 }));
  return {
    health: () => wait({ ok: true, sessionId: 'mock', spendingHalted: false }),
    examples: () => live.examples().catch(() => []),
    config: () => wait({ rules: { fallbackLimit: 3, probationAttempts: 3, dropThreshold: 0.5, perCallCeiling: '100000' }, ruleSetHash: 'mock'.padEnd(64, '0'), network: 'eip155:84532', hygiene: null, buyer: 'Scout' }),
    services: () => wait(SERVICES), registerService: off,
    wallet: () => wait({ address: '0x0000000000000000000000000000000000000000', usdcBalance: '20000000', reserved: '0', sessionId: 'mock', spendingHalted: false, network: 'eip155:84532' }),
    tasks: () => wait([]), task: off, createTask: off, taskChat: () => wait({ messages: [], status: 'stopped', usesModel: false }), chat: off,
    ledger: () => wait(LEDGER), verify: () => wait({ ok: true, rows: 1, headHash: 'mock'.padEnd(64, '0') }),
    reconcile: () => wait({ ok: false, status: 'unverified', ledgerTotal: '0', chainTotal: '0', differences: [], error: 'mock data, nothing to compare' }),
    reputation: () => wait([]), newSession: off, attack: off, attacks: () => wait([]),
  };
}
