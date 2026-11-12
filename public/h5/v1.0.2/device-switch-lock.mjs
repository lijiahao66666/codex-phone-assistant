// A single origin-wide lock coordinates cooperating H5 tabs. It does not
// coordinate older pages that have not installed this protocol, other browser
// profiles, or external writers; server-side identity/profile validation is
// still required for every mutation.
export const DEVICE_SWITCH_LOCK = 'codex-phone:device-switch:v1';

// The callback owns the lock until its promise settles. Do not retry an action
// on failure: a network error can occur after the server changed the cookie.
export async function withDeviceSwitchLock({ locks = globalThis.navigator?.locks, signal, run } = {}) {
  if (!locks || typeof locks.request !== 'function') return { status: 'unsupported' };
  if (typeof run !== 'function') return { status: 'invalid' };
  if (signal?.aborted) return { status: 'cancelled' };
  let entered = false;
  try {
    return await locks.request(DEVICE_SWITCH_LOCK, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) return { status: 'busy' };
      if (signal?.aborted) return { status: 'cancelled' };
      entered = true;
      return { status: 'completed', value: await run({ signal }) };
    });
  } catch (error) {
    // The caller must distinguish failure before dispatch from an unknown
    // outcome after dispatch and reconcile with the server before retrying.
    return { status: entered ? 'outcome-unknown' : 'unavailable', error };
  }
}
