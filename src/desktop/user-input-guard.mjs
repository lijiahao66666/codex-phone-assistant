export function inspectUserInput(request, threadId) {
  const p = request?.params;
  if (request?.method !== 'item/tool/requestUserInput' || request.completed === true ||
      !['string', 'number'].includes(typeof request.id) || request.id === '' ||
      p?.threadId !== threadId || typeof p.turnId !== 'string' || !p.turnId ||
      typeof p.itemId !== 'string' || !p.itemId || !Array.isArray(p.questions) ||
      p.questions.length === 0 || p.questions.length > 10) return null;
  const ids = new Set();
  const questions = [];
  for (const q of p.questions) {
    if (!q || typeof q.id !== 'string' || !q.id || ids.has(q.id) || q.isSecret ||
        typeof q.question !== 'string' || typeof q.header !== 'string' ||
        (q.options != null && !Array.isArray(q.options))) return null;
    const options = q.options ?? [];
    if (options.length > 30 || options.some(o => typeof o?.label !== 'string' || !o.label || typeof o.description !== 'string')) return null;
    ids.add(q.id);
    questions.push({ id: q.id, header: q.header, question: q.question, isOther: q.isOther === true,
      options: options.map(({ label, description }) => ({ label, description })) });
  }
  return { id: request.id, kind: 'userInput', turnId: p.turnId, itemId: p.itemId, questions };
}

export function matchUserInput(state, requestId, answers) {
  if (!state || !Array.isArray(state.requests) || !answers || typeof answers !== 'object' || Array.isArray(answers)) return null;
  const matches = state.requests.filter(request => request?.id === requestId);
  if (matches.length !== 1) return null;
  const request = inspectUserInput(matches[0], state.id);
  if (!request || Object.keys(answers).length !== request.questions.length) return null;
  for (const q of request.questions) {
    const value = answers[q.id];
    if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 8192 ||
        (q.options.length && !q.isOther && !q.options.some(option => option.label === value))) return null;
  }
  return { answers: Object.fromEntries(request.questions.map(q => [q.id, { answers: [answers[q.id].trim()] }])) };
}
