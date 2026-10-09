import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function normalizeThread(thread) {
  let cwd = String(thread.cwd || '');
  if (cwd.startsWith('file:')) {
    try { cwd = fileURLToPath(cwd); } catch { cwd = ''; }
  }
  return {
    id: String(thread.id),
    title: String(thread.name || thread.preview || '未命名对话').slice(0, 300),
    cwd,
    updatedAt: Number(thread.updatedAt || thread.createdAt || 0) * 1000
  };
}

export class DesktopCatalog {
  constructor({ executable, spawnProcess = spawn, timeoutMs = 8000, environment = process.env } = {}) {
    this.environment = environment;
    this.executable = executable;
    this.spawnProcess = spawnProcess;
    this.timeoutMs = timeoutMs;
    this.items = [];
    this.updatedAt = null;
    this.error = null;
    this.pending = new Map();
    this.nextId = 0;
    this.refreshing = null;
    this.lastAttempt = 0;
  }

  snapshot() {
    if (Date.now() - this.lastAttempt > 15000 && !this.refreshing) this.refresh();
    return { items: this.items, updatedAt: this.updatedAt, loading: Boolean(this.refreshing), error: this.error };
  }

  findExecutable() {
    const candidates = [
      this.executable,
      process.env.CODEX_BIN,
      path.join(os.homedir(), '.codex', 'packages', 'app-server-daemon', 'current', 'bin', 'codex.exe'),
      path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
    ];
    const found = candidates.find(candidate => candidate && fs.existsSync(candidate));
    if (!found) throw new Error('找不到本机 Codex 可执行文件');
    return found;
  }

  async connect() {
    if (this.ready) return this.ready;
    this.ready = this.open();
    try { await this.ready; } catch (error) { this.close(); throw error; }
  }

  async open() {
    const child = this.spawnProcess(this.findExecutable(), ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env:this.environment });
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', () => {}); // Never send raw Codex logs to the phone.
    child.on('error', () => this.fail('Codex 对话目录进程启动失败'));
    child.on('exit', () => {
      if (this.child === child) {
        this.fail('Codex 对话目录连接中断');
        this.child = null; this.ready = null;
      }
    });
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id); clearTimeout(pending.timer);
          if (message.error) {
            const error = new Error('Codex 对话目录读取失败');
            if (typeof message.error.code === 'number') error.rpcCode = message.error.code;
            pending.reject(error);
          }
          else pending.resolve(message.result);
        } catch { /* Ignore non-RPC output. */ }
      }
    });
    await this.rpc('initialize', { clientInfo: { name: 'mobile-panel-catalog', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  }

  rpc(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error('读取 Codex 对话目录超时'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (error) this.fail('Codex 对话目录连接中断');
      });
    });
  }

  refresh() {
    if (this.refreshing) return this.refreshing;
    this.lastAttempt = Date.now();
    this.refreshing = (async () => {
      try {
        await this.connect();
        const items = [];
        let cursor = null;
        do {
          const result = await this.rpc('thread/list', {
            cursor, limit: 100, archived: false, sortKey: 'updated_at',
            sourceKinds: ['cli', 'vscode', 'appServer'], useStateDbOnly: true
          });
          for (const thread of result.data || []) items.push(normalizeThread(thread));
          cursor = result.nextCursor || null;
        } while (cursor);
        this.items = items; this.updatedAt = new Date().toISOString(); this.error = null;
      } catch (error) {
        this.error = error.message; this.close();
      } finally { this.refreshing = null; }
    })();
    return this.refreshing;
  }

  fail(message) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error(message)); }
    this.pending.clear();
  }
  close() {
    this.fail('Codex 对话目录连接已关闭');
    const child = this.child;
    this.child = null; this.ready = null;
    child?.kill();
  }
}
