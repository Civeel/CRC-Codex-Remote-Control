// Progress is measured only against an explicit plan, never elapsed time or tool count.
export function normalizePlan(value) {
  if (!Array.isArray(value) || !value.length || value.length > 100) return null;
  if (value.some(item => !item || typeof item.step !== 'string' || !item.step.trim() || !['pending','in_progress','inProgress','completed'].includes(item.status))) return null;
  return value.map(item => ({ step:item.step.trim().slice(0,500), status:item.status === 'inProgress' ? 'in_progress' : item.status }));
}

export function hookProgress(event) {
  const toolUseId = typeof event.tool_use_id === 'string' ? event.tool_use_id.slice(0,200) : null;
  const response = event.tool_response;
  const failed = response?.isError === true || Boolean(response?.error);
  const isPlan = /(?:^|\.)update_plan$/.test(String(event.tool_name || ''));
  const input = typeof event.tool_input === 'object' && event.tool_input ? event.tool_input : {};
  return { toolUseId, plan:event.hook_event_name === 'PostToolUse' && isPlan && !failed ? normalizePlan(input.plan) : null };
}

export function initialProgress(turnId = null) {
  return { turnId, state:'idle', phase:'等待任务事件', plan:null, completedTools:0, activeTools:[], failure:null };
}

export function reduceProgress(previous, event) {
  let p = previous || initialProgress();
  const type = event.type;
  const turnId = event.taskId || null;
  if (type === 'codex.UserPromptSubmit' || type === 'codex.SessionStart') p = initialProgress(turnId);
  else if (turnId && p.turnId && turnId !== p.turnId) {
    // A late result or decision from an older turn must not replace the active turn.
    if (!['codex.PreToolUse','codex.Activity'].includes(type)) return p;
    p = initialProgress(turnId);
  } else if (type === 'codex.PreToolUse' && ['done','interrupted','ended'].includes(p.state)) p = initialProgress(turnId);
  if (p.state==='failed' && type!=='codex.UserPromptSubmit' && type!=='codex.SessionStart') return p;
  if (['done','interrupted','ended'].includes(p.state) && (['codex.PostToolUse','codex.Activity','codex.Retrying','codex.StatusUncertain','codex.Failed'].includes(type) || type.startsWith('permission.') || type.startsWith('question.'))) return p;
  p = { ...p, turnId:turnId || p.turnId, activeTools:[...p.activeTools] };
  const tool = event.meta?.toolName || '工具';
  if(type==='codex.Failed') {p.state='failed';p.phase=event.message || '任务因错误中断';p.activeTools=[];p.failure={reason:event.message || '任务因错误中断',detail:event.meta?.errorDetail || '',category:event.meta?.errorCategory || 'other'};}
  if(type==='codex.Retrying') {p.state='retrying';p.phase=event.message || '请求异常，Codex 正在重试';p.failure={reason:p.phase,detail:event.meta?.errorDetail || '',category:event.meta?.errorCategory || 'other'};}
  if(type==='codex.StatusUncertain') {p.state='uncertain';p.phase=event.message || '任务状态未确认，进度已暂停';}
  if(['codex.NativeApproval','codex.NativeQuestion'].includes(type)) {p.state='desktop';p.phase=event.message || '等待 Codex 内置界面处理';p.failure=null;}
  if(type==='codex.Activity') {p.state='running';p.phase=event.message || 'Codex 已恢复任务活动';p.failure=null;}
  if (['question.requested','question.waiting','question.resumed'].includes(type)) {p.state='waiting';p.phase='等待你选择或填写回答';}
  if (type==='question.parked') {p.state='parked';p.phase='提问已保留，回来后可继续回答';}
  if (['question.desktop','question.expired'].includes(type)) {p.state='desktop';p.phase='等待在 Codex 中回答';}
  if (type==='question.answered') {p.state='running';p.phase='回答已提交，等待 Codex 继续';}
  if (type === 'codex.UserPromptSubmit') { p.state='running'; p.phase='正在思考与准备'; }
  if (type === 'codex.PreToolUse') {
    p.state='running'; p.failure=null;p.phase=`正在调用 ${tool}`;
    p.activeTools.push({id:event.meta?.toolUseId || null, tool});
  }
  if (type === 'codex.PostToolUse') {
    p.state='running';p.failure=null; p.phase=`${tool} 调用结束，继续处理`;
    p.completedTools++;
    const id = event.meta?.toolUseId;
    const index = p.activeTools.findIndex(item => id ? item.id === id : item.tool === tool);
    if (index >= 0) p.activeTools.splice(index,1);
    const plan = normalizePlan(event.meta?.plan);
    if (plan) p.plan=plan;
    if (p.activeTools.length) p.phase=`正在调用 ${p.activeTools.at(-1).tool}`;
  }
  if (['permission.requested','permission.waiting'].includes(type)) { p.state='waiting'; p.phase='等待手机授权'; }
  if (type === 'permission.parked') { p.state='parked'; p.phase='手机离线，请求已保留，可在电脑 CRC 审批'; }
  if (type === 'permission.resumed') { p.state='waiting'; p.phase='手机已恢复，可继续授权'; }
  if (['permission.desktop','permission.expired'].includes(type)) { p.state='desktop'; p.phase='等待电脑审批'; }
  if (['permission.approved','permission.denied'].includes(type)) { p.state='running'; p.phase=type === 'permission.approved' ? '授权已批准，等待工具继续' : '授权已拒绝，等待 Codex 继续'; }
  if (type === 'codex.Stop') { p.state='done';p.failure=null; p.phase='本轮已结束'; p.activeTools=[]; }
  if (type === 'codex.Interrupt') { p.state='interrupted'; p.phase='本轮已中断'; p.activeTools=[]; }
  if (type === 'codex.SessionEnd') { p.state='ended'; p.phase='对话已关闭'; p.activeTools=[]; }
  return p;
}

export function progressView(progress) {
  const p = progress || initialProgress();
  const completed = p.plan?.filter(item => item.status === 'completed').length || 0;
  const total = p.plan?.length || 0;
  const paused = ['waiting','parked','desktop','interrupted','ended','failed','retrying','uncertain'].includes(p.state);
  const percent = total ? Math.round(completed / total * 100) : p.state === 'done' ? 100 : null;
  return {
    mode:percent !== null ? 'determinate' : p.state === 'running' || paused ? 'indeterminate' : 'idle',
    percent, paused, phase:p.phase, plan:p.plan || [],
    text:total ? `计划 ${completed}/${total} · ${percent}%` : ({failed:'任务失败',retrying:'重试中',uncertain:'状态未确认'})[p.state] || (p.state === 'done' ? '本轮结束' : paused ? p.phase : p.state === 'running' ? '进行中' : '暂无进度'),
    note:total ? `按已完成的计划步骤计算，不代表耗时比例。${p.state === 'done' && completed < total ? '本轮已结束，仍有计划步骤未标记完成。' : ''}` : p.state === 'done' ? '本轮对话已结束，不代表整个项目已完成。' : p.state === 'idle' ? '尚未收到当前任务的实时事件。' : `已收到 ${p.completedTools} 次工具调用结束事件。`
  };
}
