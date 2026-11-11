'use strict';
(() => {
  const panel = document.querySelector('#install-prompt');
  const dismiss = document.querySelector('#install-dismiss');
  const action = document.querySelector('#install-action');
  const message = document.querySelector('#install-message');
  if (!panel || !dismiss || !action || !message) return;
  const help = document.querySelector('#install-help');
  const storageKey = 'codex-phone-install-dismissed-until';
  const displayMode = window.matchMedia?.('(display-mode: standalone)');
  const isStandalone = () => displayMode?.matches || navigator.standalone === true;
  const suppressed = () => {
    try { return Number(localStorage.getItem(storageKey)) > Date.now(); } catch { return false; }
  };
  const ua = navigator.userAgent || '';
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const mobile = ios || /Android/.test(ua);
  let deferred, offered = false, installed = false, prompting = false, dismissed = false;
  let eligible = !panel.hasAttribute('data-home-only');
  const instructions = ios
    ? '点击浏览器的“分享”，选择“添加到主屏幕”，再点“添加”。如果没有此选项，请用 Safari 打开此页面。'
    : '打开浏览器菜单，选择“安装应用”或“添加到主屏幕”，按提示确认。没有此选项时，可以尝试 Chrome 或 Edge。';
  function hide() { panel.hidden = true; }
  function refresh() {
    if (!eligible || installed || dismissed || isStandalone() || suppressed() || (!mobile && !deferred && !offered)) { hide(); return; }
    message.textContent = '像 App 一样从手机桌面打开，使用独立窗口。';
    action.textContent = deferred ? '添加到主屏幕' : '查看添加方法';
    action.hidden = !help && !deferred;
    action.disabled = prompting;
    if (help) {
      help.textContent = instructions;
      action.setAttribute('aria-controls', 'install-help');
      action.setAttribute('aria-expanded', String(!help.hidden));
    } else if (!deferred) message.textContent = instructions;
    panel.hidden = false;
  }
  window.setInstallPromptPageEligible = value => {
    eligible = value === true;
    if (!eligible && help) help.hidden = true;
    refresh();
  };
  dismiss.addEventListener('click', () => {
    try { localStorage.setItem(storageKey, String(Date.now() + 30 * 86400000)); } catch { /* Storage can be unavailable. */ }
    dismissed = true;
    hide();
  });
  action.addEventListener('click', async () => {
    if (prompting) return;
    const prompt = deferred;
    if (!prompt) {
      if (help) { help.hidden = !help.hidden; refresh(); }
      return;
    }
    deferred = undefined;
    prompting = true; action.disabled = true;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice?.outcome === 'accepted') installed = true;
    } catch { if (help) help.hidden = false; }
    finally { prompting = false; refresh(); }
  });
  window.addEventListener('beforeinstallprompt', event => {
    if (installed || isStandalone() || suppressed() || dismissed) return;
    event.preventDefault();
    deferred = event; offered = true;
    refresh();
  });
  window.addEventListener('appinstalled', () => { deferred = undefined; installed = true; hide(); });
  displayMode?.addEventListener?.('change', refresh);
  refresh();
})();
