import fs from 'node:fs';
import path from 'node:path';

export function loadEnvironment(root) {
  const local={};
  const filename=path.join(root,'.env');
  if(fs.existsSync(filename)) {
    for(const line of fs.readFileSync(filename,'utf8').split(/\r?\n/)) {
      const match=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if(match) local[match[1]]=match[2].replace(/^(['"])(.*)\1$/,'$2');
    }
  }
  return {...local,...process.env};
}

export function serverConfig(root) {
  const env=loadEnvironment(root);
  const port=Number(env.PORT || 8788);
  if(!Number.isInteger(port) || port<1 || port>65535) throw Error('PORT must be an integer between 1 and 65535.');
  for(const key of ['CODEX_REMOTE_TOKEN','CODEX_HOOK_TOKEN']) {
    if(!env[key] || env[key].length<32 || env[key].includes('REPLACE_')) throw Error(`${key} is missing or too short. Run npm run setup.`);
  }
  if(env.CODEX_REMOTE_TOKEN===env.CODEX_HOOK_TOKEN) throw Error('The access token and Hook token must be different.');
  return {env,port,accessToken:env.CODEX_REMOTE_TOKEN,hookToken:env.CODEX_HOOK_TOKEN,dataDir:path.resolve(root,env.CODEX_REMOTE_DATA_DIR || 'data'),codexBin:env.CODEX_BIN || undefined,presenceTtl:Number(env.MOBILE_PRESENCE_TTL_MS || 7000)};
}
