'use strict';
(() => {

const form = document.querySelector('#pair-form');
const codeInput = document.querySelector('#code');
const submitButton = document.querySelector('#submit');
const errorMessage = document.querySelector('#pair-error');
const scanButton = document.querySelector('#scan');
const stopButton = document.querySelector('#stop-scan');
const scanner = document.querySelector('#scanner');
const scanStatus = document.querySelector('#scan-status');
const video = document.querySelector('#camera');
const canvas = document.querySelector('#scan-canvas');
const cancelPair = document.querySelector('#cancel-pair');
const overlay = document.querySelector('#pair-overlay');
const unpairedControl = document.querySelector('#unpaired-control');
const pairAnother = document.querySelector('#pair-another');
const codePattern = /^\d{6}$/;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

const fragment = new URLSearchParams(location.hash.slice(1));
const scanned = fragment.get('token');
const addingComputer = location.hash === '#new';
if (location.hash || location.pathname === '/pair') window.history.replaceState(null, '', '/');
let selectedQrToken = scanned && tokenPattern.test(scanned) ? scanned : null;
window.pairingReady = (async () => {
  try {
    const response = await fetch('/api/host-status', { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) {
      const result = await response.json().catch(() => null);
      if (result?.error === 'device-replaced') { window.pairingConflictState = result; return 'replaced'; }
    }
    return response.ok ? 'paired' : response.status === 401 || response.status === 403 ? 'unpaired' : 'unavailable';
  } catch { return 'unavailable'; }
})();

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = !message;
  if (!scanner.hidden && message) scanStatus.textContent = message;
}
codeInput.addEventListener('input', () => { selectedQrToken = null; showError(''); });

let stream = null, scanGeneration = 0, frame = null, scanTimer = null;
function stopScan() {
  scanGeneration++;
  if (frame !== null) cancelAnimationFrame(frame);
  if (scanTimer !== null) clearTimeout(scanTimer);
  frame = scanTimer = null;
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null;
  video.srcObject = null;
  scanner.hidden = true;
  scanButton.disabled = false;
}
function pairingCode(value) {
  try {
    const url = new URL(value);
    if (url.origin !== location.origin || url.pathname !== '/pair' || url.search || url.username || url.password) return null;
    const params = new URLSearchParams(url.hash.slice(1));
    const token = params.get('token');
    if ([...params.keys()].length !== 1 || !token || !tokenPattern.test(token)) return null;
    return token;
  } catch { return null; }
}
scanButton.addEventListener('click', async () => {
  if (!navigator.mediaDevices?.getUserMedia || typeof jsQR !== 'function') return showError('当前浏览器不支持扫码，请输入配对码');
  stopScan();
  const generation = scanGeneration;
  scanButton.disabled = true;
  showError('');
  codeInput.blur();
  scanner.hidden = false;
  scanStatus.textContent = '正在打开相机…';
  stopButton.focus();
  try {
    const camera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    if (generation !== scanGeneration) { camera.getTracks().forEach(track => track.stop()); return; }
    stream = camera;
    video.srcObject = camera;
    await video.play();
    if (generation !== scanGeneration) return;
    scanStatus.textContent = '将电脑端的配对二维码放入框内';
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('camera unavailable');
    scanTimer = setTimeout(() => { stopScan(); showError('扫码超时，请重试或输入配对码'); }, 60000);
    const scan = () => {
      if (generation !== scanGeneration) return;
      if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
        const scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const result = jsQR(image.data, image.width, image.height);
        if (result) {
          const token = pairingCode(result.data);
          if (token) { selectedQrToken = token; codeInput.value = ''; stopScan(); showError(''); void submitPair(); return; }
          showError('二维码不是此服务的配对码');
        }
      }
      frame = requestAnimationFrame(scan);
    };
    frame = requestAnimationFrame(scan);
  } catch (error) {
    if (generation !== scanGeneration) return;
    stopScan();
    showError(error?.name === 'NotAllowedError' ? '相机权限未开启，请在浏览器设置中允许，或输入配对码' : '无法打开相机，请重试或输入配对码');
  }
});
stopButton.addEventListener('click', () => { stopScan(); scanButton.focus(); });
document.querySelector('#scan-manual').addEventListener('click', () => { stopScan(); codeInput.focus(); });
window.addEventListener('keydown', event => { if (event.key === 'Escape' && !scanner.hidden) { stopScan(); scanButton.focus(); } });
let pairGeneration = 0;
let pageActive = true;
cancelPair.addEventListener('click', () => { pairGeneration++; cancelPair.hidden = true; submitButton.disabled = false; showError('已取消等待'); });
function openPairing() { if (window.showPairingRecovery?.()) return; overlay.hidden = false; showError(''); }
function closePairing() { stopScan(); pairGeneration++; overlay.hidden = true; cancelPair.hidden = true; submitButton.disabled = false; selectedQrToken = null; }
unpairedControl.addEventListener('click', openPairing);
pairAnother.addEventListener('click', () => { document.querySelector('#devices').open = false; openPairing(); });
document.querySelector('#pair-close').addEventListener('click', closePairing);
document.querySelector('#pair-scrim').addEventListener('click', closePairing);
window.addEventListener('pagehide', () => { pageActive = false; closePairing(); });
window.addEventListener('pageshow', () => { pageActive = true; });

async function submitPair() {
  if (submitButton.disabled) return;
  const qrToken = selectedQrToken;
  const code = codeInput.value.trim();
  if (qrToken ? !tokenPattern.test(qrToken) : !codePattern.test(code)) return showError('配对码格式不正确');
  const generation = ++pairGeneration;
  showError('');
  stopScan();
  submitButton.disabled = true;
  try {
    const response = await fetch('/api/pair', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(qrToken ? { qrToken } : { code }),
    });
    if (generation !== pairGeneration) { if (response.ok && response.status !== 202 && pageActive) location.assign('/'); return; }
    if (response.status === 202 && !qrToken) {
      const result = await response.json();
      if (generation !== pairGeneration) return;
      if (!result.pending || !tokenPattern.test(result.claimToken || '')) throw new Error('invalid response');
      cancelPair.hidden = false;
      showError('等待电脑确认配对');
      for (let i = 0; i < 60 && generation === pairGeneration; i++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (generation !== pairGeneration) return;
        const claim = await fetch('/api/pair/claim', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claimToken: result.claimToken }) });
        if (generation !== pairGeneration) { if (claim.ok && claim.status !== 202 && pageActive) location.assign('/'); return; }
        if (claim.status === 202) continue;
        if (claim.ok) { codeInput.value = ''; selectedQrToken = null; location.assign('/'); return; }
        if (claim.status === 401) { showError('配对已拒绝或过期'); return; }
        throw new Error('claim failed');
      }
      if (generation === pairGeneration) showError('配对已过期，请重新获取配对码');
      return;
    }
    if (response.ok && response.status !== 202) { codeInput.value = ''; selectedQrToken = null; location.assign('/'); return; }
    if (response.ok) throw new Error('unexpected response');
    if (response.status === 401) showError('配对码无效或已过期');
    else if (response.status === 429) showError('尝试次数过多，请稍后再试');
    else showError('配对失败，请稍后再试');
  } catch {
    if (generation === pairGeneration) showError('连接中断，配对结果未知，请重新打开页面确认');
  } finally {
    if (generation === pairGeneration) { submitButton.disabled = false; cancelPair.hidden = true; }
  }
}
form.addEventListener('submit', event => { event.preventDefault(); return submitPair(); });
if (selectedQrToken) { openPairing(); void submitPair(); }
else if (scanned || addingComputer) { openPairing(); if (scanned) showError('二维码不是此服务的配对码'); }
})();
