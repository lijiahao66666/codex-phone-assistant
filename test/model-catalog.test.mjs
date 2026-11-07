import test from 'node:test';
import assert from 'node:assert/strict';
import { readModelCatalog, modelSettings, changeModel } from '../src/desktop/model-catalog.mjs';

const entry = (model, efforts = ['low', 'high']) => ({ model, displayName: model, hidden: false, defaultReasoningEffort: efforts[0], supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })) });

test('reads all catalog pages and rejects repeated cursors', async () => {
  const pages = [];
  const catalog = await readModelCatalog(async (_method, { cursor }) => { pages.push(cursor); return cursor === null ? { data: [entry('a')], nextCursor: 'next' } : { data: [entry('b')], nextCursor: null }; });
  assert.deepEqual(pages, [null, 'next']);
  assert.deepEqual(catalog.map(model => model.model), ['a', 'b']);
  await assert.rejects(readModelCatalog(async () => ({ data: [], nextCursor: 'again' })), /cursor/);
});

test('selection preserves mode and instructions and validates reasoning', async () => {
  const catalog = await readModelCatalog(async () => ({ data: [entry('a'), entry('b', ['medium'])], nextCursor: null }));
  const current = { mode: 'plan', settings: { model: 'a', reasoning_effort: 'high', developer_instructions: 'keep' } };
  assert.deepEqual(modelSettings(catalog, current, 'b'), { mode: 'plan', settings: { model: 'b', reasoning_effort: 'medium', developer_instructions: 'keep' } });
  assert.throws(() => modelSettings(catalog, current, 'b', 'high'), /effort/);
});

test('model update checks session after owner discovery', async () => {
  const catalog = await readModelCatalog(async () => ({ data: [entry('a'), entry('b')], nextCursor: null }));
  let sent = 0;
  const session = { status: 'ready', conversationId: 'thread', revision: 1, conversation: { ownerId: 'owner' }, value: { id: 'thread', threadRuntimeStatus: { type: 'idle' }, latestCollaborationMode: { mode: 'default', settings: { model: 'a', reasoning_effort: 'low', developer_instructions: null } } } };
  session.client = { async setCollaborationMode(_id, _mode, _settings, { beforeWrite }) { session.revision++; if (!beforeWrite()) throw Object.assign(new Error('changed'), { code: 'unavailable' }); sent++; } };
  await assert.rejects(changeModel({ catalog, session, model: 'b', effort: 'high' }), { code: 'unavailable' });
  assert.equal(sent, 0);
});
