const finite = value => typeof value === 'number' && Number.isFinite(value);

export function normalizeBalance(result) {
  const bucket = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  if (!bucket) return { credits: null, windows: [] };
  const raw = bucket.credits;
  const balance = typeof raw?.balance === 'string' || finite(raw?.balance) ? String(raw.balance).trim() : '';
  const credits = raw ? {
    unlimited: raw.unlimited === true,
    balance: /^\d+(?:\.\d+)?$/.test(balance) ? balance : null,
    hasCredits: typeof raw.hasCredits === 'boolean' ? raw.hasCredits : null
  } : null;
  const windows = ['primary', 'secondary'].flatMap(key => {
    const window = bucket[key];
    if (!finite(window?.usedPercent)) return [];
    return [{ remainingPercent: Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)) * 10) / 10,
      durationMins: finite(window.windowDurationMins) && window.windowDurationMins > 0 ? window.windowDurationMins : null,
      resetsAt: finite(window.resetsAt) && window.resetsAt > 0 ? window.resetsAt : null }];
  });
  return { credits, windows };
}

export function balanceText(snapshot) {
  if (!snapshot?.updatedAt) return snapshot?.error ? '余额：暂时无法读取' : '余额：读取中…';
  if (snapshot.provider) {
    const provider = snapshot.provider, lines = [];
    const money = value => '$' + value.toFixed(2);
    if (provider.walletBalance !== null) lines.push(`余额：${money(provider.walletBalance)}`);
    if (provider.keyRemaining !== null) lines.push(`API Key 额度：${money(provider.keyRemaining)}`);
    if (provider.subscriptionRemaining !== null) lines.push(`套餐剩余额度：${money(provider.subscriptionRemaining)}`);
    if (snapshot.error) lines.push('更新失败，显示上次数据');
    return lines.join('\n');
  }
  const { credits, windows = [] } = snapshot;
  const lines = [credits?.unlimited ? '余额：不限量' : credits?.balance !== null && credits?.balance !== undefined
    ? `余额：${credits.balance} 积分` : credits?.hasCredits === false ? '余额：无可用积分' : '余额：账号未提供'];
  for (const window of windows) {
    const mins = window.durationMins;
    const name = mins === 10080 ? '每周额度' : mins && mins % 1440 === 0 ? `${mins / 1440} 天额度`
      : mins && mins % 60 === 0 ? `${mins / 60} 小时额度` : mins ? `${mins} 分钟额度` : '使用额度';
    lines.push(`${name}剩余 ${window.remainingPercent}%`);
  }
  if (snapshot.error) lines.push('更新失败，显示上次数据');
  return lines.join('\n');
}
