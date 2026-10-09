import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlan, hookProgress, reduceProgress, progressView } from '../public/progress.mjs';

const event = (type, taskId='turn-1', meta={}) => ({type,taskId,meta});
const plan = [
  {step:'检查当前实现',status:'completed'},
  {step:'修改代码',status:'in_progress'},
  {step:'验证功能',status:'pending'}
];

test('only successful plan updates supply measurable progress', () => {
  const input={hook_event_name:'PostToolUse',tool_name:'update_plan',tool_use_id:'tool-1',tool_input:{plan},tool_response:'Plan updated'};
  assert.deepEqual(hookProgress(input).plan,plan);
  assert.equal(hookProgress({...input,hook_event_name:'PreToolUse'}).plan,null);
  assert.equal(hookProgress({...input,tool_response:{isError:true}}).plan,null);
  assert.equal(hookProgress({...input,tool_response:{error:'rejected'}}).plan,null);
  assert.equal(hookProgress({...input,tool_name:'Bash'}).plan,null);
  assert.equal(normalizePlan([{step:'invalid',status:'almost_done'}]),null);
  assert.equal(normalizePlan(Array(101).fill(plan[0])),null);
  assert.deepEqual(normalizePlan([{step:'next',status:'inProgress'}]),[{step:'next',status:'in_progress'}]);
});

test('unplanned activity counts tool endings without inventing percentages', () => {
  let p=reduceProgress(null,event('codex.UserPromptSubmit'));
  p=reduceProgress(p,event('codex.PreToolUse','turn-1',{toolName:'Bash',toolUseId:'a'}));
  p=reduceProgress(p,event('codex.PreToolUse','turn-1',{toolName:'Bash',toolUseId:'b'}));
  p=reduceProgress(p,event('codex.PostToolUse','turn-1',{toolName:'Bash',toolUseId:'a'}));
  assert.equal(p.activeTools.length,1);
  assert.equal(p.activeTools[0].id,'b');
  assert.equal(p.completedTools,1);
  assert.equal(progressView(p).percent,null);
  assert.equal(progressView(p).mode,'indeterminate');
  p=reduceProgress(p,event('permission.waiting'));
  assert.equal(progressView(p).paused,true);
  p=reduceProgress(p,event('permission.parked'));
  assert.equal(p.state,'parked');
  assert.equal(progressView(p).paused,true);
  p=reduceProgress(p,event('permission.resumed'));
  assert.equal(p.state,'waiting');
  p=reduceProgress(p,event('permission.desktop'));
  assert.equal(p.state,'desktop');
  p=reduceProgress(p,event('permission.approved'));
  assert.equal(progressView(p).paused,false);
  p=reduceProgress(p,event('codex.Stop'));
  assert.equal(progressView(p).percent,100);
  assert.equal(progressView(p).text,'本轮结束');
});

test('plan revisions and turn changes reset measured progress', () => {
  let p=reduceProgress(null,event('codex.PostToolUse','turn-1',{toolName:'update_plan',plan}));
  assert.equal(progressView(p).percent,33);
  p=reduceProgress(p,event('codex.PostToolUse','turn-1',{toolName:'update_plan',plan:plan.map(item=>({...item,status:'completed'}))}));
  assert.equal(progressView(p).percent,100);
  const revised=[...plan,{step:'新增验证',status:'pending'}];
  p=reduceProgress(p,event('codex.PostToolUse','turn-1',{toolName:'update_plan',plan:revised}));
  assert.equal(progressView(p).percent,25);
  p=reduceProgress(p,event('codex.UserPromptSubmit','turn-2'));
  assert.equal(p.plan,null);
  assert.equal(p.completedTools,0);
  const current=p;
  assert.equal(reduceProgress(p,event('codex.PostToolUse','turn-1',{plan})),current);
  assert.equal(reduceProgress(p,event('permission.desktop','turn-1')),current);
});

test('interrupt and session close preserve partial progress rather than completing it', () => {
  const p=reduceProgress(null,event('codex.PostToolUse','turn-1',{plan}));
  for (const type of ['codex.Interrupt','codex.SessionEnd','codex.Stop']) {
    const ended=reduceProgress(p,event(type));
    assert.equal(progressView(ended).percent,33);
    assert.equal(reduceProgress(ended,event('codex.PostToolUse')),ended);
    const next=reduceProgress(ended,event('codex.PreToolUse','turn-2'));
    assert.equal(next.state,'running');
    assert.equal(next.plan,null);
  }
  assert.equal(progressView(reduceProgress(null,event('codex.Interrupt'))).percent,null);
});

test('different conversations maintain independent plan and tool state on history replay', () => {
  const histories=[
    {...event('codex.PostToolUse','a',{plan}),conversationId:'one'},
    {...event('codex.PreToolUse','b',{toolName:'Bash'}),conversationId:'two'},
    {...event('permission.waiting','a'),conversationId:'one'},
    {...event('codex.Stop','b'),conversationId:'two'}
  ];
  const replay=()=>{const map=new Map();for(const e of histories)map.set(e.conversationId,reduceProgress(map.get(e.conversationId),e));return map;};
  assert.deepEqual(replay(),replay());
  assert.equal(progressView(replay().get('one')).percent,33);
  assert.equal(progressView(replay().get('one')).paused,true);
  assert.equal(progressView(replay().get('two')).percent,100);
});
