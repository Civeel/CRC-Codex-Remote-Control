import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {TaskHealth,LocalTaskRecords,taskRecord,taskLog,failureInfo} from '../task-health.mjs';
import {reduceProgress,progressView} from '../public/progress.mjs';

const record=(type,turn_id,at=110000,extra={})=>({timestamp:new Date(at).toISOString(),type:'event_msg',payload:{type,turn_id,...extra}});
const begin=(conversationId='one',taskId='turn-one',at=100000)=>({type:'codex.UserPromptSubmit',conversationId,taskId,ts:new Date(at).toISOString(),meta:{cwd:'fixture'}});
function tempFixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'crc-health-test-'));
  t.after(()=>{assert.equal(path.dirname(dir),os.tmpdir());assert.ok(path.basename(dir).startsWith('crc-health-test-'));fs.rmSync(dir,{recursive:true,force:true});});
  return dir;
}

test('failure categories, retry logs and lifecycle records do not use arbitrary tool text',()=>{
  assert.equal(failureInfo({message:'limit reached',codexErrorInfo:'UsageLimitExceeded'}).category,'quota');
  assert.equal(failureInfo('insufficient_quota').category,'quota');
  assert.equal(failureInfo('HTTP 429 Too many requests').category,'rate_limit');
  assert.equal(failureInfo('stream disconnected HTTP 503').category,'network');
  assert.equal(failureInfo('HTTP 401 Unauthorized').category,'auth');
  assert.equal(failureInfo({codexErrorInfo:'ContextWindowExceeded'}).category,'context');
  const secret=failureInfo('connection failed https://host.invalid/?token=private-secret Bearer private-bearer sk-privatekey');
  assert.ok(!secret.detail.includes('private-secret'));
  assert.ok(!secret.detail.includes('private-bearer'));
  assert.ok(!secret.detail.includes('sk-privatekey'));
  assert.equal(taskRecord(record('task_failed','one',110000,{error:{message:'额度不足'}})).state,'failed');
  assert.equal(taskRecord(record('error','one',110000,{message:'network failure',will_retry:true})).state,'retrying');
  assert.equal(taskRecord(record('turn_aborted','one')).state,'interrupted');
  assert.equal(taskRecord({type:'response_item',payload:{type:'function_call_output',output:'余额不足 error'}}),null);
  assert.equal(taskRecord(record('agent_message','one',110000,{message:'假设余额不足'})).state,'running');
  const row={ts:110,ts_nanos:123000000,target:'codex_core::responses_retry',feedback_log_body:'stream disconnected, retrying: HTTP 503 token=private-body'};
  assert.equal(taskLog(row,'one',100000).state,'retrying');
  assert.ok(!taskLog(row,'one',100000).detail.includes('private-body'));
  assert.equal(taskLog({...row,target:'codex_core::shell_snapshot'},'one',100000),null);
  assert.equal(taskLog({...row,feedback_log_body:'retrying turn_id=another'},'one',100000),null);
  assert.equal(taskLog(row,'one',120000),null);
});

test('partial transcript writes, recovery, failure and different turns preserve honest progress',t=>{
  const dir=tempFixture(t),file=path.join(dir,'record.jsonl'),events=[];
  let now=100000;
  fs.writeFileSync(file,JSON.stringify(record('task_started','turn-one',100000))+'\n');
  const health=new TaskHealth({emit:e=>events.push(e),now:()=>now,staleMs:1000,records:{transcript:()=>file,logs:()=>[],close(){}}});
  health.observe(begin());health.tick();
  now=102000;health.tick();
  assert.equal(events.at(-1).type,'codex.StatusUncertain');
  assert.equal(events.length,1);health.tick();assert.equal(events.length,1);
  const activity=JSON.stringify(record('item_completed','turn-one',103000));
  fs.appendFileSync(file,activity.slice(0,50));now=103000;health.tick();
  assert.equal(events.length,1);
  fs.appendFileSync(file,activity.slice(50)+'\n');health.tick();
  assert.equal(events.at(-1).type,'codex.Activity');
  const failure=record('error','turn-one',104000,{error:{message:'Insufficient balance',codexErrorInfo:'UsageLimitExceeded'}});
  fs.appendFileSync(file,JSON.stringify(failure)+'\n');now=104000;health.tick();
  assert.equal(events.at(-1).type,'codex.Failed');
  let p=reduceProgress(null,begin());
  p=reduceProgress(p,{type:'codex.PostToolUse',taskId:'turn-one',meta:{plan:[{step:'第一步',status:'completed'},{step:'第二步',status:'pending'}]}});
  p=reduceProgress(p,events.at(-1));
  assert.equal(p.state,'failed');assert.equal(progressView(p).paused,true);assert.equal(progressView(p).percent,50);
  assert.equal(reduceProgress(p,{type:'codex.Stop',taskId:'turn-one'}),p);
  assert.equal(reduceProgress(p,{type:'codex.PostToolUse',taskId:'turn-one'}),p);
  assert.equal(reduceProgress(p,{type:'permission.approved',taskId:'turn-one'}),p);
  fs.appendFileSync(file,JSON.stringify(record('task_complete','turn-one',105000))+'\n');now=105000;health.tick();
  assert.equal(events.at(-1).type,'codex.Failed');
  health.observe(begin('one','turn-two',106000));
  fs.appendFileSync(file,JSON.stringify(record('error','turn-one',107000,{message:'old failure'}))+'\n'+JSON.stringify(record('task_complete','turn-two',108000))+'\n');
  now=108000;health.tick();assert.equal(events.at(-1).type,'codex.Stop');assert.equal(events.at(-1).taskId,'turn-two');
  p=reduceProgress(p,begin('one','turn-two',106000));assert.equal(p.state,'running');assert.equal(p.failure,null);
});

