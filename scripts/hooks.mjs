import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const events=['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Stop','Interrupt','SessionEnd'];
export function hookCommand(root) {
  const hookPath=path.join(root,'hook.mjs');
  if(/["%!\r\n]/.test(hookPath)) throw Error('Move CRC to a folder without quotes, %, ! or line breaks before installing Hooks.');
  return `node "${hookPath}"`;
}
export function updateHooks(config,root,mode) {
  if(!config || typeof config!=='object' || Array.isArray(config)) throw Error('Existing hooks.json is not an object.');
  const result=structuredClone(config);
  if(result.hooks!==undefined && (!result.hooks || typeof result.hooks!=='object' || Array.isArray(result.hooks))) throw Error('Existing hooks section is invalid.');
  result.hooks ||= {};
  const command=hookCommand(root);
  for(const name of events) {
    const groups=result.hooks[name] || [];
    if(!Array.isArray(groups)) throw Error(`Invalid Hook event: ${name}`);
    result.hooks[name]=groups.map(group=>{
      if(!group || !Array.isArray(group.hooks)) throw Error(`Invalid Hook group: ${name}`);
      return {...group,hooks:group.hooks.filter(hook=>hook.command!==command)};
    }).filter(group=>group.hooks.length);
    if(mode==='install') result.hooks[name].push({hooks:[{type:'command',command,timeout:['PermissionRequest','PreToolUse','Stop'].includes(name)?86460:['Interrupt','SessionEnd'].includes(name)?3:5,...(['PermissionRequest','PreToolUse','Stop'].includes(name)?{statusMessage:'等待 CRC 手机授权或提问回答'}:{})}]});
    if(!result.hooks[name].length) delete result.hooks[name];
  }
  return result;
}
export function manageHooks(root,codexHome,mode) {
  if(!['install','uninstall'].includes(mode)) throw Error('Usage: hooks.mjs install|uninstall [--codex-home PATH]');
  const filename=path.join(path.resolve(codexHome),'hooks.json');
  const existing=fs.existsSync(filename)?fs.readFileSync(filename,'utf8'):null;
  if(existing===null && mode==='uninstall') return {changed:false};
  const config=existing===null?{}:JSON.parse(existing.replace(/^\uFEFF/,''));
  const next=JSON.stringify(updateHooks(config,root,mode),null,2)+'\n';
  if(existing!==null && JSON.stringify(config)===JSON.stringify(JSON.parse(next))) return {changed:false};
  fs.mkdirSync(path.dirname(filename),{recursive:true});
  let backup=null;
  if(existing!==null) {
    backup=filename+`.crc-backup-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(backup,existing,{flag:'wx',mode:0o600});
  }
  const temporary=filename+`.crc-${crypto.randomBytes(8).toString('hex')}.tmp`;
  fs.writeFileSync(temporary,next,{flag:'wx',mode:0o600});
  fs.renameSync(temporary,filename);
  return {changed:true,filename,backup};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const homeOption=process.argv.indexOf('--codex-home');
    const codexHome=homeOption>=0?process.argv[homeOption+1]:process.env.CODEX_HOME || path.join(os.homedir(),'.codex');
    if(!codexHome) throw Error('--codex-home requires a directory.');
    const result=manageHooks(root,codexHome,process.argv[2]);
    console.log(result.changed?'CRC Hook configuration updated. Existing unrelated Hooks preserved.':'CRC Hook configuration is already up to date.');
    if(result.backup) console.log('A local backup of the previous Hook configuration was created.');
    if(process.argv[2]==='install') console.log('Open /hooks in Codex and trust the new configuration. Restart Codex if it has not reloaded Hooks.');
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
