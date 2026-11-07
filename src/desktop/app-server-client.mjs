import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const trackedWrites = new Set(['thread/start', 'thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt', 'thread/settings/update']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Owns one stdio app-server. Observers receive each outbound request exactly once.
export class AppServerClient extends EventEmitter {
  constructor({ binary, cwd, env = process.env, timeout = 15000, args = ['app-server'], spawnProcess = spawn, lateResponseLimit = 1024 } = {}) {
    super();
    if (!binary || !cwd) throw new TypeError('binary and cwd required');
    if (!Number.isInteger(lateResponseLimit) || lateResponseLimit < 1 || lateResponseLimit > 4096) throw new TypeError('invalid late response limit');
    this.child = spawnProcess(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map(); this.nextId = 0; this.timeout = timeout; this.closed = false;
    this.instanceId = randomUUID(); this.lateResponseLimit = lateResponseLimit; this.lateResponses = new Map();
    this.child.stderr.resume();
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on('line', raw => this.#receive(raw));
    this.child.on('error', error => this.#fail(error));
    this.child.on('exit', () => this.#fail(new Error('app-server exited')));
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'codex-phone-assistant', version: '1' }, capabilities: { experimentalApi: true } });
    this.sendRaw(JSON.stringify({ method: 'initialized', params: {} }));
    return this;
  }
  request(method, params, { observe = true, attemptId = null } = {}) {
    if (this.closed) return Promise.reject(new Error('app-server unavailable'));
    if (attemptId !== null && (typeof attemptId !== 'string' || !uuid.test(attemptId))) throw new TypeError('invalid attempt ID');
    const id = ++this.nextId, message = { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (trackedWrites.has(method)) {
          if (this.lateResponses.size >= this.lateResponseLimit) this.lateResponses.delete(this.lateResponses.keys().next().value);
          const threadId = typeof params?.threadId === 'string' && uuid.test(params.threadId) ? params.threadId : null;
          this.lateResponses.set(id, { instanceId: this.instanceId, requestId: id, method, threadId, attemptId });
        }
        reject(Object.assign(new Error('app-server request timed out'), { code: 'outcome-unknown', instanceId: this.instanceId, requestId: id, attemptId }));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { const raw = JSON.stringify(message); if (observe) this.emit('inbound', raw, message); this.sendRaw(raw); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  sendRaw(raw) {
    if (this.closed || !this.child.stdin.writable) throw new Error('app-server unavailable');
    this.child.stdin.write(`${raw}\n`);
  }
  invalidate(error) { this.#fail(error); }
  #receive(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { this.#fail(new Error('invalid app-server JSON')); this.child.kill(); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { this.#fail(new Error('invalid app-server message')); this.child.kill(); return; }
    this.emit('outbound', raw, message);
    if (message.id == null || message.method) return;
    const late = this.lateResponses.get(message.id);
    if (late) {
      this.lateResponses.delete(message.id);
      const hasResult = Object.hasOwn(message, 'result'), hasError = Object.hasOwn(message, 'error');
      const validError = message.error && Number.isSafeInteger(message.error.code);
      const status = hasResult && !hasError ? 'success' : !hasResult && hasError && validError ? 'error' : 'invalid';
      this.emit('lateResponse', { ...late, status,
        ...(status === 'error' ? { errorCode: message.error.code,
          writerConflict: late.method === 'thread/resume' && message.error.code === -32600 && typeof message.error.message === 'string' && /already has an active writer/i.test(message.error.message) } : {}) });
      return;
    }
    if (!this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(pending.timer);
    const hasResult = Object.hasOwn(message, 'result'), hasError = Object.hasOwn(message, 'error');
    if (hasResult === hasError || (hasError && (!message.error || !Number.isSafeInteger(message.error.code)))) {
      pending.reject(Object.assign(new Error('invalid app-server response'), { code: 'outcome-unknown' }));
    } else if (hasError) pending.reject(Object.assign(new Error(message.error.message || 'app-server error'), { rpcError: message.error }));
    else pending.resolve(message.result);
  }
  #fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.lateResponses.clear(); this.lines.close(); this.emit('unavailable', error);
  }
  async close() {
    if (!this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null) return;
    if (!this.closed) this.#fail(new Error('app-server closed'));
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 2000);
      this.child.once('close', () => { clearTimeout(timer); resolve(); });
      this.child.kill('SIGTERM');
    });
  }
}
