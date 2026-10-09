import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serverConfig } from '../config.mjs';
try {
  const config=serverConfig(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  console.log('Phone access token (private; do not share screenshots):');
  console.log(config.accessToken);
} catch(error) { console.error(error.message); process.exitCode=1; }
