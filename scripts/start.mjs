import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { serverConfig } from '../config.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
try {
  const config=serverConfig(root);
  let existing=null;
  try {const r=await fetch(`http://127.0.0.1:${config.port}/api/health`,{signal:AbortSignal.timeout(2000)});if(r.ok)existing=await r.json();} catch {}
  if(existing?.app==='crc-codex-remote-control') console.log(`CRC is already running on http://127.0.0.1:${config.port}/`);
  else {
    const child=spawn(process.execPath,['server.js'],{cwd:root,stdio:'inherit',windowsHide:true});
    child.on('error',()=>{console.error('Unable to start CRC.');process.exitCode=1;});
    child.on('exit',code=>{process.exitCode=code || 0;});
    process.on('SIGINT',()=>child.kill('SIGINT'));
    process.on('SIGTERM',()=>child.kill('SIGTERM'));
  }
} catch(error) {console.error(error.message);process.exitCode=1;}
