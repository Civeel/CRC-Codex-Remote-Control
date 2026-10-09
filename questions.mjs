const reserved=new Set(['__proto__','constructor','prototype']);
export function normalizeQuestions(value) {
  if(!Array.isArray(value)||!value.length||value.length>20) return null;
  const ids=new Set(),questions=[];
  for(const [index,item] of value.entries()) {
    if(!item || typeof item!=='object') return null;
    const id=String(item.id || `question-${index+1}`);
    const question=item.question ?? item.title;
    if(!id || id.length>100 || reserved.has(id) || ids.has(id) || typeof question!=='string' || !question.trim() || question.length>20000) return null;
    ids.add(id);
    if(item.options!==undefined && (!Array.isArray(item.options)||item.options.length>50)) return null;
    const options=[];
    for(const [optionIndex,option] of (item.options || []).entries()) {
      const label=typeof option==='string'?option:option?.label;
      const description=typeof option==='object' && option?String(option.description || ''):'';
      if(typeof label!=='string'||!label.trim()||label.length>2000||description.length>4000) return null;
      options.push({id:`option-${optionIndex+1}`,label,description});
    }
    questions.push({id,header:String(item.header || `问题 ${index+1}`).slice(0,100),question,options,isSecret:item.isSecret===true});
  }
  return questions;
}

export function questionsFromHook(event) {
  if(event.hook_event_name==='PreToolUse' && /(?:^|[._])request_user_input(?:_async)?$/.test(String(event.tool_name || ''))) {
    let input=event.tool_input;
    if(typeof input==='string') {try{input=JSON.parse(input);}catch{return null;}}
    const questions=normalizeQuestions(input?.questions);
    return questions?{origin:'tool',questions}:null;
  }
  if(event.hook_event_name!=='Stop' || event.stop_hook_active===true) return null;
  const message=event.last_assistant_message;
  if(typeof message!=='string'||!message.trim()||message.length>20000) return null;
  const visible=message.replace(/```[\s\S]*?```/g,'').replace(/`[^`]*`/g,'');
  const lines=visible.split(/\r?\n/).map(line=>line.replace(/^\s*[>#*\-]+\s*/,'').trim()).filter(Boolean);
  // Require a direct request near the end; ordinary setup/checklist instructions aren't questions.
  const candidates=lines.slice(-12);
  const direct=candidates.some(line=>/^(?:请(?:你|您)?(?:选择|回答|告诉我)|需要(?:你|您)(?:提供|选择|确认))/.test(line)
    || (/[?？]\s*$/.test(line) && /^(?:(?:你|您)(?:希望|想|要|倾向)|是否(?:需要|希望|要)|要|如何|怎么|哪个|Which\b|What\b|Would you\b|Do you\b|Can you\b|Please (?:choose|provide|confirm|tell)\b)/i.test(line)));
  if(!direct) return null;
  const options=lines.map(line=>line.match(/^(?:\d+[.)、]|[A-Z][.)、])\s*(.+)$/)?.[1]).filter(Boolean);
  const questions=normalizeQuestions([{id:'reply',header:'Codex 需要你回答',question:message,options:options.length>=2&&options.length<=10?options:[]}]);
  return questions?{origin:'stop',questions}:null;
}

export function validateAnswers(questions,input) {
  if(!input || typeof input!=='object' || Array.isArray(input)) throw Error('请回答每个问题');
  if(Object.keys(input).length!==questions.length || Object.keys(input).some(id=>!questions.some(q=>q.id===id))) throw Error('问题或答案不匹配，请刷新后重试');
  const result=Object.create(null);
  for(const question of questions) {
    if(!Object.hasOwn(input,question.id)) throw Error(`请回答：${question.header}`);
    const answer=input[question.id];
    if(!answer || typeof answer!=='object' || Array.isArray(answer)) throw Error('回答格式不正确');
    const optionId=answer.optionId ?? null, text=answer.text ?? '';
    if(optionId!==null && !question.options.some(option=>option.id===optionId)) throw Error('选项无效，请重新选择');
    if(typeof text!=='string'||text.length>4000) throw Error('每个问题的文字回答最多 4000 个字符');
    if(!optionId&&!text.trim()) throw Error(`请选择选项或填写：${question.header}`);
    result[question.id]={optionId,text:text.trim()};
  }
  return result;
}

export function answerFeedback(questions,answers) {
  const validated=validateAnswers(questions,answers);
  return 'CRC 用户已明确回复当前提问。请按以下回答继续处理；此反馈仅回答问题，不授予其他操作权限。\n'+JSON.stringify(questions.map(question=>({id:question.id,question:question.question,choice:question.options.find(option=>option.id===validated[question.id].optionId)?.label || null,text:validated[question.id].text})),null,2);
}
