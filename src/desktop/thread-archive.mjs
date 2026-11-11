const validThreadId = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const unavailable = (reason, ownerKind = 'unknown') => ({ available: false, reason, ownerKind });

// Authorization and lock adapters are deliberately synchronous. The caller must
// refresh its allowed-thread index before calling, then keep these predicates
// live so a revoke or pending recovery during discovery cannot pass dispatch.
export function createThreadArchive({ localOwner, discover, isAuthorized, isLocked }) {
  if (!localOwner || typeof discover !== 'function' || typeof isAuthorized !== 'function'
      || typeof isLocked !== 'function') throw new TypeError('Missing archive adapters');

  function gate(threadId, context) {
    if (!validThreadId(threadId)) return 'invalid-thread';
    try {
      if (isAuthorized(threadId, context) !== true) return 'not-authorized';
      if (isLocked(threadId, context) !== false) return 'thread-locked';
    } catch { return 'unavailable'; }
    return null;
  }

  function helperReady(threadId, expectedOwner) {
    try {
      return localOwner.state === 'ready' && expectedOwner
        && localOwner.ownerId() === expectedOwner
        && localOwner.owner?.isThreadOwned(threadId) === true
        && localOwner.owner.canPerformThreadAction(threadId) === true
        && !localOwner.owner.isThreadReleasing(threadId)
        && localOwner.pendingWrites === 0 && localOwner.uncertainWrites === false
        && localOwner.client?.pending?.size === 0
        && !localOwner.rawBridge?.hasUnresolved();
    } catch { return false; }
  }

  async function inspect(threadId, context = {}) {
    const blocked = gate(threadId, context);
    if (blocked) return unavailable(blocked);
    let owner;
    try { owner = await discover(threadId); } catch { return unavailable('owner-unavailable'); }
    const changed = gate(threadId, context);
    if (changed) return unavailable(changed);
    if (owner?.kind !== 'owner' || typeof owner.ownerId !== 'string' || !owner.ownerId) {
      return unavailable('owner-unavailable');
    }
    let helperId;
    try { helperId = localOwner.ownerId(); } catch { return unavailable('owner-unavailable'); }
    if (helperId != null && typeof helperId !== 'string') return unavailable('owner-unavailable');
    // The native follower protocol has no archive operation. In particular, do
    // not resume, unsubscribe, or send helper app-server writes to this owner.
    if (owner.ownerId !== helperId) return unavailable('not-supported-desktop-owner', 'desktop');
    if (!helperReady(threadId, helperId)) return unavailable('thread-not-idle', 'helper');
    return { available: true, reason: null, ownerKind: 'helper' };
  }

  async function archive(threadId, context = {}) {
    let expectedOwner;
    try { expectedOwner = localOwner.ownerId(); } catch { /* inspect reports availability */ }
    const result = await inspect(threadId, context);
    let reason = result.reason;
    if (result.available) {
      reason = gate(threadId, context);
      if (!reason && !helperReady(threadId, expectedOwner)) reason = 'thread-not-idle';
    }
    if (reason) throw Object.assign(new Error(reason), {
      code: reason === 'not-supported-desktop-owner' ? reason : 'unavailable', reason,
    });
    // No retry: after dispatch an RPC timeout may mean the archive succeeded.
    // Preserve the original error and the LocalOwner uncertain-write lock.
    return localOwner.threadAction(threadId, 'archive');
  }

  return { inspect, archive };
}
