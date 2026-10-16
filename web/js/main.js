// App shell: hash router, sidebar wallet panel, profile menu, faucet dialog, global banners.
import { api, MOCK } from './api.js';
import { app } from './app.js';
import explore from './pages/explore.js';
import ledger from './pages/ledger.js';
import attack from './pages/attack.js';
import { tasks, reputation, wallet, settings } from './pages/more.js';
import { $, $$, esc, icon, formatUsdc, short, copyText, openDialog, dialogHead, wireDialogs, toast } from './ui.js';

const PAGES = { explore, tasks, ledger, reputation, attack, wallet, settings };
let current = null;

function setSidebar(open) { $('#sidebar').classList.toggle('open', open); $('#scrim').hidden = !open; }
function closeProfile() { $('#profile-menu').hidden = true; $('#profile-btn').setAttribute('aria-expanded', 'false'); }

async function show(name, first) {
  const page = PAGES[name] || PAGES.explore;
  const key = PAGES[name] ? name : 'explore';
  $$('[data-page]').forEach((p) => { p.hidden = p.dataset.page !== key; });
  $$('[data-nav]').forEach((a) => { if (a.dataset.nav === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  $('#page-title').textContent = page.title;
  $('#page-sub').textContent = page.subtitle;
  document.title = `${page.title} · AgentMarket`;
  setSidebar(false); closeProfile();
  if (!first && current !== key) window.scrollTo({ top: 0 });
  current = key;
  await page.mount($(`#page-${key}`));
}
const route = (first = false) => show(location.hash.replace('#', '').split('?')[0], first);

export async function refreshWallet() {
  try {
    const w = await api.wallet();
    app.wallet = w;
    $('#wp-addr').textContent = short(w.address);
    $('#wp-addr').title = w.address;
    $('#menu-addr').textContent = w.address;
    $('#wp-balance').textContent = w.usdcBalance == null ? '–' : formatUsdc(w.usdcBalance);
    setHalted(w.spendingHalted, w.haltReason);
    $('#offline-banner').hidden = true;
  } catch (e) {
    $('#offline-text').textContent = e.status === 0 ? 'Cannot reach Beacon. Is it running?' : `Beacon answered with an error: ${e.message}`;
    $('#offline-banner').hidden = false;
  }
}
function setHalted(on, reason = '') { $('#halted-banner').hidden = !on; $('#halted-text').textContent = reason; }
app.refreshWallet = refreshWallet;
app.setHalted = setHalted;

function faucet() {
  openDialog(`${dialogHead('dialog-sm-title', 'Get test USDC')}<div class="dialog-body"><p class="note mb">${icon('alert', 'icon-sm')} Testnet only. These tokens have no real value.</p>
    <p>The Circle faucet gives <strong>20 test USDC</strong> per address, per chain, every 2 hours. Choose <strong>Base Sepolia</strong> and <strong>USDC</strong>, then paste the wallet address from the sidebar.</p>
    <p class="mt"><a class="btn btn-secondary" href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer">Open Circle faucet ${icon('external')}</a></p></div>
    <div class="dialog-foot"><button type="button" class="btn btn-secondary" data-close>Close</button></div>`, true);
}

function bind() {
  wireDialogs();
  window.addEventListener('hashchange', () => route());
  $('#profile-btn').addEventListener('click', () => { const open = $('#profile-menu').hidden; $('#profile-menu').hidden = !open; $('#profile-btn').setAttribute('aria-expanded', String(open)); });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu-wrap')) closeProfile();
    const t = e.target.closest('[data-action]');
    if (t) {
      if (t.dataset.action === 'open-sidebar') { setSidebar(true); $('#sidebar a')?.focus(); }
      else if (t.dataset.action === 'close-sidebar') setSidebar(false);
      else if (t.dataset.action === 'open-faucet') faucet();
      else if (t.dataset.action === 'retry-load') { refreshWallet(); route(); }
    }
    if (e.target.closest('[data-copy-addr]') && app.wallet) copyText(app.wallet.address, 'Wallet address copied.');
    const cj = e.target.closest('[data-copy-json]');
    if (cj) copyText(cj.parentElement.querySelector('code').textContent, 'JSON copied to clipboard.');
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeProfile(); setSidebar(false); } });
}

async function init() {
  bind();
  if (MOCK) $('#mock-banner').hidden = false;
  await refreshWallet();
  api.config().then((c) => { if (c.attackPanel) $('#nav-attack').hidden = false; }).catch(() => undefined);
  await route(true);
  setInterval(refreshWallet, 20000);
}
init();
