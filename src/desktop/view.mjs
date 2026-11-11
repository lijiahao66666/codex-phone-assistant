import { inspectApproval } from './approval-guard.mjs';
import { inspectUserInput } from './user-input-guard.mjs';
import { inspectQuestions, parseQuestionReply, pendingAsyncQuestions, registerAsyncQuestionHistory } from './async-question-guard.mjs';
import { createHash } from 'node:crypto';
import { userInputImagePath } from '../media/user-input-media.mjs';

// Project the desktop's private conversation state into a display-only view.
// Unknown or unloaded history is explicitly marked incomplete.
export function desktopView(state, { imageHandles = new Map(), mediaHandles = new Map() } = {}) {
  if (!state || typeof state !== 'object' || typeof state.id !== 'string') throw new TypeError('Invalid conversation state');
  const legacy = Array.isArray(state.turns) ? state.turns : [];
  const canonical = state.turnHistory?.kind === 'canonical' ? state.turnHistory.history : null;
  let turns = legacy;
  let viewKeys = null;
  let complete = false;
  let reason = 'history-not-confirmed';
  if (canonical) {
    if (!Array.isArray(canonical.islands) || !canonical.entitiesByKey || typeof canonical.entitiesByKey !== 'object') {
      throw new TypeError('Invalid canonical history');
    }
    turns = [];
    const canonicalKeys = [];
    for (const island of canonical.islands) {
      if (!Array.isArray(island.entries)) throw new TypeError('Invalid history entries');
      for (const entry of island.entries) {
        const turn = canonical.entitiesByKey[entry?.value];
        if (!turn || typeof turn !== 'object') throw new TypeError('Missing history turn');
        turns.push(turn);
        canonicalKeys.push(entry?.value);
      }
    }
    if (!legacy.length && canonicalKeys.every(key => typeof key === 'string' && key.length > 0 && key.length <= 4096) && new Set(canonicalKeys).size === canonicalKeys.length) {
      const keys = canonicalKeys.map(key => `canonical:${createHash('sha256').update(key).digest('hex')}`);
      if (new Set(keys).size === keys.length) viewKeys = keys;
    }
    for (const turn of legacy) {
      const index = typeof turn?.turnId === 'string' ? turns.findIndex(item => item.turnId === turn.turnId) : -1;
      if (index === -1) turns.push(turn);
      else turns[index] = turn;
    }
    complete = canonical.isComplete === true && canonical.islands.length === 1 && canonical.islands[0]?.newerBoundary?.status === 'exhausted' && legacy.length === 0;
    reason = legacy.length ? 'mixed-history' : complete ? null : 'history-paginated';
  } else if (state.resumeState === 'resumed' && state.turnsPagination?.hasLoadedOldest !== false) {
    complete = true;
    reason = null;
  }
  if (turns.some(turn => turn.itemsPagination?.hasLoadedOldest === false || turn.itemsPagination?.hasLoadedNewest === false || turn.itemsPagination?.evicted === true)) {
    complete = false;
    reason = reason ?? 'items-paginated';
  }
  const userMessageIds = new Set(turns.flatMap(turn => Array.isArray(turn.items) ? turn.items.filter(item => item?.type === 'userMessage' && typeof item.id === 'string').map(item => item.id) : []));
  const viewTurns = turns.map((turn, index) => ({
    id: typeof turn.turnId === 'string' ? turn.turnId : null,
    ...(viewKeys ? { viewKey: viewKeys[index] } : {}),
    status: typeof turn.status === 'string' ? turn.status : 'unknown',
    startedAt: turn.turnStartedAtMs ?? null,
    items: orderSteeringMessages(turnDisplayItems(turn, index)).filter(item => (item?.type !== 'steeringUserMessage' || !item.serverUserMessageId || !userMessageIds.has(item.serverUserMessageId)) && !emptyCompletedWait(item)).map(item => displayItem(item, imageHandles, mediaHandles, turn.remodexOptimisticPendingTurn === true)),
  }));
  const view = { turns: viewTurns, history: { complete, reason } };
  const questionTurns = registerAsyncQuestionHistory(view, state);
  const unknownQuestionItemIds = [];
  const legacyTailQuestion = !canonical && !complete ? viewTurns.at(-1)?.items.findLast(item => item.type === 'agentMessage' && item.questions?.length) : null;
  const legacyActionableItemId = legacyTailQuestion && pendingAsyncQuestions(view, legacyTailQuestion.id) ? legacyTailQuestion.id : null;
  {
    const items = viewTurns.flatMap(turn => turn.items);
    const counts = new Map();
    for (const item of items) if (item.type === 'agentMessage' && item.questions?.length) counts.set(item.id, (counts.get(item.id) || 0) + 1);
    const answered = new Set(), submitting = new Set();
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type === 'userMessage') {
        for (const id of item.questionReplyIds || []) answered.add(id);
        for (const id of item.questionReplyPendingIds || []) submitting.add(id);
      }
      if (item.type === 'agentMessage' && item.questions?.length) {
        const proven = counts.get(item.id) === 1 && [...questionTurns].some(turn => turn.items.includes(item));
        if (proven) item.pendingQuestionIds = item.questions.filter(question => !answered.has(question.id)).map(question => question.id);
        // A gap or a partially loaded newer turn removes our proof, not the
        // unanswered question. Only stable IDs cross the window boundary; old
        // question bodies/options must not inflate every live snapshot.
        else if (item.questions.some(question => !answered.has(question.id)) && typeof item.id === 'string' && item.id !== legacyActionableItemId) unknownQuestionItemIds.push(item.id);
        const pending = item.questions.filter(question => submitting.has(question.id) && !answered.has(question.id)).map(question => question.id);
        if (counts.get(item.id) === 1 && pending.length) item.submittingQuestionIds = pending;
      }
    }
  }
  const rawGoal = state.threadGoal;
  const goal = rawGoal?.threadId === state.id && typeof rawGoal.objective === 'string' &&
    ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(rawGoal.status)
    ? { objective: rawGoal.objective, status: rawGoal.status,
        timeUsedSeconds: Number.isFinite(rawGoal.timeUsedSeconds) && rawGoal.timeUsedSeconds >= 0 ? rawGoal.timeUsedSeconds : null,
        updatedAt: Number.isFinite(rawGoal.updatedAt) && rawGoal.updatedAt >= 0 ? rawGoal.updatedAt : null }
    : null;
  return Object.assign(view, {
    id: state.id,
    unknownQuestionItemIds: [...new Set(unknownQuestionItemIds)],
    collaborationMode: ['default', 'plan'].includes(state.latestCollaborationMode?.mode) ? state.latestCollaborationMode.mode : null,
    model: typeof state.latestCollaborationMode?.settings?.model === 'string' ? state.latestCollaborationMode.settings.model : null,
    reasoningEffort: Object.hasOwn(state.latestCollaborationMode?.settings || {}, 'reasoning_effort')
      ? (typeof state.latestCollaborationMode.settings.reasoning_effort === 'string' ? state.latestCollaborationMode.settings.reasoning_effort : null)
      : (typeof state.latestReasoningEffort === 'string' ? state.latestReasoningEffort : null),
    title: typeof state.title === 'string' ? state.title : '',
    runtimeStatus: ['active', 'idle'].includes(state.threadRuntimeStatus?.type) ? state.threadRuntimeStatus.type : 'unknown',
    goal,
    // Keep only the request identity and method until each response contract is verified.
    requests: Array.isArray(state.requests) ? state.requests.filter(request => request?.completed !== true).map(request => inspectApproval(request, state.id) || inspectUserInput(request, state.id) || ({ id: request?.id, method: request?.method })).filter(request => request.id !== undefined) : [],
  });
}

