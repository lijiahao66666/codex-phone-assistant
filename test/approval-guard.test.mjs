import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectApproval, matchApproval } from '../src/desktop/approval-guard.mjs';

const command = { id: 7, method: 'item/commandExecution/requestApproval', params: {
  kind: 'command', threadId: 'thread', turnId: 'turn', itemId: 'item', command: 'echo test',
  availableDecisions: ['accept', 'decline', 'cancel'],
} };
const file = { id: 'request', method: 'item/fileChange/requestApproval', params: {
  threadId: 'thread', turnId: 'turn', itemId: 'file', reason: 'Write files',
} };

test('selects only a unique current thread approval and explicit decision', () => {
  const state = { id: 'thread', requests: [command, file] };
  assert.equal(matchApproval(state, 7, 'command', 'accept')?.command, 'echo test');
  assert.equal(matchApproval(state, 'request', 'file', 'decline')?.kind, 'file');
  assert.equal(matchApproval(state, 7, 'file', 'accept'), null);
  assert.equal(matchApproval(state, 7, 'command', 'acceptForSession'), null);
  assert.equal(matchApproval({ ...state, requests: [command, command] }, 7, 'command', 'accept'), null);
  assert.equal(inspectApproval(command, 'other'), null);
});

test('rejects missing details, unsupported permission scopes and decision sets', () => {
  assert.equal(inspectApproval({ ...command, params: { ...command.params, command: '' } }, 'thread'), null);
  assert.equal(inspectApproval({ ...command, params: { ...command.params, additionalPermissions: {} } }, 'thread'), null);
  assert.equal(inspectApproval({ ...command, params: { ...command.params, kind: 'stdin' } }, 'thread'), null);
  assert.equal(inspectApproval({ ...command, params: { ...command.params, availableDecisions: ['decline'] } }, 'thread'), null);
  assert.equal(inspectApproval({ ...file, params: { ...file.params, grantRoot: '/tmp' } }, 'thread'), null);
  assert.equal(inspectApproval({ ...file, params: { ...file.params, itemId: '' } }, 'thread'), null);
});
