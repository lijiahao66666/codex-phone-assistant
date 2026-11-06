'use strict';
(() => {
  const panel = document.querySelector('#install-prompt');
  const dismiss = document.querySelector('#install-dismiss');
  const action = document.querySelector('#install-action');
  const message = document.querySelector('#install-message');
  if (!panel || !dismiss || !action || !message) return;
  const storageKey = 'codex-phone-install-dismissed-until';
  const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  const suppressed = () => {
    try { return Number(localStorage.getItem(storageKey)) > Date.now(); } catch { return false; }
  };
  let deferred;
  function hide() { panel.hidden = true; }
  function show(text, canInstall) {
    if (isStandalone() || suppressed()) return;
    message.textContent = text;
    action.hidden = !canInstall;
    panel.hidden = false;
  }
  dismiss.addEventListener('click', () => {
    try { localStorage.setItem(storageKey, String(Date.now() + 30 * 86400000)); } catch { /* Storage can be unavailable. */ }
    deferred = undefined;
    hide();
  });
  action.addEventListener('click', async () => {
    const prompt = deferred;
    if (!prompt) return;
    deferred = undefined;
    action.disabled = true;
    try { await prompt.prompt(); } catch { /* The browser may reject an expired prompt. */ }
    finally { action.disabled = false; hide(); }
  });
  window.addEventListener('beforeinstallprompt', event => {
    if (isStandalone() || suppressed()) return;
    event.preventDefault();
    deferred = event;
    show('从主屏幕打开，使用独立窗口。', true);
  });
  window.addEventListener('appinstalled', () => { deferred = undefined; hide(); });
  const ua = navigator.userAgent || '';
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios) show('在浏览器中点“分享”，选择“添加到主屏幕”。', false);
})();