test('retry pauses immediately, new activity resumes, waiting requests and long tools are not killed',()=>{
  let now=100000,waiting=false,rows=[],events=[];
  const health=new TaskHealth({emit:e=>events.push(e),now:()=>now,staleMs:1000,isWaiting:()=>waiting,records:{transcript:()=>null,logs:()=>rows,close(){}}});
  health.observe(begin());
  rows=[{id:1,ts:101,ts_nanos:0,target:'codex_core::responses_retry',feedback_log_body:'stream disconnected, retrying insufficient_quota'}];
  now=101000;health.tick();assert.equal(events.at(-1).type,'codex.Retrying');
  const retry=reduceProgress(reduceProgress(null,begin()),events.at(-1));assert.equal(progressView(retry).paused,true);assert.equal(progressView(retry).percent,null);
  rows=[];now=102500;health.tick();assert.equal(events.at(-1).type,'codex.StatusUncertain');
  const uncertain=reduceProgress(retry,events.at(-1));assert.equal(progressView(uncertain).paused,true);assert.ok(uncertain.failure);
  health.accept(health.tasks.get('one'),{state:'running',taskId:'turn-one',at:103000});
  assert.equal(events.at(-1).type,'codex.Activity');assert.equal(reduceProgress(uncertain,events.at(-1)).failure,null);
  health.observe(begin('two','turn-other',103000));waiting=true;now=110000;const count=events.length;health.tick();assert.equal(events.length,count);
  waiting=false;health.tick();assert.ok(events.slice(count).every(e=>e.type==='codex.StatusUncertain'));
  assert.ok(!events.some(e=>e.type==='codex.Failed'));
});

test('read-only database lookup bounds transcript paths and associates retry rows with one conversation',t=>{
  const home=tempFixture(t),sessions=path.join(home,'sessions');fs.mkdirSync(sessions);
  const file=path.join(sessions,'one.jsonl');fs.writeFileSync(file,'');
  const outside=path.join(home,'outside.jsonl');fs.writeFileSync(outside,'');
  const state=new DatabaseSync(path.join(home,'state_5.sqlite'));
  state.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT)');state.prepare('INSERT INTO threads VALUES (?,?)').run('one',file);state.close();
  const logs=new DatabaseSync(path.join(home,'logs_2.sqlite'));
  logs.exec('CREATE TABLE logs (id INTEGER, ts INTEGER, ts_nanos INTEGER, thread_id TEXT, level TEXT, target TEXT, feedback_log_body TEXT)');
  const insert=logs.prepare('INSERT INTO logs VALUES (?,?,?,?,?,?,?)');
  insert.run(1,101,0,'one','WARN','codex_core::responses_retry','retrying network');insert.run(2,101,0,'two','WARN','codex_core::responses_retry','retrying quota');logs.close();
  const records=new LocalTaskRecords(home);
  try {assert.equal(records.transcript('one'),fs.realpathSync(file));assert.equal(records.transcript('one',outside),null);assert.deepEqual(records.logs({id:'one',startedAt:100000,logCursor:0}).map(r=>r.id),[1]);}
  finally {records.close();}
});

test('a Stop question remains answerable after model text completion but explicit failure is terminal',()=>{
  const events=[];
  const health=new TaskHealth({emit:e=>events.push(e),now:()=>100000,isAwaitingStopAnswer:()=>true,records:{transcript:()=>null,logs:()=>[],close(){}}});
  health.observe(begin());
  health.observe({type:'question.waiting',conversationId:'one',taskId:'turn-one',ts:new Date(100001).toISOString()});
  health.accept(health.tasks.get('one'),{state:'done',taskId:'turn-one',at:110000});
  assert.equal(events.length,0);
  health.accept(health.tasks.get('one'),{state:'failed',taskId:'turn-one',at:120000,reason:'网络请求失败'});
  assert.equal(events.at(-1).type,'codex.Failed');
});

test('live publications cannot hide a subsequent failure in the same recovery batch',t=>{
  const dir=tempFixture(t),file=path.join(dir,'recovery.jsonl'),events=[];
  fs.writeFileSync(file,[record('stream_error','turn-one',110000,{message:'network'}),record('error','turn-one',111000,{message:'insufficient_quota'})].map(r=>JSON.stringify(r)).join('\n')+'\n');
  const health=new TaskHealth({now:()=>120000,records:{transcript:()=>file,logs:()=>[],close(){}},emit:e=>{const item={...e,ts:new Date(120000).toISOString()};events.push(item);health.observe(item);}});
  health.observe(begin());health.tick();
  assert.deepEqual(events.map(e=>e.type),['codex.Retrying','codex.Failed']);
  assert.equal(health.tasks.get('one').state,'failed');
  const restored=new TaskHealth({now:()=>120000,records:{close(){}},emit(){}});
  restored.observe(begin());for(const e of events) restored.observe(e,{replay:true});
  assert.equal(restored.tasks.get('one').state,'failed');
});

test('a late tool completion cannot hide a confirmed failure of the same turn',()=>{
  const events=[];
  const health=new TaskHealth({emit:e=>events.push(e),now:()=>130000,records:{close(){}}});
  health.observe(begin());
  health.observe({type:'codex.PostToolUse',conversationId:'one',taskId:'turn-one',ts:new Date(125000).toISOString()});
  health.accept(health.tasks.get('one'),{state:'failed',taskId:'turn-one',at:120000,reason:'额度不足'});
  assert.equal(events.at(-1).type,'codex.Failed');
});
