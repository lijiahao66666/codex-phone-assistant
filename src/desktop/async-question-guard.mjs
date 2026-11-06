export function questionId(itemId, index) { return JSON.stringify(['request_user_input_async', itemId, index]); }

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
