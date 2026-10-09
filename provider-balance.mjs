import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function tomlString(value) {
  if (/^'[^']*'$/.test(value)) return value.slice(1, -1);
  try { const parsed = JSON.parse(value); return typeof parsed === 'string' ? parsed : null; } catch { return null; }
}

export function configuredProvider(config) {
  const tables = new Map([['', {}]]);
  let table = '';
  for (const line of config.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([\w.-]+)\]\s*(?:#.*)?$/);
    if (section) { table = section[1]; if (!tables.has(table)) tables.set(table, {}); continue; }
    const field = line.match(/^\s*(model_provider|base_url|env_key|experimental_bearer_token)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/);
    if (field) tables.get(table)[field[1]] = tomlString(field[2]);
  }
  const name = tables.get('').model_provider;
  return tables.get(`model_providers.${name}`) || null;
}

export function normalizeProviderBalance(data) {
  const amount = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const provider = {
    name: 'Black AI Coding', currency: 'USD',
    walletBalance: amount(data?.balance),
    keyRemaining: data?.mode === 'quota_limited' ? amount(data?.quota?.remaining) : null,
    subscriptionRemaining: data?.subscription ? amount(data?.remaining) : null
  };
  if ([provider.walletBalance, provider.keyRemaining, provider.subscriptionRemaining].every(value => value === null)) throw new Error('provider_balance_unavailable');
  return { provider, credits: null, windows: [] };
}

export class ProviderBalance {
  constructor({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), readFile = file => fs.readFileSync(file, 'utf8'), fetchImpl = fetch, environment = process.env } = {}) {
    this.codexHome = codexHome; this.readFile = readFile; this.fetchImpl = fetchImpl; this.environment = environment;
  }
  settings() {
    let config;
    try { config = configuredProvider(this.readFile(path.join(this.codexHome, 'config.toml'))); } catch { return null; }
    let base;
    try { base = new URL(config?.base_url); } catch { return null; }
    // Credentials may only be sent to the verified provider configured for Codex.
    if (base.protocol !== 'https:' || !['www.blackaicoding.com', 'blackaicoding.com'].includes(base.hostname) || base.port || base.username || base.password) return null;
    let key = config.env_key ? this.environment[config.env_key] : config.experimental_bearer_token;
    if (!key && !config.env_key) {
      try { key = JSON.parse(this.readFile(path.join(this.codexHome, 'auth.json'))).OPENAI_API_KEY; } catch {}
    }
    if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key)) throw new Error('provider_credential_unavailable');
    return { origin: base.origin, key: key.trim() };
  }
  async read(settings) {
    const response = await this.fetchImpl(`${settings.origin}/v1/usage`, {
      method: 'GET', headers: { Authorization: `Bearer ${settings.key}`, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      const error = new Error('provider_balance_failed'); error.httpStatus = response.status; throw error;
    }
    const body = await response.text();
    if (body.length > 512000) throw new Error('provider_response_too_large');
    return normalizeProviderBalance(JSON.parse(body));
  }
}
