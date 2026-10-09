import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOnlyScope } from './permission-scope.mjs';
import { DesktopCatalog } from './desktop-catalog.mjs';
import { AccountBalance } from './account-balance.mjs';
import { ProviderBalance } from './provider-balance.mjs';
import { MobilePresence } from './mobile-presence.mjs';
import { normalizePlan } from './public/progress.mjs';
import { normalizeQuestions, validateAnswers } from './questions.mjs';
import { TaskHealth, LocalTaskRecords } from './task-health.mjs';
import { serverConfig } from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = serverConfig(__dirname);
const app = express();
const port = config.port;
const host = '127.0.0.1';
const accessToken = config.accessToken;
const hookToken = config.hookToken;
const eventsFile = path.join(config.dataDir, 'events.ndjson');
fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.get('/api/health', (req,res) => res.json({app:'crc-codex-remote-control',version:'0.2.0',status:'ok'}));
app.use(express.static(path.join(__dirname, 'public')));

const clients = new Set();
const pending = new Map();
const decisions = new Map();
// Replies are transient: never persist them in events or expose them through panel history.
const answerResults = new Map();
const requestType = request => request.kind === 'question' ? 'question' : 'permission';
const waiters = new Map();
const conversationTitles = new Map();
let hookSeenAt = null;
let activeTaskId = null;
const sessions = new Map();
const presenceTtl = Number(config.env.MOBILE_PRESENCE_TTL_MS || 7000);
const mobilePresence = new MobilePresence({ ttlMs: Number.isFinite(presenceTtl) && presenceTtl >= 200 ? presenceTtl : 7000 });
const presenceKey = (sessionId, clientId) => `${sessionId}:${clientId}`;
const validClientId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(value);
const approvalTimeout = Math.min(86400000, Math.max(1000, Number(config.env.CODEX_APPROVAL_TIMEOUT_MS) || 86400000));
const approvalPollMs = Math.min(25000, Math.max(200, Number(config.env.CODEX_APPROVAL_POLL_MS) || 25000));
const hookLeaseMs = Math.max(approvalPollMs + 5000, Number(config.env.CODEX_HOOK_LEASE_MS) || 90000);
const desktopCatalog = new DesktopCatalog({ executable:config.codexBin, environment:config.env });
const providerBalance = new ProviderBalance({ codexHome:config.env.CODEX_HOME || undefined, environment:config.env });
const accountBalance = new AccountBalance({ read: async () => {
  const providerSettings = providerBalance.settings();
  if (providerSettings) return providerBalance.read(providerSettings);
  await desktopCatalog.connect();
  return desktopCatalog.rpc('account/rateLimits/read', {});
} });
process.once('exit', () => desktopCatalog.close());
const liveApprovalBridge = () => Boolean(hookToken && hookSeenAt && Date.now() - hookSeenAt < 600000);
let sequence = 0;
let taskHealth;
const readEvents = () => fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const history = readEvents();
sequence = history.at(-1)?.id || 0;
const publish = (event) => {
  const item = { id: ++sequence, ts: new Date().toISOString(), ...event };
  fs.appendFileSync(eventsFile, JSON.stringify(item) + '\n');
  const packet = `data: ${JSON.stringify(item)}\n\n`;
  for (const res of clients) res.write(`id: ${item.id}\n${packet}`);
  taskHealth?.observe(item);
  return item;
};
taskHealth=new TaskHealth({
  records:new LocalTaskRecords(config.env.CODEX_HOME || undefined),
  staleMs:Math.max(1000,Number(config.env.CODEX_TASK_STALE_MS) || 120000),
  isWaiting:(conversationId,taskId)=>[...pending.values()].some(r=>r.conversationId===conversationId&&r.taskId===taskId),
  isAwaitingStopAnswer:(conversationId,taskId)=>[...pending.values()].some(r=>r.conversationId===conversationId&&r.taskId===taskId&&r.kind==='question'&&r.origin==='stop'),
  emit:event=>{
    if(['codex.Failed','codex.Interrupt','codex.Stop'].includes(event.type)) {
      for(const request of [...pending.values()]) if(request.conversationId===event.conversationId&&request.taskId===event.taskId) expireRequest(request,'对应任务已结束或失败',true);
    }
    publish(event);
  }
});
for(const event of history) taskHealth.observe(event,{replay:true});
taskHealth.start();
process.once('exit',()=>taskHealth.close());
const secure = (req, res, next) => {
  const bearer = req.get('authorization')?.replace(/^Bearer\s+/i, '') || req.get('x-codex-token');
  const cookieId = req.headers.cookie?.match(/(?:^|;\s*)codex_session=([a-f0-9]+)/)?.[1];
  let session = sessions.get(cookieId);
  if(session && session.expiresAt<=Date.now()){sessions.delete(cookieId);session=null;}
  const token = bearer || session?.token;
  if (token !== accessToken) return res.status(401).json({ error: 'unauthorized' });
  req.panelSession = session;
  req.panelSessionId = cookieId;
  next();
};
const secureHook = (req, res, next) => {
  if (!hookToken || req.get('x-hook-token') !== hookToken) return res.status(401).json({ error: 'unauthorized' });
  hookSeenAt = Date.now();
  next();
};

