import { DesktopSession } from '../desktop/session.mjs';
import { listDesktopThreads } from '../desktop/thread-list.mjs';
import { desktopIpcPool } from '../desktop/ipc-pool.mjs';
import { readDesktopReadState } from '../desktop/read-state.mjs';
import { inspectQuestions, parseQuestionReply, pendingAsyncQuestions, registerAsyncQuestionHistory } from '../desktop/async-question-guard.mjs';

const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 1024;
const requestKinds = new Map([
  ['item/tool/requestUserInput', 'question'],
  ['item/commandExecution/requestApproval', 'approval'],
  ['item/fileChange/requestApproval', 'approval'],
]);
const eventKey = (...parts) => JSON.stringify(parts);

function tailTurn(state) {
  const legacy = Array.isArray(state?.turns) ? state.turns : [];
  const history = state?.turnHistory?.kind === 'canonical' ? state.turnHistory.history : null;
  const island = history?.islands?.at(-1), entry = island?.entries?.at(-1);
  const canonical = entry ? history.entitiesByKey?.[entry.value] : null;
  const tail = legacy.at(-1);
  if (!tail) return canonical ?? null;
  if (!canonical || tail.turnId === canonical.turnId) return tail;
  // The canonical history is older than the live legacy tail in mixed states,
  // matching desktopView's merge order without projecting the full history.
  return tail;
}

function inputReplies(content, text) {
  if (Array.isArray(content)) {
    // Match the desktop projection, including its refusal to accept image
    // messages as structured answers. Never copy arbitrary message bodies.
    if (content.some(part => !['text', 'input_text'].includes(part?.type))) return [];
    let size = 0;
    const parts = [];
    for (const part of content) if (typeof part.text === 'string') {
      size += part.text.length + 1;
      if (size > 32768) return [];
      parts.push(part.text);
    }
    text = parts.join('\n');
  }
  return typeof text === 'string' && text.length <= 32768 ? parseQuestionReply(text) ?? [] : [];
}

