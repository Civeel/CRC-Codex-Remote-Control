import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredProvider, normalizeProviderBalance, ProviderBalance } from '../provider-balance.mjs';
import { balanceText } from '../public/account-balance.mjs';
import { AccountBalance } from '../account-balance.mjs';

const config = 'model_provider = "custom"\n[model_providers.other]\nbase_url = "https://example.test/v1"\n[model_providers.custom]\nbase_url = "https://www.blackaicoding.com/v1" # comment\n';
const files = text => filename => filename.endsWith('config.toml') ? text : JSON.stringify({ OPENAI_API_KEY: 'test-key-never-live' });

test('only the selected Codex provider and verified HTTPS origin receive credentials', async () => {
  assert.equal(configuredProvider(config).base_url, 'https://www.blackaicoding.com/v1');
  for (const url of ['https://www.blackaicoding.com.evil.test/v1', 'http://www.blackaicoding.com/v1', 'https://evil:@www.blackaicoding.com/v1', 'https://www.blackaicoding.com:9999/v1']) {
    const source = new ProviderBalance({ readFile: files(config.replace('https://www.blackaicoding.com/v1', url)) });
    assert.equal(source.settings(), null);
  }
  let request;
  const source = new ProviderBalance({ readFile: files(config), fetchImpl: async (url, options) => {
    request = { url, options }; return { ok: true, text: async () => JSON.stringify({ balance: 23.456, email: 'private@example.test', api_key: 'secret', usage: { detail: 'private' } }) };
  } });
  const result = await source.read(source.settings());
  assert.equal(request.url, 'https://www.blackaicoding.com/v1/usage');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key-never-live');
  assert.match(balanceText({ ...result, updatedAt: 'now' }), /余额：\$23.46/);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(result).includes('test-key'), false);
});

test('wallet balance, API key quota and subscription quota remain distinct', () => {
  const quota = normalizeProviderBalance({ mode: 'quota_limited', quota: { remaining: 0 } });
  assert.equal(quota.provider.walletBalance, null);
  assert.equal(balanceText({ ...quota, updatedAt: 'now' }), 'API Key 额度：$0.00');
  const subscription = normalizeProviderBalance({ subscription: {}, remaining: 9.5 });
  assert.equal(balanceText({ ...subscription, updatedAt: 'now' }), '套餐剩余额度：$9.50');
  assert.throws(() => normalizeProviderBalance({ balance: null }), /unavailable/);
  assert.throws(() => normalizeProviderBalance({ balance: 'unknown' }), /unavailable/);
});

test('a provider timeout or auth failure preserves prior data without exposing response details', async () => {
  let clock = 1000, fail = false;
  const source = new ProviderBalance({ readFile: files(config), fetchImpl: async () => fail
    ? { ok: false, status: 401, text: async () => 'secret server response' }
    : { ok: true, text: async () => '{"balance":0}' } });
  const account = new AccountBalance({ now: () => clock, read: () => source.read(source.settings()) });
  await account.refresh();
  assert.match(balanceText(account.snapshot()), /余额：\$0.00/);
  fail = true; clock += 60001;
  await account.refresh();
  assert.match(balanceText(account.snapshot()), /更新失败/);
  assert.equal(account.snapshot().provider.walletBalance, 0);
  assert.equal(JSON.stringify(account.snapshot()).includes('secret'), false);
});
