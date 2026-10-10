import test from 'node:test';
import crypto from 'node:crypto';
import net from 'node:net';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = {CODEX_REMOTE_TOKEN:crypto.randomBytes(32).toString('hex'),CODEX_HOOK_TOKEN:crypto.randomBytes(32).toString('hex')};
const probe=net.createServer();
await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
const port=probe.address().port;
await new Promise(resolve=>probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-remote-test-'));
const testCodexHome=path.join(dataDir,'codex-home');
fs.mkdirSync(path.join(testCodexHome,'sessions'),{recursive:true});
const hooks = new Set();

async function until(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch {}
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error('Timed out waiting for condition');
}

function runHook(input, extraEnv={}) {
  const child = spawn(process.execPath, ['hook.mjs'], { cwd: root, env: { ...process.env, CODEX_HOME:testCodexHome, CODEX_REMOTE_PORT: String(port), CODEX_HOOK_TOKEN: config.CODEX_HOOK_TOKEN,...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  hooks.add(child); child.on('close',()=>hooks.delete(child));
  let output = '', error = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => error += chunk);
  child.stdin.end(JSON.stringify(input));
  const done=new Promise((resolve, reject) => child.on('close', code => code === 0 ? resolve({ output, error }) : reject(new Error(`Hook failed: ${error}`))));
  done.catch(()=>{}); // Cleanup can kill a Hook after an earlier assertion failure.
  return {child,done};
}

test('resumable approvals across lock, packet loss and reconnect; desktop decisions and terminal protection', async () => {
  const server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), CODEX_HOME:testCodexHome,MOBILE_PRESENCE_TTL_MS:'1000',CODEX_APPROVAL_POLL_MS:'200',CODEX_APPROVAL_TIMEOUT_MS:'15000',CODEX_HOOK_LEASE_MS:'5200', CODEX_REMOTE_DATA_DIR: dataDir, CODEX_REMOTE_TOKEN: config.CODEX_REMOTE_TOKEN, CODEX_HOOK_TOKEN: config.CODEX_HOOK_TOKEN }, stdio: ['ignore','ignore','pipe'], windowsHide: true });
  let serverErrors='', heartbeatTimer;
  server.stderr.on('data',chunk=>serverErrors+=chunk.toString());
  const streams=[];
  const streamReaders=[];
  const openStream=async(url,options)=>{
    const response=await fetch(url,options);assert.equal(response.status,200);
    const reader=response.body.getReader();streamReaders.push(reader);
    // A real browser drains SSE continuously; otherwise an unreferenced response can be GC'd.
    (async()=>{while(!(await reader.read()).done){}})().catch(()=>{});
  };
  try {
    try { await until(async () => (await fetch(base)).ok); }
    catch { throw new Error('Test server unavailable: '+serverErrors.slice(-2000)); }
    const login = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: config.CODEX_REMOTE_TOKEN,clientKind:'mobile' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const session = () => fetch(`${base}/api/session`, { headers: { cookie } }).then(response => response.json());
    const decide=(id,decision='approved',actor=cookie)=>fetch(`${base}/api/permission-requests/${id}/decision`,{method:'POST',headers:{cookie:actor,'Content-Type':'application/json'},body:JSON.stringify({decision})});
    const clientId='mobile-integration-test-0001';
    const pulse=()=>fetch(`${base}/api/presence`,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({clientId,active:true})});
    assert.equal((await pulse()).status,409); // Login alone is not online.
    const desktopLogin=await fetch(`${base}/api/session`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:config.CODEX_REMOTE_TOKEN,clientKind:'desktop'})});
    const desktopCookie=desktopLogin.headers.get('set-cookie').split(';')[0];
    const desktopAbort=new AbortController(); streams.push(desktopAbort);
    await openStream(`${base}/api/stream?clientId=desktop-integration-test-0001`,{headers:{cookie:desktopCookie},signal:desktopAbort.signal});
    assert.equal((await fetch(`${base}/api/presence`,{headers:{cookie}}).then(r=>r.json())).mobileOnline,false);
    const offlineHook=runHook({hook_event_name:'PermissionRequest',session_id:'thread-test',turn_id:'offline',tool_name:'Bash',tool_input:{command:'npm install'}});
    assert.equal((await offlineHook.done).output,''); // Native Codex approval remains in charge.
    assert.equal((await session()).pending.length,0);
    const offlineQuestion=runHook({hook_event_name:'PreToolUse',session_id:'thread-test',turn_id:'offline-question',tool_name:'request_user_input',tool_input:{questions:[{id:'choice',header:'选择',question:'如何继续？',options:[{label:'继续',description:'继续任务'},{label:'停止',description:'停止任务'}]}]}});
    assert.equal((await offlineQuestion.done).output,'');
    assert.equal((await session()).pending.length,0);
    // Away mode keeps NEW approvals on the phone even with no open mobile stream.
    const awayMode=enabled=>fetch(`${base}/api/remote-mode`,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({enabled})});
    assert.equal((await awayMode(true)).status,200);
    assert.equal((await fetch(`${base}/api/hooks/mobile-status`,{headers:{'X-Hook-Token':config.CODEX_HOOK_TOKEN}}).then(r=>r.json())).remoteEnabled,true);
    const awayHook=runHook({hook_event_name:'PermissionRequest',session_id:'thread-test',turn_id:'away-new',tool_name:'Bash',tool_input:{command:'example-away'}});
    const awayRequest=await until(async()=>(await session()).pending.find(r=>r.taskId==='away-new'&&r.ready));
    assert.equal(awayRequest.status,'parked');
    await new Promise(resolve=>setTimeout(resolve,1200));
    assert.equal(awayHook.child.exitCode,null);
    assert.equal((await decide(awayRequest.id,'approved')).status,200);
    assert.equal(JSON.parse((await awayHook.done).output).hookSpecificOutput.decision.behavior,'allow');
    assert.equal((await awayMode(false)).status,200);
    const mobileAbort=new AbortController(); streams.push(mobileAbort);
    await openStream(`${base}/api/stream?clientId=${clientId}`,{headers:{cookie},signal:mobileAbort.signal});
    assert.equal((await pulse()).status,200);
    heartbeatTimer=setInterval(()=>pulse().catch(()=>{}),150);

    await runHook({ hook_event_name: 'SessionStart', session_id: 'thread-test', cwd: root, source: 'startup' }).done;
    const history = await fetch(`${base}/api/events?after=0`, { headers: { cookie } }).then(response => response.json());
    assert.equal(history.at(-1).type, 'codex.SessionStart');

    const progressPlan=[{step:'检查实现',status:'completed'},{step:'修改与验证',status:'in_progress'}];
    await runHook({hook_event_name:'PostToolUse',session_id:'progress-thread',turn_id:'progress-turn',tool_name:'update_plan',tool_use_id:'plan-tool',tool_input:{plan:progressPlan},tool_response:'Plan updated'}).done;
    const progressHistory=await fetch(`${base}/api/events?after=${history.at(-1).id}`,{headers:{cookie}}).then(r=>r.json());
    assert.deepEqual(progressHistory.at(-1).meta.plan,progressPlan);
    assert.equal(progressHistory.at(-1).meta.toolUseId,'plan-tool');

    const allowHook = runHook({ hook_event_name: 'PermissionRequest', session_id: 'thread-test', turn_id: 'turn-allow', cwd: root, tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: C:\\Example\\CRC\\fixture.txt\n*** End Patch' } });
    const allowRequest = await until(async () => (await session()).pending.find(item => item.taskId === 'turn-allow' && item.ready));
    assert.deepEqual(allowRequest.files, ['C:\\Example\\CRC\\fixture.txt']);
    const allow = await fetch(`${base}/api/permission-requests/${allowRequest.id}/decision`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approved' }) });
    assert.equal(allow.status, 200);
    assert.equal(JSON.parse((await allowHook.done).output).hookSpecificOutput.decision.behavior, 'allow');

    const readHook = runHook({ hook_event_name:'PermissionRequest', session_id:'thread-test', turn_id:'turn-read', cwd:root, tool_name:'Bash', tool_input:{ command:"Get-ChildItem -LiteralPath 'C:\\Windows\\Temp' -File -Force -ErrorAction Stop | Select-Object -First 5 -ExpandProperty Name" } });
    const readRequest = await until(async () => (await session()).pending.find(item => item.taskId === 'turn-read' && item.ready));
    assert.equal(readRequest.filesKnown, false);
    assert.equal(readRequest.readOnly, true);
    assert.equal(readRequest.canApprove, true);
    assert.deepEqual(readRequest.readPaths, ['C:\\Windows\\Temp']);
    const readAllow = await fetch(`${base}/api/permission-requests/${readRequest.id}/decision`, { method:'POST', headers:{ cookie, 'Content-Type':'application/json' }, body:JSON.stringify({decision:'approved'}) });
    assert.equal(readAllow.status, 200);
    assert.equal(JSON.parse((await readHook.done).output).hookSpecificOutput.decision.behavior, 'allow');

    // Arbitrary commands are sent as fixture data only; the test never executes them.
    const unrestrictedHook = runHook({hook_event_name:'PermissionRequest',session_id:'thread-test',turn_id:'turn-unrestricted',cwd:root,tool_name:'Bash',tool_input:{command:'npm install'}});
    const unrestrictedRequest = await until(async()=>(await session()).pending.find(r=>r.taskId==='turn-unrestricted'&&r.ready));
    assert.equal(unrestrictedRequest.filesKnown,false);
    assert.equal(unrestrictedRequest.readOnly,false);
    assert.equal(unrestrictedRequest.canApprove,true);
    const unrestrictedApproval = await fetch(`${base}/api/permission-requests/${unrestrictedRequest.id}/decision`,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({decision:'approved'})});
    assert.equal(unrestrictedApproval.status,200);
    assert.equal(JSON.parse((await unrestrictedHook.done).output).hookSpecificOutput.decision.behavior,'allow');
    const duplicateApproval = await fetch(`${base}/api/permission-requests/${unrestrictedRequest.id}/decision`,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({decision:'approved'})});
    assert.equal(duplicateApproval.status,404);

    const genericHook = runHook({hook_event_name:'PermissionRequest',session_id:'another-thread',turn_id:'turn-generic',cwd:root,tool_name:'mcp__example__request',tool_input:{operation:'example-operation'}});
    const genericRequest = await until(async()=>(await session()).pending.find(r=>r.taskId==='turn-generic'&&r.ready));
    assert.equal(genericRequest.canApprove,true);
    assert.equal(genericRequest.command,'');
    const genericApproval = await fetch(`${base}/api/permission-requests/${genericRequest.id}/decision`,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({decision:'approved'})});
    assert.equal(genericApproval.status,200);
    assert.equal(JSON.parse((await genericHook.done).output).hookSpecificOutput.decision.behavior,'allow');

    const denyHook = runHook({ hook_event_name: 'PermissionRequest', session_id: 'thread-test', turn_id: 'turn-deny', cwd: root, tool_name: 'Bash', tool_input: { command: 'npm install' } });
    const denyRequest = await until(async () => (await session()).pending.find(item => item.taskId === 'turn-deny' && item.ready));
    assert.equal(denyRequest.filesKnown, false);
    const deny = await fetch(`${base}/api/permission-requests/${denyRequest.id}/decision`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'denied' }) });
    assert.equal(deny.status, 200);
    assert.equal(JSON.parse((await denyHook.done).output).hookSpecificOutput.decision.behavior, 'deny');
    const desktopHook = runHook({ hook_event_name:'PermissionRequest', session_id:'thread-test', turn_id:'turn-desktop', cwd:root, tool_name:'Bash', tool_input:{command:'npm install'} });
    const desktopRequest = await until(async () => (await session()).pending.find(item=>item.taskId==='turn-desktop' && item.ready));
    const desktop = await fetch(`${base}/api/permission-requests/${desktopRequest.id}/decision`, {method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({decision:'desktop'})});
    assert.equal(desktop.status,200);
    assert.equal((await desktopHook.done).output,'');
    assert.equal((await session()).pending.length, 0);
    const pausedHooks=['pause-one','pause-two'].map(turn_id=>runHook({hook_event_name:'PermissionRequest',session_id:turn_id,turn_id,tool_name:'Bash',tool_input:{command:'npm install'}}));
    const pausedRequests=await until(async()=>{const rows=(await session()).pending.filter(r=>r.taskId.startsWith('pause-')&&r.ready);return rows.length===2?rows:null;});
    clearInterval(heartbeatTimer);
    await fetch(`${base}/api/presence`,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({clientId,active:false})});
    await until(async()=>{const rows=(await session()).pending;return rows.length===2&&rows.every(r=>r.status==='parked');});
    for(const item of pausedHooks) assert.equal(item.child.exitCode,null);
    await new Promise(resolve=>setTimeout(resolve,500)); // Multiple long-poll responses do not finalize the request.
    const restored=await session();
    assert.equal(restored.clientKind,'mobile');
    assert.equal(restored.approvalMode,'resumable');
    assert.deepEqual(restored.pending.map(r=>r.id).sort(),pausedRequests.map(r=>r.id).sort());

    await pulse();
    heartbeatTimer=setInterval(()=>pulse().catch(()=>{}),150);
    assert.ok((await session()).pending.every(r=>r.status==='pending'));
    assert.equal((await decide(pausedRequests.find(r=>r.taskId==='pause-one').id,'approved')).status,200);
    assert.equal((await decide(pausedRequests.find(r=>r.taskId==='pause-two').id,'denied',desktopCookie)).status,200);
    assert.equal(JSON.parse((await pausedHooks[0].done).output).hookSpecificOutput.decision.behavior,'allow');
    assert.equal(JSON.parse((await pausedHooks[1].done).output).hookSpecificOutput.decision.behavior,'deny');
    assert.equal((await decide(pausedRequests[0].id)).status,404);
    const lostHook=runHook({hook_event_name:'PermissionRequest',session_id:'thread-test',turn_id:'packet-loss',tool_name:'Bash',tool_input:{command:'npm install'}});
    const lostRequest=await until(async()=>(await session()).pending.find(r=>r.taskId==='packet-loss'&&r.ready));
    clearInterval(heartbeatTimer); // Keep TCP stream open but stop heartbeats.
    await until(async()=>(await session()).pending.find(r=>r.id===lostRequest.id&&r.status==='parked'));
    assert.equal(lostHook.child.exitCode,null);

    await pulse();
    heartbeatTimer=setInterval(()=>pulse().catch(()=>{}),150);
    assert.equal((await decide(lostRequest.id)).status,200);
    assert.equal(JSON.parse((await lostHook.done).output).hookSpecificOutput.decision.behavior,'allow');
    const closeHook=runHook({hook_event_name:'PermissionRequest',session_id:'thread-test',turn_id:'stream-close',tool_name:'Bash',tool_input:{command:'npm install'}});
    const closeRequest=await until(async()=>(await session()).pending.find(r=>r.taskId==='stream-close'&&r.ready));
    clearInterval(heartbeatTimer); mobileAbort.abort();
    await until(async()=>(await session()).pending.find(r=>r.id===closeRequest.id&&r.status==='parked'));
    const reconnectedAbort=new AbortController(); streams.push(reconnectedAbort);
    await openStream(`${base}/api/stream?clientId=${clientId}`,{headers:{cookie},signal:reconnectedAbort.signal});
    await pulse(); heartbeatTimer=setInterval(()=>pulse().catch(()=>{}),150);
    assert.equal((await session()).pending.find(r=>r.id===closeRequest.id).status,'pending');
    assert.equal((await decide(closeRequest.id)).status,200);
    assert.equal(JSON.parse((await closeHook.done).output).hookSpecificOutput.decision.behavior,'allow');

    const cancelledHook=runHook({hook_event_name:'PermissionRequest',session_id:'cancel-thread',turn_id:'cancel-turn',tool_name:'Bash',tool_input:{command:'npm install'}});
    const cancelledRequest=await until(async()=>(await session()).pending.find(r=>r.taskId==='cancel-turn'&&r.ready));
    await runHook({hook_event_name:'Interrupt',session_id:'cancel-thread',turn_id:'cancel-turn'}).done;
    assert.equal((await cancelledHook.done).output,'');
    assert.equal((await decide(cancelledRequest.id)).status,404);

    const timeoutHook=runHook({hook_event_name:'PermissionRequest',session_id:'timeout-thread',turn_id:'timeout-turn',tool_name:'Bash',tool_input:{command:'npm install'}},{CODEX_APPROVAL_TIMEOUT_MS:'1000'});
    const timeoutRequest=await until(async()=>(await session()).pending.find(r=>r.taskId==='timeout-turn'&&r.ready));
    assert.equal((await timeoutHook.done).output,'');
    assert.equal((await decide(timeoutRequest.id)).status,404);

    const raceHook=runHook({hook_event_name:'PermissionRequest',session_id:'race-thread',turn_id:'race-turn',tool_name:'Bash',tool_input:{command:'example'}});
    const raceRequest=await until(async()=>(await session()).pending.find(r=>r.taskId==='race-turn'&&r.ready));
    const raceResults=await Promise.all([decide(raceRequest.id,'approved'),decide(raceRequest.id,'denied',desktopCookie)]);
    assert.deepEqual(raceResults.map(r=>r.status).sort(),[200,404]);
    assert.equal(JSON.parse((await raceHook.done).output).hookSpecificOutput.decision.behavior,raceResults[0].status===200?'allow':'deny');

    const lostCallback=runHook({hook_event_name:'PermissionRequest',session_id:'lost-callback-thread',turn_id:'lost-callback-turn',tool_name:'Bash',tool_input:{command:'example'}});
    const lostCallbackRequest=await until(async()=>(await session()).pending.find(r=>r.taskId==='lost-callback-turn'&&r.ready));
    const killed=lostCallback.done.catch(()=>{}); lostCallback.child.kill(); await killed;
    await until(async()=>(await session()).pending.every(r=>r.id!==lostCallbackRequest.id),8000);
    assert.equal((await decide(lostCallbackRequest.id)).status,404);
    assert.equal((await session()).pending.length,0);
    const healthFile=path.join(testCodexHome,'sessions','health.jsonl');
    fs.writeFileSync(healthFile,'');
    const failedHook=runHook({hook_event_name:'PermissionRequest',session_id:'health-thread',turn_id:'health-turn',transcript_path:healthFile,tool_name:'Bash',tool_input:{command:'fixture-only'}});
    const failedRequest=await until(async()=>(await session()).pending.find(r=>r.taskId==='health-turn'&&r.ready));
    const unaffectedHook=runHook({hook_event_name:'PermissionRequest',session_id:'unaffected-thread',turn_id:'unaffected-turn',tool_name:'Bash',tool_input:{command:'fixture-only'}});
    const unaffectedRequest=await until(async()=>(await session()).pending.find(r=>r.taskId==='unaffected-turn'&&r.ready));
    const appendRecord=(type,turn_id,extra={})=>fs.appendFileSync(healthFile,JSON.stringify({timestamp:new Date().toISOString(),type:'event_msg',payload:{type,turn_id,...extra}})+'\n');
    appendRecord('error','health-turn',{error:{message:'insufficient_quota',codexErrorInfo:'UsageLimitExceeded'}});
    await until(async()=>(await session()).pending.every(r=>r.id!==failedRequest.id));
    assert.equal((await failedHook.done).output,'');
    assert.equal((await decide(failedRequest.id)).status,404);
    assert.ok((await session()).pending.some(r=>r.id===unaffectedRequest.id));
    const healthHistory=await fetch(`${base}/api/events`,{headers:{cookie}}).then(r=>r.json());
    const failedEvent=healthHistory.find(e=>e.type==='codex.Failed'&&e.conversationId==='health-thread');
    assert.ok(failedEvent);assert.equal(failedEvent.meta.errorCategory,'quota');
    assert.equal((await decide(unaffectedRequest.id)).status,200);
    assert.equal(JSON.parse((await unaffectedHook.done).output).hookSpecificOutput.decision.behavior,'allow');
    await runHook({hook_event_name:'UserPromptSubmit',session_id:'health-thread',turn_id:'health-next-turn',transcript_path:healthFile,prompt:'fixture new turn'}).done;
    appendRecord('stream_error','health-next-turn',{message:'stream disconnected HTTP 503'});
    const healthEvent=type=>fetch(`${base}/api/events`,{headers:{cookie}}).then(r=>r.json()).then(rows=>rows.find(e=>e.type===type&&e.taskId==='health-next-turn'));
    assert.equal((await until(()=>healthEvent('codex.Retrying'))).meta.errorCategory,'network');
    appendRecord('item_completed','health-next-turn');
    await until(()=>healthEvent('codex.Activity'));
    appendRecord('task_complete','health-next-turn');
    await until(()=>healthEvent('codex.Stop'));
    assert.equal((await session()).pending.length,0);
    const answer=(id,answers)=>fetch(`${base}/api/question-requests/${id}/answer`,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({answers})});
    const questionInput={hook_event_name:'PreToolUse',session_id:'question-thread',turn_id:'question-turn',tool_name:'functions.request_user_input',tool_input:{questions:[{id:'method',header:'方式',question:'选择方式',options:[{label:'甲',description:'甲说明'},{label:'乙',description:'乙说明'}]},{id:'details',question:'补充说明'}]}};
    const questionHook=runHook(questionInput);
    const questionRequest=await until(async()=>(await session()).pending.find(r=>r.taskId==='question-turn'&&r.ready));
    assert.equal(questionRequest.kind,'question');
    assert.equal((await decide(questionRequest.id,'approved')).status,400);
    assert.equal((await answer(questionRequest.id,{method:{text:'缺少一题'}})).status,400);
    const answerMarker='private-answer-fixture-never-log';
    const answers={method:{optionId:'option-2',text:answerMarker},details:{text:'另一个回答'}};
    clearInterval(heartbeatTimer);
    await fetch(`${base}/api/presence`,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({clientId,active:false})});
    assert.equal((await session()).pending.find(r=>r.id===questionRequest.id).status,'parked');
    assert.equal((await pulse()).status,200);
    heartbeatTimer=setInterval(()=>pulse().catch(()=>{}),150);
    await until(async()=>(await session()).pending.find(r=>r.id===questionRequest.id)?.status==='pending');
    const stopHook=runHook({hook_event_name:'Stop',session_id:'stop-question-thread',turn_id:'stop-question-turn',last_assistant_message:'你希望使用哪种方式？'});
    const stopRequest=await until(async()=>(await session()).pending.find(r=>r.taskId==='stop-question-turn'&&r.ready));
    const raceAnswers=await Promise.all([answer(questionRequest.id,answers),answer(questionRequest.id,answers)]);
    assert.deepEqual(raceAnswers.map(r=>r.status).sort(),[200,404]);
    assert.ok((await session()).pending.some(r=>r.id===stopRequest.id));
    const questionOutput=JSON.parse((await questionHook.done).output).hookSpecificOutput;
    assert.equal(questionOutput.hookEventName,'PreToolUse');
    assert.equal(questionOutput.permissionDecision,'deny');
    assert.ok(questionOutput.permissionDecisionReason.includes(answerMarker));
    assert.ok(questionOutput.permissionDecisionReason.includes('"choice": "乙"'));
    assert.equal((await answer(stopRequest.id,{reply:{text:'使用第一种方式'}})).status,200);
    const stopOutput=JSON.parse((await stopHook.done).output);
    assert.equal(stopOutput.decision,'block');
    assert.ok(stopOutput.reason.includes('使用第一种方式'));
    assert.ok(!fs.readFileSync(path.join(dataDir,'events.ndjson'),'utf8').includes(answerMarker));
    const questionHistory=await fetch(`${base}/api/events`,{headers:{cookie}}).then(r=>r.json());
    assert.ok(questionHistory.some(e=>e.type==='question.answered'));
    assert.ok(!JSON.stringify(questionHistory).includes(answerMarker));
    const prior=await fetch(`${base}/api/permission-requests/${questionRequest.id}`,{headers:{cookie}}).then(r=>r.json());
    assert.equal(prior.answers,undefined);
    const loopGuard=await runHook({hook_event_name:'Stop',session_id:'stop-question-thread',turn_id:'stop-question-turn',last_assistant_message:'你希望使用哪种方式？',stop_hook_active:true}).done;
    assert.equal(loopGuard.output,'');
    const handoffHook=runHook({...questionInput,turn_id:'question-native'});
    const handoffRequest=await until(async()=>(await session()).pending.find(r=>r.taskId==='question-native'&&r.ready));
    assert.equal((await decide(handoffRequest.id,'desktop')).status,200);
    assert.equal((await handoffHook.done).output,'');
    assert.equal((await answer(handoffRequest.id,answers)).status,404);
    const interruptHook=runHook({...questionInput,turn_id:'question-interrupt'});
    const interruptRequest=await until(async()=>(await session()).pending.find(r=>r.taskId==='question-interrupt'&&r.ready));
    await runHook({hook_event_name:'Interrupt',session_id:'question-thread',turn_id:'question-interrupt'}).done;
    assert.equal((await interruptHook.done).output,'');
    assert.equal((await answer(interruptRequest.id,answers)).status,404);
    const timeoutQuestion=runHook({...questionInput,turn_id:'question-timeout'},{CODEX_APPROVAL_TIMEOUT_MS:'1000'});
    const timeoutQuestionRequest=await until(async()=>(await session()).pending.find(r=>r.taskId==='question-timeout'&&r.ready));
    assert.equal((await timeoutQuestion.done).output,'');
    assert.equal((await answer(timeoutQuestionRequest.id,answers)).status,404);
    const nativeEscape=runHook({...questionInput,turn_id:'question-native-escaped',tool_use_id:'escaped-question-call'});
    const nativeEscapeRequest=await until(async()=>(await session()).pending.find(r=>r.taskId==='question-native-escaped'&&r.ready));
    assert.equal(nativeEscapeRequest.toolUseId,'escaped-question-call');
    await runHook({hook_event_name:'PostToolUse',session_id:'question-thread',turn_id:'question-native-escaped',tool_name:questionInput.tool_name,tool_use_id:'unrelated-question-call'}).done;
    assert.ok((await session()).pending.some(r=>r.id===nativeEscapeRequest.id));
    await runHook({hook_event_name:'PostToolUse',session_id:'question-thread',turn_id:'question-native-escaped',tool_name:questionInput.tool_name,tool_use_id:'escaped-question-call'}).done;
    assert.equal((await nativeEscape.done).output,'');
    assert.equal((await answer(nativeEscapeRequest.id,answers)).status,404);
    const escapedStatus=await fetch(`${base}/api/permission-requests/${nativeEscapeRequest.id}`,{headers:{cookie}}).then(r=>r.json());
    assert.equal(escapedStatus.status,'desktop');
    assert.equal((await session()).pending.length,0);
  } finally {
    clearInterval(heartbeatTimer);
    for(const controller of streams) controller.abort();
    for(const child of hooks) child.kill();
    server.kill();
    assert.equal(path.dirname(dataDir),os.tmpdir());
    assert.ok(path.basename(dataDir).startsWith('codex-remote-test-'));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
