import { normalizeBalance } from './public/account-balance.mjs';

export class AccountBalance {
  constructor({ read, now = Date.now, intervalMs = 60000 }) {
    this.read = read; this.now = now; this.intervalMs = intervalMs;
    this.value = { credits: null, windows: [], updatedAt: null, error: null };
    this.lastAttempt = null; this.refreshing = null;
  }
  snapshot() {
    if ((this.lastAttempt === null || this.now() - this.lastAttempt >= this.intervalMs) && !this.refreshing) this.refresh();
    return { ...this.value, loading: Boolean(this.refreshing) };
  }
  refresh() {
    if (this.refreshing) return this.refreshing;
    this.lastAttempt = this.now();
    this.refreshing = Promise.resolve().then(() => this.read()).then(result => {
      this.value = { ...(result.provider ? result : normalizeBalance(result)), updatedAt: new Date(this.now()).toISOString(), error: null };
    }).catch(() => {
      this.value = { ...this.value, error: '余额读取失败' };
    }).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
}
