// Only an acknowledged operation plus a matching Desktop user item can retire
// an old revision guard. Optimistic prompt params alone are not evidence.
export function confirmedUserOperation(state, threadId, operationId) {
  if (!state || state.id !== threadId || typeof operationId !== 'string' || !operationId) return false;
  const turns = Array.isArray(state.turns) ? [...state.turns] : [];
  const history = state.turnHistory?.kind === 'canonical' ? state.turnHistory.history : null;
  if (history) {
    if (!Array.isArray(history.islands) || !history.entitiesByKey || typeof history.entitiesByKey !== 'object') return false;
    for (const island of history.islands) {
      if (!Array.isArray(island?.entries)) return false;
      for (const entry of island.entries) {
        const turn = history.entitiesByKey[entry?.value];
        if (!turn || typeof turn !== 'object') return false;
        turns.push(turn);
      }
    }
  }
  const byId = new Map();
  for (const turn of turns) {
    if (!turn || typeof turn.turnId !== 'string' || !Array.isArray(turn.items)) return false;
    // Conflicting duplicate turns make the evidence ambiguous.
    if (byId.has(turn.turnId)) return false;
    byId.set(turn.turnId, turn);
  }
  const matchedUsers = [], matchedSteers = [], itemCounts = new Map();
  const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 1024 && !/[\x00-\x20\x7f]/.test(id);
  for (const turn of byId.values()) for (const item of turn.items) {
    if (item?.type === 'userMessage' && validId(item.id)) itemCounts.set(item.id, (itemCounts.get(item.id) || 0) + 1);
    if (turn.remodexOptimisticPendingTurn === true) continue;
    if (item?.type === 'userMessage' && (item.clientId ?? item.client_id) === operationId) matchedUsers.push(item);
    if (item?.type === 'steeringUserMessage' && item.clientUserMessageId === operationId) matchedSteers.push(item);
  }
  if (matchedUsers.length > 1 || matchedSteers.length > 1) return false;
  const user = matchedUsers[0], steer = matchedSteers[0];
  if (user && (!validId(user.id) || itemCounts.get(user.id) !== 1)) return false;
  if (steer && (steer.status !== 'accepted' || !validId(steer.serverUserMessageId))) return false;
  if (user && steer && user.id !== steer.serverUserMessageId) return false;
  return Boolean(user || steer);
}
