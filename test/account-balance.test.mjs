import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBalance, balanceText } from '../public/account-balance.mjs';
import { AccountBalance } from '../account-balance.mjs';

test('balances preserve real zero and unknown values without exposing account fields', () => {
  const result = normalizeBalance({ email: 'private@example.test', rateLimits: { credits: { balance: '0', hasCredits: false }, primary: { usedPercent: 25, windowDurationMins: 300 }, secondary: { usedPercent: 105, windowDurationMins: 10080 } } });
  assert.equal(result.credits.balance, '0');
  assert.deepEqual(result.windows.map(w => w.remainingPercent), [75, 0]);
  const text = balanceText({ ...result, updatedAt: '2026-10-09T00:00:00Z' });
  assert.match(text, /余额：0 积分/);
  assert.match(text, /每周额度剩余 0%/);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(normalizeBalance({ rateLimits: { credits: { balance: '' } } }).credits.balance, null);
  assert.match(balanceText({ ...normalizeBalance({}), updatedAt: 'now' }), /账号未提供/);
  assert.equal(normalizeBalance({ rateLimits: { primary: { usedPercent: null } } }).windows.length, 0);
  assert.equal(normalizeBalance({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 20 } } }, rateLimits: { primary: { usedPercent: 90 } } }).windows[0].remainingPercent, 80);
});

test('reads deduplicate, cache and keep previous balance when upstream fails', async () => {
  let calls = 0, clock = 1000, fail = false;
  const account = new AccountBalance({ now: () => clock, read: async () => {
    calls++; if (fail) throw Error('secret upstream diagnostic');
    return { rateLimits: { credits: { balance: '10' } } };
  } });
  assert.equal(account.snapshot().loading, true);
  account.snapshot();
  await account.refresh();
  assert.equal(calls, 1);
  assert.equal(account.snapshot().credits.balance, '10');
  clock += 60001; fail = true;
  account.snapshot(); await account.refresh();
  assert.equal(calls, 2);
  assert.equal(account.snapshot().credits.balance, '10');
  assert.match(balanceText(account.snapshot()), /显示上次数据/);
  assert.equal(JSON.stringify(account.snapshot()).includes('secret'), false);
});
