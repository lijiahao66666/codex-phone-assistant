export function questionId(itemId, index) { return JSON.stringify(['request_user_input_async', itemId, index]); }

export function parseQuestionReply(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 32768) return null;
  const match = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(text);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    const replies = Array.isArray(parsed) ? parsed : [parsed];
    if (!Array.isArray(replies) || !replies.length || replies.length > 10) return null;
    const ids = new Set();
    for (const reply of replies) {
      if (!reply || typeof reply.questionItemId !== 'string' || typeof reply.question !== 'string' || !reply.question.trim() || typeof reply.answer !== 'string' || !reply.answer.trim()) return null;
      const id = JSON.parse(reply.questionItemId);
      if (!Array.isArray(id) || id.length !== 3 || id[0] !== 'request_user_input_async' || typeof id[1] !== 'string' || !id[1] || !Number.isSafeInteger(id[2]) || id[2] < 0 || id[2] >= 10 || questionId(id[1], id[2]) !== reply.questionItemId || ids.has(reply.questionItemId)) return null;
      ids.add(reply.questionItemId);
    }
    return replies;
  } catch { return null; }
}

export function pendingAsyncQuestions(view, itemId) {
  if (!view || !Array.isArray(view.turns) || typeof itemId !== 'string' || !itemId) return null;
  const items = view.turns.flatMap(turn => Array.isArray(turn?.items) ? turn.items : []);
  const matches = items.map((item, index) => ({ item, index })).filter(({ item }) => item?.type === 'agentMessage' && item.id === itemId && item.questions?.length);
  if (matches.length !== 1) return null;
  const { item, index } = matches[0];
  if (view.history?.complete !== true) {
    const last = view.turns.at(-1)?.items || [];
    const lastIndex = last.indexOf(item);
    if (lastIndex < 0 || (!Array.isArray(item.pendingQuestionIds) && last.slice(lastIndex + 1).some(next => next.type === 'userMessage' || next.questions?.length))) return null;
  }
  const answered = new Set(items.slice(index + 1).flatMap(next => next?.type === 'userMessage' && Array.isArray(next.questionReplyIds) ? next.questionReplyIds : []));
  const pending = item.questions.filter(question => !answered.has(question.id));
  const submitting = new Set(items.slice(index + 1).flatMap(next => next?.type === 'userMessage' && Array.isArray(next.questionReplyPendingIds) ? next.questionReplyPendingIds : []));
  if (pending.some(question => submitting.has(question.id))) return null;
  return pending.length ? pending : null;
}

export function inspectQuestions(item) {
  if (item?.type !== 'agentMessage' || typeof item.id !== 'string' || !item.id || !Array.isArray(item.questions) || item.questions.length > 10) return [];
  if (item.questions.some(q => !q || typeof q.title !== 'string' || !q.title.trim() || (q.options != null && (!Array.isArray(q.options) || q.options.length > 30 || q.options.some(option => typeof option !== 'string'))))) return [];
  return item.questions.map((q, index) => ({ id: questionId(item.id, index), question: q.title, options: q.options || [] }));
}

export function formatQuestionReply(questions, answers) {
  if (!Array.isArray(questions) || !questions.length || !answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).length !== questions.length) return null;
  const replies = [];
  for (const question of questions) {
    const answer = answers[question.id];
    if (typeof answer !== 'string' || !answer.trim() || Buffer.byteLength(answer) > 8192) return null;
    replies.push({ questionItemId: question.id, question: question.question, answer: answer.trim() });
  }
  const text = `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`;
  return Buffer.byteLength(text) <= 32768 ? text : null;
}
