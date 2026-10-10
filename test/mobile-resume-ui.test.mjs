import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { reduceProgress, progressView } from '../public/progress.mjs';
import { balanceText } from '../public/account-balance.mjs';

test('phone reload restores its session and unlock reconnects without losing the approval',async()=>{
  const elements=new Map(),handlers=new Map(),calls=[];
  let failAnswer=false;
  const element=id=>{
    if(!elements.has(id)) elements.set(id,{value:'',checked:false,style:{},parentElement:{classList:{toggle(){}}},classList:{toggle(){}},setAttribute(){},removeAttribute(){}});
    return elements.get(id);
  };
  const request={id:'approval-fixture',source:'codex-hook',conversationId:'thread-fixture',taskId:'turn-fixture',status:'parked',ready:true,action:'示例工具调用',toolName:'Bash',cwd:'example',filesKnown:false,readOnly:false,toolInput:'{"command":"example"}'};
  const response=body=>({ok:true,status:200,json:async()=>body});
  const context=vm.createContext({
    reduceProgress,progressView,balanceText,console,crypto:{randomUUID:()=> 'phone-fixture-0000001'},
    AbortController,AbortSignal,TextDecoder,Blob,
    document:{hidden:false,getElementById:element,addEventListener:(name,callback)=>handlers.set(name,callback)},
    window:{addEventListener:(name,callback)=>handlers.set('window:'+name,callback)},
    navigator:{userAgent:'Android',maxTouchPoints:1,sendBeacon:()=>true},
    setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},
    fetch:async(url,options={})=>{
      calls.push({url,options});
      if(url==='/api/session')return response({clientKind:'mobile',pending:[request],liveApprovalBridge:true});
      if(url.startsWith('/api/events'))return response([{id:1,type:'codex.UserPromptSubmit',conversationId:request.conversationId,taskId:request.taskId,ts:new Date().toISOString(),message:'示例任务',meta:{cwd:'example'}}]);
      if(url==='/api/conversations')return response({items:[],loading:false});
      if(url==='/api/account/balance')return response({credits:{balance:'12.5',unlimited:false},windows:[{durationMins:300,remainingPercent:75}],updatedAt:new Date().toISOString()});
      if(url==='/api/presence')return response({mobileOnline:true});
      if(url.startsWith('/api/stream'))return {...response({}),body:{getReader:()=>({read:()=>new Promise(()=>{})})}};
      if(url.includes('/decision'))return response({status:'approved'});
      if(url.includes('/answer')) {if(failAnswer){failAnswer=false;throw Error('模拟网络中断');}return response({status:'answered'});}
      throw Error('Unexpected fixture fetch');
    }
  });
  const source=fs.readFileSync(new URL('../public/app-v2.js',import.meta.url),'utf8').replace(/^import .*\r?\n/gm,'');
  vm.runInContext(source,context);
  for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.filter(call=>call.url==='/api/session').length,1);
  assert.equal(calls.find(call=>call.url==='/api/session').options.method,undefined);
  assert.equal(element('token').value,'');
  assert.equal(element('phoneApproval').checked,true);
  assert.ok(element('accountBalance').textContent.includes('12.5 积分'));
  assert.ok(element('accountBalance').textContent.includes('5 小时额度剩余 75%'));
  assert.ok(element('requests').innerHTML.includes('data-id="approval-fixture"'));
  assert.ok(element('requests').innerHTML.includes('data-decision="approved" >批准'));

  context.document.hidden=true;handlers.get('visibilitychange')();
  assert.ok(element('requests').innerHTML.includes('approval-fixture'));
  context.document.hidden=false;handlers.get('visibilitychange')();
  for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.filter(call=>call.url.startsWith('/api/stream')).length,2);
  assert.ok(element('requests').innerHTML.includes('approval-fixture'));

  const button={dataset:{id:request.id,decision:'approved'},disabled:false};
  await handlers.get('click')({target:{id:'',closest:selector=>selector==='[data-id]'?button:null}});
  assert.equal(calls.filter(call=>call.url.includes('/decision')).length,1);
  assert.ok(element('requests').innerHTML.includes('没有待处理授权'));
  const question={id:'question-fixture',kind:'question',source:'codex-hook',conversationId:request.conversationId,taskId:request.taskId,status:'pending',ready:true,action:'回答问题',questions:[{id:'method',header:'方式',question:'选择 <方式>',options:[{id:'option-1',label:'甲',description:'详细说明'}]}]};
  context.fixtureQuestion=question;
  vm.runInContext('applyEvent({id:2,type:"question.requested",conversationId:fixtureQuestion.conversationId,taskId:fixtureQuestion.taskId,ts:new Date().toISOString(),meta:fixtureQuestion})',context);
  assert.ok(element('requests').innerHTML.includes('type="radio"'));
  assert.ok(element('requests').innerHTML.includes('选择 &lt;方式&gt;'));
  const questionButton={dataset:{id:question.id,answer:'true'},disabled:false};
  const clickAnswer=()=>handlers.get('click')({target:{id:'',closest:selector=>selector==='[data-id]'?questionButton:null}});
  await clickAnswer();
  assert.equal(calls.filter(c=>c.url.includes('/answer')).length,0);
  assert.ok(element('requests').innerHTML.includes('请为每个问题'));
  const input={dataset:{reply:question.id,question:'method'},type:'textarea',value:'保持 <我的> 输入'};
  handlers.get('input')({target:input});
  handlers.get('change')({target:{dataset:input.dataset,type:'radio',value:'option-1'}});
  let writes=0, markup=element('requests').innerHTML;
  Object.defineProperty(element('requests'),'innerHTML',{get:()=>markup,set:value=>{writes++;markup=value;},configurable:true});
  vm.runInContext('render()',context);
  assert.equal(writes,0,'unrelated renders must not replace the focused question form');
  vm.runInContext('applyEvent({id:3,type:"question.parked",conversationId:fixtureQuestion.conversationId,taskId:fixtureQuestion.taskId,ts:new Date().toISOString(),meta:{...fixtureQuestion,status:"parked"}})',context);
  assert.ok(markup.includes('保持 &lt;我的&gt; 输入'));
  assert.ok(markup.includes('value="option-1" checked'));
  context.document.hidden=true;handlers.get('visibilitychange')();
  context.document.hidden=false;handlers.get('visibilitychange')();
  assert.ok(markup.includes('保持 &lt;我的&gt; 输入'));
  vm.runInContext('selected="temporarily-other-thread";renderRequests([],"empty");selected=fixtureQuestion.conversationId;render()',context);
  assert.ok(markup.includes('保持 &lt;我的&gt; 输入'));
  failAnswer=true;
  await clickAnswer();
  assert.ok(markup.includes('模拟网络中断'));
  assert.ok(markup.includes('保持 &lt;我的&gt; 输入'));
  await clickAnswer();
  const answerCall=calls.filter(c=>c.url.includes('/answer')).at(-1);
  assert.deepEqual(JSON.parse(answerCall.options.body),{answers:{method:{optionId:'option-1',text:'保持 <我的> 输入'}}});
  assert.ok(!element('requests').innerHTML.includes('question-fixture'));
  vm.runInContext('applyEvent({id:4,type:"codex.Retrying",conversationId:fixtureQuestion.conversationId,taskId:fixtureQuestion.taskId,ts:new Date().toISOString(),message:"网络连接异常，正在重试",meta:{errorCategory:"network",errorDetail:"HTTP 503"}})',context);
  assert.ok(element('progressTrack').className.includes('paused'));
  assert.equal(element('taskStatus').textContent,'请求异常·重试中');
  assert.ok(element('taskError').textContent.includes('HTTP 503'));
  vm.runInContext('applyEvent({id:5,type:"codex.Failed",conversationId:fixtureQuestion.conversationId,taskId:fixtureQuestion.taskId,ts:new Date().toISOString(),message:"任务已中断：余额不足",meta:{errorCategory:"quota",errorDetail:"insufficient_quota"}})',context);
  assert.equal(element('taskStatus').textContent,'失败·已中断');
  assert.ok(element('progressTrack').className.includes('paused'));
  assert.equal(element('progressText').textContent,'任务失败');
  assert.equal(element('taskError').hidden,false);
  vm.runInContext('applyEvent({id:6,type:"codex.UserPromptSubmit",conversationId:fixtureQuestion.conversationId,taskId:"new-turn",ts:new Date().toISOString(),message:"继续任务",meta:{}})',context);
  assert.equal(element('taskError').hidden,true);
  assert.equal(element('taskStatus').textContent,'运行中');
  vm.runInContext('applyEvent({type:"panel.snapshot",pending:[fixtureQuestion],remoteEnabled:true})',context);
  assert.equal(element('awayMode').checked,true);
  assert.ok(element('requests').innerHTML.includes('question-fixture'));
  vm.runInContext('applyEvent({type:"panel.snapshot",pending:[],remoteEnabled:false})',context);
  assert.ok(!element('requests').innerHTML.includes('question-fixture'));
  assert.equal(element('awayMode').checked,false);
});
