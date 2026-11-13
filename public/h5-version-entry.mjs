import { chooseBootstrap } from './h5-bootstrap.mjs';

// The scripts are intentionally fixed here; neither a server response nor a
// query parameter is allowed to inject a URL into the page.
const common = version => [`/h5/${version}/markdown-parser.js`, `/h5/${version}/html-sanitizer.js`, `/h5/${version}/install-prompt.js`];
const scripts = Object.freeze({
  '/h5/v1.0.1/desktop.html': [...common('v1.0.1'), '/h5/v1.0.1/jsQR.js', '/h5/v1.0.1/pair.js', '/h5/v1.0.1/desktop.js', '/download/home-entry.js?v=20261106-2'],
  '/h5/v1.0.2/desktop.html': [...common('v1.0.2'), '/h5/v1.0.2/task-reminder-store.js', '/h5/v1.0.2/notification-presence.js', '/h5/v1.0.2/notifications.js', '/h5/v1.0.2/jsQR.js', '/h5/v1.0.2/pair.js', '/h5/v1.0.2/desktop.js', '/download/home-entry.js?v=20261106-2'],
  '/h5/v1.0.2-activity1/desktop.html': [...common('v1.0.2-activity1'), '/h5/v1.0.2-activity1/task-reminder-store.js', '/h5/v1.0.2-activity1/notification-presence.js', '/h5/v1.0.2-activity1/notifications.js', '/h5/v1.0.2-activity1/jsQR.js', '/h5/v1.0.2-activity1/pair.js', '/h5/v1.0.2-activity1/desktop.js', '/download/home-entry.js?v=20261106-2'],
  '/h5/v1.0.2-unread1/desktop.html': [...common('v1.0.2-unread1'), '/h5/v1.0.2-unread1/task-reminder-store.js', '/h5/v1.0.2-unread1/notification-presence.js', '/h5/v1.0.2-unread1/notifications.js', '/h5/v1.0.2-unread1/jsQR.js', '/h5/v1.0.2-unread1/pair.js', '/h5/v1.0.2-unread1/desktop.js', '/download/home-entry.js?v=20261106-2'],
});

export async function decideVersionEntry({ pathname, hash = '', fetchImpl, storage, signal } = {}) {
  if (!Object.hasOwn(scripts, pathname) || typeof hash !== 'string' || (hash && !hash.startsWith('#'))) return { status: 'invalid' };
  if (hash === '#new' || new URLSearchParams(hash.slice(1)).has('token')) return { status: 'navigate', path: '/' + hash };
  // Only the unversioned entry point starts pairing; all other traffic must
  // prove the current identity before it loads any versioned application.
  const choice = await chooseBootstrap({ fetchImpl, storage, signal, hash: '' });
  if (choice.status === 'pair') return { status: 'navigate', path: '/' + hash };
  if (choice.status !== 'navigate') return choice;
  if (choice.path !== pathname) return { status: 'navigate', path: choice.path + hash };
  return { status: 'load', scripts: [...scripts[pathname]], ...(choice.offline ? { offline: true, scope: choice.scope } : {}) };
}

// Offline mode is pinned to the identity revalidated by the relay. Prevent
// mutations even if the desktop reconnects while this page is still open;
// a reload runs version negotiation again. Do not let a changed current
// cookie silently redirect read requests to another computer.
export function offlineFetch(fetchImpl, scope, origin) {
  return async (input, init = {}) => {
    const method = String(init.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) throw new Error('Offline read-only mode');
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const url = new URL(raw, origin);
    if (url.origin !== origin || !url.pathname.startsWith('/api/')) return fetchImpl(input, init);
    const headers = new Headers(init.headers || (typeof input === 'object' && input?.headers) || undefined);
    headers.set('x-codex-expected-device', scope.deviceId);
    const response = await fetchImpl(input, { ...init, headers });
    if (url.pathname === '/api/devices' && response.ok) {
      const value = await response.clone().json();
      if (value?.currentDeviceId !== scope.deviceId || !value.devices?.some(item => item.deviceId === scope.deviceId && item.hostId === scope.hostId)) throw new Error('Device scope changed');
    }
    return response;
  };
}

async function start() {
  const notice = document.querySelector('#h5-version-status'), retry = document.querySelector('#h5-version-retry');
  if (!notice || !retry) return;
  let generation = 0, loading = false, failed = false;
  const run = async () => {
    const sequence = ++generation; retry.hidden = true; notice.firstChild.textContent = '正在连接电脑… ';
    const result = await decideVersionEntry({ pathname: location.pathname, hash: location.hash });
    if (sequence !== generation) return;
    if (result.status === 'navigate') { location.replace(result.path); return; }
    if (result.status === 'load' && !loading) {
      loading = true;
      try {
        if (result.offline) {
          globalThis.fetch = offlineFetch(globalThis.fetch.bind(globalThis), result.scope, location.origin);
          const banner = document.createElement('p'); banner.setAttribute('role', 'status'); banner.textContent = '电脑未连接，当前为只读模式；重新打开页面可检查连接。';
          document.body.prepend(banner);
        }
        for (const src of result.scripts) await new Promise((resolve, reject) => {
          const script = document.createElement('script'); script.src = src; script.onload = resolve; script.onerror = src.startsWith('/download/') ? resolve : reject; document.head.append(script);
        });
        document.querySelector('.app').hidden = false; notice.hidden = true;
      } catch { notice.firstChild.textContent = '页面加载失败，请重试。 '; retry.hidden = false; failed = true; }
      return;
    }
    notice.firstChild.textContent = result.status === 'offline' ? '电脑未连接，请打开桌面助手。 ' : result.status === 'unsupported' ? '桌面助手版本暂不兼容，请检查更新。 ' : '正在等待电脑连接，请重试。 ';
    retry.hidden = false;
  };
  retry.addEventListener('click', () => { if (failed) location.reload(); else void run(); });
  await run();
}
if (typeof document !== 'undefined' && document.querySelector('#h5-version-status')) void start();
