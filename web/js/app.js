// Tiny shared state so pages stay decoupled. Filled in by main.js.
export const app = {
  hired: new Set(),
  listeners: new Set(),
  wallet: null,
  setHired(id, on) {
    if (on) this.hired.add(id); else this.hired.delete(id);
    this.listeners.forEach((fn) => fn());
  },
  clearHired() { this.hired.clear(); this.listeners.forEach((fn) => fn()); },
  onHired(fn) { this.listeners.add(fn); },
  // set by main.js
  refreshWallet: async () => {},
  setHalted: () => {},
  goto: (hash) => { location.hash = hash; },
};