app.post('/api/session', (req, res) => {
  if (req.body?.token !== accessToken) return res.status(401).json({ error: 'unauthorized' });
  const id = crypto.randomBytes(24).toString('hex');
  sessions.set(id, { token: accessToken, kind: req.body?.clientKind === 'mobile' ? 'mobile' : 'desktop', expiresAt:Date.now()+28800000 });
  const secureCookie=req.secure || req.get('x-forwarded-proto')==='https';
  res.setHeader('Set-Cookie', `codex_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookie?'; Secure':''}`);
  res.json({ serverTime: new Date().toISOString(), pending: [...pending.values()], liveApprovalBridge: liveApprovalBridge(), clientKind:sessions.get(id).kind, approvalMode:'resumable' });
});
app.get('/api/session', secure, (req, res) => res.json({ serverTime: new Date().toISOString(), pending: [...pending.values()], liveApprovalBridge: liveApprovalBridge(), clientKind:req.panelSession?.kind || 'desktop', approvalMode:'resumable' }));
app.get('/api/conversations', secure, (req, res) => res.json(desktopCatalog.snapshot()));
app.get('/api/account/balance', secure, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(accountBalance.snapshot());
});
app.get('/api/presence', secure, (req, res) => res.json({ mobileOnline: mobilePresence.online() }));
app.post('/api/presence', secure, (req, res) => {
  if (req.panelSession?.kind !== 'mobile' || !validClientId(req.body?.clientId)) return res.status(400).json({ error:'mobile_session_required' });
  const key = presenceKey(req.panelSessionId, req.body.clientId);
  if (req.body.active === false) {
    mobilePresence.pause(key); updateApprovalRouting();
  } else if (!mobilePresence.heartbeat(key)) return res.status(409).json({ error:'stream_required' });
  updateApprovalRouting();
  res.json({ mobileOnline: mobilePresence.online() });
});
app.get('/api/hooks/mobile-status', secureHook, (req, res) => res.json({ mobileOnline: mobilePresence.online(), approvalProtocol:2, questionProtocol:1, approvalMode:'resumable' }));
app.get('/api/events', secure, (req, res) => {
  const after = Number(req.query.after || 0);
  res.json(readEvents().filter(e => e.id > after).slice(0, 500));
});
app.get('/api/stream', secure, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(`retry: 3000\n\n`);
  const after = Number(req.query.after || 0);
  for (const event of readEvents()) if (event.id > after) res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
  clients.add(res);
  const mobileKey = req.panelSession?.kind === 'mobile' && validClientId(req.query.clientId) ? presenceKey(req.panelSessionId, req.query.clientId) : null;
  if (mobileKey) mobilePresence.connect(mobileKey, res);
  res.on('close', () => {
    clients.delete(res);
    if (mobileKey) { mobilePresence.disconnect(mobileKey, res); updateApprovalRouting(); }
  });
});
function handoff(request, reason) {
  if (!pending.has(request.id)) return;
  request.status = 'desktop'; request.decidedAt = new Date().toISOString(); request.note = reason;
  pending.delete(request.id); decisions.set(request.id, request);
  publish({ type:`${requestType(request)}.desktop`, conversationId:request.conversationId, taskId:request.taskId, message:`${reason}：${request.action}`, meta:request });
  const waiter = waiters.get(request.id);
  waiters.delete(request.id);
  if (waiter && !waiter.writableEnded) waiter.json({ decision:'desktop' });
}
function expireRequest(request, reason, cancelled=false) {
  if (!pending.has(request.id)) return;
  request.status=cancelled?'cancelled':'expired'; request.ready=false; request.note=reason;
  pending.delete(request.id); decisions.set(request.id,request);
  publish({type:`${requestType(request)}.${cancelled?'cancelled':'expired'}`,conversationId:request.conversationId,taskId:request.taskId,message:`${reason}：${request.action}`,meta:request});
  const waiter=waiters.get(request.id); waiters.delete(request.id);
  if(waiter && !waiter.writableEnded) waiter.json({decision:cancelled?'cancelled':'timeout'});
}
function updateApprovalRouting() {
  const online=mobilePresence.online(), now=Date.now();
  for(const request of [...pending.values()]) {
    if(now>=request.expiresAt || now-request.lastHookAt>=hookLeaseMs) {expireRequest(request,now>=request.expiresAt?(request.kind==='question'?'提问等待已到期，转回 Codex':'授权等待已到期，转回原生审批'):'任务回调已失联');continue;}
    const status=online?'pending':'parked';
    if(request.status===status) continue;
    request.status=status;
    publish({type:`${requestType(request)}.${online?'resumed':'parked'}`,conversationId:request.conversationId,taskId:request.taskId,message:online?`手机恢复在线，可继续处理：${request.action}`:`手机离线，请求已保留，可在电脑 CRC 面板处理：${request.action}`,meta:request});
  }
}
const presenceSweep = setInterval(updateApprovalRouting, Math.min(1000, mobilePresence.ttlMs / 4));
presenceSweep.unref();
app.post('/api/events', secure, (req, res) => {
  if (!req.body?.type) return res.status(400).json({ error: 'type is required' });
  if (req.body.type === 'task.started') activeTaskId = req.body.taskId || null;
  if (req.body.type === 'task.finished' && (!req.body.taskId || req.body.taskId === activeTaskId)) activeTaskId = null;
  res.status(201).json(publish({ type: req.body.type, taskId: req.body.taskId || null, message: String(req.body.message || ''), meta: req.body.meta || {} }));
});
app.post('/api/permission-requests', secure, (req, res) => res.status(410).json({ error: 'hook_required' }));
app.post('/api/hooks/event', secureHook, (req, res) => {
  const type = String(req.body?.type || 'unknown');
  const conversationId = String(req.body?.sessionId || '');
  if (!conversationId) return res.status(400).json({ error: 'sessionId required' });
  const taskId = req.body?.turnId || null;
  const message = String(req.body?.message || '').slice(0, 500);
  if(['Stop','Interrupt','SessionEnd'].includes(type)) {
    for(const request of [...pending.values()]) if(request.conversationId===conversationId && (type==='SessionEnd' || !taskId || request.taskId===taskId)) expireRequest(request,'对应任务已结束或中断',true);
  }
  if (type === 'UserPromptSubmit' && message && !conversationTitles.has(conversationId)) conversationTitles.set(conversationId, message.slice(0, 80));
  const plan = type === 'PostToolUse' && /(?:^|\.)update_plan$/.test(String(req.body?.toolName || '')) ? normalizePlan(req.body?.plan) : null;
  const event = publish({ type: `codex.${type}`, conversationId, taskId, message, meta: { cwd: req.body?.cwd || null, model: req.body?.model || null, toolName: req.body?.toolName || null, toolUseId: typeof req.body?.toolUseId === 'string' ? req.body.toolUseId.slice(0,200) : null, plan, conversationTitle: conversationTitles.get(conversationId) || conversationId } });
  taskHealth.observe(event,{transcriptPath:req.body?.transcriptPath});
  if(type==='PostToolUse' && /(?:^|[._])request_user_input(?:_async)?$/.test(String(req.body?.toolName || ''))) {
    for(const request of [...pending.values()]) {
      if(request.kind!=='question' || request.origin!=='tool' || request.conversationId!==conversationId || request.taskId!==taskId) continue;
      const sameCall=request.toolUseId && event.meta.toolUseId ? request.toolUseId===event.meta.toolUseId : request.toolName===req.body.toolName;
      if(sameCall) handoff(request,'提问回调未能接管，原工具已在 Codex 中执行。旧手机请求已关闭；请重新加载并信任提问 Hook 配置');
    }
  }
  res.status(201).json(event);
});
app.post('/api/hooks/permission', secureHook, (req, res) => {
  const body = req.body || {};
  if (!body.sessionId || !body.turnId || !body.toolName) return res.status(400).json({ error: 'sessionId, turnId and toolName required' });
  const id = crypto.randomUUID();
  const files = Array.isArray(body.files) ? body.files.map(String).slice(0, 100) : [];
  const request = { id, source: 'codex-hook', conversationId: String(body.sessionId), conversationTitle: conversationTitles.get(String(body.sessionId)) || String(body.sessionId), taskId: String(body.turnId), action: String(body.action || body.toolName).slice(0, 500), permission: String(body.permission || body.toolName).slice(0, 200), permissionMode: String(body.permissionMode || ''), reason: String(body.action || '').slice(0, 500), command: String(body.command || ''), toolName: String(body.toolName), cwd: String(body.cwd || ''), files, filesKnown: body.filesKnown === true && files.length > 0, toolInput: String(body.toolInput || ''), createdAt: new Date().toISOString(), status: 'pending' };
  const readScope = readOnlyScope(body.command);
  request.readOnly = readScope.readOnly;
  request.readPaths = readScope.readPaths;
  // The user decides on every genuine Hook request; scope detection is descriptive.
  request.canApprove = true;
  if (request.readOnly) request.permission = `只读列出目录前 ${readScope.limit} 个文件名，不修改文件`;
  const now=Date.now();
  request.expiresAt=Math.min(now+approvalTimeout,Number(body.expiresAt) || now+approvalTimeout);
  request.lastHookAt=now; request.ready=false;
  if(request.expiresAt<=now) return res.status(400).json({error:'approval_deadline_expired'});
  pending.set(id, request);
  publish({ type: 'permission.requested', conversationId: request.conversationId, taskId: request.taskId, message: `授权请求：${request.action}`, meta: request });
  taskHealth.observe({type:'permission.requested',conversationId:request.conversationId,taskId:request.taskId,ts:request.createdAt,meta:{cwd:request.cwd}},{transcriptPath:body.transcriptPath});
  updateApprovalRouting();
  res.status(201).json({ id });
});
app.post('/api/hooks/question', secureHook, (req, res) => {
  const body=req.body || {}, questions=normalizeQuestions(body.questions);
  if(!body.sessionId || !body.turnId || !questions || !['tool','stop'].includes(body.origin)) return res.status(400).json({error:'invalid_question'});
  const now=Date.now(), id=crypto.randomUUID();
  const request={id,kind:'question',source:'codex-hook',conversationId:String(body.sessionId),conversationTitle:conversationTitles.get(String(body.sessionId)) || String(body.sessionId),taskId:String(body.turnId),cwd:String(body.cwd || ''),toolName:String(body.toolName || 'Stop'),origin:body.origin,questions,action:'Codex 需要你回答',createdAt:new Date().toISOString(),status:'pending',ready:false,lastHookAt:now,expiresAt:Math.min(now+approvalTimeout,Number(body.expiresAt) || now+approvalTimeout)};
  request.toolUseId=typeof body.toolUseId==='string'?body.toolUseId.slice(0,200):null;
  if(request.expiresAt<=now) return res.status(400).json({error:'question_deadline_expired'});
  pending.set(id,request);
  publish({type:'question.requested',conversationId:request.conversationId,taskId:request.taskId,message:request.action,meta:request});
  taskHealth.observe({type:'question.requested',conversationId:request.conversationId,taskId:request.taskId,ts:request.createdAt,meta:{cwd:request.cwd}},{transcriptPath:body.transcriptPath});
  updateApprovalRouting();
  res.status(201).json({id});
});
app.get('/api/hooks/permission/:id/wait', secureHook, (req, res) => {
  updateApprovalRouting();
  const prior = decisions.get(req.params.id);
  if (prior) return res.json({ decision: prior.status==='expired'?'timeout':prior.status, ...(answerResults.has(prior.id)?{answers:answerResults.get(prior.id)}:{}) });
  const request = pending.get(req.params.id);
  if (!request || request.source !== 'codex-hook') return res.status(404).json({ error: 'request not found' });
  const previous=waiters.get(request.id);
  if(previous && !previous.writableEnded) previous.json({decision:'pending'});
  waiters.set(request.id, res);
  request.lastHookAt=Date.now();
  const firstWait=!request.ready;
  request.ready = true;
  if(firstWait) publish({ type: `${requestType(request)}.${request.status==='parked'?'parked':'waiting'}`, conversationId: request.conversationId, taskId: request.taskId, message: `等待手机或电脑 CRC 面板决定：${request.action}`, meta: request });
  const timer = setTimeout(() => {
    if (waiters.get(request.id) !== res) return;
    waiters.delete(request.id);
    res.json({ decision: 'pending' });
  }, approvalPollMs);
  res.on('close', () => {
    clearTimeout(timer);
    if (waiters.get(request.id) === res) {
      waiters.delete(request.id);
    }
  });
});
app.post('/api/hooks/permission/:id/release', secureHook, (req,res)=>{
  const request=pending.get(req.params.id);
  if(request) expireRequest(request,request.kind==='question'?'提问回调结束，转回 Codex':'授权回调结束，转回原生审批');
  answerResults.delete(req.params.id);
  res.json({released:Boolean(request)});
});
app.post('/api/question-requests/:id/answer', secure, (req,res)=>{
  updateApprovalRouting();
  const request=pending.get(req.params.id);
  if(!request) return res.status(404).json({error:'request not found'});
  if(request.kind!=='question') return res.status(400).json({error:'not a question'});
  if(!request.ready) return res.status(503).json({error:'question_bridge_offline'});
  let answers;
  try {answers=validateAnswers(request.questions,req.body?.answers);} catch(error) {return res.status(400).json({error:'invalid_answer',message:error.message});}
  request.status='answered'; request.decidedAt=new Date().toISOString();
  pending.delete(request.id); decisions.set(request.id,request); answerResults.set(request.id,answers);
  const cleanup=setTimeout(()=>answerResults.delete(request.id),60000); cleanup.unref();
  publish({type:'question.answered',conversationId:request.conversationId,taskId:request.taskId,message:'回答已提交，等待 Codex 处理',meta:request});
  const waiter=waiters.get(request.id); waiters.delete(request.id);
  if(waiter && !waiter.writableEnded) waiter.json({decision:'answered',answers});
  res.json({id:request.id,status:'answered'});
});
app.post('/api/permission-requests/:id/decision', secure, (req, res) => {
  updateApprovalRouting();
  const request = pending.get(req.params.id);
  if (!request) return res.status(404).json({ error: 'request not found' });
  if (request.source !== 'codex-hook' || !request.ready) return res.status(503).json({ error: 'approval_bridge_offline' });
  if (!['approved', 'denied', 'desktop'].includes(req.body?.decision)) return res.status(400).json({ error: 'decision must be approved, denied or desktop' });
  if(request.kind==='question') {
    if(req.body.decision!=='desktop') return res.status(400).json({error:'question_requires_answer'});
    handoff(request,'转到 Codex 中回答'); return res.json(request);
  }
  request.status = req.body.decision; request.decidedAt = new Date().toISOString(); request.note = String(req.body.note || '');
  pending.delete(request.id); decisions.set(request.id, request); publish({ type: `permission.${request.status}`, conversationId: request.conversationId, taskId: request.taskId, message: `${{ approved:'已批准', denied:'已拒绝', desktop:'转交电脑审批' }[request.status]}：${request.action}`, meta: request });
  const waiter = waiters.get(request.id); waiters.delete(request.id); if(waiter && !waiter.writableEnded) waiter.json({ decision: request.status });
  res.json(request);
});
app.get('/api/permission-requests/:id', secure, (req, res) => {
  const request = pending.get(req.params.id) || decisions.get(req.params.id);
  if (!request) return res.status(404).json({ error: 'request not found' });
  res.json(request);
});
app.delete('/api/permission-requests/:id', secure, (req, res) => {
  if (!pending.has(req.params.id)) return res.status(404).json({ error: 'request not found' });
  handoff(pending.get(req.params.id),'手动移交原生审批'); res.status(204).end();
});

app.get('/api/demo', secure, (req, res) => res.status(410).json({ error: 'demo_disabled' }));

app.listen(port, host, () => {
  console.log(`Codex Remote Control listening on http://${host}:${port}`);
  if (host === '127.0.0.1') console.log('For Tailscale, set HOST to the Tailscale IP or use a Tailscale Serve reverse proxy.');
  console.log('Access token loaded from configuration.');
});
