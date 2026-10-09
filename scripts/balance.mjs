import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvironment } from '../config.mjs';
import { ProviderBalance } from '../provider-balance.mjs';
import { DesktopCatalog } from '../desktop-catalog.mjs';
import { normalizeBalance, balanceText } from '../public/account-balance.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))), env=loadEnvironment(root);
const catalog=new DesktopCatalog({executable:env.CODEX_BIN || undefined,environment:env});
try {
  const provider=new ProviderBalance({codexHome:env.CODEX_HOME || undefined,environment:env}), settings=provider.settings();
  let snapshot;
  if(settings) snapshot=await provider.read(settings);
  else {await catalog.connect();snapshot=normalizeBalance(await catalog.rpc('account/rateLimits/read',{}));}
  console.log(balanceText({...snapshot,updatedAt:new Date().toISOString()}));
} catch {console.error('Balance is unavailable for this configuration. Credentials and raw responses were not printed.');process.exitCode=1;}
finally {catalog.close();}
