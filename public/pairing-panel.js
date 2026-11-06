const status = document.querySelector('#status');
const button = document.querySelector('#pair');
const result = document.querySelector('#pair-result');
const code = document.querySelector('#code');
const qr = document.querySelector('#qr');
const expiry = document.querySelector('#expiry');
const requests = document.querySelector('#requests');
const phoneConnection = document.querySelector('#phone-connection');
let devicesTimer, devicesGeneration = 0;
let expiryTimer, pollTimer, pollGeneration = 0, pollSequence = 0;
const deciding = new Set();
const decided = new Set();
const announced = new Set();

async function refreshDevices(generation) {
  try {
    const response = await fetch('/api/devices', { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (!Array.isArray(data.devices)) throw new Error();
    if (generation !== devicesGeneration) return;
    const known = data.devices.every(device => typeof device.phoneConnected === 'boolean');
    phoneConnection.textContent = !known ? '手机连接状态不可用' : data.devices.some(device => device.phoneConnected) ? '手机已连接' : '暂无手机连接';
  } catch {
    if (generation === devicesGeneration) phoneConnection.textContent = '手机连接状态不可用';
  }
  if (generation === devicesGeneration) devicesTimer = setTimeout(() => refreshDevices(generation), 5000);
}
void refreshDevices(++devicesGeneration);

async function pollRequests(generation) {
  const sequence = ++pollSequence;
  try {
    const response = await fetch('/api/pair-requests');
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (generation !== pollGeneration || sequence !== pollSequence) return;
    if (!Array.isArray(data.requests)) throw new Error();
    const fragment = document.createDocumentFragment();
    const pending = data.requests.filter(request => typeof request.requestId === 'string' && !decided.has(request.requestId));
    if (pending[0] && !announced.has(pending[0].requestId)) {
      announced.add(pending[0].requestId);
      window.webkit?.messageHandlers?.pairRequest?.postMessage('pending');
    }
    for (const request of pending.slice(0, 1)) {
      if (typeof request.requestId !== 'string') continue;
      const row = document.createElement('div');
      row.className = 'pair-request';
      row.setAttribute('role', 'dialog'); row.setAttribute('aria-modal', 'true'); row.setAttribute('aria-labelledby', 'pair-request-title');
      const label = document.createElement('h2'); label.id = 'pair-request-title';
      label.textContent = '手机配对请求';
      const description = document.createElement('p'); description.textContent = '有手机通过配对码请求连接这台电脑，是否允许？';
      const actions = document.createElement('div'); actions.className = 'pair-request-actions';
      row.append(label, description, actions);
      for (const [text, approve] of [['允许', true], ['拒绝', false]]) {
        const action = document.createElement('button');
        action.type = 'button'; action.textContent = text;
        action.disabled = deciding.has(request.requestId);
        action.addEventListener('click', async () => {
          if (deciding.has(request.requestId)) return;
          deciding.add(request.requestId);
          row.querySelectorAll('button').forEach(button => { button.disabled = true; });
          try {
            const result = await fetch('/api/pair-decision', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: request.requestId, approve }) });
            if (!result.ok) throw new Error();
            if (generation !== pollGeneration) return;
            decided.add(request.requestId);
            status.textContent = approve ? '已允许手机配对。' : '已拒绝配对请求。';
          } catch { if (generation === pollGeneration) status.textContent = '处理失败或请求已过期，请重新配对。'; }
          finally { deciding.delete(request.requestId); if (generation === pollGeneration) { clearTimeout(pollTimer); void pollRequests(generation); } }
        });
        actions.append(action);
      }
      fragment.append(row);
    }
    requests.replaceChildren(fragment);
    requests.hidden = pending.length === 0;
  } catch { if (generation === pollGeneration && sequence === pollSequence) status.textContent = '无法获取配对请求，请检查连接。'; }
  if (generation === pollGeneration && sequence === pollSequence) pollTimer = setTimeout(() => pollRequests(generation), 2000);
}

function clearPairing() {
  clearTimeout(expiryTimer);
  clearTimeout(pollTimer);
  ++pollGeneration;
  decided.clear();
  announced.clear();
  requests.replaceChildren();
  requests.hidden = true;
  result.hidden = true;
  code.textContent = '';
  qr.removeAttribute('src');
  expiry.textContent = '';
}

button.addEventListener('click', async () => {
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = '正在生成...';
  status.textContent = '';
  clearPairing();
  try {
    const response = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!response.ok) throw new Error('无法生成配对码，请检查网络后重试。');
    const pair = await response.json();
    if (typeof pair.code !== 'string' || typeof pair.qr !== 'string' || !Number.isFinite(pair.expiresAt) || pair.expiresAt <= Date.now()) throw new Error('配对码已失效，请重新生成。');
    code.textContent = pair.code;
    qr.src = pair.qr;
    expiry.textContent = `有效期至 ${new Date(pair.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    result.hidden = false;
    void pollRequests(++pollGeneration);
    button.textContent = '重新生成';
    expiryTimer = setTimeout(() => { clearPairing(); status.textContent = '配对码已过期，请重新生成。'; button.textContent = '重新生成'; }, Math.max(0, pair.expiresAt - Date.now()));
  } catch (error) {
    status.textContent = error.message || '无法生成配对码，请稍后重试。';
    button.textContent = '重试';
  } finally { button.disabled = false; }
});

window.addEventListener('pagehide', () => { clearPairing(); ++devicesGeneration; clearTimeout(devicesTimer); });
window.addEventListener('pageshow', event => { if (event.persisted) void refreshDevices(++devicesGeneration); });
