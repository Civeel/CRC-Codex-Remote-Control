import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serverConfig } from '../config.mjs';
import { DesktopCatalog } from '../desktop-catalog.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
console.log(`Node ${process.version}; platform ${process.platform}`);
let config;
try {config=serverConfig(root);console.log('Local configuration: valid (tokens hidden)');} catch(error){console.log(`Local configuration: ${error.message}`);process.exitCode=1;}
const catalog=new DesktopCatalog({executable:config?.codexBin});
try {catalog.findExecutable();console.log('Codex executable: found');} catch {console.log('Codex executable: not found. Set CODEX_BIN to codex.exe in .env.');process.exitCode=1;}
if(config) {
  try {const response=await fetch(`http://127.0.0.1:${config.port}/api/health`,{signal:AbortSignal.timeout(2000)});const health=await response.json();console.log(health.app==='crc-codex-remote-control'?'Panel service: available':'Panel service: another application is using this port');}
  catch {console.log('Panel service: unavailable. Start it with npm start.');}
}
console.log(fs.existsSync(path.join(root,'.env'))?'Local .env: present and private':'Local .env: absent (environment variables may be in use)');
console.log('For the private HTTPS address, run: tailscale serve status');
console.log('Do not post tokens, conversations or raw network reports in GitHub issues.');
