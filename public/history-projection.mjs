const allowed = new Set(['userMessage', 'agentMessage', 'reasoning', 'commandExecution', 'fileChange', 'imageView', 'imageGeneration', 'subAgentActivity', 'collabAgentToolCall', 'mcpToolCall', 'error']);

export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  throw new Error('invalid canonical value');
}

export function readonlyPage(page) {
  if (!page || !Array.isArray(page.turns) || page.turns.length > 1000) throw new Error('invalid page');
  return { turns: page.turns.map(turn => {
    if (!turn || !((typeof turn.id === 'string' && turn.id && turn.id.length <= 1024) || (typeof turn.viewKey === 'string' && turn.viewKey && turn.viewKey.length <= 1024)) || !Array.isArray(turn.items) || turn.items.length > 10000) throw new Error('invalid turn');
    return { id: typeof turn.id === 'string' ? turn.id : null, ...(typeof turn.viewKey === 'string' ? { viewKey: turn.viewKey } : {}), ...(typeof turn.status === 'string' ? { status: turn.status } : {}), ...(Number.isFinite(turn.startedAt) ? { startedAt: turn.startedAt } : {}), items: turn.items.filter(item => item && allowed.has(item.type)).map(item => ({
      type: item.type,
      ...(typeof item.id === 'string' ? { id: item.id.slice(0, 1024) } : {}),
      ...(typeof item.text === 'string' ? { text: item.text } : {}),
      ...(typeof item.phase === 'string' ? { phase: item.phase.slice(0, 64) } : {}),
      ...(Array.isArray(item.summary) ? { summary: item.summary.filter(s => typeof s === 'string') } : {}),
      ...(Number.isSafeInteger(item.imageCount) && item.imageCount > 0 ? { imageCount: item.imageCount } : {}),
      ...Object.fromEntries(['status', 'kind', 'agentPath', 'agentThreadId', 'server', 'tool', 'command', 'output', 'message'].filter(key => typeof item[key] === 'string').map(key => [key, item[key]])),
      ...(Number.isFinite(item.durationMs) ? { durationMs: item.durationMs } : {}),
      ...(Number.isFinite(item.exitCode) ? { exitCode: item.exitCode } : {}),
      ...(typeof item.willRetry === 'boolean' ? { willRetry: item.willRetry } : {}),
      ...(Array.isArray(item.actions) ? { actions: item.actions.filter(a => a && ['read', 'search', 'listFiles'].includes(a.type)).map(a => ({ type: a.type, name: typeof a.name === 'string' ? a.name : '' })) } : {}),
      ...(Array.isArray(item.changes) ? { changes: item.changes.filter(c => c && typeof c.path === 'string').map(c => ({ path: c.path, ...(typeof c.kind === 'string' ? { kind: c.kind } : {}), ...(typeof c.diff === 'string' ? { diff: c.diff } : {}) })) } : {}),
      ...(Array.isArray(item.agents) ? { agents: item.agents.filter(a => a && typeof a.id === 'string').map(a => ({ id: a.id, status: typeof a.status === 'string' ? a.status : '' })) } : {}),
    })) };
  }) };
}

export async function pageHash(page) {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(readonlyPage(page))));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
