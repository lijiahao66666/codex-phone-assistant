const stages = new Set(['open', 'first-ready', 'first-encoded', 'first-received', 'first-written', 'first-drain', 'chunk-begin', 'chunk-end', 'closed']);
const numbers = ['bytes', 'projectMs', 'encodeMs', 'queuedBytes'];

// One ephemeral relay-generated ID, at most one record per fixed milestone.
// Never accept payloads, identities, paths or arbitrary error strings.
export function createStreamDiagnostics(streamId, sink, { now = () => performance.now() } = {}) {
  const valid = typeof streamId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(streamId);
  const began = now(), seen = new Set();
  const pending = stage => valid && !seen.has('closed') && stages.has(stage) && !seen.has(stage);
  return { pending, mark(stage, detail = {}) {
    if (!pending(stage)) return false;
    seen.add(stage);
    const entry = { streamId, stage, elapsedMs: Math.max(0, Math.round((now() - began) * 100) / 100) };
    for (const key of numbers) if (Number.isFinite(detail[key]) && detail[key] >= 0) entry[key] = Math.round(detail[key] * 100) / 100;
    if (typeof detail.chunked === 'boolean') entry.chunked = detail.chunked;
    try { sink(entry); } catch { /* Observation never changes stream behavior. */ }
    return true;
  } };
}