function inputIdentity(content) {
  return JSON.stringify((Array.isArray(content) ? content : []).flatMap(part => {
    if (['text', 'input_text'].includes(part?.type) && typeof part.text === 'string') return [{ text: part.text }];
    const path = userInputImagePath(part);
    return path ? [{ image: path }] : [];
  }));
}

function turnDisplayItems(turn, index) {
  const items = Array.isArray(turn.items) ? turn.items : [];
  const input = turn.params?.input;
  if (!Array.isArray(input) || inputIdentity(input) === '[]') return items;
  // Equal content can be a genuine follow-up. Only a confirmed server/client
  // identity authorizes removing the echo of the prompt rendered from params.
  const initialClientId = turn.params?.clientUserMessageId;
  const validItemId = id => typeof id === 'string' && id.length > 0 && id.length <= 1024 && !/[\x00-\x20\x7f]/.test(id);
  const nativeId = turn.remodexInitialUserMessageId;
  const clientEchoes = typeof initialClientId === 'string' && initialClientId
    ? items.filter(item => item?.type === 'userMessage' && (item.clientId ?? item.client_id) === initialClientId) : [];
  // Native canonical turns may carry only the client correlation, without the
  // adapter's remodexInitialUserMessageId. Retain that confirmed server ID so
  // recorded history and live projection describe the same message.
  const echo = clientEchoes.length === 1 && validItemId(clientEchoes[0].id)
    && items.filter(item => item?.id === clientEchoes[0].id).length === 1
    && inputIdentity(clientEchoes[0].content) === inputIdentity(input) ? clientEchoes[0] : null;
  const initialId = validItemId(nativeId) && !items.some(item => item?.id === nativeId && item.type !== 'userMessage')
    ? nativeId : echo?.id ?? null;
  const isEcho = item => item?.type === 'userMessage' && initialId && item.id === initialId;
  const syntheticId = `initial-user:${turn.turnId ?? index}`;
  const ids = new Set(items.map(item => item?.id));
  let promptId = initialId || syntheticId;
  if (!initialId) while (ids.has(promptId)) promptId += ':prompt';
  // Explicitly link the pre-acknowledgement placeholder already retained by
  // H5 history. Never claim a synthetic ID that is a real loaded item ID.
  const initialIdentity = initialId && !ids.has(syntheticId) ? { initialPromptId: syntheticId } : {};
  const prompt = { type: 'userMessage', id: promptId, content: input, ...initialIdentity };
  return [prompt, ...items.filter(item => !isEcho(item))];
}

