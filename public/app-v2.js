import { reduceProgress, progressView } from './progress.mjs?v=14';
import { balanceText } from './account-balance.mjs?v=2';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let events = [], pending = new Map(), selected = null, lastId = 0, streamController;
let desktopThreads = new Map(), catalogTimer, catalogLoading = false;
let balanceTimer, balanceLoading = false;
const presenceClientId = crypto.randomUUID();
let mobileMode=false, streamConnected=false, heartbeatTimer, heartbeatBusy=false;
const answerDrafts=new Map(), answerErrors=new Map(), submittingAnswers=new Set();
let requestSignature='';
const label = state => ({waiting:'待处理',parked:'待处理·已保留',running:'运行中',done:'本轮结束',idle:'暂无实时状态',desktop:'Codex 待处理',interrupted:'已中断',ended:'已关闭',failed:'失败·已中断',retrying:'请求异常·重试中',uncertain:'状态未确认'})[state];
function answerDraft(r) {
  if(!answerDrafts.has(r.id)) answerDrafts.set(r.id,Object.fromEntries(r.questions.map(q=>[q.id,{optionId:null,text:''}])));
  return answerDrafts.get(r.id);
}
function questionCard(r) {
  const draft=answerDraft(r), busy=submittingAnswers.has(r.id);
  return `<article class="request question-request"><strong>Codex 需要你回答</strong><small>当前任务：${esc(r.taskId)}</small>${r.questions.map(q=>`<fieldset><legend>${esc(q.header)}</legend><p class="question-text">${esc(q.question)}</p>${q.options.map(o=>`<label class="question-option"><input type="radio" name="${esc(r.id+'-'+q.id)}" data-reply="${esc(r.id)}" data-question="${esc(q.id)}" value="${esc(o.id)}" ${draft[q.id].optionId===o.id?'checked':''} ${busy?'disabled':''}><span>${esc(o.label)}${o.description?`<small>${esc(o.description)}</small>`:''}</span></label>`).join('')}<label class="answer-label">${q.options.length?'补充说明或自行回答':'你的回答'}${q.isSecret?`<input type="password" autocomplete="off" data-reply="${esc(r.id)}" data-question="${esc(q.id)}" maxlength="4000" value="${esc(draft[q.id].text)}" ${busy?'disabled':''}>`:`<textarea data-reply="${esc(r.id)}" data-question="${esc(q.id)}" maxlength="4000" rows="3" placeholder="在这里输入回答" ${busy?'disabled':''}>${esc(draft[q.id].text)}</textarea>`}</label></fieldset>`).join('')}<p class="answer-error" role="alert">${esc(answerErrors.get(r.id)||'')}</p><div class="actions"><button data-id="${esc(r.id)}" data-answer="true" ${!r.ready||busy?'disabled':''}>${busy?'正在提交…':'提交回答'}</button><button class="secondary" data-id="${esc(r.id)}" data-decision="desktop" ${!r.ready||busy?'disabled':''}>在 Codex 中回答</button></div><small>${r.ready?'提交后将回答交给 Codex 继续处理；回答不会授予额外操作权限':'正在连接提问回调'}</small></article>`;
}
function renderRequests(requests,markup) {
  const signature=JSON.stringify([requests,[...submittingAnswers],[...answerErrors]]);
  if(signature===requestSignature) return;
  requestSignature=signature;
  const active=document.activeElement;
  const focus=active?.dataset?.reply?{reply:active.dataset.reply,question:active.dataset.question,type:active.type,value:active.value,start:active.selectionStart,end:active.selectionEnd}:null;
  $('requests').innerHTML=markup;
  if(focus) {
    const replacement=[...($('requests').querySelectorAll?.('[data-reply]')||[])].find(el=>el.dataset.reply===focus.reply&&el.dataset.question===focus.question&&el.type===focus.type&&(el.type!=='radio'||el.value===focus.value));
    if(replacement) {replacement.focus({preventScroll:true});if(typeof focus.start==='number') replacement.setSelectionRange(focus.start,focus.end);}
  }
}

