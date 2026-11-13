import { withDeviceSwitchLock } from './device-switch-lock.mjs';

// A cross-version navigation destroys in-memory state. Until complete durable
// migration exists, it is permitted only when the page proves it has no work.
export async function switchDeviceVersion({ current, target, protocol, getCurrent, hasWork, setBusy, freeze, changed, navigate, fetchImpl = globalThis.fetch, locks = globalThis.navigator?.locks, fragment = '' }) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!current || !target || !uuid.test(current.deviceId || '') || !uuid.test(current.hostId || '') || !uuid.test(target.deviceId || '') || !uuid.test(target.hostId || '') || !['v1', 'unversioned'].includes(protocol) || typeof getCurrent !== 'function' || typeof hasWork !== 'function' || typeof setBusy !== 'function' || typeof freeze !== 'function' || typeof changed !== 'function' || typeof navigate !== 'function' || typeof fetchImpl !== 'function' || typeof fragment !== 'string' || (fragment && !fragment.startsWith('#'))) return { status: 'invalid' };
  const currentMatches = () => { const value = getCurrent(); return value?.deviceId === current.deviceId && value?.hostId === current.hostId; };
  const result = await withDeviceSwitchLock({ locks, run: async () => {
    if (!currentMatches()) return { status: 'changed' };
    setBusy(true);
    let dispatched = false;
    try {
      const response = await fetchImpl(`/api/ui-profile?deviceId=${encodeURIComponent(target.deviceId)}`, { credentials: 'same-origin', cache: 'no-store', headers: { 'x-codex-expected-device': current.deviceId } });
      if (!response.ok) { if (response.status === 409) freeze(); return { status: 'unavailable' }; }
      const profile = await response.json();
      if (!currentMatches() || profile.currentDeviceId !== current.deviceId || profile.deviceId !== target.deviceId || profile.hostId !== target.hostId) return { status: 'changed' };
      if (profile.status !== 'ready' || !['v1', 'unversioned'].includes(profile.uiProtocol) || !uuid.test(profile.profileEpoch || '')) return { status: 'unavailable' };
      const crossing = profile.uiProtocol !== protocol;
      if (crossing && hasWork() !== false) return { status: 'work-present' };
      // Re-check before dispatch while the page is inert and lock is held.
      if (!currentMatches() || crossing && hasWork() !== false) return { status: 'changed' };
      dispatched = true;
      const selected = await fetchImpl('/api/devices/select', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-codex-expected-device': current.deviceId }, body: JSON.stringify({ deviceId: target.deviceId, expectedDeviceId: current.deviceId, uiProtocol: profile.uiProtocol, profileEpoch: profile.profileEpoch }) });
      if (!selected.ok) { freeze(); return { status: selected.status === 409 ? 'changed' : 'unavailable' }; }
      const check = await fetchImpl('/api/devices', { credentials: 'same-origin', cache: 'no-store' });
      if (!check.ok) throw new Error('Selection outcome unknown');
      const devices = await check.json();
      if (!Array.isArray(devices.devices) || devices.currentDeviceId !== target.deviceId || !devices.devices.some(item => item.deviceId === target.deviceId && item.hostId === target.hostId)) throw new Error('Selection outcome unknown');
      const verified = await fetchImpl(`/api/ui-profile?deviceId=${encodeURIComponent(target.deviceId)}`, { credentials: 'same-origin', cache: 'no-store', headers: { 'x-codex-expected-device': target.deviceId } });
      if (!verified.ok) throw new Error('Selection outcome unknown');
      const finalProfile = await verified.json();
      if (finalProfile.status !== 'ready' || finalProfile.hostId !== target.hostId || finalProfile.deviceId !== target.deviceId || finalProfile.currentDeviceId !== target.deviceId || finalProfile.profileEpoch !== profile.profileEpoch || finalProfile.uiProtocol !== profile.uiProtocol || !currentMatches()) throw new Error('Selection outcome unknown');
      changed();
      if (crossing) navigate((profile.uiProtocol === 'v1' ? '/h5/v1.0.2-open1/desktop.html' : '/h5/v1.0.1/desktop.html') + fragment);
      return { status: crossing ? 'navigating' : 'selected' };
    } catch {
      if (dispatched) { freeze(); return { status: 'outcome-unknown' }; }
      return { status: 'unavailable' };
    } finally { setBusy(false); }
  } });
  return result.status === 'completed' ? result.value : { status: result.status };
}
