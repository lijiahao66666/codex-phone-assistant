import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectQuestions, formatQuestionReply } from '../src/desktop/async-question-guard.mjs';

test('projects desktop async question IDs and formats the desktop reply', () => {
  const questions = inspectQuestions({ type: 'agentMessage', id: 'item', questions: [{ title: 'Choose', options: ['A', 'B'] }] });
  assert.deepEqual(questions, [{ id: '["request_user_input_async","item",0]', question: 'Choose', options: ['A', 'B'] }]);
  const expected = `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: questions[0].id, question: 'Choose', answer: 'A' }])}\n</send_user_message_question_reply>`;
  assert.equal(formatQuestionReply(questions, { [questions[0].id]: 'A' }), expected);
  assert.equal(formatQuestionReply(questions, { wrong: 'A' }), null);
});
