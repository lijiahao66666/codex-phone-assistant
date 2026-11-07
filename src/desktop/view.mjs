import { inspectApproval } from './approval-guard.mjs';
import { inspectUserInput } from './user-input-guard.mjs';
import { inspectQuestions } from './async-question-guard.mjs';
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
    complete = canonical.isComplete === true && canonical.islands.length === 1 && legacy.length === 0;
    reason = legacy.length ? 'mixed-history' : complete ? null : 'history-paginated';
  } else if (state.resumeState === 'resumed' && state.turnsPagination?.hasLoadedOldest !== false) {
    complete = true;
    reason = null;
  }
  if (turns.some(turn => turn.itemsPagination?.hasLoadedOldest === false || turn.itemsPagination?.evicted === true)) {
    complete = false;
    reason = reason ?? 'items-paginated';
  }
  const userMessageIds = new Set(turns.flatMap(turn => Array.isArray(turn.items) ? turn.items.filter(item => item?.type === 'userMessage' && typeof item.id === 'string').map(item => item.id) : []));
  const viewTurns = turns.map((turn, index) => ({
    id: typeof turn.turnId === 'string' ? turn.turnId : null,
    ...(viewKeys ? { viewKey: viewKeys[index] } : {}),
    status: typeof turn.status === 'string' ? turn.status : 'unknown',
    startedAt: turn.turnStartedAtMs ?? null,
    items: orderSteeringMessages(turnDisplayItems(turn, index)).filter(item => (item?.type !== 'steeringUserMessage' || !item.serverUserMessageId || !userMessageIds.has(item.serverUserMessageId)) && !emptyCompletedWait(item)).map(item => displayItem(item, imageHandles, mediaHandles)),
  }));
  const rawGoal = state.threadGoal;
  const goal = rawGoal?.threadId === state.id && typeof rawGoal.objective === 'string' &&
    ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(rawGoal.status)
    ? { objective: rawGoal.objective, status: rawGoal.status,
        timeUsedSeconds: Number.isFinite(rawGoal.timeUsedSeconds) && rawGoal.timeUsedSeconds >= 0 ? rawGoal.timeUsedSeconds : null,
        updatedAt: Number.isFinite(rawGoal.updatedAt) && rawGoal.updatedAt >= 0 ? rawGoal.updatedAt : null }
    : null;
  return {
    id: state.id,
    collaborationMode: ['default', 'plan'].includes(state.latestCollaborationMode?.mode) ? state.latestCollaborationMode.mode : null,
    model: typeof state.latestCollaborationMode?.settings?.model === 'string' ? state.latestCollaborationMode.settings.model : null,
    reasoningEffort: typeof state.latestCollaborationMode?.settings?.reasoning_effort === 'string' ? state.latestCollaborationMode.settings.reasoning_effort : null,
    title: typeof state.title === 'string' ? state.title : '',
    runtimeStatus: ['active', 'idle'].includes(state.threadRuntimeStatus?.type) ? state.threadRuntimeStatus.type : 'unknown',
    goal,
    turns: viewTurns,
    history: { complete, reason },
    // Keep only the request identity and method until each response contract is verified.
    requests: Array.isArray(state.requests) ? state.requests.filter(request => request?.completed !== true).map(request => inspectApproval(request, state.id) || inspectUserInput(request, state.id) || ({ id: request?.id, method: request?.method })).filter(request => request.id !== undefined) : [],
  };
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
  // Desktop renders the initial bubble from params.input. Its app-server echo
  // can briefly coexist as the first user item; do not duplicate that bubble.
  // A later identical input after work or an answer remains a genuine message.
  const prePromptTypes = new Set(['automaticApprovalReview', 'forkedFromConversation', 'modelChanged', 'modelRerouted', 'personalityChanged', 'remoteTaskCreated', 'worktreeInit']);
  const first = items.findIndex(item => !prePromptTypes.has(item?.type));
  const duplicate = items[first]?.type === 'userMessage' && inputIdentity(items[first].content) === inputIdentity(input);
  const prompt = { type: 'userMessage', id: `initial-user:${turn.turnId ?? index}`, content: input };
  return [prompt, ...items.filter((_, itemIndex) => !duplicate || itemIndex !== first)];
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
  const match = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(text);
  if (!match) return text;
  try {
    const replies = JSON.parse(match[1]);
    if (!Array.isArray(replies) || !replies.length || replies.length > 20 || replies.some(reply => !reply || typeof reply.question !== 'string' || typeof reply.answer !== 'string')) return text;
    return replies.map(reply => `${reply.question}\n${reply.answer}`).join('\n\n');
  } catch { return text; }
}

function displayItem(item, imageHandles, mediaHandles) {
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
    return { ...base, type: 'userMessage', text: displayUserText(text, imageCount), ...(imageCount ? { imageCount } : {}), ...(images.length ? { images } : {}) };
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
