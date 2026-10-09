import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { serverConfig } from '../config.mjs';

export function setup(root) {
  const filename=path.join(root,'.env');
  if(fs.existsSync(filename)) return {created:false,filename};
  const content=`# Local secrets. Never commit this file.\nPORT=8788\nCODEX_REMOTE_TOKEN=${crypto.randomBytes(32).toString('hex')}\nCODEX_HOOK_TOKEN=${crypto.randomBytes(32).toString('hex')}\nMOBILE_PRESENCE_TTL_MS=7000\nCODEX_BIN=\n`;
  fs.writeFileSync(filename,content,{flag:'wx',mode:0o600});
  return {created:true,filename};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  try {
    const result=setup(root); serverConfig(root);
    console.log(result.created ? 'Local configuration created with independent random tokens.' : 'Existing configuration preserved.');
    console.log('Next: npm run hooks:install, then trust the Hook in Codex.');
    console.log('Use npm run token to view the phone access token locally.');
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
