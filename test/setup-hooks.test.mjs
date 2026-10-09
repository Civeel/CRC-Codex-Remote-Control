import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../scripts/setup.mjs';
import { manageHooks, updateHooks, hookCommand } from '../scripts/hooks.mjs';

function temporary() {return fs.mkdtempSync(path.join(os.tmpdir(),'crc-release-test-'));}
function cleanup(folder) {
  assert.equal(path.dirname(folder),os.tmpdir());
  assert.ok(path.basename(folder).startsWith('crc-release-test-'));
  fs.rmSync(folder,{recursive:true,force:true});
}

test('setup generates independent secrets once and preserves existing configuration',()=>{
  const root=temporary();
  try {
    assert.equal(setup(root).created,true);
    const first=fs.readFileSync(path.join(root,'.env'),'utf8');
    const secrets=[...first.matchAll(/(?:CODEX_REMOTE_TOKEN|CODEX_HOOK_TOKEN)=([a-f0-9]{64})/g)].map(match=>match[1]);
    assert.equal(secrets.length,2);assert.notEqual(secrets[0],secrets[1]);
    assert.equal(setup(root).created,false);
    assert.equal(fs.readFileSync(path.join(root,'.env'),'utf8'),first);
  } finally {cleanup(root);}
});

test('Hook install is idempotent and uninstall preserves unrelated groups',()=>{
  const root=path.join(os.tmpdir(),'CRC Example');
  const other={type:'command',command:'node other-hook.mjs',timeout:5};
  const original={description:'Existing user settings',hooks:{PreToolUse:[{matcher:'Bash',hooks:[other]}],OtherEvent:[{hooks:[other]}]}};
  const installed=updateHooks(original,root,'install');
  assert.deepEqual(updateHooks(installed,root,'install'),installed);
  assert.equal(installed.hooks.PermissionRequest[0].hooks[0].timeout,86460);
  assert.equal(installed.hooks.PreToolUse.at(-1).hooks[0].timeout,86460);
  assert.equal(installed.hooks.Stop[0].hooks[0].timeout,86460);
  assert.equal(installed.hooks.Interrupt[0].hooks[0].timeout,3);
  assert.deepEqual(updateHooks(installed,root,'uninstall'),original);
  assert.ok(hookCommand(root).includes('CRC Example'));
});

test('Hook file management backs up exact existing data and never touches the actual profile',()=>{
  const temp=temporary();
  const root=path.join(temp,'CRC Source');
  const home=path.join(temp,'synthetic-codex-home');
  try {
    fs.mkdirSync(home);
    const initial='{ "description": "synthetic", "hooks": {} }\n';
    fs.writeFileSync(path.join(home,'hooks.json'),initial);
    const result=manageHooks(root,home,'install');
    assert.equal(result.changed,true);
    assert.equal(fs.readFileSync(result.backup,'utf8'),initial);
    assert.equal(manageHooks(root,home,'install').changed,false);
    manageHooks(root,home,'uninstall');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home,'hooks.json'),'utf8')),JSON.parse(initial));
    fs.writeFileSync(path.join(home,'hooks.json'),'{invalid');
    assert.throws(()=>manageHooks(root,home,'install'));
    assert.equal(fs.readFileSync(path.join(home,'hooks.json'),'utf8'),'{invalid');
  } finally {cleanup(temp);}
});
