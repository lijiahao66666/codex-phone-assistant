import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runtimeSettingsPatch } = require('remodex/src/codex-runtime-settings');

// The thread payload omits effective runtime settings carried beside it in
// start/resume responses. Apply those only after the owner hydrates the thread.
export function createOwnerSettingsObserver(owner, { pendingLimit = 1024 } = {}) {
  if (!Number.isInteger(pendingLimit) || pendingLimit < 1) throw new TypeError('Invalid pending limit');
  const pending = new Map();
  let sequence = 0;
  const supersedePending = (threadId, confirmedSequence, fields) => {
    for (const request of pending.values()) {
      if (request.threadId === threadId && request.sequence < confirmedSequence) {
        for (const field of fields) request.superseded.add(field);
      }
    }
  };
  return {
    observeInbound(raw, message) {
      owner.observeInbound(raw, message);
      if (message?.id == null || !['thread/start', 'thread/resume'].includes(message.method)) return;
      const threadId = message.method === 'thread/resume' ? message.params?.threadId : null;
      if (message.method === 'thread/resume' && (typeof threadId !== 'string' || !threadId)) return;
      const id = String(message.id);
      pending.delete(id);
      if (pending.size >= pendingLimit) pending.delete(pending.keys().next().value);
      pending.set(id, { threadId, sequence: ++sequence, superseded: new Set() });
    },
    observeOutbound(raw, message) {
      owner.observeOutbound(raw, message);
      if (message?.method === 'thread/settings/updated' && message.params?.threadSettings && owner.isThreadOwned(message.params.threadId)) {
        const patch = runtimeSettingsPatch(message.params.threadSettings, { authoritative: true });
        const fields = [];
        if (Object.hasOwn(patch, 'model')) fields.push('model');
        if (Object.hasOwn(patch, 'reasoningEffort')) fields.push('effort');
        supersedePending(message.params.threadId, ++sequence, fields);
      }
      if (message?.id == null || message.method) return;
      const id = String(message.id), request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      const result = message.result, threadId = result?.thread?.id;
      if (Object.hasOwn(message, 'error') || result?.remodexDesktopIpcMirror === true ||
          typeof threadId !== 'string' || !threadId ||
          (request.threadId && threadId !== request.threadId) || !owner.isThreadOwned(threadId)) return;
      const settings = {};
      if (typeof result.model === 'string' && result.model.trim()) settings.model = result.model;
      if (Object.hasOwn(result, 'reasoningEffort') && (result.reasoningEffort === null || typeof result.reasoningEffort === 'string')) {
        settings.effort = result.reasoningEffort;
      }
      // A partial confirmation only supersedes the fields it actually carries.
      // Keep independent effective settings from an earlier resume response.
      for (const field of request.superseded) delete settings[field];
      if (!Object.keys(settings).length) return;
      supersedePending(threadId, request.sequence, Object.keys(settings));
      // This is a local projection update, never an app-server mutation request.
      const update = { method: 'thread/settings/updated', params: { threadId, threadSettings: settings } };
      owner.observeOutbound(JSON.stringify(update), update);
    },
    clear() { pending.clear(); },
  };
}
