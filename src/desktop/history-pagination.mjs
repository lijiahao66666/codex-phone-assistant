import { createHash } from 'node:crypto';
import { canonicalJson, readonlyPage } from '../../public/history-projection.mjs';
const digest = value => createHash('sha256').update(JSON.stringify(value, (key, item) => key === 'images' || key === 'videos' ? undefined : item)).digest('hex');
function historyDigests(value) {
  const media = [];
  let position = 0;
  const content = JSON.stringify(value, (key, item) => {
    const index = position++;
    if (key === 'images' || key === 'videos') { media.push([index, key, item]); return undefined; }
    return item;
  });
  return {
    historicalHash: createHash('sha256').update(content).digest('hex'),
    mediaRevision: createHash('sha256').update(JSON.stringify(media)).digest('hex'),
  };
}
const keyOf = (turn, key) => turn?.[key];
function validated(view, recentCount) {
  if (!view || typeof view.id !== 'string' || !Array.isArray(view.turns) || !Number.isSafeInteger(recentCount) || recentCount < 1) throw new Error('invalid view');
  const useKeys = view.turns.every(t => typeof t?.viewKey === 'string' && t.viewKey) && new Set(view.turns.map(t => t.viewKey)).size === view.turns.length;
  const key = useKeys ? 'viewKey' : 'id';
  const keys = view.turns.map(t => keyOf(t, key));
  if (keys.some(k => typeof k !== 'string' || !k) || new Set(keys).size !== keys.length) throw new Error('unstable turn keys');
  const split = Math.max(0, view.turns.length - recentCount);
  return { key, split, prefix: view.turns.slice(0, split), recent: view.turns.slice(split) };
}
export function makeWindow(view, { recentCount = 3 } = {}) {
  const parts = validated(view, recentCount), { historicalHash, mediaRevision } = historyDigests(parts.prefix);
  // A pending editor is a live control even when its transcript turn has aged
  // out of the recent window. Send only its question metadata, never that
  // turn's potentially large tool output or historical message body.
  const pendingQuestionTurns = parts.prefix.flatMap(turn => {
    const items = (turn.items || []).filter(item => item.type === 'agentMessage' && Array.isArray(item.questions)
      && item.questions.some(question => item.pendingQuestionIds?.includes(question.id) || item.submittingQuestionIds?.includes(question.id)))
      .map(item => ({ id: item.id, type: item.type, text: '', questions: item.questions,
        ...(Array.isArray(item.pendingQuestionIds) ? { pendingQuestionIds: item.pendingQuestionIds } : {}),
        ...(Array.isArray(item.submittingQuestionIds) ? { submittingQuestionIds: item.submittingQuestionIds } : {}) }));
    return items.length ? [{ id: turn.id, ...(turn.viewKey ? { viewKey: turn.viewKey } : {}), status: turn.status, items }] : [];
  });
  return { ...view, turns: parts.recent, pendingQuestionTurns, history: { ...view.history, complete: parts.split === 0 && view.history?.complete === true, reason: parts.split ? 'on-demand' : view.history?.reason, available: parts.split, historicalHash, mediaRevision, keyField: parts.key, cursor: parts.split ? keyOf(parts.recent[0], parts.key) : null } };
}
export function makePage(view, { recentCount = 3, historicalHash, before, maxBytes = 256 * 1024, maxSingleTurnBytes = 4 * 1024 * 1024 } = {}) {
  const parts = validated(view, recentCount);
  if (digest(parts.prefix) !== historicalHash) throw new Error('history-changed');
  const all = view.turns, index = all.findIndex(t => keyOf(t, parts.key) === before);
  if (index < 1 || index > parts.split) throw new Error('invalid-cursor');
  const turns = []; let bytes = 0;
  for (let i = index - 1; i >= 0; i--) {
    const size = Buffer.byteLength(JSON.stringify(all[i])) + 1;
    if (size > maxSingleTurnBytes && !turns.length) throw new Error('turn-too-large');
    if (size > maxBytes && !turns.length) { turns.unshift(all[i]); bytes += size; break; }
    if (bytes + size > maxBytes) break;
    turns.unshift(all[i]); bytes += size;
  }
  const pageHash = createHash('sha256').update(canonicalJson(readonlyPage({ turns }))).digest('hex');
  return { threadId: view.id, historicalHash, pageHash, keyField: parts.key, before, turns, nextBefore: index - turns.length > 0 ? keyOf(turns[0], parts.key) : null, complete: index - turns.length === 0 && view.history?.complete === true };
}
