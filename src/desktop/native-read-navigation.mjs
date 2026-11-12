import { setTimeout as delay } from 'node:timers/promises';
import { readDesktopReadState } from './read-state.mjs';
import { openDesktopThread } from './open-thread.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scopePattern = /^[a-f0-9]{64}$/;

// A phone click navigates Desktop; it does not invent a notification receipt.
export async function navigateDesktopUnread(threadId, expectedScope, {
  isCancelled = () => false, readState = readDesktopReadState, openThread = openDesktopThread,
  timeoutMs = 3000, pollMs = 100,
} = {}) {
  const fail = () => { throw Object.assign(new Error('Desktop read unavailable'), { code: 'unavailable' }); };
  if (!uuid.test(threadId || '') || !scopePattern.test(expectedScope || '') || typeof isCancelled !== 'function'
      || typeof readState !== 'function' || typeof openThread !== 'function'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000
      || !Number.isSafeInteger(pollMs) || pollMs < 1) fail();
  const check = state => {
    if (isCancelled() || state?.status !== 'available' || state.canReadUnread !== true
        || state.scopeKey !== expectedScope || !(state.unreadThreadIds instanceof Set)) fail();
  };
  const before = await readState(); check(before);
  if (!before.unreadThreadIds.has(threadId)) fail();
  if (isCancelled()) fail();
  await openThread(threadId);
  if (isCancelled()) fail();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await readState(); check(state);
    if (!state.unreadThreadIds.has(threadId)) return { read: true };
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail();
    await delay(Math.min(pollMs, remaining));
    if (isCancelled()) fail();
  }
}