function questionSummary(state) {
  const legacy = Array.isArray(state.turns) ? state.turns : [];
  const canonical = state.turnHistory?.kind === 'canonical' ? state.turnHistory.history : null;
  const raw = canonical ? canonical.islands.flatMap(island => island.entries.map(entry => canonical.entitiesByKey[entry.value])) : [...legacy];
  if (canonical) for (const turn of legacy) {
    const index = typeof turn?.turnId === 'string' ? raw.findIndex(value => value?.turnId === turn.turnId) : -1;
    if (index < 0) raw.push(turn); else raw[index] = turn;
  }
  const complete = !canonical && state.resumeState === 'resumed' && state.turnsPagination?.hasLoadedOldest !== false
    && !raw.some(turn => turn.itemsPagination?.hasLoadedOldest === false || turn.itemsPagination?.hasLoadedNewest === false || turn.itemsPagination?.evicted === true);
  // Reuse the exact private native-history proof used by desktopView, while
  // avoiding projection of tool output, media and agent message bodies.
  const view = { turns: raw.map(turn => ({ id: typeof turn?.turnId === 'string' ? turn.turnId : null, items: [] })), history: { complete } };
  const safe = registerAsyncQuestionHistory(view, state);
  const fallback = !canonical && !complete ? view.turns.at(-1) : null;
  for (let index = 0; index < raw.length; index++) {
    const turn = raw[index], projected = view.turns[index];
    const selected = safe.has(projected) || projected === fallback;
    const rawItems = Array.isArray(turn.items) ? turn.items : [];
    // Match native steering placement before inspecting chronological answers.
    const candidates = new Map(), markers = new Map();
    for (const item of rawItems) {
      if (item?.type === 'steeringUserMessage' && typeof item.serverUserMessageId === 'string') {
        const list = candidates.get(item.serverUserMessageId) ?? []; list.push(item); candidates.set(item.serverUserMessageId, list);
      }
      if (item?.type === 'steered' && typeof item.id === 'string') markers.set(item.id, (markers.get(item.id) ?? 0) + 1);
    }
    const movable = new Map([...candidates].filter(([id, list]) => list.length === 1 && markers.get(id) === 1).map(([id, list]) => [id, list[0]]));
    const items = rawItems.flatMap(item => item?.type === 'steeringUserMessage' && movable.get(item.serverUserMessageId) === item ? []
      : item?.type === 'steered' && movable.has(item.id) ? [movable.get(item.id)] : [item]);
    const addReplies = (content, text, accepted) => {
      const replies = inputReplies(content, text);
      if (replies.length) projected.items.push({ type: 'userMessage', [accepted ? 'questionReplyIds' : 'questionReplyPendingIds']: replies.map(reply => reply.questionItemId) });
    };
    if (selected) addReplies(turn.params?.input, null, turn.remodexOptimisticPendingTurn !== true);
    for (const item of items) {
      if (item?.type === 'agentMessage') {
        const questions = inspectQuestions(item);
        if (questions.length) projected.items.push({ type: 'agentMessage', id: item.id, questions });
      } else if (selected && (item?.type === 'userMessage' || item?.type === 'steeringUserMessage')) {
        const accepted = turn.remodexOptimisticPendingTurn !== true && (item.type === 'userMessage' || item.status === 'accepted' || item.steerAcknowledged === true);
        addReplies(item.type === 'steeringUserMessage' ? item.input : item.content, item.text, accepted);
        // Keep non-answer messages for the guard's incomplete legacy fallback.
        projected.items.push({ type: 'userMessage' });
      }
    }
  }
  const controls = [], resolved = [];
  const allItems = view.turns.flatMap(turn => turn.items);
  for (const turn of view.turns) for (const item of turn.items) {
    if (item.type !== 'agentMessage' || !validId(turn.id)) continue;
    const eventId = eventKey('question', state.id, turn.id, 'async', item.id);
    if (pendingAsyncQuestions(view, item.id)) controls.push({ eventId, kind: 'question' });
    // null from pendingAsyncQuestions also means unknown/submitting/ambiguous;
    // only an exact, accepted answer after a unique proven question resolves it.
    if (!safe.has(turn) || allItems.filter(value => value.type === 'agentMessage' && value.id === item.id).length !== 1) continue;
    const answers = new Set(allItems.slice(allItems.indexOf(item) + 1).flatMap(value => value.questionReplyIds ?? []));
    if (item.questions.every(question => answers.has(question.id))) resolved.push(eventId);
  }
  return { controls, resolved };
}

// Retain only turn/control identities. Native question proof can inspect a
// continuous loaded suffix without retaining its text or tool output.
export function taskNotificationSummary(state) {
  if (!validId(state?.id)) throw new TypeError('Invalid notification state');
  const turn = tailTurn(state), controls = new Map();
  for (const request of Array.isArray(state.requests) ? state.requests : []) {
    const kind = requestKinds.get(request?.method), p = request?.params;
    if (!kind || request.completed === true || !['string', 'number'].includes(typeof request.id) || p?.threadId !== state.id || !validId(p.turnId) || !validId(p.itemId)) continue;
    const eventId = eventKey(kind, state.id, p.turnId, request.method, request.id);
    controls.set(eventId, { eventId, kind });
  }
  const questions = questionSummary(state);
  for (const control of questions.controls) controls.set(control.eventId, control);
  const turnId = validId(turn?.turnId) ? turn.turnId : null;
  const status = typeof turn?.status === 'string' ? turn.status : 'unknown';
  const active = state.threadRuntimeStatus?.type === 'active' || status === 'inProgress' || controls.size > 0;
  return { turnId, status, startedAt: Number.isSafeInteger(turn?.turnStartedAtMs) ? turn.turnStartedAtMs : null, active, controls: [...controls.values()].sort((a, b) => a.eventId.localeCompare(b.eventId)), resolvedAsyncControls: questions.resolved };
}

function isAsyncControl(eventId) {
  try { return JSON.parse(eventId)?.[3] === 'async'; } catch { return false; }
}

