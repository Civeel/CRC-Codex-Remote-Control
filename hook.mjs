import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookProgress } from './public/progress.mjs';
import { loadEnvironment } from './config.mjs';
import { questionsFromHook, answerFeedback } from './questions.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const env = loadEnvironment(root);
const base = `http://127.0.0.1:${process.env.CODEX_REMOTE_PORT || env.PORT || 8788}`;
const hookToken = process.env.CODEX_HOOK_TOKEN || env.CODEX_HOOK_TOKEN || '';
const headers = { 'Content-Type': 'application/json', 'X-Hook-Token': hookToken };

async function request(route, body, timeoutMs = 4000) {
  const response = await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Bridge returned ${response.status}`);
  return response.json();
}

const holdMs=()=>Math.min(86400000,Math.max(1000,Number(process.env.CODEX_APPROVAL_TIMEOUT_MS || env.CODEX_APPROVAL_TIMEOUT_MS) || 86400000));
async function waitForDecision(created,expiresAt,retry=true) {
  let lastHealthy=Date.now();
  try {
    while(Date.now()<expiresAt) {
      try {
        const response=await fetch(`${base}/api/hooks/permission/${created.id}/wait`,{headers:{'X-Hook-Token':hookToken},signal:AbortSignal.timeout(Math.max(1,Math.min(35000,expiresAt-Date.now())))});
        if(response.status===404 || response.status===401) return;
        if(!response.ok) throw Error('Request service unavailable');
        const result=await response.json(); lastHealthy=Date.now();
        if(result.decision!=='pending') return result;
      } catch {
        if(!retry || Date.now()-lastHealthy>30000 || Date.now()>=expiresAt) return;
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
    }
  } finally {
    await request(`/api/hooks/permission/${created.id}/release`,{}).catch(()=>{});
  }
}

function affectedFiles(input) {
  const command = String(input?.command || '');
  const patchPaths = [...command.matchAll(/^\*\*\* (?:Add|Update|Delete|Move to) File: (.+)$/gm)].map(match => match[1].trim());
  const explicit = [input?.file_path, input?.path, input?.target_file].filter(value => typeof value === 'string');
  return [...new Set([...patchPaths, ...explicit])].slice(0, 100);
}

async function main() {
  if(!hookToken) return;
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const event = JSON.parse(raw);
  const common = { sessionId: event.session_id, turnId: event.turn_id || null, cwd: event.cwd || null, model: event.model || null, toolUseId: typeof event.tool_use_id==='string'?event.tool_use_id:null, transcriptPath: typeof event.transcript_path==='string'?event.transcript_path:null };
  const question=questionsFromHook(event);
  if(question && common.sessionId && common.turnId) {
    const capability=await fetch(base+'/api/hooks/mobile-status',{headers,signal:AbortSignal.timeout(4000)});
    if(!capability.ok) return;
    const questionStatus=await capability.json();
    if(questionStatus.questionProtocol!==1) return;
    if(questionStatus.mobileOnline!==true && questionStatus.remoteEnabled!==true) {
      await request('/api/hooks/event',{...common,type:'NativeQuestion',message:'外出模式未开启且手机离线，提问已交给 Codex 内置界面；此请求无法从手机接回'});
      return;
    }
    const expiresAt=Date.now()+holdMs();
    const created=await request('/api/hooks/question',{...common,...question,toolName:event.tool_name || 'Stop',expiresAt});
    const result=await waitForDecision(created,expiresAt);
    if(result?.decision==='answered') {
      const feedback=answerFeedback(question.questions,result.answers);
      // Hooks provide model-visible feedback; they cannot resolve Desktop's native question RPC.
      process.stdout.write(JSON.stringify(question.origin==='stop'
        ? {decision:'block',reason:feedback}
        : {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:feedback}}));
    }
    return;
  }
  if (event.hook_event_name === 'PermissionRequest') {
    // Old servers do not implement presence. Return control to native approval.
    const presence = await fetch(base + '/api/hooks/mobile-status', { headers, signal: AbortSignal.timeout(4000) });
    if (!presence.ok) return;
    const presenceStatus = await presence.json();
    if (presenceStatus.mobileOnline !== true && presenceStatus.remoteEnabled !== true) {
      await request('/api/hooks/event',{...common,type:'NativeApproval',message:'外出模式未开启且手机离线，授权已交给 Codex 内置界面；此请求无法从手机接回'});
      return;
    }
    const input = event.tool_input || {};
    const files = affectedFiles(input);
    const timeoutMs=holdMs();
    const expiresAt=Date.now()+timeoutMs;
    const created = await request('/api/hooks/permission', {
      ...common,
      toolName: event.tool_name || 'unknown',
      action: input.description || `Codex 请求使用 ${event.tool_name || '工具'}`,
      command: String(input.command || ''),
      permission: event.tool_name === 'Bash' ? '执行命令' : event.tool_name === 'apply_patch' ? '修改文件' : '调用工具',
      permissionMode: event.permission_mode || '',
      expiresAt,
      files,
      filesKnown: files.length > 0,
      toolInput: JSON.stringify(input)
    });
    if (created.decision === 'desktop') return;
    const result=await waitForDecision(created,expiresAt,presenceStatus.approvalProtocol===2);
    if(!result || result.decision==='pending') return;
    if (result.decision === 'approved') {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }));
    } else if (result.decision === 'denied') {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: '用户通过手机拒绝了此授权请求。' } } }));
    }
    return;
  }
  const messages = {
    SessionStart: `对话已开始：${event.source || 'startup'}`,
    UserPromptSubmit: String(event.prompt || '').slice(0, 500),
    PreToolUse: `准备调用 ${event.tool_name || '工具'}`,
    PostToolUse: `${event.tool_name || '工具'} 调用结束`,
    Stop: String(event.last_assistant_message || '任务已结束').slice(0, 500),
    Interrupt: '任务已中断',
    SessionEnd: '对话已结束'
  };
  await request('/api/hooks/event', { ...common, ...hookProgress(event), type: event.hook_event_name, message: messages[event.hook_event_name] || event.hook_event_name, toolName: event.tool_name || null });
}

main().catch(() => { /* Fail open to Codex's original approval prompt. */ });
