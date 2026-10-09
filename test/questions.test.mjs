import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeQuestions,questionsFromHook,validateAnswers,answerFeedback} from '../questions.mjs';
import {reduceProgress} from '../public/progress.mjs';

test('structured questions preserve options, async titles and strict answer binding',()=>{
  const questions=normalizeQuestions([{id:'route',question:'选哪种方式？',options:[{label:'甲',description:'甲说明'},'乙']},{title:'请补充要求'}]);
  assert.equal(questions[0].options[1].id,'option-2');
  const answers={route:{optionId:'option-2',text:'补充要求'},'question-2':{text:'详细说明'}};
  const validated=validateAnswers(questions,answers);
  assert.equal(validated.route.text,'补充要求');
  assert.ok(answerFeedback(questions,answers).includes('"choice": "乙"'));
  assert.throws(()=>validateAnswers(questions,{route:{text:'缺少一题'}}));
  assert.throws(()=>validateAnswers(questions,{...answers,extra:{text:'错误绑定'}}));
  assert.throws(()=>validateAnswers(questions,{...answers,route:{optionId:'wrong'}}));
  assert.throws(()=>validateAnswers(questions,{...answers,route:{text:'x'.repeat(4001)}}));
  assert.throws(()=>validateAnswers(questions,{...answers,route:{text:'   '}}));
  assert.equal(normalizeQuestions([{id:'__proto__',question:'问题'}]),null);
  assert.equal(normalizeQuestions([{id:'same',question:'一'},{id:'same',question:'二'}]),null);
  for(const name of ['functions.request_user_input','functions.request_user_input_async','request_user_input']) assert.equal(questionsFromHook({hook_event_name:'PreToolUse',tool_name:name,tool_input:{questions:[{title:'输入说明',options:['A','B']}]}}).origin,'tool');
  assert.equal(questionsFromHook({hook_event_name:'PreToolUse',tool_name:'exec_command',tool_input:{questions}}),null);
});

test('Stop detection avoids instructions and recursive continuations',()=>{
  const event={hook_event_name:'Stop',last_assistant_message:'请选择部署方式：\n1. 私有网络\n2. 公网代理'};
  assert.equal(questionsFromHook(event).questions[0].options.length,2);
  assert.equal(questionsFromHook({...event,stop_hook_active:true}),null);
  assert.equal(questionsFromHook({...event,last_assistant_message:'请确认服务运行，然后刷新手机页面。'}),null);
  assert.equal(questionsFromHook({...event,last_assistant_message:'What changed\n实现了回答功能。'}),null);
  assert.equal(questionsFromHook({...event,last_assistant_message:'你希望使用哪种方式？'}).origin,'stop');
  let progress=reduceProgress(null,{type:'codex.UserPromptSubmit',taskId:'turn'});
  progress=reduceProgress(progress,{type:'question.waiting',taskId:'turn'});
  assert.equal(progress.state,'waiting');
  progress=reduceProgress(progress,{type:'question.parked',taskId:'turn'});
  assert.equal(progress.state,'parked');
  progress=reduceProgress(progress,{type:'question.answered',taskId:'turn'});
  assert.equal(progress.state,'running');
});