export class TaskNotificationMonitor {
  constructor({ hostId = 'local', createSession = options => new DesktopSession(options), createProbeClient = () => desktopIpcPool.acquire(), readState = readDesktopReadState, listThreads = listDesktopThreads, onEvent = () => {}, onClear = () => {}, onHealth = () => {}, now = Date.now, pollMs = 5000, coalesceMs = 250, snapshotTimeoutMs = 15000, retryMs = 30000, maxActive = 64, concurrency = 2, discoveryConcurrency = 8, probesPerPoll = 64, initialProbeLimit = 64, maxQueued = 128, maxRecords = 10000 } = {}) {
    for (const [name, value] of Object.entries({ pollMs, coalesceMs, snapshotTimeoutMs, retryMs, maxActive, concurrency, discoveryConcurrency, probesPerPoll, initialProbeLimit, maxQueued, maxRecords })) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid ${name}`);
    if (concurrency > maxActive || discoveryConcurrency > 8 || maxActive > 256 || initialProbeLimit > 256 || maxQueued > 1024 || maxRecords > 50000 || typeof createSession !== 'function' || typeof createProbeClient !== 'function' || typeof readState !== 'function' || typeof listThreads !== 'function' || typeof onEvent !== 'function' || typeof onClear !== 'function' || typeof onHealth !== 'function') throw new TypeError('Invalid monitor configuration');
    Object.assign(this, { hostId, createSession, createProbeClient, readState, listThreads, onEvent, onClear, onHealth, now, pollMs, coalesceMs, snapshotTimeoutMs, retryMs, maxActive, concurrency, discoveryConcurrency, probesPerPoll, initialProbeLimit, maxQueued, maxRecords });
    this.records = new Map(); this.entries = new Map(); this.queue = new Map(); this.probing = new Map(); this.ready = new Map();
    this.generation = 0; this.running = false; this.budget = 0; this.healthSignature = null;
  }

  start() {
    if (this.running) return this;
    this.running = true; ++this.generation;
    this.timer = setInterval(() => { void this.poll(); }, this.pollMs); this.timer.unref?.();
    void this.poll(); return this;
  }

  async poll() {
    if (!this.running || this.polling) return;
    const generation = this.generation; this.polling = true;
    const previousCompleteListAt = this.lastCompleteListAt;
    this.pollIssue = false;
    try {
      await this.#readReceipts(generation);
      if (!this.running || generation !== this.generation) return;
      const { rows, complete } = await this.#list();
      if (!this.running || generation !== this.generation) return;
      const ids = new Set(rows.map(row => row.id));
      if (complete) for (const [id] of this.records) if (!ids.has(id)) { this.queue.delete(id); this.ready.delete(id); this.probing.get(id)?.abort.abort(); this.records.delete(id); this.#release(id); }
      const initial = !this.hasListed;
      let rank = 0;
      for (const row of rows.sort((a, b) => b.recency - a.recency || b.id.localeCompare(a.id))) {
        let record = this.records.get(row.id);
        if (!record) {
          if (this.records.size >= this.maxRecords) { this.#health('record-capacity', { limit: this.maxRecords }); break; }
          record = { recency: row.recency, summary: null, forceBaseline: true, retryAt: 0, failed: false, failures: 0, needsProbe: !initial || rank < this.initialProbeLimit,
            // A previous complete list proves this ID was absent. Its first
            // snapshot may already contain a short completed turn; require the
            // native start timestamp before treating that turn as a live event.
            liveAfter: !initial && Number.isSafeInteger(previousCompleteListAt) ? previousCompleteListAt : null };
          this.records.set(row.id, record);
          // Historical threads outside the recent window are metadata only.
          // Enabling notifications must not walk thousands of old owners or
          // request their complete histories in the background.
          if (record.needsProbe) this.#enqueue(row.id, row.recency);
        } else {
          const changed = record.recency !== row.recency; record.recency = row.recency;
          if (!this.entries.has(row.id)) {
            if (changed) { record.retryAt = 0; record.failures = 0; record.needsProbe = true; }
            const activeRetry = record.failed && record.summary?.active && this.now() >= record.retryAt;
            if (record.needsProbe || activeRetry) { record.needsProbe = true; this.#enqueue(row.id, row.recency, Boolean(activeRetry)); }
          }
        }
        rank++;
      }
      this.hasListed = true;
      this.listConfirmed = complete;
      this.lastCompleteListAt = complete && !this.pollIssue ? this.now() : null;
      this.budget = this.probesPerPoll;
      this.#pump();
    } catch {
      if (this.running && generation === this.generation) this.#health('list-unavailable');
    } finally { this.polling = false; if (this.running && generation === this.generation) this.#reportReadiness(); }
  }

  #enqueue(id, recency, activeRetry = false) {
    if (this.probing.has(id) || this.ready.has(id)) return;
    if (this.queue.has(id)) { this.queue.set(id, { recency, activeRetry }); return; }
    if (this.queue.size >= this.maxQueued) {
      this.#health('queue-capacity', { limit: this.maxQueued });
      const worst = [...this.queue].sort((a, b) => Number(a[1].activeRetry) - Number(b[1].activeRetry) || a[1].recency - b[1].recency)[0];
      if (!worst || Number(activeRetry) < Number(worst[1].activeRetry) || activeRetry === worst[1].activeRetry && recency <= worst[1].recency) return;
      this.queue.delete(worst[0]);
    }
    this.queue.set(id, { recency, activeRetry });
  }

  #failed(record) {
    record.failed = true; record.forceBaseline = true; record.liveAfter = null; record.failures++;
    record.retryAt = this.now() + Math.min(300000, this.retryMs * 2 ** Math.min(record.failures - 1, 20));
  }

  async #readReceipts(generation) {
    // A read may capture native state before its Promise settles. Only use
    // that sample for completion events already present when the scan began.
    const observedEvents = new Map();
    for (const [id, record] of this.records) if (record.latestEvent?.kind === 'completed') {
      observedEvents.set(id, { record, event: record.latestEvent });
    }
    let current;
    try { current = await this.readState(); } catch { current = null; }
    if (!this.running || generation !== this.generation) return;
    const valid = current?.status === 'available' && current.canReadUnread === true
      && typeof current.scopeKey === 'string' && current.scopeKey.length > 0 && current.unreadThreadIds instanceof Set;
    const previous = this.nativeReadState;
    this.nativeReadState = valid ? { scopeKey: current.scopeKey, unreadThreadIds: new Set(current.unreadThreadIds) } : null;
    for (const [id, record] of this.records) {
      if (!valid || !previous || previous.scopeKey !== current.scopeKey) record.unreadSeen = null;
      const event = record.latestEvent;
      const observed = observedEvents.get(id);
      if (!valid || observed?.record !== record || observed.event !== event) continue;
      if (current.unreadThreadIds.has(id)) {
        // The unread observation must postdate this exact completion event.
        // An older turn's unread bit cannot acknowledge a newer completion.
        record.unreadSeen = { scopeKey: current.scopeKey, eventId: event.eventId };
      } else if (previous?.scopeKey === current.scopeKey && record.unreadSeen?.scopeKey === current.scopeKey
          && record.unreadSeen.eventId === event.eventId && previous.unreadThreadIds.has(id)) {
        this.#clear(id, event.eventId, 'desktop-read');
      }
    }
  }

  async #list() {
    const rows = new Map(); let cursor = null, complete = true;
    for (let page = 0; page < 100; page++) {
      const value = await this.listThreads({ includeRecency: true, limit: 500, ...(cursor ? { before: cursor } : {}) });
      if (!Array.isArray(value?.statusCandidates) && (!Array.isArray(value?.recent) || !Array.isArray(value?.projects))) throw new Error('Invalid monitor list');
      const candidates = Array.isArray(value?.statusCandidates) ? value.statusCandidates : [
        ...(Array.isArray(value?.recent) ? value.recent : []),
        ...(Array.isArray(value?.projects) ? value.projects.flatMap(project => Array.isArray(project?.threads) ? project.threads : []) : []),
      ];
      for (const row of candidates) if (validId(row?.id) && Number.isSafeInteger(row.recency)) rows.set(row.id, { id: row.id, recency: row.recency });
      if (value?.truncated) { complete = false; this.#health('list-truncated'); }
      if (!value?.nextCursor) return { rows: [...rows.values()], complete };
      const next = value.nextCursor;
      if (!validId(next.id) || !Number.isSafeInteger(next.recency) || cursor && next.id === cursor.id && next.recency === cursor.recency) throw new Error('Invalid monitor cursor');
      cursor = next;
    }
    this.#health('list-page-capacity'); return { rows: [...rows.values()], complete: false };
  }

  #pump() {
    if (!this.running) return;
    if (this.pumping) { this.pumpAgain = true; return; }
    this.pumping = true;
    try {
      let pending = [...this.entries.values()].filter(entry => !entry.initialized).length;
      for (const [id, record] of [...this.ready].sort((a, b) => b[1].recency - a[1].recency)) {
        if (pending >= this.concurrency || this.entries.size >= this.maxActive) break;
        this.ready.delete(id);
        if (this.records.get(id) !== record || this.entries.has(id)) continue;
        record.needsProbe = false; pending++;
        this.#observe(id, record);
      }
      if (this.entries.size >= this.maxActive) {
        if (this.queue.size || this.ready.size) this.#health('active-capacity', { limit: this.maxActive, queued: this.queue.size + this.ready.size });
        return;
      }
      for (const [id] of [...this.queue].sort((a, b) => Number(b[1].activeRetry) - Number(a[1].activeRetry) || b[1].recency - a[1].recency)) {
        if (!this.budget || this.probing.size >= this.discoveryConcurrency || this.ready.size + this.probing.size >= this.maxQueued) break;
        const record = this.records.get(id);
        if (!record || this.entries.has(id) || this.probing.has(id) || this.ready.has(id)) { this.queue.delete(id); continue; }
        if (record.retryAt > this.now()) continue;
        this.queue.delete(id); record.needsProbe = false; this.budget--;
        this.#discover(id, record);
      }
    } finally {
      this.pumping = false;
      if (this.pumpAgain) { this.pumpAgain = false; queueMicrotask(() => this.#pump()); }
    }
  }

  #probeClient() {
    if (this.probeConnecting) return this.probeConnecting;
    if (this.probeClient?.state !== 'closed' && this.probeClient) return Promise.resolve(this.probeClient);
    const client = this.createProbeClient(); this.probeClient = client;
    const connecting = Promise.resolve().then(() => client.connect()).then(() => client).catch(async error => {
      if (this.probeClient === client) this.probeClient = null;
      await client.close().catch(() => {}); throw error;
    }).finally(() => { if (this.probeConnecting === connecting) this.probeConnecting = null; });
    this.probeConnecting = connecting; return connecting;
  }

  #discover(id, record) {
    const generation = this.generation, probe = { abort: new AbortController(), pending: null };
    this.probing.set(id, probe);
    // Discoveries share one pool lease and never follow or request history.
    // An absent historical owner therefore cannot occupy a snapshot slot.
    probe.pending = Promise.resolve().then(() => {
      if (!this.running || generation !== this.generation || this.records.get(id) !== record) throw new Error('Monitor probe cancelled');
      return this.#probeClient();
    }).then(client => {
      if (!this.running || generation !== this.generation || this.records.get(id) !== record) throw new Error('Monitor probe cancelled');
      return client.discover(id, this.hostId, { signal: probe.abort.signal });
    }).then(owner => {
      if (!this.running || generation !== this.generation || this.records.get(id) !== record) return;
      if (!validId(owner?.ownerId)) throw new Error('Owner unavailable');
      this.ready.set(id, record);
    }).catch(() => {
      if (!this.running || generation !== this.generation || this.records.get(id) !== record) return;
      record.needsProbe = false; this.#failed(record);
      if (record.summary?.active) this.#health('observe-unavailable');
    }).finally(() => {
      if (this.probing.get(id) === probe) this.probing.delete(id);
      if (this.running && generation === this.generation) { this.#pump(); this.#reportReadiness(); }
    });
  }

  #observe(id, record) {
    let session;
    try { session = this.createSession({ conversationId: id, hostId: this.hostId, snapshotTimeoutMs: this.snapshotTimeoutMs }); }
    catch { this.#failed(record); queueMicrotask(() => this.#pump()); return; }
    const entry = { session, initialized: false, latest: null, listener: null, timer: null, snapshotTimer: null };
    this.entries.set(id, entry);
    const fail = () => {
      if (this.entries.get(id) !== entry) return;
      this.#failed(record);
      if (record.summary?.active) this.#health('observe-unavailable');
      this.#release(id); this.#pump(); this.#reportReadiness();
    };
    entry.listener = change => {
      if (!this.running || this.entries.get(id) !== entry) return;
      if (change?.status !== 'ready' || !session.value) return fail();
      entry.latest = session.value;
      if (!entry.initialized) {
        clearTimeout(entry.snapshotTimer); entry.initialized = true;
        this.#process(id, entry, record); this.#pump();
      } else if (tailTurn(entry.latest)?.status === 'completed' && (record.summary?.turnId !== tailTurn(entry.latest)?.turnId || record.summary?.status !== 'completed')) {
        // Do not coalesce a completed turn away if the next turn starts in the
        // same 250 ms interval. Output-only changes remain coalesced below.
        clearTimeout(entry.timer); entry.timer = null; this.#process(id, entry, record);
      } else if (!entry.timer) {
        entry.timer = setTimeout(() => { entry.timer = null; this.#process(id, entry, record); }, this.coalesceMs); entry.timer.unref?.();
      }
    };
    session.on('state', entry.listener);
    entry.snapshotTimer = setTimeout(fail, this.snapshotTimeoutMs); entry.snapshotTimer.unref?.();
    try { session.start(); } catch { fail(); }
  }

  #process(id, entry, record) {
    if (!this.running || this.entries.get(id) !== entry || !entry.latest) return;
    let summary;
    try { summary = taskNotificationSummary(entry.latest); } catch {
      this.#failed(record);
      this.#health('state-invalid'); this.#release(id); this.#pump(); return;
    }
    const freshNewThread = !record.summary && Number.isSafeInteger(record.liveAfter) && summary.startedAt !== null && summary.startedAt >= record.liveAfter;
    const previous = freshNewThread ? { turnId: null, status: 'unknown', controls: [] } : record.summary;
    const previouslyObservedAt = freshNewThread ? record.liveAfter : record.observedAt, firstSummary = !entry.hasSummary;
    entry.hasSummary = true;
    // A missing async question in an unproven snapshot is still the same
    // known question, even when it was part of the non-notifying baseline.
    const currentControls = new Set(summary.controls.map(control => control.eventId));
    for (const control of record.summary?.controls ?? []) if (isAsyncControl(control.eventId)
        && !currentControls.has(control.eventId) && !summary.resolvedAsyncControls.includes(control.eventId)) summary.controls.push(control);
    const pendingControls = new Set(summary.controls.map(control => control.eventId));
    for (const eventId of record.emittedControls ?? []) if (!pendingControls.has(eventId) && (!isAsyncControl(eventId) || summary.resolvedAsyncControls.includes(eventId))) {
      this.#clear(id, eventId, 'resolved'); record.emittedControls.delete(eventId);
    }
    if (summary.controls.length || record.emittedControls?.size) summary.active = true;
    record.summary = summary; record.observedAt = this.now(); record.failed = false; record.retryAt = 0; record.failures = 0;
    // A turn that asks the user for input remains a question notification even
    // if its runtime also reports completed. Do not add a second completion
    // notification when that same question is subsequently answered.
    if (summary.controls.some(control => control.kind === 'question' && JSON.parse(control.eventId)[2] === summary.turnId) && summary.turnId) record.questionTurnId = summary.turnId;
    this.observedBaseline = true;
    if (previous && (!record.forceBaseline || freshNewThread)) {
      const priorControls = new Set(previous.controls.map(control => control.eventId));
      for (const control of summary.controls) if (!priorControls.has(control.eventId) && !record.emittedControls?.has(control.eventId)) this.#event(id, control);
      const observedCompletion = summary.turnId === previous.turnId && previous.status === 'inProgress';
      const newCompletedTurn = summary.turnId !== previous.turnId && summary.startedAt !== null && summary.startedAt >= previouslyObservedAt;
      if (summary.turnId && !summary.controls.length && !record.emittedControls?.size && record.questionTurnId !== summary.turnId && summary.status === 'completed' && (observedCompletion || newCompletedTurn)) this.#event(id, { kind: 'completed', eventId: eventKey('completed', id, summary.turnId) });
    }
    record.forceBaseline = false; record.liveAfter = null;
    if (!summary.active) { this.#release(id); this.#pump(); }
    if (firstSummary || previous?.active !== summary.active) this.#reportReadiness();
  }

  #event(threadId, { eventId, kind }) {
    const record = this.records.get(threadId);
    if (record) {
      record.latestEvent = { eventId, kind };
      record.unreadSeen = null;
      if (kind !== 'completed') { record.emittedControls ??= new Set(); record.emittedControls.add(eventId); }
    }
    try { Promise.resolve(this.onEvent({ eventId, threadId, kind, createdAt: this.now() })).catch(() => this.#health('delivery-unavailable')); }
    catch { this.#health('delivery-unavailable'); }
  }

  #clear(threadId, eventId, reason) {
    const record = this.records.get(threadId);
    if (record?.latestEvent?.eventId === eventId) { record.latestEvent = null; record.unreadSeen = null; }
    try { Promise.resolve(this.onClear({ threadId, eventId, reason, createdAt: this.now() })).catch(() => this.#health('delivery-unavailable')); }
    catch { this.#health('delivery-unavailable'); }
  }

  #health(reason, detail = {}) {
    if (['list-unavailable', 'list-truncated', 'list-page-capacity', 'record-capacity', 'queue-capacity', 'active-capacity', 'state-invalid'].includes(reason)) this.pollIssue = true;
    const signature = JSON.stringify([reason, detail]);
    if (signature === this.healthSignature) return;
    this.healthSignature = signature;
    try { this.onHealth({ reason, ...detail }); } catch { /* Observability must not interrupt follower cleanup. */ }
  }

  #reportReadiness() {
    if (!this.running || this.polling || !this.listConfirmed || this.pollIssue) return;
    if ([...this.records.values()].some(record => record.failed && record.summary?.active)) return this.#health('observe-unavailable');
    if (this.queue.size || this.probing.size || this.ready.size || [...this.entries.values()].some(entry => !entry.initialized) || [...this.records.values()].some(record => record.needsProbe)) return;
    if (!this.observedBaseline && this.records.size) return this.#health('observe-unavailable');
    this.#health('ready');
  }

  #release(id) {
    const entry = this.entries.get(id); if (!entry) return;
    this.entries.delete(id); clearTimeout(entry.timer); clearTimeout(entry.snapshotTimer);
    entry.session.off('state', entry.listener);
    const closing = Promise.resolve().then(() => entry.session.close()).catch(() => {});
    this.closing ??= new Set(); this.closing.add(closing); closing.finally(() => this.closing.delete(closing));
  }

  async close() {
    this.running = false; ++this.generation; clearInterval(this.timer); this.timer = null;
    this.nativeReadState = null;
    const probes = [...this.probing.values()];
    for (const probe of probes) probe.abort.abort();
    const client = this.probeClient; this.probeClient = null;
    if (client) await client.close().catch(() => {});
    await Promise.allSettled(probes.map(probe => probe.pending));
    this.probing.clear(); this.ready.clear();
    for (const id of this.entries.keys()) this.#release(id);
    this.queue.clear(); this.records.clear(); this.budget = 0; this.hasListed = false; this.listConfirmed = false; this.lastCompleteListAt = null; this.observedBaseline = false; this.healthSignature = null;
    await Promise.allSettled([...(this.closing ?? [])]);
  }

  stop() { return this.close(); }
}

export { TaskNotificationMonitor as TaskMonitor };
