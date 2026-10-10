import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const terminal=new Set(['done','failed','interrupted','ended']);
export function failureInfo(error,{rawDetail=true}={}) {
  const text=typeof error==='string'?error:String(error?.message || error?.error?.message || 'Codex 请求失败');
  const code=JSON.stringify(error?.codexErrorInfo || error?.code || '');
  const source=text+' '+code;
  let category='other',reason='Codex 请求失败';
  if(/insufficient[_ ](?:quota|credit|balance)|usage[_ ]?limit|quota.{0,30}(?:exceed|exhaust)|credit.{0,30}(?:exhaust|insufficient)|余额不足|额度(?:不足|耗尽)|用量.{0,10}上限/i.test(source)) {category='quota';reason='余额不足或使用额度已耗尽';}
  else if(/ContextWindowExceeded|context.{0,20}(?:exceed|long)|上下文.{0,10}(?:超出|过长)/i.test(source)) {category='context';reason='对话超过上下文限制';}
  else if(/rate[_ ]limit|too many requests|\b429\b|频率限制/i.test(source)) {category='rate_limit';reason='请求过于频繁，服务限流';}
  else if(/unauthori[sz]ed|invalid.{0,15}(?:api.?key|token)|authentication|\b401\b|\b403\b|登录.{0,8}过期/i.test(source)) {category='auth';reason='身份认证或账号访问失败';}
  else if(/network|connect|stream disconnect|timeout|timed out|dns|\b50[234]\b|网络|连接|超时/i.test(source)) {category='network';reason='网络连接或上游服务异常';}
  const http=source.match(/\b(401|402|403|408|429|500|502|503|504)\b/)?.[1];
  const safe=text.replace(/https?:\/\/[^\s"<>]+/gi,'[地址已隐藏]')
    .replace(/\bBearer\s+[^\s,"}]+/gi,'Bearer [已隐藏]')
    .replace(/\bsk-[a-zA-Z0-9_-]+/g,'[密钥已隐藏]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|authorization|cookie)["']?\s*[=:]\s*["']?)[^\s,"';}]+/gi,'$1[已隐藏]')
    .slice(0,1200);
  return {category,reason,detail:rawDetail?safe:reason+(http?`（HTTP ${http}）`:'')};
}

export function taskRecord(record,currentTurn=null) {
  const p=record?.payload;
  if(record?.type!=='event_msg' || !p || typeof p!=='object') return null;
  const taskId=p.turn_id || p.turnId || currentTurn;
  const at=Date.parse(record.timestamp);
  if(!taskId || !Number.isFinite(at)) return null;
  const base={taskId,at};
  if(p.type==='task_started') return {...base,state:'running'};
  if(['turn_aborted','task_aborted','task_interrupted'].includes(p.type)) return {...base,state:'interrupted',reason:'Codex 任务已中断'};
  if(p.type==='task_complete' && ['interrupted','cancelled'].includes(p.status)) return {...base,state:'interrupted',reason:'Codex 任务已中断'};
  if(p.type==='task_complete') return p.error || p.status==='failed'
    ? {...base,state:'failed',...failureInfo(p.error || p.message)} : {...base,state:'done'};
  if(['error','task_failed','turn_failed'].includes(p.type)) return {...base,state:p.will_retry===true || p.willRetry===true?'retrying':'failed',...failureInfo(p.error || p.message || p)};
  if(['stream_error','retry','retrying'].includes(p.type)) return {...base,state:'retrying',...failureInfo(p.error || p.message || p)};
  // Only typed lifecycle records are considered, never tool output or assistant prose.
  if(['item_started','item_completed','agent_message','agent_reasoning','token_count'].includes(p.type)) return {...base,state:'running',activity:true};
  return null;
}

export function taskLog(row,currentTurn,startedAt) {
  const at=Number(row.ts)*1000 + Math.floor(Number(row.ts_nanos || 0)%1e9/1e6);
  if(!Number.isFinite(at) || at<startedAt) return null;
  const body=String(row.feedback_log_body || ''), target=String(row.target || '');
  const explicitTurn=body.match(/\bturn_id\s*[=:]\s*["']?([\w-]+)/)?.[1];
  if(explicitTurn && explicitTurn!==currentTurn) return null;
  if(target==='codex_core::responses_retry' && /retrying|reconnecting|stream disconnected/i.test(body)) return {taskId:currentTurn,at,state:'retrying',...failureInfo(body,{rawDetail:false})};
  if(/^codex_core::(?:codex|tasks)(?:::|$)/.test(target) && /\b(?:error in turn|turn error|turn failed|failed to sample|retries exhausted|retry limit exceeded)\b/i.test(body)) return {taskId:currentTurn,at,state:'failed',...failureInfo(body,{rawDetail:false})};
  return null;
}

// These are read-only compatibility readers, not a connection to Desktop's live RPC transport.
export class LocalTaskRecords {
  constructor(codexHome=process.env.CODEX_HOME || path.join(os.homedir(),'.codex')) {this.home=path.resolve(codexHome);this.dbs=new Map();}
  database(name) {
    if(!this.dbs.has(name)) {
      const file=path.join(this.home,name);
      if(!fs.existsSync(file)) return null;
      this.dbs.set(name,new DatabaseSync(file,{readOnly:true,timeout:50}));
    }
    return this.dbs.get(name);
  }
  transcript(conversationId,hint) {
    let file=hint;
    if(!file) file=this.database('state_5.sqlite')?.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(conversationId)?.rollout_path;
    if(typeof file!=='string' || !file.endsWith('.jsonl')) return null;
    const resolved=fs.realpathSync(file);
    const allowed=['sessions','archived_sessions'].some(dir=>{
      const relative=path.relative(path.join(this.home,dir),resolved);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
    return allowed?resolved:null;
  }
  logs(t) {
    const statement=this.database('logs_2.sqlite')?.prepare("SELECT id,ts,ts_nanos,target,feedback_log_body FROM logs WHERE thread_id = ? AND id > ? AND ts >= ? AND level IN ('WARN','ERROR') AND target LIKE 'codex_core::%' ORDER BY id LIMIT 128");
    return statement?.all(t.id,t.logCursor,Math.floor(t.startedAt/1000)) || [];
  }
  close() {for(const db of this.dbs.values()) db.close();this.dbs.clear();}
}

export class TaskHealth {
  constructor({emit,records=new LocalTaskRecords(),now=Date.now,staleMs=120000,isWaiting=()=>false,isAwaitingStopAnswer=()=>false}={}) {
    this.emit=emit;this.records=records;this.now=now;this.staleMs=staleMs;this.isWaiting=isWaiting;this.isAwaitingStopAnswer=isAwaitingStopAnswer;this.tasks=new Map();this.cursor=0;
  }
  observe(event,{transcriptPath,replay=false}={}) {
    if(!event.conversationId) return;
    // Live monitor publications already updated the task with the source timestamp.
    // Re-stamping them with publish time would hide later records in the same read batch.
    if(event.meta?.source==='task-health' && !replay) return;
    const taskId=event.taskId, type=event.type, at=Date.parse(event.ts) || this.now();
    let t=this.tasks.get(event.conversationId);
    if(!t || (taskId && taskId!==t.taskId && ['codex.UserPromptSubmit','codex.PreToolUse'].includes(type))) {
      t={id:event.conversationId,taskId:taskId || null,state:'idle',startedAt:at,lastAt:at,logCursor:0,offset:null,buffer:'',scanTurn:null,cwd:event.meta?.cwd || '',hint:transcriptPath};this.tasks.set(t.id,t);
    }
    if(transcriptPath) t.hint=transcriptPath;
    if(!taskId || (t.taskId && taskId!==t.taskId)) return;
    if(!t.taskId) {t.taskId=taskId;t.startedAt=at;}
    if(terminal.has(t.state) && type!=='codex.UserPromptSubmit') return;
    t.nextPollAt=0;
    t.lastAt=Math.max(t.lastAt,at);
    if(['codex.UserPromptSubmit','codex.PreToolUse','codex.PostToolUse','codex.Activity','permission.approved','permission.denied','question.answered'].includes(type)) {t.state='running';t.reason=null;}
    if(/^(permission|question)\.(requested|waiting|parked|resumed|desktop|expired)$/.test(type)) t.state='waiting';
    if(['codex.NativeApproval','codex.NativeQuestion'].includes(type)) t.state='waiting';
    if(type==='codex.Retrying') {t.state='retrying';t.reason=event.message;}
    if(type==='codex.StatusUncertain') t.state='uncertain';
    if(type==='codex.Failed') t.state='failed';
    if(type==='codex.Stop') t.state='done';
    if(type==='codex.Interrupt') t.state='interrupted';
    if(type==='codex.SessionEnd') t.state='ended';
  }
  accept(t,signal) {
    if(!signal || signal.taskId!==t.taskId || signal.at<t.startedAt || (signal.at<t.lastAt&&!terminal.has(signal.state)) || terminal.has(t.state)) return;
    // Stop questions hold a live Hook after the model has finished its text response.
    if(signal.state==='done' && this.isAwaitingStopAnswer(t.id,t.taskId)) return;
    t.lastAt=signal.at;
    if(signal.state==='running') {
      if(t.state==='waiting' || this.isWaiting(t.id,t.taskId)) return;
      const resume=['uncertain','retrying'].includes(t.state);t.state='running';t.reason=null;
      if(resume) this.send(t,'Activity','Codex 已恢复任务活动');
      return;
    }
    if(signal.state===t.state && signal.reason===t.reason) return;
    t.state=signal.state;t.reason=signal.reason;
    const type={done:'Stop',interrupted:'Interrupt',failed:'Failed',retrying:'Retrying'}[signal.state];
    const message=signal.state==='failed'?`任务已中断：${signal.reason}`:signal.state==='retrying'?`请求异常，Codex 正在重试：${signal.reason}`:signal.state==='done'?'本轮已结束（桌面任务记录）':'任务已中断（桌面任务记录）';
    this.send(t,type,message,{errorCategory:signal.category || null,errorDetail:signal.detail || null});
  }
  send(t,type,message,meta={}) {this.emit({type:`codex.${type}`,conversationId:t.id,taskId:t.taskId,message,meta:{cwd:t.cwd,source:'task-health',...meta}});}
  readTranscript(t) {
    if(!t.file || !fs.existsSync(t.file)) {
      t.file=this.records.transcript(t.id,t.hint);
      if(!t.file) return;
    }
    const stat=fs.statSync(t.file);
    if(t.offset===null || stat.size<t.offset) {t.offset=Math.max(0,stat.size-512*1024);t.skipFirst=t.offset>0;t.buffer='';t.scanTurn=null;t.decoder=new TextDecoder();}
    const length=Math.min(stat.size-t.offset,256*1024);
    if(!length) return;
    const data=Buffer.alloc(length),handle=fs.openSync(t.file,'r');
    let bytesRead;
    try {bytesRead=fs.readSync(handle,data,0,length,t.offset);t.offset+=bytesRead;} finally {fs.closeSync(handle);}
    t.buffer+=t.decoder.decode(data.subarray(0,bytesRead),{stream:true});
    let end;
    while((end=t.buffer.indexOf('\n'))>=0) {
      const line=t.buffer.slice(0,end);t.buffer=t.buffer.slice(end+1);
      if(t.skipFirst) {t.skipFirst=false;continue;}
      try {
        const record=JSON.parse(line);
        if(record.type==='turn_context') t.scanTurn=record.payload?.turn_id || t.scanTurn;
        if(record.type==='event_msg' && record.payload?.type==='task_started') t.scanTurn=record.payload.turn_id || t.scanTurn;
        this.accept(t,taskRecord(record,t.scanTurn || t.taskId));
      } catch { /* Ignore unrecognized records and partially written lines. */ }
    }
    if(t.buffer.length>1024*1024) {t.buffer='';t.skipFirst=true;}
  }
  tick() {
    const candidates=[...this.tasks.values()].filter(t=>t.taskId&&!terminal.has(t.state)&&!(t.nextPollAt>this.now()));
    if(!candidates.length) return;
    let index=this.cursor%candidates.length;
    const budgetStart=Date.now();
    // Bound file/SQLite work so a large history cannot monopolize the panel's event loop.
    for(let count=0;count<Math.min(8,candidates.length);count++) {
      const t=candidates[index];index=(index+1)%candidates.length;
      // One unavailable source must not prevent the other source or timeout handling.
      try {this.readTranscript(t);} catch {}
      try {
        for(const row of this.records.logs(t)) {t.logCursor=Math.max(t.logCursor,Number(row.id));this.accept(t,taskLog(row,t.taskId,t.startedAt));}
      } catch {}
      if(['running','retrying'].includes(t.state) && !this.isWaiting(t.id,t.taskId) && this.now()-t.lastAt>=this.staleMs) {
        t.state='uncertain';
        this.send(t,'StatusUncertain','长时间未收到任务活动，状态未确认'+(t.reason?`；最后异常：${t.reason}`:'')+'。进度已暂停，有新活动时自动恢复。');
      }
      t.nextPollAt=t.state==='uncertain'&&this.now()-t.lastAt>3600000?this.now()+30000:0;
      if(Date.now()-budgetStart>=40) break;
    }
    this.cursor=index;
  }
  start() {this.timer=setInterval(()=>this.tick(),2000);this.timer.unref();}
  close() {clearInterval(this.timer);this.records.close();}
}