function conversations() {
  const map = new Map([...desktopThreads.values()].map(thread => [thread.id, {
    id:thread.id, title:thread.title, cwd:thread.cwd,
    lastAt:thread.updatedAt ? new Date(thread.updatedAt).toISOString() : '',
    lastMessage:'等待此对话的 Hook 事件', state:'idle'
  }]));
  for (const e of events) {
    const id = e.conversationId;
    if (!id) continue;
    const c = map.get(id) || {id, title:'', cwd:'', lastAt:'', lastMessage:'', state:'done'};
    const title = e.meta?.conversationTitle;
    if (title && title !== id && !desktopThreads.has(id)) c.title = title;
    if (e.type === 'codex.UserPromptSubmit' && e.message && !c.title) c.title = e.message.slice(0,80);
    c.cwd = e.meta?.cwd || c.cwd;
    if (!c.lastAt || e.ts > c.lastAt) c.lastAt = e.ts;
    c.lastMessage = e.message || c.lastMessage;
    c.progress = reduceProgress(c.progress,e);
    c.state = c.progress.state;
    map.set(id,c);
  }
  for (const r of pending.values()) {
    const id = r.conversationId;
    const c = map.get(id) || {id,title:'',cwd:'',lastAt:'',lastMessage:'',state:'done'};
    c.title = c.title || (r.conversationTitle !== id ? r.conversationTitle : '');
    c.cwd = c.cwd || r.cwd;
    c.lastAt = r.createdAt || c.lastAt;
    if (!c.progress?.turnId || c.progress.turnId === r.taskId) {
      c.progress = reduceProgress(c.progress,{type:`${r.kind==='question'?'question':'permission'}.${r.status==='parked'?'parked':'waiting'}`,taskId:r.taskId});
      c.state = c.progress.state;
    }
    map.set(id,c);
  }
  return map;
}
function render() {
  const map = conversations();
  if (!selected || !map.has(selected)) selected = [...map.values()].sort((a,b) => String(b.lastAt).localeCompare(String(a.lastAt)))[0]?.id || null;
  $('conversationCount').textContent = map.size;
  const projects = new Map();
  for (const c of map.values()) {
    const project = c.cwd || '未识别项目';
    if (!projects.has(project)) projects.set(project,[]);
    projects.get(project).push(c);
  }
  $('conversationList').innerHTML = projects.size ? [...projects].map(([project,items]) =>
    `<section class="project-group"><div class="project-name">${esc(project)}</div>${items.sort((a,b)=>String(b.lastAt).localeCompare(String(a.lastAt))).map(c =>
      `<button class="conversation-item ${c.id === selected ? 'selected' : ''}" data-conversation="${esc(c.id)}"><i class="state-dot ${c.state}"></i><span><strong>${esc(c.title || '未命名对话')}</strong><small>${esc(c.id.slice(0,18))}</small></span><em>${label(c.state)}</em></button>`).join('')}</section>`
  ).join('') : '<div class="empty">尚未收到 Codex 对话事件</div>';
  const c = map.get(selected);
  $('taskTitle').textContent = c?.title || (c ? '未命名对话' : '等待任务');
  $('taskConversation').textContent = c?.id || '';
  $('taskStatus').textContent = c ? label(c.state) : '空闲';
  $('taskStatus').className = `status ${c?.state || 'idle'}`;
  $('taskMessage').textContent = c?.lastMessage || '尚未收到任务事件';
  const failure=c?.progress?.failure;
  $('taskError').hidden=!failure;
  $('taskError').textContent=failure?[failure.reason,failure.detail].filter(Boolean).join('\n'):'';
  $('taskError').className=`task-error ${c?.state || ''}`;
  renderProgress(c);
  const requests = [...pending.values()].filter(r => r.conversationId === selected);
  $('pendingCount').textContent = requests.length;
  const requestsMarkup = requests.length ? requests.map(r => r.kind === 'question' ? questionCard(r) : `<article class="request"><strong>${esc(r.action)}</strong><small><b>任务：</b>${esc(r.taskId)}<br><b>权限：</b>${esc(r.permission)}<br><b>工具：</b>${esc(r.toolName)}<br><b>工作目录：</b>${esc(r.cwd)}</small>${r.command ? `<code>${esc(r.command)}</code>` : ''}<small><b>${r.readOnly ? '读取范围' : '已识别文件'}：</b>${r.readOnly ? r.readPaths.map(esc).join('<br>') : r.filesKnown ? r.files.map(esc).join('<br>') : '未能自动列出影响文件；请查看命令和原始参数后决定'}</small><details ${!r.filesKnown && !r.readOnly ? 'open' : ''}><summary>查看原始参数</summary><code>${esc(r.toolInput)}</code></details><div class="actions"><button data-id="${esc(r.id)}" data-decision="approved" ${r.ready ? '' : 'disabled'}>批准</button><button class="deny" data-id="${esc(r.id)}" data-decision="denied" ${r.ready ? '' : 'disabled'}>拒绝</button><button class="secondary" data-id="${esc(r.id)}" data-decision="desktop" ${r.ready ? '' : 'disabled'}>转到原生审批</button></div><small>${r.ready ? '等待你的决定；批准仅允许本次工具调用，转到原生审批后不能由手机接回' : '正在连接授权回调'}</small></article>`).join('') : '<div class="empty">此对话没有待处理授权或提问</div>';
  renderRequests(requests,requestsMarkup);
  $('eventList').innerHTML = events.filter(e => e.conversationId === selected).slice(-200).reverse().map(e => `<div class="event"><time>${new Date(e.ts).toLocaleTimeString('zh-CN')}</time><span class="type">${esc(e.type)}</span><span>${esc(e.message)}</span></div>`).join('');
}
function renderProgress(c) {
  const progress = progressView(c?.progress);
  const disconnected = !streamConnected && Boolean(c?.progress);
  $('progressTrack').className = `progress ${progress.mode} ${progress.paused || disconnected ? 'paused' : ''} ${c?.state || 'idle'}`;
  $('bar').style.width = progress.percent !== null ? `${progress.percent}%` : '';
  $('progressText').textContent = progress.text;
  $('progressPhase').textContent = disconnected ? `最后状态：${progress.phase}` : progress.phase;
  $('progressNote').textContent = (disconnected ? '实时事件未连接，当前显示最后收到的进度。' : '') + progress.note;
  $('progressTrack').setAttribute('aria-valuetext',`${progress.phase}，${progress.text}`);
  if (progress.percent !== null) $('progressTrack').setAttribute('aria-valuenow',progress.percent);
  else $('progressTrack').removeAttribute('aria-valuenow');
  $('planSteps').innerHTML = progress.plan.map(step=>`<li class="plan-step ${step.status}"><span class="plan-mark" aria-hidden="true">${step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '●' : '○'}</span><span>${esc(step.step)}</span><small>${{completed:'已完成',in_progress:'进行中',pending:'待开始'}[step.status]}</small></li>`).join('');
  $('planSteps').hidden = !progress.plan.length;
}
function applyEvent(e) {
  if (!e?.id || e.id <= lastId) return;
  lastId = e.id; events.push(e);
  if (/^(permission|question)\.(requested|waiting|parked|resumed)$/.test(e.type)) pending.set(e.meta.id,e.meta);
  if (/^(permission|question)\.(approved|denied|answered|expired|desktop|cancelled)$/.test(e.type)) {pending.delete(e.meta.id);answerDrafts.delete(e.meta.id);answerErrors.delete(e.meta.id);}
  render();
}
function connection(message,ok) { $('connectionText').textContent=message; $('dot').parentElement.classList.toggle('ok',ok); renderProgress(conversations().get(selected)); }
function presenceMessage(online) {
  $('mobilePresenceText').textContent=online ? '手机审批在线' : '手机离线，请求保留，可用电脑 CRC 审批';
}
async function heartbeat() {
  if (heartbeatBusy || document.hidden || !streamConnected) return;
  heartbeatBusy=true;
  try {
    const r=await fetch('/api/presence', mobileMode
      ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId:presenceClientId,active:true}),signal:AbortSignal.timeout(2000)}
      : {signal:AbortSignal.timeout(2000)});
    if (!r.ok) throw Error();
    presenceMessage((await r.json()).mobileOnline);
  } catch { presenceMessage(false); }
  finally { heartbeatBusy=false; }
}
function pausePresence() {
  clearInterval(heartbeatTimer);
  if (mobileMode && streamConnected) navigator.sendBeacon('/api/presence',new Blob([JSON.stringify({clientId:presenceClientId,active:false})],{type:'application/json'}));
}
function startHeartbeat() {
  clearInterval(heartbeatTimer);
  if (document.hidden || !streamConnected) return;
  heartbeat(); heartbeatTimer=setInterval(heartbeat,2000);
}
async function syncCatalog() {
  if (catalogLoading) return;
  catalogLoading=true; clearTimeout(catalogTimer);
  let next=15000;
  try {
    const r=await fetch('/api/conversations',{signal:AbortSignal.timeout(8000)});
    if (!r.ok) throw Error('读取桌面对话目录失败');
    const snapshot=await r.json();
    if (snapshot.updatedAt) desktopThreads=new Map(snapshot.items.map(thread=>[thread.id,thread]));
    $('catalogText').textContent=snapshot.error || (snapshot.loading ? '正在同步桌面对话…' : '桌面对话目录已同步');
    if (snapshot.loading) next=1500;
    render();
  } catch(e) { $('catalogText').textContent=e.message + '；已保留现有对话'; }
  finally { catalogLoading=false; catalogTimer=setTimeout(syncCatalog,next); }
}
async function syncBalance() {
  clearTimeout(balanceTimer);
  if (balanceLoading || !streamConnected || document.hidden) return;
  balanceLoading = true;
  let next = 60000;
  try {
    const response = await fetch('/api/account/balance', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw Error();
    const snapshot = await response.json();
    $('accountBalance').textContent = balanceText(snapshot);
    $('accountBalance').title = snapshot.updatedAt ? `更新于 ${new Date(snapshot.updatedAt).toLocaleString('zh-CN')}` : '';
    if (snapshot.loading) next = 1500;
  } catch {
    $('accountBalance').textContent = '余额：暂时无法读取';
    next = 15000;
  } finally {
    balanceLoading = false;
    if (streamConnected && !document.hidden) balanceTimer = setTimeout(syncBalance, next);
  }
}
async function connect(restore=false) {
  const token=$('token').value.trim(); if (!restore && !token) return;
  $('connect').disabled=true; connection('正在连接',false);
  pausePresence(); streamController?.abort(); streamConnected=false;
  mobileMode=$('phoneApproval').checked;
  try {
    const login=await fetch('/api/session',restore?{signal:AbortSignal.timeout(8000)}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,clientKind:mobileMode?'mobile':'desktop'}),signal:AbortSignal.timeout(8000)});
    if (!login.ok) {if(restore && login.status===401) {connection('未连接',false);return;} throw Error(restore?'登录已过期，请重新连接':'访问令牌无效');}
    const session=await login.json();
    if(restore && session.clientKind) {mobileMode=session.clientKind==='mobile';$('phoneApproval').checked=mobileMode;}
    events=[]; lastId=0;
    while (true) {
      const h=await fetch(`/api/events?after=${lastId}`,{signal:AbortSignal.timeout(8000)});
      if (!h.ok) throw Error('读取历史事件失败');
      const page=await h.json(); events.push(...page);
      lastId=page.at(-1)?.id || lastId;
      if (page.length<500) break;
    }
    pending=new Map(session.pending.filter(r=>r.source==='codex-hook').map(r=>[r.id,r]));
    render(); connection(session.liveApprovalBridge?'Codex Hook 已连接':'面板已连接，等待 Codex Hook',true);
    syncCatalog();
    streamController?.abort(); streamController=new AbortController(); stream(streamController.signal);
  } catch(e) { connection(e.message||'连接失败',false); } finally { $('connect').disabled=false; }
}
async function stream(signal) {
  while (!signal.aborted) {
    try {
      const r=await fetch(`/api/stream?after=${lastId}&clientId=${presenceClientId}`,{signal}); if(!r.ok) throw Error();
      streamConnected=true; startHeartbeat();
      connection('实时连接正常',true);
      syncBalance();
      const reader=r.body.getReader(), decoder=new TextDecoder(); let buffer='';
      while (!signal.aborted) {
        const part=await reader.read(); if(part.done) break;
        buffer+=decoder.decode(part.value,{stream:true});
        const frames=buffer.split('\n\n'); buffer=frames.pop();
        for (const frame of frames) { const data=frame.split('\n').find(line=>line.startsWith('data: ')); if(data) applyEvent(JSON.parse(data.slice(6))); }
      }
    } catch { /* Reconnect below; progress pauses as soon as the stream ends. */ }
    finally { if(streamController?.signal===signal) { clearInterval(heartbeatTimer); streamConnected=false; presenceMessage(false); if(!signal.aborted) connection('实时连接中断，重连中',false); } }
    if (!signal.aborted) await new Promise(resolve=>setTimeout(resolve,1500));
  }
}
function recordAnswer(e) {
  const el=e.target, r=pending.get(el.dataset?.reply);
  if(r?.kind!=='question' || !r.questions.some(q=>q.id===el.dataset.question)) return;
  const draft=answerDraft(r)[el.dataset.question];
  if(el.type==='radio') draft.optionId=el.value; else draft.text=el.value;
}
document.addEventListener('input',recordAnswer);
document.addEventListener('change',recordAnswer);
document.addEventListener('click',async e=>{
  if(e.target.id==='syncConversations'){syncCatalog();return;}
  const item=e.target.closest('[data-conversation]');
  if(item){selected=item.dataset.conversation;render();return;}
  if(e.target.id==='clear'){ $('eventList').innerHTML=''; return; }
  const b=e.target.closest('[data-id]'); if(!b)return;
  const r=pending.get(b.dataset.id); if(!r||!r.ready)return;
  if(b.dataset.answer) {
    if(submittingAnswers.has(r.id)) return;
    const answers=answerDraft(r);
    if(r.questions.some(q=>!answers[q.id].optionId&&!answers[q.id].text.trim())) {answerErrors.set(r.id,'请为每个问题选择选项或填写回答');render();return;}
    submittingAnswers.add(r.id);answerErrors.delete(r.id);render();
    try {
      const x=await fetch(`/api/question-requests/${r.id}/answer`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({answers}),signal:AbortSignal.timeout(8000)});
      if(!x.ok) throw Error((await x.json()).message||'请求已结束或提交失败');
      pending.delete(r.id);answerDrafts.delete(r.id);
    } catch(error) {if(pending.has(r.id)) answerErrors.set(r.id,error.message+'；已保留填写内容，请重试');}
    finally {submittingAnswers.delete(r.id);render();}
    return;
  }
  b.disabled=true;
  try {
    const x=await fetch(`/api/permission-requests/${r.id}/decision`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision:b.dataset.decision}),signal:AbortSignal.timeout(8000)});
    if(!x.ok) throw Error((await x.json()).message||'提交失败');
    pending.delete(r.id);answerDrafts.delete(r.id);render();
  } catch(err) { b.disabled=false;connection(`授权提交失败：${err.message}`,false); }
});
$('connect').onclick=()=>connect(false);
$('phoneApproval').checked=/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints>1);
$('phoneApproval').onchange=()=>{ if(streamConnected) {if($('token').value.trim()) connect(); else {$('phoneApproval').checked=mobileMode;connection('切换设备类型需重新输入访问令牌',false);}} };
function resumeVisible() {
  if(document.hidden) return;
  if(streamController) {clearInterval(heartbeatTimer);streamController.abort();streamConnected=false;streamController=new AbortController();stream(streamController.signal);}
}
document.addEventListener('visibilitychange',()=>document.hidden ? pausePresence() : resumeVisible());
window.addEventListener('pagehide',pausePresence);
window.addEventListener('pageshow',event=>{if(event.persisted)resumeVisible();});
connect(true);
