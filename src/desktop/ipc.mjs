import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { absolutePath } from '../common/path-utils.mjs';

const defaultSocketPath = process.platform === 'win32'
  ? '\\\\.\\pipe\\codex-ipc'
  : join(homedir(), '.codex', 'ipc', 'ipc.sock');

// This private desktop protocol is version-specific; writes require explicit methods.
export class DesktopIpc extends EventEmitter {
  #socket;
  constructor({ socketPath = defaultSocketPath, timeout = 5000, maxFrame = 64 * 1024 * 1024 } = {}) {
    super();
    this.socketPath = socketPath;
    this.timeout = timeout;
    this.maxFrame = maxFrame;
    this.frameHeader = Buffer.alloc(4);
    this.frameHeaderBytes = 0;
    this.frameLength = null;
    this.frameChunks = [];
    this.frameBytes = 0;
    this.pending = new Map();
    this.subscriptions = new Map();
    this.state = 'new';
  }

  async connect() {
    if (this.state !== 'new') throw new Error('Client already used');
    this.state = 'connecting';
    this.#socket = net.createConnection(this.socketPath);
    this.#socket.on('data', chunk => this.receive(chunk));
    this.#socket.on('error', error => { this.failure = error; });
    this.#socket.on('close', () => this.disconnected());
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#socket.destroy(); reject(new Error('IPC connection timed out')); }, this.timeout);
      this.#socket.once('connect', () => { clearTimeout(timer); resolve(); });
      this.#socket.once('error', error => { clearTimeout(timer); reject(error); });
    });
    try {
      const response = await this.#request('initialize', { clientType: 'codex-hub' }, { sourceClientId: 'initializing-client' });
      if (typeof response.result?.clientId !== 'string') throw new Error('Missing IPC client ID');
      this.clientId = response.result.clientId;
      this.state = 'ready';
    } catch (error) { this.#socket.destroy(); throw error; }
    return this;
  }

  #send(message) {
    if (!this.#socket || this.#socket.destroyed || !this.#socket.writable) throw new Error('IPC disconnected');
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > this.maxFrame) throw new Error('IPC frame too large');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    this.#socket.write(Buffer.concat([header, body]));
  }

  #request(method, params, { sourceClientId = this.clientId, version = 1, targetClientId, timeout = this.timeout } = {}) {
    const versions = { initialize: 1, 'thread-owner-discovery': 1, 'thread-follower-start-turn': 2,
      'thread-follower-steer-turn': 1, 'thread-follower-interrupt-turn': 4, 'thread-follower-update-thread-settings': 2,
      'thread-follower-command-approval-decision': 1, 'thread-follower-file-approval-decision': 1,
      'thread-follower-submit-user-input': 1, 'thread-follower-load-complete-history': 1 };
    if (versions[method] !== version) throw new Error('Unsupported IPC method or version');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`${method} timed out`)); }, timeout);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.#send({ type: 'request', requestId, sourceClientId, version, method, params, ...(targetClientId ? { targetClientId } : {}) }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }

  async discover(conversationId, hostId = 'local') {
    if (this.state !== 'ready') throw new Error('IPC not ready');
    if (!conversationId || !hostId) throw new Error('conversationId and hostId required');
    const response = await this.#request('thread-owner-discovery', { hostId, conversationId });
    if (!response.handledByClientId) throw new Error('Thread owner not found');
    return { ownerId: response.handledByClientId, result: response.result };
  }

  // Read-only liveness probe for a thread that another client claims to own.
  // `thread-owner-discovery` answers from Desktop's ownership cache, so a cached
  // owner can outlive the process that really held the writer. Asking that client
  // for the history revision is the cheapest way to prove it still responds.
  async probeOwner(conversationId, ownerId, { timeout = 2000 } = {}) {
    if (this.state !== 'ready') throw new Error('IPC not ready');
    if (typeof conversationId !== 'string' || !conversationId || typeof ownerId !== 'string' || !ownerId) throw new TypeError('conversationId and ownerId required');
    const response = await this.#request('thread-follower-load-complete-history', { conversationId }, { targetClientId: ownerId, timeout });
    return response?.result ?? null;
  }

  async #control(method, conversationId, params, version = 1, expectedOwnerId, beforeWrite) {
    if (typeof conversationId !== 'string' || !conversationId.trim()) throw new TypeError('conversationId required');
    if (typeof expectedOwnerId !== 'string' || !expectedOwnerId) throw new TypeError('expectedOwnerId required');
    const { ownerId } = await this.discover(conversationId, 'local');
    if (ownerId !== expectedOwnerId) throw Object.assign(new Error('Thread owner changed'), { code: 'unavailable' });
    if (this.state !== 'ready') throw new Error('IPC not ready');
    if (beforeWrite && !(await beforeWrite())) throw Object.assign(new Error('Thread state changed'), { code: 'unavailable' });
    if (this.state !== 'ready') throw new Error('IPC not ready');
    const response = await this.#request(method, { conversationId, ...params }, { version, targetClientId: ownerId });
    if (response.handledByClientId && response.handledByClientId !== ownerId) throw new Error('Unexpected thread owner');
    return response.result;
  }

  async startTurn(conversationId, turnStart, { expectedOwnerId, beforeWrite } = {}) {
    if (!turnStart || typeof turnStart !== 'object' || Array.isArray(turnStart) ||
        !turnStart.request || typeof turnStart.request !== 'object' || Array.isArray(turnStart.request) ||
        !turnStart.context || typeof turnStart.context !== 'object' || Array.isArray(turnStart.context)) throw new TypeError('turnStart request and context required');
    return this.#control('thread-follower-start-turn', conversationId, { turnStart: { request: turnStart.request, context: turnStart.context } }, 2, expectedOwnerId, beforeWrite);
  }

  async steerTurn(conversationId, input, { cwd, clientUserMessageId = randomUUID(), expectedOwnerId, beforeWrite } = {}) {
    if (!Array.isArray(input) || input.length === 0 || input.some(item => item?.type === 'text' ? typeof item.text !== 'string' : item?.type !== 'localImage' || !absolutePath(item.path))) throw new TypeError('input must contain text or local images');
    if (!absolutePath(cwd)) throw new TypeError('absolute cwd required');
    if (typeof clientUserMessageId !== 'string' || !clientUserMessageId) throw new TypeError('invalid clientUserMessageId');
    const text = input.filter(item => item.type === 'text').map(item => item.text).join('\n');
    const imageAttachments = input.flatMap((item, index) => item.type === 'localImage' ? [{ id: `${clientUserMessageId}:${index}`, src: item.path, localPath: item.path }] : []);
    const restoreMessage = { id: clientUserMessageId, text, cwd, createdAt: Date.now(),
      context: { prompt: text, addedFiles: [], fileAttachments: [], ideContext: null, imageAttachments, workspaceRoots: [cwd] } };
    return this.#control('thread-follower-steer-turn', conversationId, { input, restoreMessage, clientUserMessageId }, 1, expectedOwnerId, beforeWrite);
  }

  async interruptTurn(conversationId, expectedTurnId, { expectedOwnerId } = {}) {
    if (typeof expectedTurnId !== 'string' || !expectedTurnId) throw new TypeError('expectedTurnId required');
    return this.#control('thread-follower-interrupt-turn', conversationId, { mode: 'user-stop', expectedTurnId }, 4, expectedOwnerId);
  }

  async setCollaborationMode(conversationId, mode, settings, { expectedOwnerId, beforeWrite } = {}) {
    if (!['plan', 'default'].includes(mode) || typeof settings?.model !== 'string' || !settings.model || (settings.reasoning_effort !== null && typeof settings.reasoning_effort !== 'string') || (settings.developer_instructions !== null && typeof settings.developer_instructions !== 'string')) throw new TypeError('Invalid collaboration mode settings');
    return this.#control('thread-follower-update-thread-settings', conversationId, { threadSettings: { collaborationMode: { mode, settings: { model: settings.model, reasoning_effort: settings.reasoning_effort, developer_instructions: settings.developer_instructions } } } }, 2, expectedOwnerId, beforeWrite);
  }

  async replyCommandApproval(conversationId, requestId, decision, { expectedOwnerId } = {}) {
    return this.#approval('thread-follower-command-approval-decision', conversationId, requestId, decision, expectedOwnerId);
  }

  async replyFileApproval(conversationId, requestId, decision, { expectedOwnerId } = {}) {
    return this.#approval('thread-follower-file-approval-decision', conversationId, requestId, decision, expectedOwnerId);
  }

  async #approval(method, conversationId, requestId, decision, expectedOwnerId) {
    if (!['string', 'number'].includes(typeof requestId) || requestId === '') throw new TypeError('requestId required');
    if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision)) throw new TypeError('unsupported approval decision');
    return this.#control(method, conversationId, { requestId, decision }, 1, expectedOwnerId);
  }

  async replyUserInput(conversationId, requestId, response, { expectedOwnerId } = {}) {
    if (!['string', 'number'].includes(typeof requestId) || requestId === '') throw new TypeError('requestId required');
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new TypeError('response required');
    return this.#control('thread-follower-submit-user-input', conversationId, { requestId, response }, 1, expectedOwnerId);
  }

  async subscribe(conversationId, listener, hostId = 'local', { beforeFollow } = {}) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const key = JSON.stringify([hostId, conversationId]);
    if (this.subscriptions.has(key)) throw new Error('Thread already subscribed');
    const subscription = { conversationId, hostId, listener, ownerId: null };
    this.subscriptions.set(key, subscription);
    try {
      const { ownerId } = await this.discover(conversationId, hostId);
      if (this.state !== 'ready' || this.subscriptions.get(key) !== subscription) throw new Error('Subscription cancelled');
      if (beforeFollow) await beforeFollow();
      if (this.state !== 'ready' || this.subscriptions.get(key) !== subscription) throw new Error('Subscription cancelled');
      if (beforeFollow && (await this.discover(conversationId, hostId)).ownerId !== ownerId) throw new Error('Thread owner changed');
      if (this.state !== 'ready' || this.subscriptions.get(key) !== subscription) throw new Error('Subscription cancelled');
      subscription.ownerId = ownerId;
      this.#follow(subscription, true);
    } catch (error) { if (this.subscriptions.get(key) === subscription) this.subscriptions.delete(key); throw error; }
    return () => this.subscriptions.get(key) === subscription && this.unsubscribe(conversationId, hostId);
  }

  #follow(subscription, following) {
    this.#send({ type: 'broadcast', method: 'thread-stream-following-changed', sourceClientId: this.clientId,
      version: 1, targetClientIds: [subscription.ownerId], params: { conversationId: subscription.conversationId, hostId: subscription.hostId, following } });
  }

  unsubscribe(conversationId, hostId = 'local') {
    const key = JSON.stringify([hostId, conversationId]);
    const subscription = this.subscriptions.get(key);
    if (!subscription) return false;
    this.subscriptions.delete(key);
    if (subscription.ownerId && this.state === 'ready') this.#follow(subscription, false);
    return true;
  }

  receive(chunk) {
    let offset = 0;
    while (offset < chunk.length || (this.frameLength === 0 && this.frameHeaderBytes === 4)) {
      if (this.frameLength === null) {
        const count = Math.min(4 - this.frameHeaderBytes, chunk.length - offset);
        chunk.copy(this.frameHeader, this.frameHeaderBytes, offset, offset + count);
        this.frameHeaderBytes += count;
        offset += count;
        if (this.frameHeaderBytes < 4) return;
        this.frameLength = this.frameHeader.readUInt32LE();
        if (this.frameLength > this.maxFrame) { this.failure = new Error('IPC frame too large'); this.#socket.destroy(); return; }
      }
      const count = Math.min(this.frameLength - this.frameBytes, chunk.length - offset);
      if (count) this.frameChunks.push(chunk.subarray(offset, offset + count));
      this.frameBytes += count;
      offset += count;
      if (this.frameBytes < this.frameLength) return;
      const body = this.frameChunks.length === 1 ? this.frameChunks[0] : Buffer.concat(this.frameChunks, this.frameLength);
      this.frameHeaderBytes = 0;
      this.frameLength = null;
      this.frameChunks = [];
      this.frameBytes = 0;
      let message;
      try { message = JSON.parse(body.toString('utf8')); }
      catch { this.failure = new Error('Invalid IPC JSON'); this.#socket.destroy(); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        this.failure = new Error('Invalid IPC message');
        this.#socket.destroy();
        return;
      }
      const pending = message.type === 'response' && this.pending.get(message.requestId);
      if (pending) {
        this.pending.delete(message.requestId); clearTimeout(pending.timer);
        if (message.resultType === 'success') pending.resolve(message);
        else {
          const known = ['no-client-found', 'client-disconnected', 'request-timeout', 'request-version-mismatch', 'no-handler-for-request', 'server-closed'];
          const code = known.includes(message.error) ? message.error : 'owner-error';
          const error = new Error(`IPC request failed: ${code}`);
          error.code = code;
          pending.reject(error);
        }
      } else if (message.type === 'broadcast' && message.method === 'client-status-changed' && message.params?.status === 'disconnected' && typeof message.params.clientId === 'string' && message.sourceClientId === message.params.clientId) {
        this.emit('ownerDisconnected', message.params.clientId);
      } else if (message.type === 'broadcast' && message.method === 'thread-stream-state-changed') {
        for (const subscription of this.subscriptions.values()) {
          if (subscription.ownerId === message.sourceClientId && subscription.conversationId === message.params?.conversationId &&
              (message.params?.hostId == null || subscription.hostId === message.params.hostId)) {
            try { subscription.listener(message.params.change, { ownerId: subscription.ownerId, hostId: subscription.hostId, conversationId: subscription.conversationId }); }
            catch (error) { this.emit('listenerError', error); }
          }
        }
      }
    }
  }

  disconnected() {
    const intentional = this.state === 'closing';
    this.state = 'closed';
    this.frameHeaderBytes = 0; this.frameLength = null; this.frameChunks = []; this.frameBytes = 0;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.failure ?? new Error('IPC disconnected')); }
    this.pending.clear(); this.subscriptions.clear();
    this.emit('disconnect', { intentional, error: this.failure });
  }

  async close() {
    if (this.state === 'closed') return;
    if (!this.#socket) { this.state = 'closed'; return; }
    if (this.state === 'ready') for (const sub of this.subscriptions.values()) if (sub.ownerId) {
      try { this.#follow(sub, false); } catch { /* The peer may have closed before its close event. */ }
    }
    this.subscriptions.clear();
    this.state = 'closing';
    await new Promise(resolve => {
      const timer = setTimeout(() => this.#socket.destroy(), this.timeout);
      this.#socket.once('close', () => { clearTimeout(timer); resolve(); });
      this.#socket.end();
    });
  }
}
