const validEffort = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\x00-\x1f\x7f]/.test(value);

export async function readModelCatalog(request, { pageSize = 100, maxPages = 20 } = {}) {
  if (typeof request !== 'function') throw new TypeError('request required');
  let cursor = null;
  const cursors = new Set(), models = new Map();
  for (let page = 0; page < maxPages; page++) {
    const result = await request('model/list', { cursor, limit: pageSize, includeHidden: false });
    if (!result || !Array.isArray(result.data) || !(result.nextCursor === null || typeof result.nextCursor === 'string')) throw new Error('Invalid model catalog');
    for (const entry of result.data) {
      if (!entry || entry.hidden !== false || typeof entry.model !== 'string' || !entry.model || typeof entry.displayName !== 'string' || !entry.displayName || !Array.isArray(entry.supportedReasoningEfforts)) continue;
      const efforts = [...new Set(entry.supportedReasoningEfforts.map(option => option?.reasoningEffort).filter(validEffort))];
      if (!efforts.length || !efforts.includes(entry.defaultReasoningEffort) || models.has(entry.model)) throw new Error('Invalid model catalog');
      models.set(entry.model, { model: entry.model, displayName: entry.displayName, defaultReasoningEffort: entry.defaultReasoningEffort, supportedReasoningEfforts: efforts, isDefault: entry.isDefault === true });
    }
    if (result.nextCursor === null) return [...models.values()];
    if (!result.nextCursor || cursors.has(result.nextCursor)) throw new Error('Invalid model cursor');
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error('Model catalog incomplete');
}

export function modelSettings(catalog, current, requestedModel, requestedEffort = null) {
  if (!Array.isArray(catalog) || !current || !['plan', 'default'].includes(current.mode) || typeof current.settings?.model !== 'string' || !current.settings.model || !(current.settings.developer_instructions === null || typeof current.settings.developer_instructions === 'string')) throw new Error('Invalid current model settings');
  const model = catalog.find(entry => entry.model === requestedModel);
  if (!model || !Array.isArray(model.supportedReasoningEfforts)) throw new Error('Model unavailable');
  const oldEffort = current.settings.reasoning_effort;
  if (oldEffort !== null && typeof oldEffort !== 'string') throw new Error('Invalid current model settings');
  const effort = requestedEffort ?? (model.supportedReasoningEfforts.includes(oldEffort) ? oldEffort : model.defaultReasoningEffort);
  if (!model.supportedReasoningEfforts.includes(effort)) throw new Error('Reasoning effort unavailable');
  return { mode: current.mode, settings: { model: model.model, reasoning_effort: effort, developer_instructions: current.settings.developer_instructions } };
}

export async function changeModel({ catalog, session, model, effort = null, validateCaller = () => true }) {
  if (!session || session.status !== 'ready' || !session.client || session.value?.id !== session.conversationId || session.value.threadRuntimeStatus?.type !== 'idle' || typeof session.conversation?.ownerId !== 'string' || !session.conversation.ownerId) throw Object.assign(new Error('Session unavailable'), { code: 'unavailable' });
  const owner = session.conversation.ownerId, revision = session.revision, client = session.client;
  const settings = modelSettings(catalog, session.value.latestCollaborationMode, model, effort);
  const beforeWrite = () => validateCaller() && session.status === 'ready' && session.client === client && session.revision === revision && session.conversation.ownerId === owner && session.value?.id === session.conversationId && session.value.threadRuntimeStatus?.type === 'idle';
  if (!beforeWrite()) throw Object.assign(new Error('Session changed'), { code: 'unavailable' });
  return client.setCollaborationMode(session.conversationId, settings.mode, settings.settings, { expectedOwnerId: owner, beforeWrite });
}