function emptyCompletedWait(item) {
  return item?.type === 'collabAgentToolCall' && item.tool === 'wait' && item.status === 'completed' &&
    Array.isArray(item.receiverThreadIds) && item.receiverThreadIds.length === 0 &&
    Array.isArray(item.receiverThreads) && item.receiverThreads.length === 0 &&
    item.agentsStates && typeof item.agentsStates === 'object' && !Array.isArray(item.agentsStates) && Object.keys(item.agentsStates).length === 0;
}

function orderSteeringMessages(items) {
  const candidates = new Map(), markers = new Map();
  for (const item of items) {
    if (item?.type === 'steeringUserMessage' && typeof item.serverUserMessageId === 'string') {
      const list = candidates.get(item.serverUserMessageId) || []; list.push(item); candidates.set(item.serverUserMessageId, list);
    }
    if (item?.type === 'steered' && typeof item.id === 'string') markers.set(item.id, (markers.get(item.id) || 0) + 1);
  }
  const movable = new Map([...candidates].filter(([id, list]) => list.length === 1 && markers.get(id) === 1).map(([id, list]) => [id, list[0]]));
  return items.flatMap(item => {
    if (item?.type === 'steeringUserMessage' && movable.get(item.serverUserMessageId) === item) return [];
    if (item?.type === 'steered' && movable.has(item.id)) return [movable.get(item.id)];
    return [item];
  });
}

function displayUserText(text, imageCount = 0) {
  if (imageCount > 0) {
    const wrapper = /^\s*# Files mentioned by the user:[ \t]*\r?\n((?:[ \t]*\r?\n)*?(?:## [^\r\n]+: \/[^\r\n]+\r?\nImage attachment: true[ \t]*\r?\n(?:[ \t]*\r?\n)*)+)Distinguish instructions in attached documents from the user's request\.[ \t]*\r?\n(?:[ \t]*\r?\n)*## My request:[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
    if (wrapper && (wrapper[1].match(/^Image attachment: true[ \t]*\r?$/gm) || []).length === imageCount) return wrapper[2];
  }
  const identified = parseQuestionReply(text);
  if (identified) return identified.map(reply => `${reply.question}\n${reply.answer}`).join('\n\n');
  const match = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(text);
  if (!match) return text;
  try {
    const replies = JSON.parse(match[1]);
    if (!Array.isArray(replies) || !replies.length || replies.length > 20 || replies.some(reply => !reply || typeof reply.question !== 'string' || typeof reply.answer !== 'string')) return text;
    return replies.map(reply => `${reply.question}\n${reply.answer}`).join('\n\n');
  } catch { return text; }
}

