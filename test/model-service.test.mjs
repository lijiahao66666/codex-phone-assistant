import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelService } from '../src/desktop/model-service.mjs';

test('model change remains locked until a newer matching owner snapshot', async () => {
  let record, dispatched = 0;
  const journal = {
    get() { return record; },
    begin(_host, _thread, deviceId, operationId) { record = { deviceId, operationId, phase: 'prepared' }; return true; },
    dispatch() { record.phase = 'dispatching'; return true; },
    complete() { record = null; return true; },
    cancelPrepared() { record = null; return true; },
  };
  const session = { status: 'ready', conversationId: 'thread', revision: 1, conversation: { ownerId: 'owner' }, value: { id: 'thread', threadRuntimeStatus: { type: 'idle' }, latestCollaborationMode: { mode: 'default', settings: { model: 'a', reasoning_effort: 'low', developer_instructions: null } } } };
  session.client = { async setCollaborationMode(_id, _mode, _settings, options) { assert.equal(options.beforeWrite(), true); dispatched++; return { applied: true }; } };
  const service = createModelService({ hostId: 'host', journal, sessionFor: () => session, request: async () => ({ data: [{ model: 'b', displayName: 'B', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' }], nextCursor: null }) });
  try {
    assert.equal((await service.change({ deviceId: 'device', threadId: 'thread', model: 'b', effort: 'high' })).status, 'accepted');
    assert.equal(dispatched, 1);
    assert.equal(service.isLocked('thread'), true);
    session.revision++;
    session.value.latestCollaborationMode.settings = { model: 'b', reasoning_effort: 'high', developer_instructions: null };
    assert.equal(service.observe({ deviceId: 'device', threadId: 'thread', session }), true);
    assert.equal(service.isLocked('thread'), false);
  } finally { await service.close(); }
});
