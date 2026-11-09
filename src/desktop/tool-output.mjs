import { createHash } from 'node:crypto';

const inlineBytes = 4096;
const pageCharacters = 16384;
const keyOf = turn => turn?.viewKey ?? turn?.id;
const validId = value => typeof value === 'string' && value.length > 0;
const stableTurns = view => Array.isArray(view?.turns) && view.turns.every(turn => validId(keyOf(turn))) && new Set(view.turns.map(keyOf)).size === view.turns.length;
const hashOf = output => createHash('sha256').update(output).digest('hex');
const highSurrogate = value => value >= 0xd800 && value <= 0xdbff;
const lowSurrogate = value => value >= 0xdc00 && value <= 0xdfff;
const splitPair = (output, offset) => offset > 0 && offset < output.length && highSurrogate(output.charCodeAt(offset - 1)) && lowSurrogate(output.charCodeAt(offset));

// The source is the full current projection: a window must not make an
// otherwise ambiguous turn identity appear unique. Do not retain its history.
export function lazyToolOutputs(view, source = view) {
  if (!stableTurns(source)) return view;
  const counts = new Map();
  for (const turn of source.turns || []) {
    const key = keyOf(turn);
    if (validId(key)) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return { ...view, turns: view.turns.map(turn => {
    if (!validId(keyOf(turn)) || counts.get(keyOf(turn)) !== 1 || !Array.isArray(turn.items)) return turn;
    const itemCounts = new Map();
    for (const item of turn.items) if (validId(item?.id)) itemCounts.set(item.id, (itemCounts.get(item.id) || 0) + 1);
    return { ...turn, items: turn.items.map(item => {
      if (item?.type !== 'commandExecution' || !validId(item.id) || itemCounts.get(item.id) !== 1 || typeof item.output !== 'string') return item;
      const bytes = Buffer.byteLength(item.output);
      if (bytes <= inlineBytes) return item;
      const { output, ...rest } = item;
      return { ...rest, outputRef: { hash: hashOf(output), bytes } };
    }) };
  }) };
}

export function toolOutputPage(view, { conversationId, turnKey, itemId, hash, offset }) {
  if (view?.id !== conversationId || !stableTurns(view) || !validId(turnKey) || !validId(itemId) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid output request');
  const turns = (view.turns || []).filter(turn => keyOf(turn) === turnKey);
  if (turns.length !== 1) throw new Error('ambiguous turn');
  const items = (turns[0].items || []).filter(item => item?.id === itemId);
  if (items.length !== 1 || items[0].type !== 'commandExecution' || typeof items[0].output !== 'string') throw new Error('unavailable output');
  const output = items[0].output;
  // Hash the current source directly without a full-output copy or retained
  // historical cache. This also detects output edits within an active turn.
  if (offset > output.length || splitPair(output, offset) || hashOf(output) !== hash) throw new Error('output changed');
  let end = Math.min(output.length, offset + pageCharacters);
  if (splitPair(output, end)) end--;
  return { threadId: view.id, turnKey, itemId, hash, offset, text: output.slice(offset, end), nextOffset: end < output.length ? end : null };
}