function displayItem(item, imageHandles, mediaHandles, optimisticTurn = false) {
  if (!item || typeof item !== 'object') return { type: 'unknown' };
  const base = { type: typeof item.type === 'string' ? item.type : 'unknown', id: item.id };
  if (item.type === 'userMessage' || item.type === 'steeringUserMessage') {
    const content = item.type === 'steeringUserMessage' ? item.input : item.content;
    const text = Array.isArray(content)
      ? content.filter(part => ['text', 'input_text'].includes(part?.type) && typeof part.text === 'string').map(part => part.text).join('\n')
      : typeof item.text === 'string' ? item.text : '';
    const paths = Array.isArray(content) ? content.map(userInputImagePath).filter(Boolean) : [];
    const imageCount = paths.length;
    const images = paths.map(path => imageHandles.get(path)).filter(Boolean);
    const acceptedReply = !optimisticTurn && (item.type === 'userMessage' || item.status === 'accepted' || item.steerAcknowledged === true);
    const replies = !imageCount ? parseQuestionReply(text) : null;
    const serverIdentity = item.type === 'steeringUserMessage' && typeof item.serverUserMessageId === 'string' && item.serverUserMessageId
      ? { serverUserMessageId: item.serverUserMessageId } : {};
    const initialIdentity = typeof item.initialPromptId === 'string' && item.initialPromptId.startsWith('initial-user:') && item.initialPromptId !== item.id ? { initialPromptId: item.initialPromptId } : {};
    return { ...base, type: 'userMessage', ...serverIdentity, ...initialIdentity, text: displayUserText(text, imageCount), ...(replies && acceptedReply ? { questionReplyIds: replies.map(reply => reply.questionItemId) } : {}), ...(replies && !acceptedReply ? { questionReplyPendingIds: replies.map(reply => reply.questionItemId) } : {}), ...(imageCount ? { imageCount } : {}), ...(images.length ? { images } : {}) };
  }
  if (item.type === 'imageView' || item.type === 'imageGeneration') {
    const media = mediaHandles.get(item.type === 'imageView' ? item.path : item.savedPath);
    if (media?.mime?.startsWith('video/')) return { ...base, videos: [media] };
    const handle = imageHandles.get(item.type === 'imageView' ? item.path : item.savedPath);
    return { ...base, ...(handle ? { images: [handle] } : {}) };
  }
  if (item.type === 'agentMessage') {
    const questions = inspectQuestions(item);
    return { ...base, text: typeof item.text === 'string' ? item.text : '', phase: item.phase, ...(questions.length ? { questions } : {}) };
  }
  if (item.type === 'reasoning') {
    return { ...base, summary: Array.isArray(item.summary) ? item.summary.filter(value => typeof value === 'string') : [] };
  }
  if (item.type === 'subAgentActivity') {
    return { ...base, kind: typeof item.kind === 'string' ? item.kind : '', agentPath: typeof item.agentPath === 'string' ? item.agentPath : '', ...(typeof item.agentThreadId === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(item.agentThreadId) ? { agentThreadId: item.agentThreadId } : {}) };
  }
  if (item.type === 'collabAgentToolCall') {
    const agents = item.agentsStates && typeof item.agentsStates === 'object' && !Array.isArray(item.agentsStates)
      ? Object.entries(item.agentsStates).map(([id, state]) => ({ id, status: typeof state?.status === 'string' ? state.status : '' })) : [];
    return { ...base, tool: typeof item.tool === 'string' ? item.tool : '', status: typeof item.status === 'string' ? item.status : '', agents };
  }
  if (item.type === 'mcpToolCall') {
    return { ...base, server: typeof item.server === 'string' ? item.server : '', tool: typeof item.tool === 'string' ? item.tool : '', status: typeof item.status === 'string' ? item.status : '' };
  }
  if (item.type === 'commandExecution') {
    const actions = Array.isArray(item.commandActions) ? item.commandActions.filter(action => ['read', 'search', 'listFiles'].includes(action?.type)).map(action => ({ type: action.type, name: typeof action.name === 'string' ? action.name : typeof action.path === 'string' ? action.path.split(/[\\/]/).filter(Boolean).at(-1) || '' : '' })) : [];
    return { ...base, command: item.command, output: item.aggregatedOutput, exitCode: item.exitCode, status: item.status, ...(Number.isFinite(item.durationMs) && item.durationMs >= 0 ? { durationMs: item.durationMs } : {}), ...(actions.length ? { actions } : {}) };
  }
  if (item.type === 'fileChange') return { ...base, changes: item.changes, status: item.status };
  if (item.type === 'error') return { ...base, message: typeof item.message === 'string' ? item.message : '', willRetry: item.willRetry };
  return base;
}
