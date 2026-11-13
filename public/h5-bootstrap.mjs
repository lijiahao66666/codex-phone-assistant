// The entry point does not start either version until the selected pairing's
// live connector has declared which protocol it understands.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const paths = Object.freeze({ unversioned: '/h5/v1.0.1/desktop.html', v1: '/h5/v1.0.2-readsync1/desktop.html' });
const deviceRequest = { method: 'GET', credentials: 'same-origin', cache: 'no-store' };
const scopeFrom = data => {
  if (!data || !Array.isArray(data.devices)) return null;
  const selected = data.devices.find(x => x.deviceId === data.currentDeviceId);
  return selected && uuid.test(selected.hostId || '') && uuid.test(selected.deviceId || '') ? { hostId: selected.hostId, deviceId: selected.deviceId } : null;
};
const cacheKey = scope => `codex-h5-protocol-v1:${scope.hostId}:${scope.deviceId}`;
const sameScope = (a, b) => Boolean(a && b && a.hostId === b.hostId && a.deviceId === b.deviceId);
const readProtocol = (storage, scope) => { try { const x = JSON.parse(storage?.getItem(cacheKey(scope)) || 'null'); return x?.hostId === scope.hostId && x?.deviceId === scope.deviceId && Object.hasOwn(paths, x.protocol) ? x.protocol : null; } catch { return null; } };
const saveProtocol = (storage, scope, protocol) => { try { storage?.setItem(cacheKey(scope), JSON.stringify({ ...scope, protocol })); } catch { /* The online experience does not require storage. */ } };

export async function chooseBootstrap({ fetchImpl = globalThis.fetch, storage, hash = '', signal } = {}) {
  if (typeof fetchImpl !== 'function' || typeof hash !== 'string' || (hash && !hash.startsWith('#'))) return { status: 'invalid' };
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch { storage = null; } }
  // Pair links must be handled by the existing pairing UI even when a
  // different computer is already selected. The hash never goes to a server.
  const fragment = new URLSearchParams(hash.slice(1));
  if (hash === '#new' || fragment.has('token')) return { status: 'pair' };
  try {
    const response = await fetchImpl('/api/devices', { ...deviceRequest, signal });
    if (!response.ok) return { status: 'unavailable' };
    const devices = await response.json();
    if (signal?.aborted) return { status: 'superseded' };
    if (!Array.isArray(devices?.devices)) return { status: 'unavailable' };
    if (!devices.devices.length) return { status: 'pair' };
    const scope = scopeFrom(devices);
    if (!scope) return { status: 'unavailable' };
    const result = await fetchImpl('/api/ui-profile', { ...deviceRequest, signal, headers: { 'x-codex-expected-device': scope.deviceId } });
    if (!result.ok) return { status: 'unavailable' };
    const profile = await result.json();
    if (signal?.aborted) return { status: 'superseded' };
    if (profile?.deviceId !== scope.deviceId || profile?.hostId !== scope.hostId) return { status: 'superseded' };
    if (profile.status !== 'ready' && profile.status !== 'offline') return { status: ['pending', 'unsupported'].includes(profile.status) ? profile.status : 'unavailable' };
    if (profile.status === 'offline') {
      const protocol = readProtocol(storage, scope);
      if (!protocol) return { status: 'offline' };
      const verify = await fetchImpl('/api/devices', { ...deviceRequest, signal });
      if (!verify.ok) return { status: 'unavailable' };
      if (signal?.aborted || !sameScope(scope, scopeFrom(await verify.json()))) return { status: 'superseded' };
      return { status: 'navigate', path: paths[protocol] + hash, offline: true, scope };
    }
    if (!Object.hasOwn(paths, profile.uiProtocol)) return { status: 'unsupported' };
    // Check the selected cookie again after the handshake; late responses
    // from a previous selection cannot choose a page for the next device.
    const verify = await fetchImpl('/api/devices', { ...deviceRequest, signal });
    if (!verify.ok) return { status: 'unavailable' };
    const current = scopeFrom(await verify.json());
    if (signal?.aborted || current?.hostId !== scope.hostId || current?.deviceId !== scope.deviceId) return { status: 'superseded' };
    saveProtocol(storage, scope, profile.uiProtocol);
    return { status: 'navigate', path: paths[profile.uiProtocol] + hash };
  } catch { return { status: signal?.aborted ? 'superseded' : 'unavailable' }; }
}

const pairingScripts = ['/markdown-parser.js', '/html-sanitizer.js', '/install-prompt.js?v=20261111-home-install2', '/task-reminder-store.js', '/notification-presence.js', '/notifications.js', '/jsQR.js', '/pair.js?v=20261107-stable1', '/desktop.js?v=20261111-home-install', '/download/home-entry.js?v=20261106-2'];

async function start() {
  const notice = document.querySelector('#h5-bootstrap-status'), retry = document.querySelector('#h5-bootstrap-retry');
  if (!notice || !retry) return;
  const initialFragment = location.hash;
  const pairingLink = initialFragment === '#new' || new URLSearchParams(initialFragment.slice(1)).has('token');
  let generation = 0, pairingStarted = false, pairingFailed = false;
  const run = async () => {
    const sequence = ++generation; retry.hidden = true; notice.firstChild.textContent = '正在连接电脑… ';
    const result = await chooseBootstrap({ hash: location.hash });
    if (sequence !== generation) return;
    if (result.status === 'navigate') { location.replace(result.path); return; }
    if (result.status === 'pair') {
      if (pairingStarted) return;
      pairingStarted = true;
      try {
        // A pairing link can be opened while another host is selected. The
        // pairing shell must not expose its unversioned background UI for that
        // host; closing the dialog returns through negotiation instead.
        if (pairingLink) {
          document.querySelector('.app').inert = true;
          document.addEventListener('click', event => {
            if (!event.target.closest?.('#pair-close, #pair-scrim')) return;
            event.preventDefault(); event.stopImmediatePropagation(); location.replace('/');
          }, true);
        }
        for (const src of pairingScripts) await new Promise((resolve, reject) => {
          const script = document.createElement('script'); script.src = src; script.onload = resolve; script.onerror = src.startsWith('/download/') ? resolve : reject; document.head.append(script);
        });
        document.querySelector('.app').hidden = false; notice.hidden = true;
      } catch { notice.firstChild.textContent = '配对页面加载失败，请重试。 '; retry.hidden = false; pairingFailed = true; }
      return;
    }
    notice.firstChild.textContent = result.status === 'offline' ? '电脑未连接，请打开桌面助手。 ' : result.status === 'unsupported' ? '桌面助手版本暂不兼容，请检查更新。 ' : '正在等待电脑连接，请重试。 ';
    retry.hidden = false;
  };
  retry.addEventListener('click', () => { if (pairingFailed) location.reload(); else void run(); });
  await run();
}
if (typeof document !== 'undefined' && document.querySelector('#h5-bootstrap-status')) void start();
