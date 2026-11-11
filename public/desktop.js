'use strict';
const projectList = document.querySelector('#project-list');
const connection = document.querySelector('#connection');
const title = document.querySelector('#title');
const history = document.querySelector('#history');
const loadEarlier = document.createElement('button');
loadEarlier.type = 'button'; loadEarlier.className = 'load-earlier'; loadEarlier.textContent = '加载更早消息'; loadEarlier.hidden = true;
history.after?.(loadEarlier);
const turns = document.querySelector('#turns');
const error = document.querySelector('#error');
const pairingConflict = document.querySelector('#pairing-conflict');
const pairingConflictDismiss = document.querySelector('#pairing-conflict-dismiss');
const pairingConflictRestore = document.querySelector('#pairing-conflict-restore');
const pairingConflictError = document.querySelector('#pairing-conflict-error');
const sidebar = document.querySelector('#sidebar');
const scrim = document.querySelector('#scrim');
const composerForm = document.querySelector('#composer-form');
const messageInput = document.querySelector('#message');
const imageChoose = document.querySelector('#image-choose');
const attachmentControl = document.querySelector('#attachment-control');
const attachmentToggle = document.querySelector('#attachment-toggle');
const attachmentMenu = document.querySelector('#attachment-menu');
const imageFile = document.querySelector('#image-file');
const fileChoose = document.querySelector('#file-choose');
const modeChoose = document.querySelector('#mode-choose');
const planBadge = document.querySelector('#plan-badge');
const currentProject = document.querySelector('#current-project');
const modeStatus = document.querySelector('#mode-status');
const modelControl = document.createElement('select');
const modelControls = document.createElement('div');
modelControls.className = 'model-controls';
modelControl.className = 'model-control';
modelControl.setAttribute('aria-label', '选择模型');
modelControl.title = '选择模型';
modelControl.disabled = true;
const effortControl = document.createElement('select');
effortControl.className = 'model-control effort-control';
effortControl.setAttribute('aria-label', '选择推理强度');
effortControl.title = '选择推理强度';
effortControl.disabled = true;
modelControls.append?.(modelControl, effortControl);
document.querySelector('.composer-inner')?.insertBefore?.(modelControls, document.querySelector('#voice-input'));
// Native selects stay as hidden logic interfaces. The visible controls are in-app
// panels, so iOS shows the same option sheet as the rest of the UI instead of the OS wheel.
const pickerRegistry = [];
function pickerOptions(select) {
  if (select.options && typeof select.options.length === 'number') return Array.from(select.options);
  return Array.isArray(select.children) ? select.children.slice() : [];
}
function closeAllPickers() {
  for (const item of pickerRegistry) { item.panel.hidden = true; item.trigger.setAttribute?.('aria-expanded', 'false'); }
}
function renderPickerPanel(item) {
  if (item.view) {
    const view = item.view;
    const back = element('button', 'picker-back', item.title);
    back.type = 'button';
    back.addEventListener('click', event => { event?.stopPropagation?.(); item.view = null; renderPickerPanel(item); });
    const rows = view.options.map(option => {
      const button = element('button', 'picker-option' + (option.current ? ' is-current' : ''), option.label);
      button.type = 'button';
      button.setAttribute?.('role', 'option');
      button.addEventListener('click', event => { event?.stopPropagation?.(); view.apply(option.value); item.view = null; closeAllPickers(); });
      return button;
    });
    item.panel.replaceChildren?.(back, element('div', 'picker-panel-title', view.title), ...rows);
    if (!rows.length) item.panel.append?.(element('div', 'picker-empty', '暂无可选项'));
    return;
  }
  const options = pickerOptions(item.select);
  if (item === modelPicker && !newDraft && !modelCatalog.length) {
    // Without the catalog the list would be empty and the control used to stay
    // disabled, so a tap did nothing at all. Offer the reload instead.
    const retry = element('button', 'picker-option', '模型列表未加载，点击重试');
    retry.type = 'button';
    retry.addEventListener('click', event => { event?.stopPropagation?.(); modelLoadAttempt = 0; void loadModels(); renderPickerPanel(item); });
    item.panel.replaceChildren?.(element('div', 'picker-panel-title', item.title), retry);
    return;
  }
  const rows = options.map(option => {
    const button = element('button', 'picker-option' + (String(option.value) === String(item.select.value) ? ' is-current' : ''), option.textContent || option.value || '默认');
    button.type = 'button';
    button.setAttribute?.('role', 'option');
    button.addEventListener('click', event => {
      event?.stopPropagation?.();
      const view = item.submenu?.(option.value);
      if (view) { item.view = view; renderPickerPanel(item); return; }
      applyPickerValue(item.select, option.value); closeAllPickers();
    });
    return button;
  });
  item.panel.replaceChildren?.(element('div', 'picker-panel-title', item.title), ...rows);
  if (!rows.length) item.panel.append?.(element('div', 'picker-empty', '暂无可选项'));
}
function syncPicker(item) {
  const options = pickerOptions(item.select);
  const current = options.find(option => String(option.value) === String(item.select.value)) || options[0];
  item.label.textContent = item.labelFor ? item.labelFor(current) : (current?.textContent || item.placeholder);
  item.trigger.hidden = Boolean(item.select.hidden);
  item.trigger.disabled = Boolean(item.select.disabled);
  if (item.select.hidden || item.select.disabled) { item.panel.hidden = true; item.view = null; item.trigger.setAttribute?.('aria-expanded', 'false'); }
  else if (!item.panel.hidden) renderPickerPanel(item);
}
function syncAllPickers() { for (const item of pickerRegistry) syncPicker(item); }
function applyPickerValue(select, value) {
  select.value = value;
  if (typeof select.dispatchEvent === 'function' && typeof Event === 'function') select.dispatchEvent(new Event('change', { bubbles: true }));
  else if (typeof select.listeners?.change === 'function') select.listeners.change();
  syncAllPickers();
}
function openPicker(item) {
  if (item.select.hidden || item.select.disabled) return;
  const closed = item.panel.hidden;
  closeAllPickers();
  if (!closed) return;
  item.view = null;
  renderPickerPanel(item);
  item.panel.hidden = false;
  item.trigger.setAttribute?.('aria-expanded', 'true');
}
function createPicker(select, { className, title, placeholder, direction = 'up', align = 'left', submenu, labelFor }) {
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'picker-trigger ' + className;
  trigger.setAttribute?.('aria-label', title);
  trigger.setAttribute?.('aria-haspopup', 'listbox');
  trigger.setAttribute?.('aria-expanded', 'false');
  const label = element('span', 'picker-value', placeholder);
  const chevron = chevronIcon();
  trigger.append?.(label, chevron);
  const panel = element('div', 'picker-panel picker-' + direction + (align === 'right' ? ' picker-align-right' : ''), '');
  panel.hidden = true;
  panel.setAttribute?.('role', 'listbox');
  const item = { select, trigger, label, panel, title, placeholder, submenu, labelFor, view: null };
  trigger.addEventListener('click', event => { event?.stopPropagation?.(); openPicker(item); });
  pickerRegistry.push(item);
  return item;
}
const modelPicker = createPicker(modelControl, { className: 'picker-model', title: '选择模型', placeholder: '模型', submenu: modelEffortView, labelFor: modelTriggerLabel });
modelControls.append?.(modelPicker.trigger, modelPicker.panel);
const projectPicker = createPicker(currentProject, { className: 'picker-project', title: '选择项目目录', placeholder: '项目', direction: 'down' });
currentProject.after?.(projectPicker.trigger);
projectPicker.trigger.after?.(projectPicker.panel);
document.addEventListener?.('click', event => {
  const target = event?.target;
  if (target?.closest?.('.picker-trigger') || target?.closest?.('.picker-panel')) return;
  closeAllPickers();
});
window.addEventListener?.('keydown', event => { if (event?.key === 'Escape') closeAllPickers(); });
const modelChanges = new Map();
const pendingModelChanges = new Map();
const cancelModelPrepared = document.createElement('button');
cancelModelPrepared.type = 'button';
cancelModelPrepared.className = 'unlock-send';
cancelModelPrepared.hidden = true;
document.querySelector('.send-feedback')?.append?.(cancelModelPrepared);
let modelCatalog = [], liveModel = null, modelDeviceGeneration = 0, modelWriteGeneration = 0;
async function modelRequestWithTimeout(url, options = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  try { return await scopedFetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
async function checkModelAfterCancel(id, change, deviceGeneration) {
  try {
    const response = await modelRequestWithTimeout(`/api/threads/${encodeURIComponent(id)}/model-status`, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('unavailable');
    const result = await response.json();
    if (modelDeviceGeneration !== deviceGeneration || modelChanges.get(id) !== change) return;
    if (result.locked === false) modelChanges.delete(id);
    else if (result.locked === true && uuid.test(result.preparedOperationId || '')) {
      change.message = '模型切换尚未发送'; change.preparedOperationId = result.preparedOperationId; change.checkAfterCancel = false;
    } else { change.message = '正在等待电脑确认'; change.preparedOperationId = null; change.checkAfterCancel = true; }
  } catch {
    if (modelDeviceGeneration === deviceGeneration && modelChanges.get(id) === change) { change.message = '无法确认模型状态'; change.checkAfterCancel = true; }
  }
}
cancelModelPrepared.addEventListener('click', async () => {
  const id = selectedId, change = id && modelChanges.get(id), deviceGeneration = modelDeviceGeneration;
  if (!id || !connected || !change || change.cancelling || (!change.checkAfterCancel && !uuid.test(change.preparedOperationId || ''))) return;
  change.cancelling = true; modelWriteGeneration++; updateComposer();
  try {
    if (!change.checkAfterCancel) {
      const response = await modelRequestWithTimeout(`/api/threads/${encodeURIComponent(id)}/model-cancel`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId: change.preparedOperationId }) });
      const result = await response.json().catch(() => null);
      if (modelDeviceGeneration !== deviceGeneration || modelChanges.get(id) !== change) return;
      if (response.status !== 202 || result?.status !== 'accepted') throw new Error('unavailable');
      change.preparedOperationId = null; change.checkAfterCancel = true;
    }
    await checkModelAfterCancel(id, change, deviceGeneration);
  } catch {
    if (modelDeviceGeneration === deviceGeneration && modelChanges.get(id) === change) { change.message = '无法确认取消结果'; change.preparedOperationId = null; change.checkAfterCancel = true; }
  } finally {
    change.cancelling = false;
    if (selectedId === id && modelDeviceGeneration === deviceGeneration) updateComposer();
  }
});
let modelLoadTimer, modelLoadAttempt = 0;
async function loadModels() {
  const generation = modelDeviceGeneration;
  let catalog = null;
  try {
    const response = await scopedFetch('/api/models', { credentials: 'same-origin', cache: 'no-store' });
    const data = response.ok ? await response.json() : null;
    catalog = Array.isArray(data?.models) && data.models.length ? data.models : null;
  } catch { catalog = null; }
  if (generation !== modelDeviceGeneration) return;
  if (catalog) {
    modelCatalog = catalog; modelLoadAttempt = 0;
    clearTimeout(modelLoadTimer); modelLoadTimer = undefined;
    updateModelControl();
    return;
  }
  // A failed or empty catalog used to stay empty for the rest of the session, so
  // the control kept its placeholder until the page was reloaded.
  modelCatalog = [];
  updateModelControl();
  if (modelLoadAttempt < 4) {
    const wait = [800, 1500, 3000, 6000][modelLoadAttempt++];
    clearTimeout(modelLoadTimer);
    modelLoadTimer = setTimeout(() => { modelLoadTimer = undefined; void loadModels(); }, wait);
    modelLoadTimer?.unref?.();
  }
}
// Rebuilding the native selects on every keystroke made typing stutter, so the
// markup is only touched when one of its inputs actually changed.
let modelControlSignature = '';
function updateModelControl() {
  if (newDraft) { modelControls.hidden = false; renderNewModels(); return; }
  const pending = selectedId ? pendingModelChanges.get(selectedId) : null;
  const shownModel = pending?.model || liveModel?.model;
  const shownEffort = pending?.effort || liveModel?.effort;
  const signature = [shownModel || '', shownEffort || '', selectedId || '', connected ? 1 : 0,
    modelCatalog.map(entry => `${entry.model}:${entry.displayName || ''}:${(entry.supportedReasoningEfforts || []).join(',')}`).join('|'),
    recoveryBlocksWrite() ? 1 : 0, modelChanges.has(selectedId) ? 1 : 0, modeChanges.has(selectedId) ? 1 : 0].join('\u0000');
  if (signature === modelControlSignature) { syncAllPickers(); return; }
  modelControlSignature = signature;
  modelControl.replaceChildren();
  if (!shownModel) {
    // History-only views do not know the desktop's live model; never present a
    // catalog default as if it were the model in use.
    const modelPlaceholder = document.createElement('option'); modelPlaceholder.value = ''; modelPlaceholder.textContent = '模型';
    modelControl.append?.(modelPlaceholder);
    const effortPlaceholder = document.createElement('option'); effortPlaceholder.value = ''; effortPlaceholder.textContent = '等级';
    effortControl.replaceChildren(effortPlaceholder);
    modelControls.hidden = Boolean(newDraft) || !selectedId;
    modelControl.disabled = true; effortControl.disabled = true;
    syncAllPickers();
    return;
  }
  const matching = modelCatalog.find(entry => entry.model === shownModel);
  // Keep the real model id on the fallback option. With an empty value the
  // select reports "" and the picker label falls back to 模型, which is what
  // made the control look empty whenever the catalog had not caught up.
  if (!matching) { const option = document.createElement('option'); option.value = shownModel; option.textContent = shownModel; modelControl.append?.(option); }
  for (const entry of modelCatalog) { const option = document.createElement('option'); option.value = entry.model; option.textContent = entry.displayName; option.selected = entry.model === shownModel; modelControl.append?.(option); }
  effortControl.replaceChildren();
  const efforts = matching?.supportedReasoningEfforts || [];
  if (!efforts.includes(shownEffort)) { const option = document.createElement('option'); option.value = ''; option.textContent = shownEffort || '默认'; effortControl.append?.(option); }
  for (const effort of efforts) { const option = document.createElement('option'); option.value = effort; option.textContent = effort; option.selected = effort === shownEffort; effortControl.append?.(option); }
  // The catalog gates the option list, not the trigger: with the trigger disabled
  // a tap never reached the panel, so an empty catalog looked like a dead control.
  const disabled = !selectedId || !connected || modelChanges.has(selectedId) || modeChanges.has(selectedId) || recoveryBlocksWrite();
  modelControls.hidden = Boolean(newDraft) || !selectedId;
  modelControl.disabled = disabled;
  effortControl.disabled = disabled || !matching || !efforts.length;
  syncAllPickers();
}
function pickerModelEntry(model) {
  if (newDraft) return newModels.find(item => item.model === model) || preferredNewModel();
  return modelCatalog.find(item => item.model === model) || null;
}
// A level that is not in the catalog still has to be visible: those options
// carry an empty value, so read the selected option's text as well.
function selectedEffortLabel() {
  if (effortControl.value) return effortControl.value;
  const fallback = [...(effortControl.options || [])].find(option => option.value === '');
  return fallback ? fallback.textContent.trim() : '';
}
function currentOptionText(current) {
  const text = current && typeof current.textContent === 'string' ? current.textContent.trim() : '';
  return text && text !== '模型' && text !== '等级' ? text : '';
}
function modelTriggerLabel(current) {
  const entry = pickerModelEntry(modelControl.value);
  const effort = selectedEffortLabel();
  const name = entry ? (entry.displayName || entry.model) : (currentOptionText(current) || modelControl.value);
  if (!name) return effort && effort !== '等级' ? effort : '模型';
  return effort && effort !== '等级' ? `${name} · ${effort}` : name;
}
function modelEffortView(model) {
  const entry = pickerModelEntry(model);
  const efforts = entry?.supportedReasoningEfforts || [];
  if (!entry || !efforts.length) return null;
  const current = efforts.includes(effortControl.value) ? effortControl.value : (efforts.includes(entry.defaultReasoningEffort) ? entry.defaultReasoningEffort : efforts[0]);
  return { title: '思考等级', options: efforts.map(value => ({ value, label: value, current: value === current })), apply: value => applyModelAndEffort(entry.model, value) };
}
function applyModelAndEffort(model, effort) {
  if (newDraft) {
    if (newDraft.pending || newDraft.uncertain || newDraft.prepared) return;
    const entry = newModels.find(item => item.model === model);
    if (!entry) return;
    newDraft.model = entry.model;
    newDraft.effort = entry.supportedReasoningEfforts.includes(effort) ? effort : (entry.supportedReasoningEfforts.includes(entry.defaultReasoningEffort) ? entry.defaultReasoningEffort : (entry.supportedReasoningEfforts[0] || null));
    renderNewModels();
    return;
  }
  const entry = modelCatalog.find(item => item.model === model);
  if (!entry) return;
  const nextEffort = entry.supportedReasoningEfforts.includes(effort) ? effort : (entry.supportedReasoningEfforts.includes(liveModel?.effort) ? liveModel.effort : entry.defaultReasoningEffort);
  modelControl.value = entry.model;
  effortControl.value = nextEffort;
  void requestModelChange(entry.model, nextEffort);
}
function flushPendingModelChange() {
  const id = selectedId;
  if (!id || newDraft || !connected || liveRuntimeStatus !== 'idle') return;
  const pending = pendingModelChanges.get(id);
  if (!pending) return;
  if (modelChanges.has(id) || modeChanges.has(id) || hasPendingOutgoing(id) || recoveryBlocksWrite()) return;
  pendingModelChanges.delete(id);
  void requestModelChange(pending.model, pending.effort);
}
async function requestModelChange(model, effort) {
  const id = selectedId, selected = modelCatalog.find(entry => entry.model === model);
  if (!id || !selected || !connected || modelChanges.has(id) || modeChanges.has(id) || hasPendingOutgoing(id) || recoveryBlocksWrite()) return updateModelControl();
  if (!selected.supportedReasoningEfforts.includes(effort)) return updateModelControl();
  if (liveRuntimeStatus !== 'idle') { pendingModelChanges.set(id, { model, effort }); return updateModelControl(); }
  if (model === liveModel?.model && effort === liveModel?.effort) return updateModelControl();
  const change = { model, effort, message: '正在切换模型' }; modelWriteGeneration++; modelChanges.set(id, change); updateComposer();
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await scopedFetch(`/api/threads/${encodeURIComponent(id)}/model`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, effort }) });
    if (modelChanges.get(id) !== change) return;
    if (response.ok) { change.confirmed = true; if (change.observed) modelChanges.delete(id); else change.message = '等待电脑确认模型'; }
    else if (response.status === 408 || response.status >= 500) change.message = '切换结果未知，请查看电脑上的模型';
    else { modelChanges.delete(id); change.message = '模型切换未被接受'; }
  } catch { if (modelChanges.get(id) === change) change.message = '切换结果未知，请查看电脑上的模型'; }
  finally { clearTimeout(timer); if (selectedId === id) updateComposer(); }
}
modelControl.addEventListener('change', () => {
  if (newDraft) return selectNewModel();
  const model = modelControl.value, selected = modelCatalog.find(entry => entry.model === model);
  if (!selected) return updateModelControl();
  const effort = selected.supportedReasoningEfforts.includes(liveModel?.effort) ? liveModel.effort : selected.defaultReasoningEffort;
  return requestModelChange(model, effort);
});
effortControl.addEventListener('change', () => newDraft ? selectNewEffort() : requestModelChange(liveModel?.model, effortControl.value));
const fileInput = document.querySelector('#attachment-file');
const imageDraft = document.querySelector('#image-draft');
const sendButton = document.querySelector('#send-message');
sendButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
const stopButton = document.querySelector('#stop-turn');
const stopStatus = document.querySelector('#stop-status');
const voiceButton = document.querySelector('#voice-input');
const voiceStatus = document.querySelector('#voice-status');
const sendStatus = document.querySelector('#send-status');
const unlockSend = document.querySelector('#unlock-send');
const abandonPrepared = document.querySelector('#abandon-prepared');
const summaryPanel = document.querySelector('#summary-panel');
const goalPanel = document.querySelector('#goal-panel');
const questionPanel = document.createElement('section');
questionPanel.className = 'question-panel';
questionPanel.hidden = true;
questionPanel.setAttribute('aria-label', '待回答的问题');
document.querySelector('.composer')?.before?.(questionPanel);
const goalStatus = document.querySelector('#goal-status');
const goalObjective = document.querySelector('#goal-objective');
const goalDuration = document.querySelector('#goal-duration');
let goalClockTimer;
function stopGoalClock() { clearTimeout(goalClockTimer); goalClockTimer = undefined; }
function renderGoalClock(goal, threadId) {
  stopGoalClock();
  const update = () => {
    if (selectedId !== threadId || goalPanel.hidden) return;
    const base = goal.timeUsedSeconds;
    const seconds = Number.isFinite(base) && base >= 0 ? Math.floor(Math.max(0, base + (goal.status === 'active' && Number.isFinite(goal.updatedAt) ? Date.now() / 1000 - goal.updatedAt : 0))) : null;
    goalDuration.textContent = seconds === null ? '' : seconds >= 3600 ? `${Math.floor(seconds / 3600)}时${Math.floor(seconds % 3600 / 60)}分` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
    if (goal.status === 'active' && Number.isFinite(goal.updatedAt) && seconds !== null) { goalClockTimer = setTimeout(update, 1000); goalClockTimer?.unref?.(); }
  };
  update();
}
goalObjective.addEventListener('click', () => goalObjective.classList.toggle('expanded'));
const summaryScrim = document.querySelector('#summary-scrim');
const summaryContent = document.querySelector('#summary-content');
const summaryToggle = document.querySelector('#toggle-summary');
const settingsOverlay = document.querySelector('#settings-overlay');
const settingsPanel = document.querySelector('#settings-panel');
const settingsToggle = document.querySelector('#open-settings');
const settingsClose = document.querySelector('#close-settings');
const settingsScrim = document.querySelector('#settings-scrim');
let settingsReturnFocus = null;
function showSettings(show) {
  if (!settingsOverlay || !settingsToggle) return;
  if (show) {
    settingsReturnFocus = document.activeElement || settingsToggle;
    closeAllPickers(); closeDevices(); showSidebar(false); showSummary(false);
  }
  settingsOverlay.hidden = !show;
  settingsToggle.setAttribute('aria-expanded', String(show));
  window.setNotificationSettingsOpen?.(show);
  if (show) settingsClose?.focus?.();
  else {
    let target = settingsReturnFocus;
    const sidebarClosedOnMobile = (window.innerWidth || 1024) <= 700 && !sidebar.classList.contains('open');
    if (!target || (target === settingsToggle && sidebarClosedOnMobile) || !target.getClientRects?.().length) target = document.querySelector('#open-sidebar');
    target?.focus?.(); settingsReturnFocus = null;
  }
}
settingsToggle?.addEventListener('click', () => showSettings(true));
settingsClose?.addEventListener('click', () => showSettings(false));
settingsScrim?.addEventListener('click', () => showSettings(false));
document.addEventListener?.('keydown', event => {
  if (settingsOverlay?.hidden !== false) return;
  if (event.key === 'Escape') { event.preventDefault(); showSettings(false); }
  else if (event.key === 'Tab') {
    const focusable = [...(settingsPanel?.querySelectorAll('button, a[href], input, select, textarea, [tabindex="0"]') || [])].filter(node => !node.hidden && !node.disabled && node.getClientRects?.().length);
    const first = focusable[0] || settingsPanel, last = focusable.at(-1) || settingsPanel;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === settingsPanel)) { event.preventDefault(); last?.focus?.(); }
    else if (!event.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement))) { event.preventDefault(); first?.focus?.(); }
  }
});
const deviceMenu = document.querySelector('#devices');
const deviceScrim = document.querySelector('#device-scrim');
const deviceCurrent = document.querySelector('#device-current');
const deviceList = document.querySelector('#device-list');
let historyScope = null, historyScopeGeneration = 0, deviceLoadGeneration = 0, homeConnectionConfirmed = false;
let deviceIdentityRetryTimer;
const deviceChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('codex-device-selection-v1') : null;
async function scopedFetch(url, options = {}) {
  const path = typeof url === 'string' ? url : '';
  if (!path.startsWith('/api/') || path.startsWith('/api/devices')) return fetch(url, options);
  if (!historyScope && window.pairingReady && path !== '/api/host-status') throw new Error('Device identity unavailable');
  const scopeGeneration = historyScopeGeneration;
  const ensureCurrentScope = () => { if (scopeGeneration !== historyScopeGeneration) throw Object.assign(new Error('Device scope changed'), { name: 'AbortError' }); };
  const response = await fetch(url, { ...options, headers: { ...options.headers, ...(historyScope ? { 'x-codex-expected-device': historyScope.deviceId } : {}) } });
  ensureCurrentScope();
  if (response.status === 401) {
    const body = await response.clone().json().catch(() => null);
    if (scopeGeneration === historyScopeGeneration && body?.error === 'device-replaced') showPairingConflict(body.activeDeviceId);
  }
  if (response.status === 409 && historyScope) {
    const body = await response.clone().json().catch(() => null);
    if (scopeGeneration === historyScopeGeneration && body?.error === 'device-changed') deviceChanged();
  }
  ensureCurrentScope();
  if (typeof response.json === 'function') {
    const readJson = response.json.bind(response);
    response.json = async (...args) => { const value = await readJson(...args); ensureCurrentScope(); return value; };
  }
  return response;
}
function resetHistoryScope(clearStored = false) {
  clearTaskNotifications();
  cancelOutgoingForScopeChange(); cancelAsyncQuestionWrites(); clearToolOutputEntries(); historyRequest?.abort(); historyRequest = null; recordedHistory = null; historyScope = null; historyScopeGeneration++; deviceLoadGeneration++; homeConnectionConfirmed = false;
}
// Unknown writes remain bound to their original device; switching never retries them.
const deviceCreationDrafts = new Map(), deviceSubmissionGuards = new Map(), deviceConversationDrafts = new Map();
function invalidateDeviceState() {
  window.setNotificationContext?.(null);
  clearTimeout(deviceIdentityRetryTimer); deviceIdentityRetryTimer = undefined;
  if (newDraft && currentDeviceId) {
    newDraft.text = messageInput.value;
    if (newDraft.pending) { newDraft.uncertain = true; newDraft.message = '发送结果未知，请先检查原电脑任务列表'; newDraft.controller?.abort(); }
    deviceCreationDrafts.set(currentDeviceId, newDraft);
  }
  if (currentDeviceId && submissions.size) deviceSubmissionGuards.set(currentDeviceId, new Map(submissions));
  submissions.clear();
  if (currentDeviceId) {
    if (selectedId && !newDraft) drafts.set(selectedId, messageInput.value);
    deviceConversationDrafts.set(currentDeviceId, {
      text: new Map(drafts), images: new Map(imageDrafts), savedCreation: savedNewDraft?.deviceId === currentDeviceId ? savedNewDraft : null,
      models: new Map([...modelChanges].map(([id, change]) => [id, { ...change, cancelling: false, checkAfterCancel: true, message: '切换结果未知，请先重新检查模型状态' }])),
      modes: new Map([...modeChanges].map(([id, change]) => [id, { ...change, uncertain: true, message: '切换结果未知，请查看电脑上的模式' }])),
      pendingModels: new Map(pendingModelChanges), pendingModes: new Map(pendingModeChanges),
      stops: new Map([...stops].map(([id, stop]) => [id, stop.pending ? { ...stop, pending: false, error: true, message: '停止结果未知，请查看任务状态' } : { ...stop }])),
    });
  }
  newDraft = null; savedNewDraft = null; newProjectBar.hidden = true;
  resetHistoryScope(); clearTimeout(reconnectTimer); active?.abort(); active = undefined;
  ++hostStatusGeneration; clearTimeout(hostStatusTimer);
  selectedId = null; connected = false; currentDeviceId = null;
  modelDeviceGeneration++; modelCatalog = []; modelChanges.clear(); pendingModelChanges.clear(); newModels = []; liveModel = null;
  imageUploadAvailable = false; uploadCompression = null; uploadConcurrency = 1;
  drafts.clear(); imageDrafts.clear(); stops.clear(); modeChanges.clear(); pendingModeChanges.clear(); modeNotices.clear();
  messageInput.value = ''; clearRecentViews(); clearConversation(); invalidateThreadList(); status('电脑已切换', 'idle'); updateComposer();
}
function deviceChanged() {
  invalidateDeviceState();
  void startPairedHome();
}
if (deviceChannel) deviceChannel.onmessage = event => { if (event.data?.type === 'device-changed') void startPairedHome({ preserveDeviceState: true }); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
sessionStorage.removeItem('codex-hub-token');
sessionStorage.removeItem('codex-hub-thread');
let active;
let reconnectTimer;
// Local, bounded diagnostics for connection acceptance. No chat/device identity,
// message payload, persistence or telemetry request is recorded here.
const connectionDiagnosticRows = [];
let connectionDiagnosticSequence = 0, currentConnectionDiagnostic = null;
const connectionDiagnosticStages = new Set(['selected', 'debounce', 'connect', 'fetch', 'headers', 'first-bytes', 'chunk-begin', 'chunk-end', 'first-state', 'handle-start', 'handle-end', 'connected', 'input-enabled', 'closed']);
function connectionDiagnosticClock() { return typeof performance === 'object' && typeof performance.now === 'function' ? performance.now() : Date.now(); }
function connectionDiagnosticsSnapshot() { return connectionDiagnosticRows.map(row => ({ ...row, milestones: { ...row.milestones } })); }
function beginConnectionDiagnostic(trigger, began = connectionDiagnosticClock()) {
  const row = { attempt: ++connectionDiagnosticSequence, trigger: ['selection', 'reconnect'].includes(trigger) ? trigger : 'direct', startedAt: new Date().toISOString(), milestones: {} };
  connectionDiagnosticRows.push(row);
  if (connectionDiagnosticRows.length > 32) connectionDiagnosticRows.shift();
  let closed = false;
  const mark = stage => {
    if (closed || !connectionDiagnosticStages.has(stage) || Object.hasOwn(row.milestones, stage)) return;
    row.milestones[stage] = Math.max(0, Math.round((connectionDiagnosticClock() - began) * 100) / 100);
  };
  if (trigger === 'selection') mark('selected');
  return { mark, correlate(streamId) { if (!closed && uuid.test(streamId || '')) row.streamId = streamId; }, close(outcome) {
    if (closed) return;
    mark('closed'); closed = true;
    row.outcome = ['cancelled', 'disconnected', 'superseded', 'invalid', 'stream-error'].includes(outcome) ? outcome : 'cancelled';
  } };
}
let selectedId = null;
let selectedTitle = '';
let newDraft = null;
let savedNewDraft = null;
let availableProjects = [];
const threadProjectNames = new Map();
let currentDeviceId = null;
const recoveryControl = document.querySelector('#recovery-control');
const recoverChat = document.querySelector('#recover-chat');
const recoveryStatus = document.querySelector('#recovery-status');
const cancelRecovery = document.createElement('button');
cancelRecovery.type = 'button';
cancelRecovery.textContent = '取消等待';
cancelRecovery.hidden = true;
recoveryControl.append(cancelRecovery);
const recoveries = new Map();
const recoveryChecks = new Map();
const recoveryStorePromise = import('/recovery-attempt-store.js').then(module => module.createRecoveryAttemptStore());
void recoveryStorePromise.catch(() => {});
const recoveryChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('codex-phone-recovery-attempts') : null;
let recoveryGuardedControls = [];
let recoveryStream = null;
let recoverableHistoryId = null;
function recoveryKey(deviceId, threadId) { return JSON.stringify([deviceId, threadId]); }
function recoveryStorageKey(deviceId, threadId) { return `codex-recovery-attempt:${deviceId}:${threadId}`; }
function recoveryState(deviceId, threadId) {
  const key = recoveryKey(deviceId, threadId);
  if (!deviceId || !threadId || recoveries.has(key)) return recoveries.get(key);
  const state = { status: 'loading', requestId: null, message: '正在核对任务状态' };
  recoveries.set(key, state);
  void (async () => {
    try {
      const store = await recoveryStorePromise;
      const legacy = localStorage.getItem(recoveryStorageKey(deviceId, threadId));
      let stored = await store.read(deviceId, threadId);
      if (legacy !== null) {
        if (!uuid.test(legacy)) throw new Error('invalid legacy record');
        if (stored === null) { await store.reserve(deviceId, threadId, legacy); stored = await store.read(deviceId, threadId); }
        if (stored !== legacy || localStorage.getItem(recoveryStorageKey(deviceId, threadId)) !== legacy) throw new Error('conflicting recovery records');
        localStorage.removeItem(recoveryStorageKey(deviceId, threadId));
      }
      if (recoveries.get(key) !== state) return;
      if (stored === null) Object.assign(state, { status: 'clear', requestId: null, message: '' });
      else Object.assign(state, { status: 'unknown', requestId: stored, message: '恢复结果未知，请重新检查' });
    } catch { if (recoveries.get(key) === state) Object.assign(state, { status: 'unknown', requestId: null, message: '无法读取恢复状态' }); }
    if (selectedId === threadId && currentDeviceId === deviceId) {
      const stream = recoveryStream;
      if (state.status === 'unknown' && state.requestId && stream?.threadId === threadId && stream.liveState && !stream.controller.signal.aborted
          && recoveryChecks.get(key)?.status === 'ready') {
        // The first live snapshot can precede IndexedDB's answer. Reconcile
        // that answer against this exact current attachment, not a later task.
        stream.reconciledStoredAttempts ??= new Set();
        if (!stream.reconciledStoredAttempts.has(state.requestId)) {
          stream.reconciledStoredAttempts.add(state.requestId);
          void finishAcceptedRecovery(threadId, deviceId, stream);
        }
      }
      updateComposer();
    }
  })();
  return state;
}
async function clearRecoveryAttempt(deviceId, threadId, state) {
  try {
    const store = await recoveryStorePromise;
    const removed = await store.remove(deviceId, threadId, state.requestId);
    if (removed) recoveryChannel?.postMessage({ deviceId, threadId });
    return removed;
  } catch { return false; }
}
async function finishAcceptedRecovery(id, deviceId, stream) {
  const key = recoveryKey(deviceId, id), state = recoveries.get(key);
  // A live snapshot is the only proof that matters: once this stream delivers
  // state the session is attached, so the notice must go. Waiting on the
  // recovery-status check kept the notice on screen whenever that request failed
  // on a fresh stream, which is exactly when the user is staring at 正在连接任务.
  // The stream identity is deliberately not compared: a reconnect replaces the
  // stream, and pinning to the old one left recovery stuck as well.
  if (!stream?.liveState || !state || state.finishing || !['pending', 'awaiting-state', 'unknown'].includes(state.status) || stream.controller.signal.aborted) return;
  state.finishing = true;
  const cleared = await clearRecoveryAttempt(deviceId, id, state);
  if (recoveries.get(key) === state) {
    // The session is already attached, so a failed record cleanup must not keep
    // the recovery notice on screen; retry the cleanup once in the background.
    recoveries.delete(key);
    if (!cleared) void clearRecoveryAttempt(deviceId, id, state);
  }
  if (selectedId === id && currentDeviceId === deviceId) updateComposer();
}
if (recoveryChannel) recoveryChannel.onmessage = event => {
  const { deviceId, threadId } = event.data || {};
  const key = recoveryKey(deviceId, threadId), state = recoveries.get(key);
  if (state && ['pending', 'awaiting-state'].includes(state.status)) return;
  recoveries.delete(key);
  if (selectedId === threadId && currentDeviceId === deviceId) updateComposer();
};
function canDraftInHistory() {
  if (!selectedId || newDraft || recoverableHistoryId !== selectedId || !currentDeviceId || !historyScope) return false;
  const state = recoveryState(currentDeviceId, selectedId);
  return Boolean(state && ['unavailable', 'clear'].includes(state.status) && !submissions.get(selectedId)?.uncertain);
}
function recoveryBlocksWrite() {
  if (!selectedId) return false;
  if (!currentDeviceId || recoveryChecks.get(recoveryKey(currentDeviceId, selectedId))?.status !== 'ready') return true;
  const state = recoveryState(currentDeviceId, selectedId);
  return Boolean(state && !['unavailable', 'clear'].includes(state.status));
}
function updateRecoveryGuardedControls() {
  const blocked = recoveryBlocksWrite();
  for (const control of recoveryGuardedControls) control.button.disabled = blocked || control.isPending();
}
function guardRecoveryControl(button, isPending) {
  recoveryGuardedControls.push({ button, isPending });
  button.disabled = recoveryBlocksWrite() || isPending();
}
function updateRecoveryControl() {
  const key = recoveryKey(currentDeviceId, selectedId), state = recoveryState(currentDeviceId, selectedId), check = recoveryChecks.get(key);
  const checkNotice = check?.status === 'failed' || check?.status === 'locked' || (connected && check?.status === 'checking');
  const pendingAttempt = Boolean(state && ['pending', 'awaiting-state', 'unknown'].includes(state.status));
  const visible = Boolean(selectedId && currentDeviceId && !newDraft && (checkNotice || pendingAttempt || (connected && state?.status === 'loading')));
  recoveryControl.hidden = !visible;
  // This button only rechecks the current attachment. It never issues a new
  // recovery or message when an earlier operation has an unknown outcome.
  const watch = recoveryLockWatches.get(key);
  recoverChat.hidden = !visible || !(check?.status === 'failed' || (check?.status === 'locked' && watch?.lockChecks >= 24));
  recoverChat.textContent = '重新检查连接';
  recoverChat.disabled = check?.status === 'checking';
  cancelRecovery.hidden = true;
  if (!visible) { stopRecoveryNoticeTimer(); return; }
  recoveryStatus.textContent = check?.status === 'locked' ? '任务正在电脑上处理，暂时不能发送'
    : check?.status === 'failed' ? '连接状态核对失败，暂时不能发送；可重新检查'
    : pendingAttempt ? (state.message || '正在确认恢复结果，暂时不能发送')
    : state?.status === 'loading' ? '正在读取恢复记录，暂时不能发送' : '正在核对任务状态，暂时不能发送';
  startRecoveryNoticeTimer();
}
// Recheck unsettled attempts without discarding their request identity. A
// timeout cannot prove that a resume was rejected or that retrying is safe.
const RECOVERY_NOTICE_DEADLINE_MS = 20000;
let recoveryNoticeTimer = null;
const recoveryLockWatches = new Map();
function stopRecoveryNoticeTimer() {
  if (recoveryNoticeTimer && typeof clearInterval === 'function') clearInterval(recoveryNoticeTimer);
  recoveryNoticeTimer = null;
}
function startRecoveryNoticeTimer() {
  // Timers are optional so the same file still runs in the DOM-less test rig.
  if (recoveryNoticeTimer || typeof setInterval !== 'function') return;
  recoveryNoticeTimer = setInterval(recoveryNoticeTick, 1500);
  recoveryNoticeTimer?.unref?.();
}
function recoveryNoticeTick() {
  const id = selectedId, deviceId = currentDeviceId;
  if (!id || !deviceId || newDraft) return;
  const key = recoveryKey(deviceId, id), state = recoveries.get(key), check = recoveryChecks.get(key);
  let changed = false;
  if (state && ['pending', 'awaiting-state', 'unknown'].includes(state.status)) {
    const since = state.since ?? (state.since = Date.now());
    if (Date.now() - since >= RECOVERY_NOTICE_DEADLINE_MS && !activeRecoveryAborts.has(key)) {
      if (state.status === 'pending') Object.assign(state, { status: 'unknown', message: '正在核对连接结果' });
      if (Date.now() - (state.lastCheckedAt || 0) >= 5000) void checkRecoveryAttempt(id, deviceId, state);
      changed = true;
    }
  }
  if (['failed', 'locked'].includes(check?.status) && connected && recoveryStream?.threadId === id && !recoveryStream.controller.signal.aborted) {
    let watch = recoveryLockWatches.get(key);
    if (watch?.stream !== recoveryStream) watch = { stream: recoveryStream, failedChecks: 0, lockChecks: 0, at: 0 };
    const counter = check.status === 'failed' ? 'failedChecks' : 'lockChecks';
    const limit = check.status === 'failed' ? 3 : 24;
    if (watch[counter] < limit && Date.now() - watch.at >= 3000) {
      watch[counter] += 1; watch.at = Date.now(); recoveryLockWatches.set(key, watch);
      void checkRecoveryStatus(id, deviceId, recoveryStream, { readOnly: true });
      changed = true;
    }
  }
  if (changed) updateComposer();
}
// Entering a recoverable history thread attaches to it once the user settles on
// it. Firing on every tap flooded the desktop app-server (rapid switching used
// to pile up one resume per task), so this waits, keeps only the latest target,
// and gives up as soon as the selection moves on.
const historyRecoveryAttempts = new Map();
const unboundAcceptedRetries = new Set();
const missingAttemptCancellations = new Set();
let historyRecoveryTimer = null, historyRecoverySeq = 0;
function scheduleHistoryRecovery(id, deviceId) {
  if (!id || !deviceId) return;
  const key = recoveryKey(deviceId, id);
  if ((historyRecoveryAttempts.get(key) || 0) > 4) {
    // Exhausting the attachment budget never cancels an unconfirmed write.
    const stuck = recoveryState(deviceId, id);
    if (stuck?.status === 'unknown') void checkRecoveryAttempt(id, deviceId, stuck);
    return;
  }
  clearTimeout(historyRecoveryTimer);
  const seq = ++historyRecoverySeq;
  historyRecoveryTimer = setTimeout(() => {
    historyRecoveryTimer = null;
    if (seq !== historyRecoverySeq || selectedId !== id || currentDeviceId !== deviceId || recoverableHistoryId !== id || connected || newDraft) return;
    historyRecoveryAttempts.set(key, (historyRecoveryAttempts.get(key) || 0) + 1);
    enqueueHistoryRecovery(id, deviceId);
  }, 500);
  historyRecoveryTimer?.unref?.();
}
// One resume at a time: switching through several history tasks used to fire a
// resume per tap, which made the desktop app-server and the phone both stutter.
let historyRecoveryPending = null, historyRecoveryBusy = false;
function enqueueHistoryRecovery(id, deviceId) {
  historyRecoveryPending = { id, deviceId };
  if (!historyRecoveryBusy) void drainHistoryRecoveryQueue();
}
async function drainHistoryRecoveryQueue() {
  if (historyRecoveryBusy) return;
  historyRecoveryBusy = true;
  try {
    while (historyRecoveryPending) {
      const next = historyRecoveryPending; historyRecoveryPending = null;
      if (selectedId !== next.id || currentDeviceId !== next.deviceId || connected || newDraft) continue;
      await runHistoryRecovery(next.id, next.deviceId);
    }
  } finally { historyRecoveryBusy = false; }
}
async function runHistoryRecovery(id, deviceId) {
  if (selectedId !== id || currentDeviceId !== deviceId || connected || newDraft) return;
  const state = recoveryState(deviceId, id);
  if (state && ['unknown', 'awaiting-state'].includes(state.status)) {
    await checkRecoveryAttempt(id, deviceId, state);
    return;
  }
  if (selectedId !== id || recoverableHistoryId !== id || connected || newDraft) return;
  void recoverSelectedChat();
}
async function checkRecoveryAttempt(id, deviceId, state) {
  if (state.checking || state.cancelling || !state.requestId) return;
  const queriedStream = recoveryStream, queriedScope = historyScopeGeneration;
  state.checking = true; state.lastCheckedAt = Date.now(); updateComposer();
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await scopedFetch(`/api/threads/${encodeURIComponent(id)}/recovery-attempt/${encodeURIComponent(state.requestId)}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('unavailable');
    const result = await response.json();
    if (recoveries.get(recoveryKey(deviceId, id)) !== state || !['unknown', 'awaiting-state'].includes(state.status)) return;
    const completeMissingCancellation = async () => {
      const stream = queriedStream, generation = queriedScope;
      const isCurrent = () => selectedId === id && currentDeviceId === deviceId && historyScopeGeneration === generation && recoverableHistoryId === id && !connected && !newDraft && recoveryStream === stream && stream?.threadId === id && !stream.controller.signal.aborted;
      const stillPending = () => isCurrent() && recoveries.get(recoveryKey(deviceId, id)) === state;
      if (!stillPending()) return;
      if (!state.missingCancellationCleared) {
        if (!(await clearRecoveryAttempt(deviceId, id, state))) throw new Error('storage');
        state.missingCancellationCleared = true;
      }
      if (!stillPending()) return;
      recoveryChecks.delete(recoveryKey(deviceId, id));
      await checkRecoveryStatus(id, deviceId, stream, { onReady: () => {
        if (!stillPending()) return;
        state.status = 'unavailable';
        return recoverSelectedChat({ preserveStream: stream, isCurrent });
      } });
    };
    // Retry only the read after an acknowledged cancel; never send it twice.
    if (state.missingCancellation) {
      if (state.missingCancellationAccepted && result?.status === 'cancelled' && result.locked === false) await completeMissingCancellation();
      return;
    }
    if (result?.status === 'missing' && result.locked === false && !missingAttemptCancellations.has(recoveryKey(deviceId, id))) {
      const stream = queriedStream, generation = queriedScope;
      const isCurrent = () => selectedId === id && currentDeviceId === deviceId && historyScopeGeneration === generation && recoverableHistoryId === id && !connected && !newDraft && recoveryStream === stream && stream?.threadId === id && !stream.controller.signal.aborted;
      const stillPending = () => isCurrent() && recoveries.get(recoveryKey(deviceId, id)) === state;
      if (!stillPending()) return;
      missingAttemptCancellations.add(recoveryKey(deviceId, id));
      state.missingCancellation = true;
      const cancelled = await scopedFetch(`/api/threads/${encodeURIComponent(id)}/recovery-cancel`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: state.requestId }) });
      const cancellation = await cancelled.json();
      if (!stillPending() || cancelled.status !== 202 || cancellation?.status !== 'accepted') return;
      state.missingCancellationAccepted = true;
      const confirmation = await scopedFetch(`/api/threads/${encodeURIComponent(id)}/recovery-attempt/${encodeURIComponent(state.requestId)}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const confirmed = await confirmation.json();
      if (!stillPending() || !confirmation.ok || confirmed?.status !== 'cancelled' || confirmed.locked !== false) return;
      await completeMissingCancellation();
      return;
    }
    if (result?.locked === false && ['rejected', 'cancelled', 'released'].includes(result.status)) {
      if (!(await clearRecoveryAttempt(deviceId, id, state))) throw new Error('storage');
      state.status = 'unavailable'; state.message = '暂时无法连接，请稍后再试'; state.since = Date.now();
      recoveryChecks.delete(recoveryKey(deviceId, id));
      if (selectedId === id && currentDeviceId === deviceId) void connect(id);
    } else if (result?.locked === false && result.status === 'accepted') {
      const firstAccepted = state.status !== 'awaiting-state';
      state.status = 'awaiting-state'; state.message = '正在连接任务';
      if (result.executionTracked === false && Date.now() - state.since >= 30000 && !unboundAcceptedRetries.has(recoveryKey(deviceId, id))) {
        const stream = queriedStream, generation = queriedScope;
        const isCurrent = () => selectedId === id && currentDeviceId === deviceId && historyScopeGeneration === generation && recoverableHistoryId === id && !connected && !newDraft && recoveryStream === stream && stream?.threadId === id && !stream.controller.signal.aborted;
        if (isCurrent()) {
          unboundAcceptedRetries.add(recoveryKey(deviceId, id));
          if (!(await clearRecoveryAttempt(deviceId, id, state))) throw new Error('storage');
          if (recoveries.get(recoveryKey(deviceId, id)) !== state) return;
          if (!isCurrent()) return;
          recoveryChecks.delete(recoveryKey(deviceId, id));
          await checkRecoveryStatus(id, deviceId, stream, { onReady: () => {
            if (!isCurrent() || recoveries.get(recoveryKey(deviceId, id)) !== state) return;
            state.status = 'unavailable';
            return recoverSelectedChat({ preserveStream: stream, isCurrent });
          } });
          return;
        }
      }
      // Keep the attachment's own retry sequence alive after acceptance. A
      // status poll must not cancel and restart that session every five seconds.
      const attachedStream = recoveryStream?.threadId === id && !recoveryStream.controller.signal.aborted && (recoveryStream.liveState || recoverableHistoryId !== id);
      if (firstAccepted && !attachedStream && selectedId === id && currentDeviceId === deviceId) void connect(id);
    } else { state.message = '恢复结果未知，请稍后重新检查'; }
  } catch {
    if (recoveries.get(recoveryKey(deviceId, id)) === state && state.status === 'unknown') state.message = '无法确认恢复结果，请稍后重新检查';
  } finally {
    clearTimeout(timer); state.checking = false;
    if (selectedId === id && currentDeviceId === deviceId) updateComposer();
  }
}
cancelRecovery.addEventListener('click', async () => {
  const id = selectedId, deviceId = currentDeviceId;
  if (!id || !deviceId || newDraft) return;
  const key = recoveryKey(deviceId, id), state = recoveryState(deviceId, id);
  if (state?.status !== 'unknown' || !state.requestId || state.checking || state.cancelling) return;
  state.cancelling = true; updateComposer();
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await scopedFetch(`/api/threads/${encodeURIComponent(id)}/recovery-cancel`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: state.requestId }) });
    const result = await response.json().catch(() => null);
    if (recoveries.get(key) !== state || state.status !== 'unknown') return;
    if (response.status === 202 && result?.status === 'accepted' && selectedId === id && currentDeviceId === deviceId) {
      if (!(await clearRecoveryAttempt(deviceId, id, state))) throw new Error('storage');
      state.status = 'unavailable'; state.message = '已取消等待'; state.since = Date.now();
      recoveryChecks.delete(key); void connect(id);
    } else state.message = '无法确认取消，请重新检查';
  } catch {
    if (recoveries.get(key) === state && state.status === 'unknown') state.message = '无法确认取消，请重新检查';
  } finally {
    clearTimeout(timer); state.cancelling = false;
    if (selectedId === id && currentDeviceId === deviceId) updateComposer();
  }
});
async function checkRecoveryStatus(id, deviceId, stream, { onReady, readOnly = false } = {}) {
  const scopeGeneration = historyScopeGeneration;
  const isCurrent = () => selectedId === id && currentDeviceId === deviceId && historyScopeGeneration === scopeGeneration
    && recoveryStream === stream && !stream.controller.signal.aborted;
  const key = recoveryKey(deviceId, id), check = { status: 'checking', since: Date.now() };
  recoveryChecks.set(key, check);
  if (selectedId === id && currentDeviceId === deviceId) updateComposer();
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await scopedFetch(`/api/threads/${encodeURIComponent(id)}/recovery-status`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('unavailable');
    const value = await response.json();
    if (typeof value?.locked !== 'boolean') throw new Error('invalid');
    if (recoveryChecks.get(key) === check && isCurrent()) { check.status = value.locked ? 'locked' : 'ready'; finishAcceptedRecovery(id, deviceId, stream); }
  } catch {
    if (recoveryChecks.get(key) === check && isCurrent()) check.status = 'failed';
  } finally {
    clearTimeout(timer);
    if (isCurrent()) {
      updateComposer();
      if (!readOnly && check.status === 'ready' && recoverableHistoryId === id && !connected) {
        if (onReady) await onReady(); else void recoverSelectedChat();
      }
    }
  }
}
const newProjectBar = document.querySelector('#new-project-bar');
const newProject = document.querySelector('#new-project');
const newModel = modelControl;
const newEffort = effortControl;
for (const selector of ['#new-model', '#new-effort']) { const old = document.querySelector(selector); if (old) { old.hidden = true; old.disabled = true; } }
const newChat = document.querySelector('#new-chat');
let newModels = [];
function preferredNewModel() { return newModels.find(item => item.isDefault) || newModels[0] || null; }
function normalizeNewModelChoice() {
  if (!newDraft || newDraft.pending || newDraft.uncertain || newDraft.prepared || !newModels.length) return;
  const fallback = preferredNewModel();
  if (!newModels.some(item => item.model === newDraft.model)) newDraft.model = fallback?.model || null;
  const model = newModels.find(item => item.model === newDraft.model);
  if (model && !model.supportedReasoningEfforts.includes(newDraft.effort)) {
    newDraft.effort = model.supportedReasoningEfforts.includes(model.defaultReasoningEffort) ? model.defaultReasoningEffort : (model.supportedReasoningEfforts[0] || null);
  }
}
let newModelSignature = '';
function renderNewModels() {
  normalizeNewModelChoice();
  const model = newModels.find(item => item.model === newDraft?.model) || preferredNewModel();
  const signature = [newModels.map(item => `${item.model}:${item.displayName || ''}:${(item.supportedReasoningEfforts || []).join(',')}`).join('|'),
    newDraft?.model || '', newDraft?.effort || '', newDraft?.pending ? 1 : 0, newDraft?.uncertain ? 1 : 0, newDraft?.prepared ? 1 : 0].join('\u0000');
  if (signature === newModelSignature) { syncAllPickers(); return; }
  newModelSignature = signature;
  newModel.replaceChildren(...newModels.map(item => { const option = element('option', '', item.displayName || item.model); option.value = item.model; return option; }));
  newModel.value = model?.model || '';
  const efforts = model?.supportedReasoningEfforts || [];
  newEffort.replaceChildren(...efforts.map(value => { const option = element('option', '', value); option.value = value; return option; }));
  newEffort.value = efforts.includes(newDraft?.effort) ? newDraft.effort : (efforts.includes(model?.defaultReasoningEffort) ? model.defaultReasoningEffort : (efforts[0] || ''));
  newModel.disabled = !newDraft || newDraft.pending || newDraft.uncertain || Boolean(newDraft.prepared) || !newModels.length;
  newEffort.disabled = !model || !efforts.length || newDraft.pending || newDraft.uncertain || Boolean(newDraft.prepared);
  syncAllPickers();
}
async function loadNewModels(draft, deviceId) {
  try {
    const response = await scopedFetch('/api/models', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('unavailable');
    const data = await response.json();
    if (newDraft !== draft || currentDeviceId !== deviceId) return;
    newModels = Array.isArray(data.models) ? data.models.filter(item => typeof item?.model === 'string' && Array.isArray(item.supportedReasoningEfforts) && item.supportedReasoningEfforts.every(value => typeof value === 'string')) : [];
  } catch { if (newDraft !== draft || currentDeviceId !== deviceId) return; newModels = []; }
  renderNewModels();
}
function selectNewModel() {
  if (!newDraft || newDraft.pending || newDraft.uncertain || newDraft.prepared) return;
  const model = newModels.find(item => item.model === newModel.value) || preferredNewModel();
  newDraft.model = model?.model || null;
  if (!model) newDraft.effort = null;
  else if (!model.supportedReasoningEfforts.includes(newDraft.effort)) newDraft.effort = model.supportedReasoningEfforts.includes(model.defaultReasoningEffort) ? model.defaultReasoningEffort : (model.supportedReasoningEfforts[0] || null);
  renderNewModels();
}
function selectNewEffort() {
  const model = newModels.find(item => item.model === newDraft?.model);
  if (newDraft && !newDraft.pending && !newDraft.uncertain && !newDraft.prepared && model) newDraft.effort = model.supportedReasoningEfforts.includes(newEffort.value) ? newEffort.value : null;
  syncAllPickers();
}
function projectStorageKey() { return currentDeviceId ? `codex-last-project:${currentDeviceId}` : null; }
function rememberedProject() { try { return localStorage.getItem(projectStorageKey()); } catch { return null; } }
function saveProject(id) { try { if (projectStorageKey()) localStorage.setItem(projectStorageKey(), id); } catch {} }
function updateNewProjectOptions() {
  const options = availableProjects.map(project => { const option = element('option', '', project.name || '未命名项目'); option.value = project.id; return option; });
  newProject.replaceChildren(...options);
  currentProject.replaceChildren(...options.map(option => option.cloneNode(true)));
  currentProject.hidden = !availableProjects.length || (!selectedId && !newDraft);
  currentProject.disabled = !newDraft || newDraft.pending || newDraft.uncertain || Boolean(newDraft.prepared);
  if (!newDraft) {
    const projectId = threadProjectNames.get(selectedId);
    currentProject.hidden = !availableProjects.some(project => project.id === projectId);
    currentProject.value = currentProject.hidden ? '' : projectId;
    syncAllPickers(); return;
  }
  if (!newDraft.pending && !newDraft.prepared && !newDraft.uncertain && !availableProjects.some(project => project.id === newDraft.projectId)) newDraft.projectId = availableProjects[0]?.id || '';
  newProject.value = newDraft.projectId;
  newProject.disabled = newDraft.pending || newDraft.uncertain || Boolean(newDraft.prepared);
  currentProject.value = newDraft.projectId;
  syncAllPickers();
}
function openNewChat(projectId) {
  if (newDraft?.pending || newDraft?.uncertain || newDraft?.prepared) { sendStatus.textContent = '请先处理当前发送'; return; }
  if (newDraft) savedNewDraft = { deviceId: currentDeviceId, projectId: newDraft.projectId, text: messageInput.value, attachments: newDraft.attachments, model: newDraft.model, effort: newDraft.effort };
  if (selectedId) drafts.set(selectedId, messageInput.value);
  const saved = savedNewDraft?.deviceId === currentDeviceId ? savedNewDraft : null;
  const defaultId = availableProjects.some(project => project.id === projectId) ? projectId : (saved?.projectId || rememberedProject());
  newDraft = { projectId: availableProjects.some(project => project.id === defaultId) ? defaultId : (availableProjects[0]?.id || ''), text: saved?.text || '', attachments: saved?.attachments || [], model: saved?.model ?? null, effort: saved?.effort ?? null, mode: saved?.mode === 'plan' ? 'plan' : 'default', pending: false, uncertain: false };
  selectedId = null; selectedTitle = ''; clearTimeout(reconnectTimer); active?.abort(); active = undefined;
  clearConversation(); title.textContent = '新聊天'; messageInput.value = newDraft.text; newProjectBar.hidden = true;
  newModels = []; renderNewModels(); void loadNewModels(newDraft, currentDeviceId);
  updateNewProjectOptions(); renderImageDraft(); showSidebar(false); status('连接中', 'connecting'); void refreshHostStatus(); updateComposer();
}
newChat.addEventListener('click', () => openNewChat());
function selectDraftProject(value) { if (newDraft && availableProjects.some(project => project.id === value)) { newDraft.projectId = value; saveProject(value); newProject.value = value; currentProject.value = value; updateComposer(); } }
newProject.addEventListener('change', () => selectDraftProject(newProject.value));
currentProject.addEventListener('change', () => selectDraftProject(currentProject.value));
const inputDrafts = new Map();
let renderedQuestionPanel = null;
let questionLiveConfirmed = false;
let unknownQuestionItems = new Set();
const asyncQuestionWrites = new Map();
function cancelAsyncQuestionWrites() {
  for (const write of asyncQuestionWrites.values()) {
    write.controller.abort();
    write.draft.feedback = '结果暂不确定，请查看电脑上的任务状态'; write.draft.outcome = '结果待确认';
  }
  asyncQuestionWrites.clear();
}
const skippedAsyncQuestions = new Set();
const approvalDrafts = new Map();
let previewGeneration = 0;
let imageRenderGeneration = 0;
const imagePreviews = new Map();
const videoPreviews = new Map();
const imageObservers = new Set();
let inlineImageLoads = 0;
const inlineImageQueue = [];
function queueInlineImage(load, generation, renderGeneration) {
  inlineImageQueue.push({ load, generation, renderGeneration });
  drainInlineImages();
}
function drainInlineImages() {
  while (inlineImageLoads < 2 && inlineImageQueue.length) {
    const next = inlineImageQueue.shift();
    if (next.generation !== previewGeneration || next.renderGeneration !== imageRenderGeneration) continue;
    inlineImageLoads++;
    Promise.resolve().then(() => {
      if (next.generation === previewGeneration && next.renderGeneration === imageRenderGeneration) return next.load();
    }).finally(() => { inlineImageLoads--; drainInlineImages(); });
  }
}
function clearImageObservers() {
  imageRenderGeneration++;
  for (const observer of imageObservers) observer.disconnect();
  imageObservers.clear();
  inlineImageQueue.length = 0;
  for (const entry of imagePreviews.values()) entry.waiters.clear();
  for (const entry of videoPreviews.values()) entry.wrappers.clear();
}
function pruneVideoPreviews() {
  for (const [key, entry] of videoPreviews) {
    for (const position of entry.players.keys()) if (!entry.wrappers.has(position)) entry.players.delete(position);
    if (!entry.wrappers.size) {
      entry.controller?.abort(); if (entry.url) URL.revokeObjectURL(entry.url);
      videoPreviews.delete(key);
    }
  }
}
function clearImagePreviews() {
  previewGeneration++;
  clearImageObservers();
  document.querySelectorAll?.('.image-view-overlay').forEach(overlay => overlay.remove());
  document.querySelectorAll?.('.file-view-overlay').forEach(overlay => overlay.remove());
  for (const entry of imagePreviews.values()) { entry.controller?.abort(); if (entry.url) URL.revokeObjectURL(entry.url); }
  imagePreviews.clear();
  for (const entry of videoPreviews.values()) { entry.controller?.abort(); if (entry.url) URL.revokeObjectURL(entry.url); }
  videoPreviews.clear();
}
function activityIcon(kind) {
  const paths = {
    read: '<path d="M12 7v14M3 18a1 1 0 0 0 1 1h3a5 5 0 0 1 5 2 5 5 0 0 1 5-2h3a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1h-3a5 5 0 0 0-5 3 5 5 0 0 0-5-3H4a1 1 0 0 0-1 1z"/>',
    command: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m7 8 3 3-3 3M13 15h4"/>',
    edit: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
    agent: '<path d="M12 8V4H8M4 12H2M22 12h-2M8 16h8"/><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M9 12h.01M15 12h.01"/>',
    tool: '<path d="M14.7 6.3a5 5 0 0 0-6.4 6.4L3 18l3 3 5.3-5.3a5 5 0 0 0 6.4-6.4l-3 3-3-3z"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4-4L5 21"/>',
  };
  const icon = element('span', 'activity-icon'); icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[kind] || paths.command}</svg>`;
  return icon;
}
function imagePreviewButton(handle, threadId, inline = false, label = '查看图片') {
  const wrapper = element('div', 'message-image');
  const button = element('button', `image-preview-button${inline ? ' inline-image' : ''}`, label);
  button.type = 'button';
  if (!inline) button.setAttribute('aria-expanded', 'false');
  const setLabel = text => { button.textContent = text; if (!inline) button.append(activityIcon('image')); };
  if (!inline) button.append(activityIcon('image'));
  const display = (failed = false) => {
    if (failed) { button.disabled = false; setLabel('图片加载失败，重试'); return; }
    const entry = imagePreviews.get(handle);
    if (!inline) button.setAttribute('aria-expanded', String(Boolean(entry?.url && entry.expanded)));
    if (inline && entry?.url) {
      const img = element('img', 'inline-image-thumbnail');
      img.src = entry.url; img.alt = '查看聊天图片';
      button.disabled = false; button.replaceChildren(img);
      wrapper.replaceChildren(button);
      return;
    }
    if (entry?.url && entry.expanded) {
      const img = element('img', 'message-image-content');
      img.src = entry.url; img.alt = '聊天图片';
      img.addEventListener('click', () => { entry.expanded = false; display(); });
      button.disabled = false; setLabel(inline ? '' : '收起图片');
      wrapper.replaceChildren(button, img);
    } else if (entry?.url) {
      button.disabled = false; setLabel(label);
      wrapper.replaceChildren(button);
    }
  };
  const existing = imagePreviews.get(handle);
  if (existing && !existing.url) { existing.waiters.add(display); button.disabled = true; setLabel('加载中...'); }
  const load = async () => {
    if (imagePreviews.get(handle)?.url) {
      const entry = imagePreviews.get(handle); entry.expanded = !entry.expanded; return display();
    }
    if (imagePreviews.has(handle)) { imagePreviews.get(handle).waiters.add(display); return; }
    const generation = previewGeneration, controller = new AbortController();
    const entry = { controller, expanded: true, waiters: new Set([display]) }; imagePreviews.set(handle, entry); button.disabled = true; setLabel('加载中...');
    try {
      let size, mime, offset = 0; const chunks = [];
      do {
        const response = await scopedFetch(`/api/threads/${encodeURIComponent(threadId)}/images/${handle}/chunks/${offset}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('unavailable');
        const part = await response.json();
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(part.mime) || !Number.isSafeInteger(part.size) || part.size < 1 || part.size > 8 * 1024 * 1024 || part.offset !== offset || (size !== undefined && (size !== part.size || mime !== part.mime)) || typeof part.data !== 'string' || part.data.length > 174764) throw new Error('invalid');
        size = part.size; mime = part.mime;
        const decoded = atob(part.data), bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
        if (!bytes.length || bytes.length > 131072 || offset + bytes.length > size || (offset + bytes.length < size && bytes.length !== 131072)) throw new Error('invalid');
        chunks.push(bytes); offset += bytes.length;
      } while (offset < size);
      if (generation !== previewGeneration || selectedId !== threadId || imagePreviews.get(handle) !== entry) return;
      entry.url = URL.createObjectURL(new Blob(chunks, { type: mime })); entry.controller = null;
      for (const show of entry.waiters) show();
      entry.waiters.clear();
    } catch {
      if (generation === previewGeneration && imagePreviews.get(handle) === entry) {
        imagePreviews.delete(handle);
        for (const show of entry.waiters) show(true);
        entry.waiters.clear();
      }
    }
  };
  button.addEventListener('click', async () => {
    if (!inline || !imagePreviews.get(handle)?.url) return load();
    const entry = imagePreviews.get(handle);
    const panel = createDetailDrawer('图片', '返回', 'image-view-overlay');
    const content = element('div', 'image-detail-content');
    const img = element('img', 'image-view-full'); img.src = entry.url; img.alt = '聊天图片';
    content.append(img); panel.append(content);
  });
  wrapper.append(button); display();
  if (inline && !existing?.url && typeof IntersectionObserver !== 'undefined') {
    const generation = previewGeneration, renderGeneration = imageRenderGeneration;
    const observer = new IntersectionObserver(entries => {
      if (generation !== previewGeneration || renderGeneration !== imageRenderGeneration) { observer.disconnect(); imageObservers.delete(observer); return; }
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect(); imageObservers.delete(observer);
      queueInlineImage(load, generation, renderGeneration);
    }, { rootMargin: '200px' });
    imageObservers.add(observer);
    observer.observe(wrapper);
  }
  return wrapper;
}
function videoPreviewButton(media, threadId, occurrence = Symbol('video')) {
  const wrapper = element('div', 'message-video');
  const button = element('button', 'image-preview-button', '查看视频');
  button.type = 'button';
  const key = JSON.stringify([threadId, media.id]);
  function player(entry) {
    const video = document.createElement('video'); video.className = 'message-video-content';
    video.controls = true; video.preload = 'metadata'; video.src = entry.url; return video;
  }
  const existing = videoPreviews.get(key);
  if (existing) {
    existing.wrappers.set(occurrence, wrapper);
    if (existing.url) {
      let video = existing.players.get(occurrence);
      if (!video) { video = player(existing); existing.players.set(occurrence, video); }
      wrapper.append(video);
    }
    else { button.disabled = true; button.textContent = '加载中...'; wrapper.append(button); }
    return wrapper;
  }
  button.addEventListener('click', async () => {
    button.disabled = true; button.textContent = '加载中...';
    const pending = videoPreviews.get(key);
    if (pending) {
      pending.wrappers.set(occurrence, wrapper);
      if (pending.url) {
        let video = pending.players.get(occurrence);
        if (!video) { video = player(pending); pending.players.set(occurrence, video); }
        wrapper.replaceChildren(video);
      }
      return;
    }
    const controller = new AbortController(), generation = previewGeneration;
    const entry = { controller, wrappers: new Map([[occurrence, wrapper]]), players: new Map(), url: null };
    videoPreviews.set(key, entry);
    try {
      let size, mime = media.mime, offset = 0; const chunks = [];
      do {
        const response = await scopedFetch(`/api/threads/${encodeURIComponent(threadId)}/images/${media.id}/chunks/${offset}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('unavailable');
        const part = await response.json();
        if (!['video/mp4', 'video/webm', 'video/quicktime'].includes(part.mime) || !Number.isSafeInteger(part.size) || part.size < 1 || part.size > 32 * 1024 * 1024 || part.offset !== offset || (size !== undefined && (size !== part.size || mime !== part.mime)) || typeof part.data !== 'string') throw new Error('invalid');
        size = part.size; mime = part.mime; const decoded = atob(part.data); const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
        if (!bytes.length || bytes.length > 131072 || offset + bytes.length > size || (offset + bytes.length < size && bytes.length !== 131072)) throw new Error('invalid');
        chunks.push(bytes); offset += bytes.length;
      } while (offset < size);
      if (controller.signal.aborted || generation !== previewGeneration || selectedId !== threadId || videoPreviews.get(key) !== entry) return;
      entry.url = URL.createObjectURL(new Blob(chunks, { type: mime })); entry.controller = null;
      for (const [position, target] of entry.wrappers) { const video = player(entry); entry.players.set(position, video); target.replaceChildren(video); }
    } catch {
      if (!controller.signal.aborted && generation === previewGeneration && selectedId === threadId && videoPreviews.get(key) === entry) {
        videoPreviews.delete(key);
        for (const [position, target] of entry.wrappers) {
          const retry = videoPreviewButton(media, threadId, position);
          retry.querySelector('button').textContent = '视频加载失败，重试';
          target.replaceWith(retry);
        }
      }
    }
  });
  wrapper.append(button); return wrapper;
}
const drafts = new Map();
const imageDrafts = new Map();
let imageUploadAvailable = false;
let uploadCompression = null;
let uploadConcurrency = 1;
let imageChunkBytes = 128 * 1024;
async function encodeUploadChunk(chunk, signal, compressionAllowed = true) {
  if (signal?.aborted) throw new Error('cancelled');
  if (compressionAllowed && uploadCompression === 'gzip' && typeof CompressionStream === 'function') {
    try {
      const compressed = await new Response(chunk.stream().pipeThrough(new CompressionStream('gzip'))).blob();
      if (signal?.aborted) throw new Error('cancelled');
      if (compressed.size < chunk.size) return { body: compressed, compressionRatio: compressed.size / chunk.size, headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip' } };
    } catch (error) { if (signal?.aborted) throw error; }
  }
  return { body: chunk, compressionRatio: 1, headers: { 'content-type': 'application/octet-stream' } };
}
async function loadCapabilities() {
  const generation = historyScopeGeneration;
  try {
    const response = await scopedFetch('/api/capabilities', { credentials: 'same-origin', cache: 'no-store' });
    const data = response.ok ? await response.json() : null;
    if (generation !== historyScopeGeneration) return;
    imageUploadAvailable = data?.imageUpload === true && [128 * 1024, 512 * 1024].includes(data?.imageChunkBytes) && data?.maxImageBytes === 20 * 1024 * 1024;
    imageChunkBytes = imageUploadAvailable ? data.imageChunkBytes : 128 * 1024;
    uploadCompression = data?.uploadCompression === 'gzip' ? 'gzip' : null;
    uploadConcurrency = data?.uploadConcurrency === 2 ? 2 : 1;
  } catch { if (generation !== historyScopeGeneration) return; imageUploadAvailable = false; uploadCompression = null; uploadConcurrency = 1; }
  updateComposer();
}
const submissions = new Map();
const stops = new Map();
const modeChanges = new Map();
const pendingModeChanges = new Map();
const modeNotices = new Map();
const unlockModeChange = document.createElement('button');
unlockModeChange.type = 'button'; unlockModeChange.className = 'unlock-send'; unlockModeChange.hidden = true;
unlockModeChange.textContent = '已核实电脑模式，解除本地保护';
document.querySelector('.send-feedback')?.append?.(unlockModeChange);
let modeUnlockTarget = null;
unlockModeChange.addEventListener('click', () => {
  const target = modeUnlockTarget;
  if (!target || !connected || newDraft || currentDeviceId !== target.deviceId || historyScopeGeneration !== target.generation || selectedId !== target.threadId || modeChanges.get(target.threadId) !== target.change || !target.change.uncertain) return;
  modeChanges.delete(target.threadId); updateComposer();
});
let liveMode = null, liveRuntimeStatus = null;
let activeTurnId = null;
const expandedThinking = new Set();
const expandedChanges = new Set();
const filePreviewCache = new Map();
const expandedCommands = new Set();
const toolOutputEntries = new Map();
const toolOutputCharacterLimit = 2 * 1024 * 1024;
const toolOutputKey = (threadId, turnKey, itemId) => JSON.stringify([currentDeviceId || '', historyScopeGeneration, threadId, turnKey, itemId]);
function abortToolOutputEntry(entry) {
  entry.controller?.abort(); entry.controller = null; entry.loading = null;
}
function clearToolOutputEntries() {
  for (const entry of toolOutputEntries.values()) abortToolOutputEntry(entry);
  toolOutputEntries.clear();
}
function outputRefValue(item) {
  const ref = item?.outputRef;
  return ref && typeof ref.hash === 'string' && /^[a-f0-9]{64}$/.test(ref.hash) && Number.isSafeInteger(ref.bytes) && ref.bytes > 4096 ? ref : null;
}
function reconcileToolOutputRefs(view) {
  const seen = new Set();
  const turnCounts = new Map();
  for (const turn of view?.turns || []) { const key = turn?.viewKey ?? turn?.id; turnCounts.set(key, (turnCounts.get(key) || 0) + 1); }
  for (const turn of view?.turns || []) {
    const turnKey = turn?.viewKey ?? turn?.id;
    if (typeof turnKey !== 'string' || !turnKey || turnCounts.get(turnKey) !== 1) continue;
    const items = turn.items || [];
    const itemCounts = new Map();
    for (const item of items) itemCounts.set(item?.id, (itemCounts.get(item?.id) || 0) + 1);
    for (const item of items) {
      const ref = item?.type === 'commandExecution' && typeof item.id === 'string' && item.id && itemCounts.get(item.id) === 1 ? outputRefValue(item) : null;
      const key = toolOutputKey(view.id, turnKey, item?.id);
      if (!ref) { if (toolOutputEntries.has(key)) { abortToolOutputEntry(toolOutputEntries.get(key)); toolOutputEntries.delete(key); } continue; }
      seen.add(key);
      const old = toolOutputEntries.get(key);
      if (!old || old.hash !== ref.hash || old.bytes !== ref.bytes) {
        if (old) abortToolOutputEntry(old);
        toolOutputEntries.set(key, { key, threadId: view.id, turnKey, itemId: item.id, hash: ref.hash, bytes: ref.bytes, text: '', nextOffset: 0, loading: null, controller: null, error: null, needsReload: Boolean(old), windowStart: 0, receivedBytes: 0, holders: new Set() });
      } else old.holders.clear();
    }
  }
  for (const [key, entry] of toolOutputEntries) if (!seen.has(key)) { abortToolOutputEntry(entry); toolOutputEntries.delete(key); }
}
function updateToolOutputHolders(entry) { for (const holder of entry.holders) holder(); }
function toolOutputSourceMatches(entry) {
  if (!streamView) return true;
  if (streamView.id !== entry.threadId) return false;
  const matchingTurns = (streamView.turns || []).filter(turn => (turn.viewKey ?? turn.id) === entry.turnKey);
  if (matchingTurns.length !== 1) return false;
  const items = (matchingTurns[0].items || []).filter(item => item?.id === entry.itemId);
  return items.length === 1 && items[0].type === 'commandExecution' && outputRefValue(items[0])?.hash === entry.hash;
}
async function loadToolOutputPage(entry, offset = entry.nextOffset) {
  if (!entry || toolOutputEntries.get(entry.key) !== entry || entry.threadId !== selectedId || entry.key !== toolOutputKey(entry.threadId, entry.turnKey, entry.itemId) || !toolOutputSourceMatches(entry) || entry.loading !== null || entry.nextOffset !== offset || offset === null) return;
  const controller = new AbortController();
  entry.controller = controller; entry.loading = offset; entry.error = null; entry.needsReload = false;
  const scopeGeneration = historyScopeGeneration, deviceId = currentDeviceId, threadId = selectedId, hash = entry.hash;
  const current = () => toolOutputEntries.get(entry.key) === entry && entry.hash === hash && toolOutputSourceMatches(entry) && historyScopeGeneration === scopeGeneration && currentDeviceId === deviceId && selectedId === threadId && !controller.signal.aborted;
  updateToolOutputHolders(entry);
  try {
    const params = new URLSearchParams({ turn: entry.turnKey, item: entry.itemId, hash, offset: String(offset) });
    const response = await scopedFetch(`/api/threads/${encodeURIComponent(entry.threadId)}/tool-output?${params}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`tool output ${response.status}`);
    const page = await response.json();
    if (!current() || page?.threadId !== entry.threadId || page?.turnKey !== entry.turnKey || page?.itemId !== entry.itemId || page?.hash !== hash || page?.offset !== offset || typeof page.text !== 'string' || page.text.length > 16384 || !(page.nextOffset === null || (Number.isSafeInteger(page.nextOffset) && page.nextOffset > offset && page.nextOffset === offset + page.text.length))) throw new Error('invalid tool output page');
    const text = entry.text + page.text;
    const receivedBytes = entry.receivedBytes + new TextEncoder().encode(page.text).length;
    if (page.nextOffset === null && receivedBytes !== entry.bytes) {
      entry.text = ''; entry.nextOffset = 0; entry.windowStart = 0; entry.receivedBytes = 0;
      throw new Error('tool output byte length mismatch');
    }
    if (page.nextOffset === null && entry.windowStart === 0 && text.length <= toolOutputCharacterLimit) {
      const encoded = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest('SHA-256', encoded);
      const actualHash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
      if (!current()) return;
      if (encoded.length !== entry.bytes || actualHash !== hash) {
        entry.text = ''; entry.nextOffset = 0; entry.windowStart = 0; entry.receivedBytes = 0;
        throw new Error('tool output integrity mismatch');
      }
    }
    // Continue through the entire output while retaining only one bounded window.
    if (text.length > toolOutputCharacterLimit) { entry.text = page.text; entry.windowStart = offset; }
    else entry.text = text;
    entry.receivedBytes = receivedBytes; entry.nextOffset = page.nextOffset; entry.error = null;
    // Keep loaded output bounded; evicted commands can be expanded again.
    let cachedCharacters = [...toolOutputEntries.values()].reduce((sum, candidate) => sum + candidate.text.length, 0);
    let cachedEntries = [...toolOutputEntries.values()].filter(candidate => candidate.text).length;
    for (const candidate of toolOutputEntries.values()) {
      if (cachedCharacters <= 2 * 1024 * 1024 && cachedEntries <= 16) break;
      if (candidate === entry || candidate.loading !== null || !candidate.text) continue;
      cachedCharacters -= candidate.text.length; cachedEntries--;
      candidate.text = ''; candidate.nextOffset = 0; candidate.error = null; candidate.windowStart = 0; candidate.receivedBytes = 0; candidate.needsReload = true;
      updateToolOutputHolders(candidate);
    }
  } catch (error) { if (current() && error?.name !== 'AbortError') entry.error = error; }
  finally { if (entry.controller === controller) { entry.controller = null; entry.loading = null; } if (current()) updateToolOutputHolders(entry); }
}
function renderToolOutput(details, item, entry) {
  const holder = element('div', 'command-output'); details.append(holder);
  const render = () => {
    holder.replaceChildren();
    if (!entry) { holder.append(element('p', 'file-change-empty', '请连接电脑后展开查看命令输出')); return; }
    if (entry.text) holder.append(element('pre', 'item-code command-output-text', entry.text));
    const message = entry.loading !== null ? '正在加载命令输出…' : entry.error ? '命令输出加载失败，请重试' : entry.needsReload ? '输出已更新或缓存已释放，点击重新加载' : !entry.text && entry.nextOffset !== null ? `展开后加载命令输出（${Math.ceil(entry.bytes / 1024)} KB）` : '';
    if (entry.windowStart > 0) holder.append(element('p', 'file-change-empty command-output-range', `当前显示第 ${entry.windowStart + 1}～${entry.windowStart + entry.text.length} 个字符`));
    if (message) holder.append(element('p', 'file-change-empty command-output-status', message));
    if (entry.loading === null && entry.nextOffset !== null && (entry.error || entry.text || entry.needsReload)) {
      const button = element('button', 'command-output-more', entry.error ? '重试加载' : entry.needsReload ? '重新加载输出' : entry.text.length + 16384 > toolOutputCharacterLimit ? '继续查看下一部分' : '加载更多输出'); button.type = 'button';
      button.addEventListener('click', () => loadToolOutputPage(entry)); holder.append(button);
    }
    if (entry.windowStart > 0 && entry.loading === null) {
      const restart = element('button', 'command-output-restart', '从头查看输出'); restart.type = 'button';
      restart.addEventListener('click', () => {
        if (toolOutputEntries.get(entry.key) !== entry || entry.threadId !== selectedId || entry.key !== toolOutputKey(entry.threadId, entry.turnKey, entry.itemId) || entry.loading !== null) return;
        entry.text = ''; entry.nextOffset = 0; entry.windowStart = 0; entry.receivedBytes = 0;
        return loadToolOutputPage(entry);
      });
      holder.append(restart);
    }
  };
  if (entry) {
    entry.holders.add(render);
    details.addEventListener('toggle', () => { if (details.open && !entry.text && !entry.error && !entry.needsReload && entry.nextOffset === 0) void loadToolOutputPage(entry); });
  }
  render();
  if (entry && details.open && !entry.text && !entry.error && !entry.needsReload && entry.nextOffset === 0) void loadToolOutputPage(entry);
}
const expandedWork = new Set();
let priorWorkGroups = new Map(), nextWorkGroupId = 0;
const transientWorkKeys = new Set();
function clearWorkGroupRecords() {
  for (const groups of priorWorkGroups.values()) for (const group of groups) expandedWork.delete(group.key);
  for (const key of transientWorkKeys) expandedWork.delete(key);
  priorWorkGroups.clear(); transientWorkKeys.clear();
}
function reconcileWorkGroups(scope, groups, preserved = new Set()) {
  const previous = priorWorkGroups.get(scope) || [];
  const overlaps = groups.map(group => previous.map(old => group.ids.some(id => old.ids.includes(id))));
  const assigned = groups.map((group, index) => {
    const matches = previous.map((old, i) => overlaps[index][i] ? i : -1).filter(i => i >= 0);
    if (matches.length === 1 && overlaps.filter(row => row[matches[0]]).length === 1) return previous[matches[0]].key;
    if (!group.ids.length) { const key = JSON.stringify([scope, 'unstable', ++nextWorkGroupId]); transientWorkKeys.add(key); return key; }
    if (!priorWorkGroups.has(scope) && group.ids.length) return JSON.stringify([...JSON.parse(scope), 'work', index]);
    return JSON.stringify([scope, 'work-group', ++nextWorkGroupId]);
  });
  for (const old of previous) if (!assigned.includes(old.key) && !preserved.has(old.key)) expandedWork.delete(old.key);
  priorWorkGroups.set(scope, groups.map((group, index) => ({ ids: group.ids, key: assigned[index] })));
  return assigned;
}
const expandedActivities = new Set();
const expandedMessages = new Set();
const conversation = document.querySelector('.conversation');
const scrollBottomButton = document.querySelector('#scroll-bottom');
let followLatest = true;
let renderedThreadId = null;
let previousHistoryScrollTop = null, historyScrollThread = null, historyAutoBlocked = false, historyCanLoad = false;
function updateScrollButton() {
  if (scrollBottomButton) scrollBottomButton.hidden = !selectedId || followLatest;
}
conversation?.addEventListener('scroll', () => {
  if (!Number.isFinite(conversation.scrollHeight) || !Number.isFinite(conversation.clientHeight)) return;
  const top = conversation.scrollTop;
  const upward = historyScrollThread === selectedId && previousHistoryScrollTop !== null && top < previousHistoryScrollTop;
  historyScrollThread = selectedId;
  previousHistoryScrollTop = top;
  followLatest = conversation.scrollHeight - conversation.clientHeight - conversation.scrollTop < 80;
  updateScrollButton();
  if (upward && top < 120 && historyCanLoad && historyHasOlder() && !historyAutoBlocked && !historyIsStale()) void loadEarlierPage();
});
// Pulling down at the very top also pages in older turns, including when the
// loaded window is shorter than the viewport and never fires a scroll event.
let historyPullStart = null;
conversation?.addEventListener('touchstart', event => {
  const touch = event.touches?.[0];
  historyPullStart = touch && conversation.scrollTop <= 4 ? { y: touch.clientY } : null;
}, { passive: true });
conversation?.addEventListener('touchmove', event => {
  const touch = event.touches?.[0];
  if (!touch || !historyPullStart) return;
  if (conversation.scrollTop > 8) { historyPullStart = null; return; }
  if (touch.clientY - historyPullStart.y >= 45 && historyCanLoad && historyHasOlder() && !historyAutoBlocked && !historyIsStale() && !historyRequest) {
    historyPullStart = null;
    void loadEarlierPage();
  }
}, { passive: true });
scrollBottomButton?.addEventListener('click', () => {
  followLatest = true;
  conversation.scrollTop = conversation.scrollHeight;
  updateScrollButton();
});
const groupExpanded = new Map();
const expandedGroups = new Set();
let connected = false;
let voiceSession = null;
let attachmentPreviewModule;
function disposeAttachmentDraft(draft) {
  draft.disposed = true;
  draft.previewController?.abort();
  draft.previewElement = null;
  if (draft.url) URL.revokeObjectURL(draft.url);
}
function addFileThumbnail(draft, holder, fallback) {
  const threadId = selectedId, newChatDraft = newDraft;
  if (!draft.previewPromise) {
    draft.previewController = new AbortController();
    draft.previewPromise = (attachmentPreviewModule ||= import('/attachment-preview.mjs').catch(error => { attachmentPreviewModule = null; throw error; }))
      .then(module => module.createAttachmentPreview(draft.file, { signal: draft.previewController.signal }))
      .then(element => { if (!draft.disposed) draft.previewElement = element; })
      .catch(() => {});
  }
  const show = () => {
    if (!draft.previewElement || draft.disposed || selectedId !== threadId || newDraft !== newChatDraft || !holder.isConnected || !(newChatDraft ? newChatDraft.attachments : imageDrafts.get(threadId) || []).includes(draft)) return;
    const preview = document.createElement('span'); preview.className = 'attachment-preview';
    const name = document.createElement('span'); name.className = 'attachment-preview-name'; name.textContent = draft.file.name;
    preview.append(draft.previewElement, name); fallback.replaceWith(preview);
  };
  if (draft.previewElement) show(); else void draft.previewPromise.then(show);
}
function renderImageDraft() {
  const drafts = newDraft ? newDraft.attachments : (selectedId && imageDrafts.get(selectedId)) || [];
  imageDraft.replaceChildren();
  imageDraft.hidden = !drafts.length;
  for (const draft of drafts) {
  const holder = document.createElement('div'); holder.className = 'image-draft-item';
  const fileCard = () => {
    const card = document.createElement('span'); card.className = 'attachment-card'; card.title = draft.file.name;
    const type = document.createElement('span'); type.className = 'attachment-type'; type.textContent = draft.file.name.includes('.') ? draft.file.name.split('.').at(-1).slice(0, 8).toUpperCase() : '文件';
    const name = document.createElement('span'); name.className = 'attachment-name'; name.textContent = draft.file.name;
    const size = document.createElement('span'); size.className = 'attachment-size'; size.textContent = draft.file.size < 1024 ? `${draft.file.size} B` : draft.file.size < 1024 * 1024 ? `${Math.ceil(draft.file.size / 1024)} KB` : `${(draft.file.size / (1024 * 1024)).toFixed(1)} MB`;
    card.append(type, name, size); return card;
  };
  const image = draft.url ? document.createElement('img') : fileCard();
  holder.title = draft.file.name;
  if (draft.url) {
    image.src = draft.url; image.alt = draft.file.name;
    image.addEventListener('error', () => image.replaceWith(fileCard()), { once: true });
  }
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'image-draft-remove';
  remove.title = '移除附件';
  remove.setAttribute('aria-label', '移除附件');
  remove.disabled = Boolean(newDraft?.pending || newDraft?.uncertain || newDraft?.prepared || submissions.get(selectedId)?.pending || submissions.get(selectedId)?.uncertain);
  remove.textContent = '×';
  remove.addEventListener('click', () => {
    disposeAttachmentDraft(draft);
    const remaining = (newDraft ? newDraft.attachments : imageDrafts.get(selectedId) || []).filter(item => item !== draft);
    if (newDraft) newDraft.attachments = remaining;
    else if (remaining.length) imageDrafts.set(selectedId, remaining); else imageDrafts.delete(selectedId);
    fileInput.value = '';
    renderImageDraft();
    updateComposer();
  });
  holder.append(image, remove); imageDraft.append(holder);
  if (!draft.url) addFileThumbnail(draft, holder, image);
  }
}
function clearImageDrafts() {
  for (const drafts of imageDrafts.values()) for (const draft of drafts) disposeAttachmentDraft(draft);
  imageDrafts.clear();
  renderImageDraft();
}
function closeAttachmentMenu() { attachmentMenu.hidden = true; attachmentToggle.setAttribute('aria-expanded', 'false'); }
attachmentToggle.addEventListener('click', () => {
  if (attachmentToggle.disabled) return;
  attachmentMenu.hidden = !attachmentMenu.hidden;
  attachmentToggle.setAttribute('aria-expanded', String(!attachmentMenu.hidden));
});
document.addEventListener?.('click', event => { if (!attachmentControl.contains(event.target)) closeAttachmentMenu(); });
document.addEventListener?.('keydown', event => { if (event.key === 'Escape' && !attachmentMenu.hidden) { closeAttachmentMenu(); attachmentToggle.focus(); } });
imageChoose.addEventListener('click', () => { closeAttachmentMenu(); if (imageUploadAvailable && (selectedId || newDraft) && connected) imageFile.click(); });
fileChoose.addEventListener('click', () => { closeAttachmentMenu(); if (imageUploadAvailable && (selectedId || newDraft) && connected) fileInput.click(); });
async function applyModeChange(id, target) {
  const change = { target, message: '正在切换模式' };
  modeNotices.delete(id); modeChanges.set(id, change); updateComposer();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await scopedFetch(`/api/threads/${encodeURIComponent(id)}/mode`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: target }),
    });
    if (modeChanges.get(id) !== change) return;
    if (response.ok) change.message = '等待电脑确认模式';
    else if (response.status === 408 || response.status >= 500) { change.uncertain = true; change.message = '切换结果未知，请查看电脑上的模式'; }
    else { modeChanges.delete(id); modeNotices.set(id, '模式切换未被接受'); }
  } catch {
    if (modeChanges.get(id) === change) { change.uncertain = true; change.message = '切换结果未知，请查看电脑上的模式'; }
  } finally {
    clearTimeout(timer);
    if (selectedId === id) updateComposer();
  }
}
function flushPendingModeChange() {
  const id = selectedId;
  if (!id || newDraft || !connected || liveRuntimeStatus !== 'idle') return;
  const target = pendingModeChanges.get(id);
  if (!target || !['default', 'plan'].includes(liveMode) || modeChanges.has(id) || modelChanges.has(id) || hasPendingOutgoing(id) || recoveryBlocksWrite()) return;
  pendingModeChanges.delete(id);
  void applyModeChange(id, target);
}
modeChoose.addEventListener('click', async () => {
  if (newDraft) {
    if (!connected || newDraft.pending || newDraft.uncertain || newDraft.prepared) return;
    newDraft.mode = newDraft.mode === 'plan' ? 'default' : 'plan';
    closeAttachmentMenu();
    updateComposer();
    return;
  }
  const id = selectedId;
  if (!id || !connected || !['default', 'plan'].includes(liveMode) || modeChanges.has(id) || modelChanges.has(id) || hasPendingOutgoing(id) || recoveryBlocksWrite()) return;
  closeAttachmentMenu();
  const target = (pendingModeChanges.get(id) || liveMode) === 'plan' ? 'default' : 'plan';
  if (liveRuntimeStatus !== 'idle') {
    if (target === liveMode) pendingModeChanges.delete(id);
    else pendingModeChanges.set(id, target);
    updateComposer();
    return;
  }
  await applyModeChange(id, target);
});
function addAttachments(input, kind) {
  const files = [...(input.files || [])];
  if (!imageUploadAvailable || (!selectedId && !newDraft) || !connected || !files.length) return;
  const previous = newDraft ? newDraft.attachments : imageDrafts.get(selectedId) || [];
  if (files.some(file => (file.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|ogv|avi|mkv|wmv|flv|3gp|mpeg|mpg|mts|m2ts)$/i.test(file.name)) && file.size > 10 * 1024 * 1024)) {
    input.value = '';
    sendStatus.textContent = '视频不能超过 10 MB';
    return;
  }
  const invalidFormat = kind === 'image' && files.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type));
  if (previous.length + files.length > 4 || invalidFormat || files.some(file => file.size < 1 || file.size > 20 * 1024 * 1024 || !file.name || file.name.length > 255 || /[\x00-\x1f\x7f/\\\u2028\u2029]/.test(file.name))) {
    input.value = '';
    sendStatus.textContent = invalidFormat ? '图片仅支持 PNG、JPEG 或 WebP 格式' : '附件无效：最多 4 个，每个不超过 20 MB';
    return;
  }
  const next = [...previous, ...files.map(file => {
    const image = kind === 'image' || ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || (!file.type && /\.(png|jpe?g|webp)$/i.test(file.name));
    return { file, kind: image ? 'image' : 'file', ...(image || file.type.startsWith('image/') ? { url: URL.createObjectURL(file) } : {}) };
  })];
  if (newDraft) newDraft.attachments = next; else imageDrafts.set(selectedId, next);
  input.value = '';
  renderImageDraft();
  updateComposer();
}
imageFile.addEventListener('change', () => addAttachments(imageFile, 'image'));
fileInput.addEventListener('change', () => addAttachments(fileInput, 'file'));
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
function stopVoice() {
  const session = voiceSession;
  if (!session) return;
  voiceSession = null;
  voiceButton.setAttribute('aria-pressed', 'false');
  voiceButton.title = '语音输入';
  try { session.recognition.abort(); } catch { /* Already stopped. */ }
}
voiceButton.addEventListener('click', () => {
  if (voiceSession) {
    if (voiceSession.stopping) return;
    voiceSession.stopping = true;
    voiceStatus.textContent = '正在完成听写';
    try { voiceSession.recognition.stop(); } catch { stopVoice(); voiceStatus.textContent = ''; }
    return;
  }
  if (!SpeechRecognition || (!selectedId && !newDraft) || !connected || newDraft?.pending || newDraft?.uncertain || newDraft?.prepared) return;
  let recognition;
  try { recognition = new SpeechRecognition(); } catch { voiceStatus.textContent = '语音输入不可用'; return; }
  const session = { recognition, threadId: selectedId, draft: newDraft };
  voiceSession = session;
  recognition.lang = 'zh-CN';
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.onresult = event => {
    if (voiceSession !== session || selectedId !== session.threadId || newDraft !== session.draft || !connected) return;
    let text = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) text += event.results[i][0]?.transcript || '';
    }
    if (!text) return;
    messageInput.value = (messageInput.value + text).slice(0, 32000);
    if (session.draft) session.draft.text = messageInput.value;
    else drafts.set(session.threadId, messageInput.value);
    updateComposer();
  };
  recognition.onerror = event => {
    if (voiceSession !== session) return;
    voiceStatus.textContent = event.error === 'not-allowed' || event.error === 'service-not-allowed' ? '麦克风权限未开启' : '语音识别失败，请重试';
    stopVoice();
  };
  recognition.onend = () => {
    if (voiceSession !== session) return;
    voiceSession = null;
    voiceButton.setAttribute('aria-pressed', 'false');
    voiceButton.title = '语音输入';
    voiceStatus.textContent = '';
  };
  try {
    recognition.start();
    voiceButton.setAttribute('aria-pressed', 'true');
    voiceButton.title = '停止语音输入';
    voiceStatus.textContent = '正在听写';
  } catch { voiceSession = null; voiceStatus.textContent = '语音输入不可用'; }
});
function updateComposer() {
  updateHomeInstallPrompt();
  if (document.hidden !== true && !pageSuspended && !newDraft && selectedId) clearTaskNotification(selectedId);
  window.refreshNotificationPresence?.();
  const state = selectedId && submissions.get(selectedId);
  updateRecoveryControl();
  updateRecoveryGuardedControls();
  if (!newDraft && selectedId && connected) {
    const blocked = recoveryBlocksWrite();
    connection.textContent = blocked ? '已连接，待确认' : '已连接';
  }
  if (messageInput.style) {
    messageInput.style.height = 'auto';
    messageInput.style.height = `${Math.min(messageInput.scrollHeight, Math.min(300, (window.innerHeight || 844) * 0.35))}px`;
  }
  messageInput.disabled = newDraft ? !connected || !newDraft.projectId || newDraft.pending || newDraft.uncertain || Boolean(newDraft.prepared) : !selectedId || ((!connected || recoveryBlocksWrite()) && !canDraftInHistory());
  if (!messageInput.disabled) currentConnectionDiagnostic?.mark('input-enabled');
  imageChoose.hidden = true;
  imageChoose.disabled = !imageUploadAvailable || messageInput.disabled || Boolean(state?.pending || state?.uncertain);
  fileChoose.hidden = !imageUploadAvailable;
  fileChoose.disabled = imageChoose.disabled;
  const modeAvailable = newDraft ? true : ['default', 'plan'].includes(liveMode);
  const modeChange = selectedId && modeChanges.get(selectedId);
  const canUnlockMode = Boolean(!newDraft && currentDeviceId && historyScope && connected && modeChange?.uncertain);
  unlockModeChange.hidden = !canUnlockMode; unlockModeChange.disabled = !canUnlockMode;
  modeUnlockTarget = canUnlockMode ? { deviceId: currentDeviceId, generation: historyScopeGeneration, threadId: selectedId, change: modeChange } : null;
  const pendingMode = selectedId && pendingModeChanges.get(selectedId);
  const effectiveMode = newDraft ? (newDraft.mode === 'plan' ? 'plan' : 'default') : (pendingMode || modeChange?.target || liveMode);
  modeChoose.hidden = !modeAvailable;
  modeChoose.textContent = effectiveMode === 'plan' ? '计划模式 ✓' : '计划模式';
  modeChoose.dataset.active = String(effectiveMode === 'plan');
  if (planBadge) planBadge.hidden = !modeAvailable || effectiveMode !== 'plan';
  modeChoose.disabled = messageInput.disabled || Boolean(modeChange) || Boolean(selectedId && modelChanges.has(selectedId)) || hasPendingOutgoing(selectedId);
  modeStatus.textContent = (modeChange?.message.includes('未知') ? modeChange.message : '') || (selectedId && modelChanges.get(selectedId)?.message) || (selectedId && modeNotices.get(selectedId)) || (pendingMode ? '将在当前回合结束后切换' : '');
  const modelChange = selectedId && modelChanges.get(selectedId);
  cancelModelPrepared.hidden = !modelChange || (!modelChange.checkAfterCancel && !uuid.test(modelChange.preparedOperationId || ''));
  cancelModelPrepared.disabled = !connected || Boolean(modelChange?.cancelling);
  cancelModelPrepared.textContent = modelChange?.checkAfterCancel ? '重新检查' : '取消模型切换';
  updateModelControl();
  attachmentControl.hidden = !imageUploadAvailable && !modeAvailable;
  attachmentToggle.disabled = messageInput.disabled || (fileChoose.disabled && !modeAvailable);
  if (attachmentToggle.disabled) closeAttachmentMenu();
  for (const removeImage of imageDraft.querySelectorAll?.('.image-draft-remove') || []) removeImage.disabled = Boolean(state?.pending || state?.uncertain);
  if (voiceSession && (messageInput.disabled || voiceSession.threadId !== selectedId || voiceSession.draft !== newDraft)) { stopVoice(); voiceStatus.textContent = ''; }
  voiceButton.disabled = messageInput.disabled || !SpeechRecognition;
  if (!SpeechRecognition) voiceButton.title = '当前浏览器不支持语音输入';
  messageInput.placeholder = newDraft ? (connected ? '输入消息' : '等待连接') : selectedId ? (connected || canDraftInHistory() ? (liveMode === 'plan' ? '输入任务生成计划' : '输入消息') : '等待连接') : '选择任务后输入消息';
  sendButton.disabled = (newDraft?.prepared ? !connected || newDraft.pending || newDraft.uncertain : messageInput.disabled) || Boolean(state?.pending || state?.uncertain) || Boolean(selectedId && (modelChanges.has(selectedId) || modeChanges.has(selectedId))) || Boolean(selectedId && imageDrafts.has(selectedId) && !imageUploadAvailable) || (!messageInput.value.trim() && !(newDraft?.attachments.length || (imageUploadAvailable && selectedId && imageDrafts.has(selectedId))));
  sendStatus.textContent = newDraft?.message || state?.message || '';
  unlockSend.hidden = !(newDraft?.uncertain || state?.uncertain);
  abandonPrepared.hidden = !newDraft?.prepared || newDraft.pending || newDraft.uncertain;
  const stop = selectedId && stops.get(selectedId);
  const hasDraft = Boolean(messageInput.value?.trim() || (selectedId && imageDrafts.has(selectedId)));
  stopButton.hidden = !activeTurnId || hasDraft;
  sendButton.hidden = Boolean(activeTurnId && !hasDraft);
  stopButton.disabled = !connected || !activeTurnId || Boolean(stop && stop.turnId === activeTurnId) || recoveryBlocksWrite();
  const stopping = stop?.turnId === activeTurnId && !stop?.error;
  stopButton.title = stopping ? '正在停止' : '停止任务';
  stopButton.setAttribute('aria-label', stopping ? '正在停止' : '停止任务');
  stopStatus.textContent = stop?.error ? stop.message : '';
  // Recovery/model confirmations can clear a write gate without a new live message.
  if (selectedId && (connected || canDraftInHistory()) && !newDraft) { const id = selectedId; void Promise.resolve().then(() => runOutgoingQueue(id)); }
}
const activeRecoveryAborts = new Map();
async function recoverSelectedChat({ preserveStream = null, isCurrent = () => true } = {}) {
  const id = selectedId, deviceId = currentDeviceId;
  if (!id || !deviceId || newDraft || !isCurrent()) return;
  const key = recoveryKey(deviceId, id), previous = recoveryState(deviceId, id);
  const check = recoveryChecks.get(key);
  if (previous?.status === 'unknown') { await checkRecoveryAttempt(id, deviceId, previous); return; }
  if (check?.status === 'failed') {
    if (recoveryStream?.threadId === id && !recoveryStream.controller.signal.aborted) void checkRecoveryStatus(id, deviceId, recoveryStream);
    else void connect(id);
    return;
  }
  // Nothing asked the bridge yet: ask now instead of waiting for the next
  // stream event. The check itself re-enters this function when it is ready.
  if (!check && recoveryStream?.threadId === id && !recoveryStream.controller.signal.aborted) { void checkRecoveryStatus(id, deviceId, recoveryStream); return; }
  if (check?.status !== 'ready' || connected || recoverableHistoryId !== id) return;
  if (previous && !['unavailable', 'clear'].includes(previous.status)) return;
  const state = { status: 'pending', message: '正在连接任务', requestId: crypto.randomUUID(), since: Date.now() };
  recoveries.set(key, state); updateComposer();
  let reserved = false;
  try {
    const store = await recoveryStorePromise;
    if (!(await store.reserve(deviceId, id, state.requestId))) throw new Error('occupied');
    reserved = true;
    recoveryChannel?.postMessage({ deviceId, threadId: id });
    if (selectedId !== id || currentDeviceId !== deviceId || newDraft || connected || !isCurrent()) throw new Error('selection changed');
  }
  catch {
    if (reserved) await clearRecoveryAttempt(deviceId, id, state);
    if (recoveries.get(key) === state) recoveries.delete(key);
    if (selectedId === id && currentDeviceId === deviceId) updateComposer();
    return;
  }
  activeRecoveryAborts.get(key)?.abort();
  // Let the relay's 60 s recovery budget settle before treating transport loss
  // as an unknown outcome; ordinary requests keep their existing deadlines.
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 70000);
  const requestScope = historyScopeGeneration;
  activeRecoveryAborts.set(key, controller);
  try {
    const response = await scopedFetch(`/api/threads/${encodeURIComponent(id)}/recover`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: state.requestId }) });
    if (recoveries.get(key) !== state) return;
    let result; try { result = await response.json(); } catch { result = null; }
    if (response.status === 202 && result?.status === 'accepted') {
      state.status = 'awaiting-state'; state.message = '正在连接任务'; state.since = Date.now();
      const attached = recoveryStream?.threadId === id && !recoveryStream.controller.signal.aborted;
      if (!controller.signal.aborted && selectedId === id && currentDeviceId === deviceId && historyScopeGeneration === requestScope && !connected && isCurrent() && !attached) void connect(id);
    } else if (response.status === 409 && result?.error === 'unavailable') {
      if (!(await clearRecoveryAttempt(deviceId, id, state))) throw new Error('storage');
      state.status = 'unavailable'; state.message = '暂时无法连接，请稍后再试'; state.since = Date.now();
    } else {
      state.status = 'unknown'; state.message = '恢复结果未知，请在电脑上查看任务'; state.since = Date.now();
    }
  } catch {
    // A superseded controller means the user moved to another task; the newer
    // attempt owns the state from here.
    if (activeRecoveryAborts.get(key) === controller && recoveries.get(key) === state) { state.status = 'unknown'; state.message = '恢复结果未知，请在电脑上查看任务'; state.since = Date.now(); }
  } finally {
    clearTimeout(timer);
    if (activeRecoveryAborts.get(key) === controller) activeRecoveryAborts.delete(key);
    if (selectedId === id && currentDeviceId === deviceId) updateComposer();
  }
}
recoverChat.addEventListener('click', () => {
  const id = selectedId, deviceId = currentDeviceId, stream = recoveryStream;
  if (!id || !deviceId || newDraft || stream?.threadId !== id || stream.controller.signal.aborted
      || recoveryChecks.get(recoveryKey(deviceId, id))?.status === 'checking') return;
  void checkRecoveryStatus(id, deviceId, stream, { readOnly: true });
});
stopButton.addEventListener('click', async () => {
  flushPendingRender();
  const id = selectedId, turnId = activeTurnId, scopeGeneration = historyScopeGeneration;
  if (!id || !turnId || !connected || stops.get(id)?.turnId === turnId || recoveryBlocksWrite()) return;
  stops.set(id, { turnId, pending: true, message: '正在停止...' });
  updateComposer();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await scopedFetch(`/api/threads/${encodeURIComponent(id)}/stop`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ turnId }),
    });
    if (scopeGeneration !== historyScopeGeneration || stops.get(id)?.turnId !== turnId) return;
    if (response.ok) {
      let result; try { result = await response.json(); } catch { /* Older relays may return no body. */ }
      if (scopeGeneration !== historyScopeGeneration || stops.get(id)?.turnId !== turnId) return;
      if (result?.status === 'stopped-goal-pause-failed') stops.set(id, { turnId, error: true, goalPauseFailed: true, message: '任务已停止，但目标暂停失败，请在电脑上检查目标状态' });
      else if (selectedId === id && activeTurnId !== turnId) stops.delete(id);
      else stops.set(id, { turnId, message: '已发送停止请求，等待任务状态更新' });
    }
    else if (response.status === 408 || response.status >= 500) stops.set(id, { turnId, error: true, message: '停止结果未知，请查看任务状态' });
    else stops.set(id, { turnId, error: true, message: '停止请求未被接受，请查看任务状态' });
  } catch {
    if (scopeGeneration === historyScopeGeneration && stops.get(id)?.turnId === turnId) stops.set(id, { turnId, error: true, message: '停止结果未知，请查看任务状态' });
  } finally {
    clearTimeout(timer);
    if (scopeGeneration !== historyScopeGeneration) return;
    const latestStop = stops.get(id);
    if (selectedId === id && activeTurnId && activeTurnId !== turnId && latestStop?.turnId === turnId && !latestStop.goalPauseFailed) stops.delete(id);
    if (selectedId === id) updateComposer();
  }
});
const outgoingMessages = new Map();
const outgoingWorkers = new Map();
const outgoingViewVersions = new Map();
const outgoingBarriers = new Map();
let nextOutgoingId = 0;
const outgoingList = document.createElement('section');
outgoingList.className = 'outgoing-messages'; outgoingList.hidden = true;
outgoingList.setAttribute('aria-label', '待送达的消息');
turns.after?.(outgoingList);
function outgoingScopeKey(threadId = selectedId) { return JSON.stringify([historyScope?.hostId || '', historyScope?.deviceId || '', threadId]); }
function outgoingDeviceMatches(entry) { return entry.scopeKey === outgoingScopeKey(entry.threadId); }
function outgoingScopeMatches(entry) { return entry.scopeGeneration === historyScopeGeneration && outgoingDeviceMatches(entry); }
function hasPendingOutgoing(threadId) {
  return Boolean(threadId && (outgoingMessages.get(outgoingScopeKey(threadId)) || []).some(entry => ['queued', 'sending', 'unknown'].includes(entry.state)));
}
function outgoingWriteBlocked(threadId) {
  const legacy = submissions.get(threadId);
  return Boolean(newDraft || selectedId !== threadId || !connected || recoveryBlocksWrite() || legacy?.pending || legacy?.uncertain || modelChanges.has(threadId) || modeChanges.has(threadId));
}
function disposeOutgoing(entry) {
  entry.controller?.abort();
  for (const image of entry.images) disposeAttachmentDraft(image);
  const entries = outgoingMessages.get(entry.scopeKey) || [];
  const remaining = entries.filter(item => item !== entry);
  if (remaining.length) outgoingMessages.set(entry.scopeKey, remaining); else outgoingMessages.delete(entry.scopeKey);
}
function outgoingFileNode(image) {
  if (image.url) { const preview = element('img', 'outgoing-image'); preview.src = image.url; preview.alt = image.file.name; return preview; }
  const file = element('div', 'outgoing-file');
  file.append(element('span', 'outgoing-file-name', image.file.name), element('span', 'outgoing-file-size', image.file.size < 1024 * 1024 ? `${Math.ceil(image.file.size / 1024)} KB` : `${(image.file.size / (1024 * 1024)).toFixed(1)} MB`));
  return file;
}
function renderOutgoingMessages() {
  const fragment = document.createDocumentFragment();
  const entries = outgoingMessages.get(outgoingScopeKey()) || [];
  for (const entry of entries) {
    const row = element('article', 'turn outgoing-message'); row.dataset.outgoingId = entry.localId;
    const group = element('div', 'user-message-group');
    if (entry.text) group.append(element('p', 'item user-message item-text', entry.text));
    if (entry.images.length) { const files = element('div', 'outgoing-files'); for (const image of entry.images) files.append(outgoingFileNode(image)); group.append(files); }
    const failed = entry.state === 'failed' || entry.state === 'unknown';
    const feedback = element('div', failed ? 'outgoing-feedback outgoing-error' : 'outgoing-feedback');
    feedback.setAttribute('role', failed ? 'alert' : 'status');
    if (failed) feedback.textContent = entry.state === 'failed' ? entry.error : '发送结果未知，请先检查聊天记录';
    else {
      feedback.className += ' outgoing-pending';
      feedback.setAttribute('aria-label', '待送达');
      feedback.innerHTML = '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="8" cy="8" r="5.5"/><path d="M8 4.5V8l2.5 1.5"/></svg>';
    }
    group.append(feedback);
    if (failed) {
      const actions = element('div', 'outgoing-actions');
      const edit = element('button', 'outgoing-edit', entry.state === 'unknown' ? '确认未送达后恢复草稿' : '恢复草稿'); edit.type = 'button';
      edit.addEventListener('click', () => {
        if (newDraft || !outgoingDeviceMatches(entry) || selectedId !== entry.threadId || !['failed', 'unknown', 'queued'].includes(entry.state)) return;
        const pending = imageDrafts.get(entry.threadId) || [];
        if (pending.length + entry.images.length > 4) { entry.error = '请先处理输入框中的附件，再恢复这条消息'; renderOutgoingMessages(); return; }
        messageInput.value = [messageInput.value, entry.text].filter(Boolean).join('\n'); drafts.set(entry.threadId, messageInput.value);
        if (entry.images.length) imageDrafts.set(entry.threadId, [...pending, ...entry.images]);
        entry.images = []; disposeOutgoing(entry); renderImageDraft(); renderOutgoingMessages(); updateComposer(); void runOutgoingQueue(entry.threadId);
      });
      const dismiss = element('button', 'outgoing-dismiss', '移除'); dismiss.type = 'button';
      dismiss.addEventListener('click', () => { if (!outgoingDeviceMatches(entry) || entry.state === 'sending') return; disposeOutgoing(entry); renderOutgoingMessages(); updateComposer(); void runOutgoingQueue(entry.threadId); });
      actions.append(edit, dismiss); group.append(actions);
    }
    row.append(group); fragment.append(row);
  }
  outgoingList.replaceChildren(fragment); outgoingList.hidden = entries.length === 0;
  if (followLatest && conversation) conversation.scrollTop = conversation.scrollHeight;
}
function cancelOutgoingForScopeChange() {
  for (const entries of outgoingMessages.values()) for (const entry of [...entries]) {
    entry.controller?.abort();
    if (entry.messageDispatched) entry.state = 'unknown';
    else if (['queued', 'sending'].includes(entry.state)) { entry.state = 'failed'; entry.error = '电脑已切换，请恢复草稿后重试'; }
  }
  outgoingWorkers.clear(); outgoingBarriers.clear(); outgoingViewVersions.clear();
  renderOutgoingMessages();
}
function syncOutgoingWithView(view) {
  if (!view || view.id !== selectedId) return;
  const key = outgoingScopeKey(view.id), previous = outgoingViewVersions.get(key);
  if (previous?.view !== view) outgoingViewVersions.set(key, { view, version: (previous?.version || 0) + 1 });
  const version = outgoingViewVersions.get(key)?.version || 0;
  if (outgoingBarriers.has(key) && version > outgoingBarriers.get(key)) outgoingBarriers.delete(key);
  renderOutgoingMessages();
  void runOutgoingQueue(view.id);
}
async function runOutgoingQueue(threadId) {
  const key = outgoingScopeKey(threadId), generation = historyScopeGeneration;
  if (outgoingWorkers.has(key) || outgoingBarriers.has(key)) return outgoingWorkers.get(key);
  const entry = (outgoingMessages.get(key) || [])[0];
  if (!entry || entry.state !== 'queued' || !outgoingScopeMatches(entry)) return;
  if (outgoingWriteBlocked(threadId)) {
    const check = recoveryChecks.get(recoveryKey(currentDeviceId, threadId));
    if (entry.recoveryRequested && !entry.recoveryStarted && canDraftInHistory() && check?.status === 'ready') {
      entry.recoveryStarted = true;
      const work = recoverSelectedChat(); outgoingWorkers.set(key, work);
      try { await work; }
      finally {
        if (outgoingWorkers.get(key) === work) outgoingWorkers.delete(key);
        const recovery = recoveries.get(recoveryKey(currentDeviceId, threadId));
        if (outgoingScopeMatches(entry) && (!recovery || recovery.status === 'unavailable')) { entry.state = 'failed'; entry.error = recovery?.message || '暂时无法连接，请恢复草稿后重试'; }
        if (outgoingScopeMatches(entry)) { renderOutgoingMessages(); updateComposer(); }
      }
    }
    return;
  }
  const work = sendOutgoing(entry);
  outgoingWorkers.set(key, work);
  try { await work; } finally {
    if (outgoingWorkers.get(key) === work) outgoingWorkers.delete(key);
    if (generation === historyScopeGeneration) { if (selectedId === threadId) { renderOutgoingMessages(); updateComposer(); } void runOutgoingQueue(threadId); }
  }
}
async function sendOutgoing(entry) {
  const id = entry.threadId, text = entry.text, images = entry.images;
  const controller = new AbortController(); entry.controller = controller; entry.state = 'sending';
  const timer = setTimeout(() => controller.abort(), 120000);
  let uploadId;
  const attachmentIds = [];
  let uploadStage = '初始化', uploadStatus = '', uploadReason = '';
  const uploadBegan = Date.now();
  const ensureScope = () => { if (!outgoingScopeMatches(entry) || controller.signal.aborted) throw new Error('cancelled'); };
  const call = (url, options) => { ensureScope(); return scopedFetch(url, { ...options, signal: options.signal || controller.signal }); };
  const checkUpload = async response => {
    uploadStatus = String(response.status);
    if (!response.ok) { const result = await response.json().catch(() => null); if (['busy', 'host-offline', 'unavailable', 'invalid', 'device-replaced', 'unsupported-encoding', 'invalid-compressed-chunk'].includes(result?.error)) uploadReason = result.error; throw Object.assign(new Error('upload'), { uploadStatus: String(response.status), uploadReason }); }
  };
  const cleanup = () => {
    if (!outgoingScopeMatches(entry)) return;
    for (const attachmentId of [...attachmentIds, ...(uploadId ? [uploadId] : [])]) void scopedFetch(`/api/threads/${encodeURIComponent(id)}/uploads/${encodeURIComponent(attachmentId)}`, { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' }).catch(() => {});
  };
  renderOutgoingMessages();
  try {
    for (const image of images) {
      uploadStage = '初始化'; uploadStatus = ''; uploadReason = '';
      await loadCapabilities(); ensureScope();
      if (!imageUploadAvailable) throw new Error('upload');
      const chunkBytes = imageChunkBytes;
      const base = `/api/threads/${encodeURIComponent(id)}/uploads`;
      const start = await call(base, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: image.file.name, size: image.file.size, kind: image.kind || 'image' }) });
      await checkUpload(start); ensureScope();
      const created = await start.json(); if (!uuid.test(created?.uploadId)) throw new Error('upload'); uploadId = created.uploadId;
      const fileController = new AbortController();
      const abortFile = () => fileController.abort();
      controller.signal.addEventListener('abort', abortFile, { once: true });
      let nextSeq = 0, firstError, compressionAllowed = true;
      const count = Math.ceil(image.file.size / chunkBytes);
      const worker = async () => {
        while (!fileController.signal.aborted) {
          const seq = nextSeq++;
          if (seq >= count) return;
          const stage = `传输 ${seq + 1}/${count}`;
          try {
            const offset = seq * chunkBytes;
            const chunk = await encodeUploadChunk(image.file.slice(offset, offset + chunkBytes), fileController.signal, compressionAllowed);
            // Sample every file losslessly, but avoid repeated CPU work for already compressed data.
            if (seq === 0 && chunk.compressionRatio > 0.98) compressionAllowed = false;
            if (fileController.signal.aborted) throw new Error('cancelled');
            const response = await call(`${base}/${encodeURIComponent(uploadId)}/chunks/${seq}`, { method: 'PUT', credentials: 'same-origin', cache: 'no-store', signal: fileController.signal, headers: chunk.headers, body: chunk.body });
            await checkUpload(response); ensureScope();
          } catch (error) {
            if (!firstError) firstError = Object.assign(error, { uploadStage: stage });
            fileController.abort(); return;
          }
        }
      };
      try { await Promise.all(Array.from({ length: Math.min(uploadConcurrency, count) }, () => worker())); }
      finally { controller.signal.removeEventListener('abort', abortFile); }
      if (firstError) throw firstError;
      ensureScope();
      uploadStage = '完成'; uploadStatus = ''; uploadReason = '';
      const finish = await call(`${base}/${encodeURIComponent(uploadId)}/finish`, { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
      await checkUpload(finish); ensureScope();
      const staged = await finish.json(); if (!uuid.test(staged?.attachmentId)) throw new Error('upload'); attachmentIds.push(staged.attachmentId); uploadId = undefined;
    }
    if (outgoingWriteBlocked(id)) throw Object.assign(new Error('paused'), { code: 'paused' });
    ensureScope(); entry.messageDispatched = true; entry.dispatchVersion = outgoingViewVersions.get(entry.scopeKey)?.version || 0;
    const response = await call(`/api/threads/${encodeURIComponent(id)}/messages`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(attachmentIds.length ? { text, attachmentIds } : { text }) });
    if (response.ok) {
      // The protocol acknowledges acceptance but does not return a message ID.
      // Remove only our local placeholder; never guess which server message is its echo.
      entry.state = 'accepted';
      if ((outgoingViewVersions.get(entry.scopeKey)?.version || 0) <= entry.dispatchVersion) outgoingBarriers.set(entry.scopeKey, entry.dispatchVersion);
      disposeOutgoing(entry);
    }
    else { const uncertain = response.status === 408 || response.status >= 500; if (!uncertain) cleanup(); entry.state = uncertain ? 'unknown' : 'failed'; entry.error = `发送失败 (${response.status})`; }
  } catch (error) {
    uploadStage = error?.uploadStage || uploadStage; uploadStatus = error?.uploadStatus || uploadStatus; uploadReason = error?.uploadReason || uploadReason;
    if (!entry.messageDispatched) cleanup();
    if (!outgoingScopeMatches(entry)) { if (entry.messageDispatched) entry.state = 'unknown'; return; }
    entry.state = error?.code === 'paused' ? 'queued' : entry.messageDispatched ? 'unknown' : 'failed';
    entry.error = entry.messageDispatched ? '发送结果未知，请先检查聊天记录' : `附件上传失败（${uploadStage} · ${uploadStatus || '网络异常'}${uploadReason ? ` · ${uploadReason}` : ''} · ${Math.round((Date.now() - uploadBegan) / 1000)}秒）`;
  } finally { clearTimeout(timer); entry.controller = null; }
}
unlockSend.addEventListener('click', () => { if (newDraft?.uncertain) { newDraft.uncertain = false; newDraft.requestId = null; newDraft.message = ''; newProject.disabled = false; } if (selectedId && submissions.get(selectedId)?.uncertain) submissions.delete(selectedId); updateComposer(); });
abandonPrepared.addEventListener('click', () => {
  const draft = newDraft;
  if (!draft?.prepared || draft.pending || draft.uncertain) return;
  const { threadId, uploaded } = draft.prepared;
  for (const id of uploaded.filter(Boolean)) void scopedFetch(`/api/threads/${encodeURIComponent(threadId)}/uploads/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'x-creation-id': draft.requestId } }).catch(() => {});
  saveProject(draft.projectId); savedNewDraft = null; newDraft = null; newProjectBar.hidden = true;
  selectedId = threadId; selectedTitle = '新聊天'; drafts.set(threadId, messageInput.value); imageDrafts.set(threadId, draft.attachments);
  renderImageDraft(); updateComposer(); void loadThreads(); void connect(threadId);
});
messageInput.addEventListener('input', () => {
  if (newDraft) newDraft.text = messageInput.value;
  if (selectedId) drafts.set(selectedId, messageInput.value);
  const state = selectedId && submissions.get(selectedId);
  if (state && !state.pending && !state.uncertain) submissions.delete(selectedId);
  updateComposer();
});
messageInput.addEventListener('focus', updateComposer);
messageInput.addEventListener('blur', updateComposer);
composerForm.addEventListener('submit', async event => {
  event.preventDefault();
  flushPendingRender();
  if (newDraft) {
    const draft = newDraft, text = messageInput.value, draftScopeGeneration = historyScopeGeneration;
    if (!connected || !draft.projectId || (!text.trim() && !draft.attachments.length) || draft.pending || draft.uncertain) return;
    const selectedModel = newModels.find(item => item.model === draft.model);
    if (draft.model && (!selectedModel || (draft.effort && !selectedModel.supportedReasoningEfforts.includes(draft.effort)))) { draft.message = '模型暂不可用，请重新选择'; updateComposer(); return; }
    if (!draft.requestId) draft.requestId = crypto.randomUUID();
    stopVoice(); draft.pending = true; draft.message = '发送中...'; newProject.disabled = true; renderNewModels(); updateComposer();
    const controller = draft.controller = new AbortController(), timer = setTimeout(() => controller.abort(), 120000);
    let preparedThread = draft.prepared?.threadId, dispatched = false, creationDispatched = false, inProgressUpload;
    const stagedIds = draft.prepared?.uploaded || [];
    try {
      const model = draft.model || null, effort = draft.model && draft.effort ? draft.effort : null;
      let response;
      if (draft.attachments.length) {
        const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
        if (!preparedThread) {
          const files = [];
          for (const entry of draft.attachments) files.push({ name: entry.file.name, kind: entry.kind || 'image', size: entry.file.size, sha256: hex(await crypto.subtle.digest('SHA-256', await entry.file.arrayBuffer())) });
          const digest = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ text, model, effort, files }))));
          const title = text.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, 80);
          creationDispatched = true;
          response = await scopedFetch('/api/chats/prepare', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: draft.requestId, projectId: draft.projectId, digest, ...(title ? { title } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) }) });
          if (response.status === 409 && (await response.clone().json().catch(() => null))?.error === 'not-dispatched') { if (draftScopeGeneration !== historyScopeGeneration) throw new Error('scope-changed'); creationDispatched = false; draft.message = '助手正在退出，请稍后重试'; return; }
          if (!response.ok) throw new Error(response.status >= 500 ? 'uncertain' : 'prepare');
          preparedThread = (await response.json()).threadId;
          if (!uuid.test(preparedThread || '')) throw new Error('uncertain');
          draft.prepared = { threadId: preparedThread, uploaded: stagedIds, ...(title ? { title } : {}) };
        }
        const base = `/api/threads/${encodeURIComponent(preparedThread)}/uploads`;
        const uploadHeaders = { 'x-creation-id': draft.requestId };
        const uploadDeviceId = currentDeviceId, uploadScopeGeneration = historyScopeGeneration;
        const ensureDraftUploadScope = () => {
          if (newDraft !== draft || currentDeviceId !== uploadDeviceId || historyScopeGeneration !== uploadScopeGeneration) {
            // The old receiver expires the upload; never clean it up with another device's credentials.
            inProgressUpload = undefined;
            throw new Error('upload');
          }
          if (controller.signal.aborted) throw new Error('upload');
        };
        for (const [index, entry] of draft.attachments.entries()) {
          if (stagedIds[index]) continue;
          await loadCapabilities(); ensureDraftUploadScope();
          if (!imageUploadAvailable) throw new Error('upload');
          const chunkBytes = imageChunkBytes, concurrency = uploadConcurrency;
          const start = await scopedFetch(base, { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { ...uploadHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ name: entry.file.name, size: entry.file.size, kind: entry.kind || 'image' }) });
          if (!start.ok) throw new Error('upload');
          const uploadId = (await start.json()).uploadId;
          if (!uuid.test(uploadId || '')) throw new Error('upload');
          inProgressUpload = uploadId;
          const fileController = new AbortController(), abortFile = () => fileController.abort();
          controller.signal.addEventListener('abort', abortFile, { once: true });
          let nextSeq = 0, firstError, compressionAllowed = true;
          const count = Math.ceil(entry.file.size / chunkBytes);
          const worker = async () => {
            while (!fileController.signal.aborted) {
              const seq = nextSeq++;
              if (seq >= count) return;
              try {
                ensureDraftUploadScope();
                const offset = seq * chunkBytes;
                const encoded = await encodeUploadChunk(entry.file.slice(offset, offset + chunkBytes), fileController.signal, compressionAllowed);
                if (seq === 0 && encoded.compressionRatio > 0.98) compressionAllowed = false;
                ensureDraftUploadScope();
                if (fileController.signal.aborted) throw new Error('upload');
                const chunk = await scopedFetch(`${base}/${uploadId}/chunks/${seq}`, { method: 'PUT', credentials: 'same-origin', signal: fileController.signal, headers: { ...uploadHeaders, ...encoded.headers }, body: encoded.body });
                if (!chunk.ok) throw new Error('upload');
                ensureDraftUploadScope();
              } catch (error) {
                if (!firstError) firstError = error;
                fileController.abort(); return;
              }
            }
          };
          try { await Promise.all(Array.from({ length: Math.min(concurrency, count) }, () => worker())); }
          finally { controller.signal.removeEventListener('abort', abortFile); }
          if (firstError) throw firstError;
          ensureDraftUploadScope();
          const finish = await scopedFetch(`${base}/${uploadId}/finish`, { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: uploadHeaders });
          if (!finish.ok) throw new Error('upload');
          const attachmentId = (await finish.json()).attachmentId;
          ensureDraftUploadScope();
          if (!uuid.test(attachmentId || '')) throw new Error('upload');
          stagedIds[index] = attachmentId; inProgressUpload = undefined;
        }
        ensureDraftUploadScope();
        dispatched = true;
        response = await scopedFetch('/api/chats/submit', { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: draft.requestId, text, attachmentIds: stagedIds, ...(draft.prepared?.title ? { title: draft.prepared.title } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) }) });
      } else {
        dispatched = true; creationDispatched = true;
        response = await scopedFetch('/api/chats', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: draft.requestId, projectId: draft.projectId, text, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }) });
      }
      if (draftScopeGeneration !== historyScopeGeneration) throw new Error('scope-changed');
      if (!response.ok) {
        if (response.status === 409 && (await response.clone().json().catch(() => null))?.error === 'not-dispatched') { if (draftScopeGeneration !== historyScopeGeneration) throw new Error('scope-changed'); draft.message = '助手正在退出，请稍后重试'; return; }
        if (response.status === 504) {
          const result = await response.json().catch(() => null);
          if (draftScopeGeneration !== historyScopeGeneration) throw new Error('scope-changed');
          if (result?.error === 'start-unknown' && uuid.test(result.threadId || '')) {
            saveProject(draft.projectId); savedNewDraft = null; newDraft = null; newProjectBar.hidden = true;
            selectedId = result.threadId; selectedTitle = '新聊天'; drafts.set(selectedId, text);
            if (draft.attachments.length) imageDrafts.set(selectedId, draft.attachments);
            submissions.set(selectedId, { pending: false, uncertain: true, message: '发送结果未知，请先检查聊天记录' });
            void loadThreads(); void connect(selectedId); return;
          }
        }
        if (preparedThread) throw new Error('uncertain');
        if (response.status === 408 || response.status >= 500) throw new Error('uncertain');
        draft.pending = false; draft.requestId = null; draft.message = '创建失败，请重试'; return;
      }
      const result = await response.json();
      if (draftScopeGeneration !== historyScopeGeneration) throw new Error('scope-changed');
      if (!uuid.test(result?.threadId || '')) throw new Error('uncertain');
      for (const attachment of draft.attachments) disposeAttachmentDraft(attachment);
      saveProject(draft.projectId); savedNewDraft = null; newDraft = null; newProjectBar.hidden = true;
      selectedId = result.threadId; selectedTitle = '新聊天'; messageInput.value = '';
      // A plan-mode choice made before the chat existed applies as soon as the
      // first turn goes idle.
      if (draft.mode === 'plan') pendingModeChanges.set(selectedId, 'plan');
      renderImageDraft(); void loadThreads(); void connect(selectedId);
    } catch (error) {
      if (draftScopeGeneration !== historyScopeGeneration) { draft.uncertain = true; draft.message = '发送结果未知，请先检查原电脑任务列表'; return; }
      if (preparedThread && !dispatched) {
        if (inProgressUpload) void scopedFetch(`/api/threads/${preparedThread}/uploads/${inProgressUpload}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'x-creation-id': draft.requestId } }).catch(() => {});
        draft.message = '附件上传失败，可继续发送，或放弃并打开聊天';
      } else if (preparedThread) {
        saveProject(draft.projectId); savedNewDraft = null; newDraft = null; newProjectBar.hidden = true;
        selectedId = preparedThread; selectedTitle = '新聊天'; drafts.set(selectedId, text); imageDrafts.set(selectedId, draft.attachments);
        submissions.set(selectedId, { pending: false, uncertain: true, message: '发送结果未知，请先检查聊天记录' });
        void loadThreads(); void connect(selectedId);
      } else if (creationDispatched) { draft.uncertain = true; draft.message = '创建结果未知，请先检查任务列表'; }
      else { draft.requestId = null; draft.message = '附件读取失败，请重试'; }
    }
    finally { clearTimeout(timer); draft.pending = false; if (newDraft === draft) { newProject.disabled = draft.uncertain || Boolean(draft.prepared); renderImageDraft(); renderNewModels(); updateComposer(); } }
    return;
  }
  const id = selectedId, text = messageInput.value, images = imageDrafts.get(id) || [];
  if (!id || (outgoingWriteBlocked(id) && !canDraftInHistory()) || (!text.trim() && !images.length) || (images.length && !imageUploadAvailable)) return;
  const all = [...outgoingMessages.values()].flat();
  if (all.length >= 16 || all.reduce((bytes, entry) => bytes + entry.images.reduce((n, image) => n + image.file.size, 0), 0) + images.reduce((bytes, image) => bytes + image.file.size, 0) > 80 * 1024 * 1024) { sendStatus.textContent = '待发送消息过多，请先处理聊天中的消息'; return; }
  stopVoice(); voiceStatus.textContent = '';
  const scopeKey = outgoingScopeKey(id), entry = { localId: `local-${++nextOutgoingId}`, scopeKey, scopeGeneration: historyScopeGeneration, threadId: id, text, images, state: 'queued', messageDispatched: false, recoveryRequested: canDraftInHistory() };
  outgoingMessages.set(scopeKey, [...(outgoingMessages.get(scopeKey) || []), entry]);
  drafts.delete(id); imageDrafts.delete(id); messageInput.value = ''; imageFile.value = ''; fileInput.value = '';
  followLatest = true; renderImageDraft(); updateComposer(); renderOutgoingMessages();
  return runOutgoingQueue(id);
});
function closeDevices() { deviceMenu.open = false; deviceScrim.hidden = true; }
function showSidebar(show) { if (show) { closeDevices(); showSummary(false); } sidebar.classList.toggle('open', show); scrim.hidden = !show; scheduleVisibleStatusRefresh(); }
document.querySelector('#open-sidebar').addEventListener('click', () => showSidebar(true));
document.querySelector('#close-sidebar').addEventListener('click', () => showSidebar(false));
scrim.addEventListener('click', () => showSidebar(false));
function showSummary(show) { if (show) { closeDevices(); showSidebar(false); } summaryPanel.hidden = !show; summaryScrim.hidden = !show; summaryToggle.setAttribute('aria-expanded', String(show)); }
summaryToggle.addEventListener('click', () => showSummary(summaryPanel.hidden));
summaryScrim.addEventListener('click', () => showSummary(false));
deviceMenu.addEventListener('toggle', () => { deviceScrim.hidden = !deviceMenu.open; if (deviceMenu.open) { showSidebar(false); showSummary(false); } });
deviceScrim.addEventListener('click', closeDevices);
document.addEventListener?.('keydown', event => { if (event.key === 'Escape' && deviceMenu.open) { event.preventDefault(); closeDevices(); deviceCurrent.focus(); } });
let summaryTouch;
summaryPanel.addEventListener('touchstart', event => { const touch = event.touches?.[0]; summaryTouch = touch ? { x: touch.clientX, y: touch.clientY } : null; }, { passive: true });
summaryPanel.addEventListener('touchend', event => { const touch = event.changedTouches?.[0]; if (summaryTouch && touch && touch.clientX - summaryTouch.x > 60 && Math.abs(touch.clientY - summaryTouch.y) < 70) showSummary(false); summaryTouch = null; }, { passive: true });

function status(text, state) { connection.textContent = text; connection.dataset.state = state; connected = state === 'ready'; updateComposer(); renderOutgoingMessages(); if (connected && selectedId) void runOutgoingQueue(selectedId); }
async function responseError(response, fallback) {
  if (response.status === 401 || response.status === 403) return '配对状态不可用，请重新配对';
  try {
    const data = await response.json();
    if (response.status === 503 && data?.error === 'host-offline') return '电脑未连接，请打开 codex手机助手';
  } catch { /* Use the generic error if the response has no JSON body. */ }
  return fallback;
}
let displayedHistoryId = null, homeErrorSource = null;
function clearConversation() { cancelAsyncQuestionWrites(); clearToolOutputEntries(); cancelPendingRender(); historyRequest?.abort(); historyRequest = null; loadEarlier.disabled = false; loadedHistory = null; recordedHistory = null; loadEarlier.hidden = true; historyCanLoad = false; historyAutoBlocked = false; historyScrollThread = null; previousHistoryScrollTop = null; displayedHistoryId = null; recoverableHistoryId = null; recoveryGuardedControls = []; renderedQuestionPanel = null; questionLiveConfirmed = false; recoveryControl.hidden = true; stopGoalClock(); clearImagePreviews(); clearWorkGroupRecords(); filePreviewCache.clear(); activeTurnId = null; liveMode = null; liveModel = null; liveRuntimeStatus = null; goalPanel.hidden = true; questionPanel.hidden = true; questionPanel.replaceChildren(); title.textContent = selectedId ? (selectedTitle || '未命名任务') : '尚未选择任务'; history.textContent = ''; turns.replaceChildren(); summaryContent.replaceChildren(); renderOutgoingMessages(); }
function diffStats(changes) {
  let added = 0, removed = 0;
  for (const change of changes || []) {
    if (typeof change?.diff !== 'string') continue;
    for (const line of change.diff.split(/\r?\n/)) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
  }
  return added || removed ? { added, removed } : null;
}
function fail(message) { clearConversation(); homeErrorSource = null; error.textContent = message; error.hidden = false; status('连接断开', 'error'); }
function showHomeError(source, message) {
  if (selectedId || (homeErrorSource && homeErrorSource !== source && source !== 'host')) return;
  if (turns.querySelector?.('.conversation-loading, .conversation-empty')) turns.replaceChildren();
  homeErrorSource = source; error.textContent = message; error.hidden = false;
  updateHomeInstallPrompt();
}
function clearHomeError(source) {
  if (homeErrorSource !== source) return;
  homeErrorSource = null; error.hidden = true; error.textContent = '';
  showConversationEmpty();
}
function element(tag, className, text) { const node = document.createElement(tag); node.className = className; node.textContent = text ?? ''; return node; }
function updateHomeInstallPrompt() {
  window.setInstallPromptPageEligible?.(!selectedId && !newDraft && connected && !homeErrorSource && error.hidden);
  window.setNotificationHomeEligible?.(!selectedId && !newDraft && connected && !homeErrorSource && error.hidden);
}
function showConversationEmpty() {
  updateHomeInstallPrompt();
  if (selectedId || !pairingAvailable || !connected || homeErrorSource || !error.hidden) return;
  turns.replaceChildren(element('div', 'conversation-empty', newDraft ? '发送第一条消息，开始新聊天' : '打开左上角任务面板，选择一个任务'));
}
function showConversationLoading(message = '正在连接') {
  const loading = element('div', 'conversation-loading', message);
  loading.setAttribute('role', 'status');
  turns.replaceChildren(loading);
}
function createDetailDrawer(title, backLabel, overlayClass = 'file-view-overlay') {
  const overlay = element('div', overlayClass);
  const panel = element('section', 'file-view-panel');
  const header = element('header', 'file-view-header');
  const back = element('button', 'file-view-back'); back.type = 'button'; back.setAttribute('aria-label', backLabel); back.title = '返回';
  back.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
  const sourceThread = selectedId;
  const summaryWasOpen = !summaryPanel.hidden;
  const summaryScroll = summaryPanel.scrollTop;
  const dismiss = () => {
    overlay.remove();
    if (summaryWasOpen && selectedId === sourceThread && !summaryPanel.hidden && Number.isFinite(summaryScroll)) summaryPanel.scrollTop = summaryScroll;
  };
  back.addEventListener('click', dismiss);
  overlay.addEventListener('click', event => { if (event.target === overlay) dismiss(); });
  header.append(back, element('strong', 'file-view-title', title));
  panel.append(header); overlay.append(panel); document.body.append(overlay);
  return panel;
}
function openFilePreview(path, threadId, turnId, itemId, index, linked = false) {
  const panel = createDetailDrawer(path.split(/[\\/]/).filter(Boolean).at(-1) || path, '返回');
  const content = element('pre', 'file-view-content', '加载中...');
  panel.append(content);
  void (async () => {
    try {
      const response = await scopedFetch(`/api/threads/${encodeURIComponent(threadId)}/file-preview`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(linked ? { turnId, itemId, path } : { turnId, itemId, index }) });
      if (!response.ok) throw new Error();
      const result = await response.json();
      if (panel.isConnected === false) return;
      if (typeof result.text !== 'string' || selectedId !== threadId) throw new Error();
      content.textContent = result.text;
    } catch { if (panel.isConnected !== false) content.textContent = '文件不可预览，可能已删除、不是文本或超过 512 KB'; }
  })();
}
function hasReasoningSummary(item) {
  return Array.isArray(item.summary) && item.summary.some(text => typeof text === 'string' && text.trim());
}
function renderAgentHistoryTurn(turn) {
  const row = element('article', 'turn');
  if (turn.status === 'interrupted' || turn.status === 'failed') row.append(element('div', 'turn-meta', turn.status === 'interrupted' ? '已中断' : '失败'));
  const items = Array.isArray(turn.items) ? turn.items : [];
  const finalIndex = turn.status === 'completed' ? items.findLastIndex(item => item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) : -1;
  let work = null;
  for (const [index, item] of items.entries()) {
    if (item.type === 'reasoning' && !hasReasoningSummary(item)) continue;
    const activity = ['reasoning', 'commandExecution', 'fileChange', 'mcpToolCall', 'subAgentActivity', 'collabAgentToolCall'].includes(item.type);
    if (activity && finalIndex >= 0 && index < finalIndex) {
      if (!work) { work = element('details', 'work-activity'); work.append(element('summary', 'work-title', '工作过程')); row.append(work); }
    } else work = null;
    const destination = work || row;
    if (item.type === 'agentMessage' && item.text) {
      const message = element('div', 'item assistant-message'); message.setAttribute('aria-label', 'Codex'); message.append(assistantContent(item.text)); destination.append(message);
    } else if (item.type === 'userMessage' && item.text) {
      const message = element('div', 'item user-message'); message.setAttribute('aria-label', '你'); message.append(element('p', 'item-text', item.text)); destination.append(message);
    } else if (item.type === 'reasoning' && Array.isArray(item.summary)) {
      const summary = item.summary.filter(text => typeof text === 'string' && text.trim()).join('\n');
      if (summary) { const details = element('details', 'thinking'); details.append(element('summary', 'thinking-title', '思考'), element('p', 'item-text thinking-content', summary)); destination.append(details); }
    } else if (item.type === 'commandExecution' && (item.command || item.output)) {
      const details = element('details', 'command-details');
      const labels = { inProgress: '正在运行命令', completed: '运行了命令', failed: '命令运行失败', declined: '命令已拒绝', interrupted: '命令已中断' };
      const heading = element('summary', 'command-title activity-command');
      heading.append(element('span', 'command-title-text', labels[item.status] || '命令'), activityIcon('command'));
      details.append(heading);
      if (item.command) details.append(element('pre', 'item-code', item.command));
      if (item.output) details.append(element('pre', 'item-code', item.output));
      destination.append(details);
    } else if (item.type === 'fileChange' && Array.isArray(item.changes)) {
      const paths = item.changes.map(change => typeof change?.path === 'string' ? change.path : '').filter(Boolean);
      if (paths.length) {
        const details = element('details', 'file-changes');
        const labels = { inProgress: '正在编辑', completed: '已编辑', failed: '编辑失败', declined: '编辑已拒绝', interrupted: '编辑已中断' };
        const heading = element('summary', 'file-changes-title', `${labels[item.status] || '文件变更'} ${paths.length === 1 ? paths[0].split(/[\\/]/).filter(Boolean).at(-1) : `${paths.length} 个文件`}`);
        heading.append(activityIcon('edit')); details.append(heading);
        for (const change of item.changes) {
          if (typeof change?.path !== 'string' || !change.path) continue;
          details.append(element('div', 'file-change-path', change.path));
          if (typeof change.diff === 'string' && change.diff) {
            const diff = element('details', 'file-diff-details');
            diff.append(element('summary', 'file-diff-title', '查看差异'), element('pre', 'file-change-diff', change.diff.slice(0, 200000)));
            details.append(diff);
          }
        }
        destination.append(details);
      }
    } else if (item.type === 'mcpToolCall') {
      const name = [item.server, item.tool].filter(value => typeof value === 'string' && value).join(' · ');
      const labels = { inProgress: '正在调用', completed: '已调用', failed: '调用失败', declined: '调用已拒绝', interrupted: '调用已中断' };
      if (name) { const line = element('div', 'activity-line', `${labels[item.status] || '工具'} ${name}`); line.append(activityIcon('tool')); destination.append(line); }
    } else if (item.type === 'subAgentActivity' || item.type === 'collabAgentToolCall') {
      const labels = { started: '开始工作', interacted: '已更新', completed: '已完成', inProgress: '进行中', interrupted: '已中断', failed: '失败', declined: '已拒绝' };
      const names = item.type === 'subAgentActivity' ? [item.agentPath] : (item.agents || []).map(agent => agent.id);
      const name = names.filter(value => typeof value === 'string' && value).map(value => value.split('/').filter(Boolean).at(-1)).join('、') || '子智能体';
      const line = element('div', 'activity-line', `${name} · ${labels[item.kind || item.status] || '活动'}`);
      line.append(activityIcon('agent')); destination.append(line);
    }
  }
  return row;
}
function openAgentHistory(name, threadId, agentId) {
  const panel = createDetailDrawer(name, '返回');
  const content = element('div', 'agent-view-content', '加载中...');
  panel.append(content);
  void (async () => {
    try {
      const response = await scopedFetch(`/api/threads/${encodeURIComponent(threadId)}/agents/${encodeURIComponent(agentId)}/history`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error();
      const result = await response.json();
      if (panel.isConnected === false) return;
      if (result.id !== agentId || !Array.isArray(result.turns) || selectedId !== threadId) throw new Error();
      content.replaceChildren(element('p', 'agent-history-note', '已记录的内容，非实时'));
      for (const turn of result.turns) { const row = renderAgentHistoryTurn(turn); if (row.childNodes.length) content.append(row); }
      if (content.childNodes.length === 1) content.append(element('p', 'agent-history-note', '暂无可显示的记录'));
    } catch { if (panel.isConnected !== false) content.textContent = '子智能体记录暂不可用'; }
  })();
}
function assistantContent(text, fileContext) {
  const node = element('div', 'item-text markdown', '');
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') { node.textContent = text; return node; }
  try {
    node.innerHTML = DOMPurify.sanitize(marked.parse(text), {
      ALLOWED_TAGS: ['p', 'br', 'hr', 'pre', 'code', 'ul', 'ol', 'li', 'strong', 'em', 'del', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a'],
      ALLOWED_ATTR: ['href', 'title'],
    });
    for (const link of node.querySelectorAll('a')) {
      const href = link.getAttribute('href') || '';
      if (href.startsWith('/') && !href.startsWith('//') && fileContext) {
        let path; try { path = decodeURIComponent(href); } catch { link.removeAttribute('href'); continue; }
        if (path.includes('\0')) { link.removeAttribute('href'); continue; }
        const button = element('button', 'message-file-link', link.textContent || path.split('/').at(-1));
        button.type = 'button'; button.title = path;
        button.addEventListener('click', () => openFilePreview(path, fileContext.threadId, fileContext.turnId, fileContext.itemId, null, true));
        link.replaceWith(button);
      }
      else if (!/^https?:\/\//i.test(href)) { link.removeAttribute('href'); if (href.startsWith('/')) { link.title = '当前消息无法预览本机文件'; link.append('（暂不可预览）'); } }
      else { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    }
  } catch { node.textContent = text; }
  return node;
}
function questionBodyWithoutLabels(text, questions) {
  // Only remove standalone copies of the form's labels. Keep explanatory
  // prose, and keep code blocks even when a line matches an option.
  const labelText = value => {
    let result = String(value || '').trim().replace(/^#{1,6}\s+/, '').replace(/^(?:[-+*]|\d+[.)、])\s+/, '').trim();
    const wrapped = /^(\*\*|__|`)([\s\S]*?)\1$/.exec(result);
    if (wrapped) result = wrapped[2].trim();
    return result.replace(/\s+/g, ' ');
  };
  const lines = String(text || '').split(/\r?\n/), protectedLines = [], removed = new Set();
  let fence = null;
  for (const line of lines) {
    const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1];
    protectedLines.push(Boolean(fence) || Boolean(marker) || /^(?: {4}|\t)/.test(line));
    if (marker) { if (!fence) fence = marker; else if (fence[0] === marker[0] && marker.length >= fence.length && line.trim() === marker) fence = null; }
  }
  for (let start = 0; start < lines.length; start++) {
    if (removed.has(start) || protectedLines[start] || !lines[start].trim()) continue;
    for (const question of questions) {
      const title = labelText(question.question), spans = new Set([1, String(question.question || '').trim().split(/\r?\n/).length]);
      let end = null;
      for (const span of spans) if (start + span <= lines.length && !protectedLines.slice(start, start + span).some(Boolean) && labelText(lines.slice(start, start + span).join('\n')) === title) { end = start + span; break; }
      if (end === null) continue;
      const options = question.options || [];
      let cursor = end, complete = true;
      for (const option of options) {
        while (cursor < lines.length && !lines[cursor].trim()) cursor++;
        if (cursor >= lines.length || protectedLines[cursor] || labelText(lines[cursor]) !== labelText(option)) { complete = false; break; }
        cursor++;
      }
      // A title followed by the complete ordered option list proves a duplicate
      // form block. Isolated option words elsewhere may be real explanation.
      const titleOnly = labelText(String(text || '')) === title;
      const isolatedTitle = !options.length && (!lines[start - 1]?.trim()) && (!lines[end]?.trim());
      if (!complete && !titleOnly) continue;
      if (!options.length && !titleOnly && !isolatedTitle) continue;
      for (let index = start; index < (complete && options.length ? cursor : end); index++) removed.add(index);
      break;
    }
  }
  return lines.filter((line, index) => !removed.has(index)).join('\n').trim();
}
function answeredQuestionIds(turns, questionLookup) {
  const counts = new Map(), replies = new Set();
  for (const [t, turn] of turns.entries()) for (const [i, item] of (turn.items || []).entries()) {
    if (item.type === 'agentMessage') for (const question of item.questions || []) {
      if (typeof question.id === 'string' && question.id) {
        counts.set(question.id, (counts.get(question.id) || 0) + 1);
        questionLookup?.set(question.id, counts.get(question.id) === 1 ? { question, t, i } : null);
      }
    }
    if (item.type === 'userMessage' && Array.isArray(item.questionReplyIds)) for (const id of item.questionReplyIds) if (typeof id === 'string' && id) replies.add(id);
  }
  return new Set([...replies].filter(id => counts.get(id) === 1));
}
function questionReplyParts(turns, turnIndex, itemIndex, text, replyIds, questionLookup) {
  if (typeof text !== 'string') return null;
  if (replyIds !== undefined) {
    if (!Array.isArray(replyIds) || replyIds.length !== 1 || typeof replyIds[0] !== 'string' || !replyIds[0]) return null;
    const matches = questionLookup ? [questionLookup.get(replyIds[0])].filter(Boolean) : [];
    if (!questionLookup) for (const [t, turn] of turns.entries()) for (const [i, item] of (turn.items || []).entries()) {
      if (item?.type === 'agentMessage') for (const question of item.questions || []) if (question.id === replyIds[0]) matches.push({ question, t, i });
    }
    if (matches.length !== 1 || matches[0].t > turnIndex || (matches[0].t === turnIndex && matches[0].i >= itemIndex)) return null;
    const question = matches[0].question.question;
    if (typeof question !== 'string' || !question || !text.startsWith(`${question}\n`)) return null;
    const answer = text.slice(question.length + 1);
    return answer.trim() ? { question, answer } : null;
  }
  for (let t = turnIndex; t >= 0; t--) {
    const items = turns[t]?.items || [];
    for (let i = t === turnIndex ? itemIndex - 1 : items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item?.type === 'userMessage') return null;
      if (item?.type !== 'agentMessage' || !item.questions?.length) continue;
      if (item.questions.length !== 1) return null;
      const question = item.questions[0]?.question;
      if (typeof question !== 'string' || !question || !text.startsWith(`${question}\n`)) return null;
      const answer = text.slice(question.length + 1);
      return answer.trim() ? { question, answer } : null;
    }
  }
  return null;
}
async function loadDevices() {
  const generation = ++deviceLoadGeneration;
  try {
    const response = await fetch('/api/devices', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) return false;
    const data = await response.json();
    if (generation !== deviceLoadGeneration) return false;
    if (!Array.isArray(data.devices)) return false;
    if (!data.devices.length) { if (historyScope) invalidateDeviceState(); showUnpaired(); return true; }
    const current = data.devices.find(item => item.deviceId === data.currentDeviceId);
    if (current && uuid.test(current.hostId || '') && uuid.test(current.deviceId || '')) {
      if (historyScope && (historyScope.hostId !== current.hostId || historyScope.deviceId !== current.deviceId)) invalidateDeviceState();
      historyScope = { hostId: current.hostId, deviceId: current.deviceId };
    } else invalidateDeviceState();
    currentDeviceId = current?.deviceId || null;
    window.setNotificationContext?.(current ? { hostId: current.hostId, deviceId: current.deviceId } : null);
    if (historyScope && deviceConversationDrafts.has(currentDeviceId)) {
      const saved = deviceConversationDrafts.get(currentDeviceId); deviceConversationDrafts.delete(currentDeviceId);
      savedNewDraft = saved.savedCreation;
      for (const [id, text] of saved.text) drafts.set(id, text);
      for (const [id, images] of saved.images) imageDrafts.set(id, images);
      for (const [id, change] of saved.models) modelChanges.set(id, change);
      for (const [id, change] of saved.modes) modeChanges.set(id, change);
      for (const [id, change] of saved.pendingModels) pendingModelChanges.set(id, change);
      for (const [id, target] of saved.pendingModes) pendingModeChanges.set(id, target);
      for (const [id, stop] of saved.stops) stops.set(id, stop);
    }
    if (historyScope && deviceSubmissionGuards.has(currentDeviceId)) {
      for (const [id, state] of deviceSubmissionGuards.get(currentDeviceId)) submissions.set(id, state);
      deviceSubmissionGuards.delete(currentDeviceId);
    }
    if (historyScope && !newDraft && deviceCreationDrafts.has(currentDeviceId)) {
      newDraft = deviceCreationDrafts.get(currentDeviceId); deviceCreationDrafts.delete(currentDeviceId);
      messageInput.value = newDraft.text || ''; newProjectBar.hidden = false;
      renderNewModels(); updateComposer(); void loadNewModels(newDraft, currentDeviceId);
    }
    if (currentDeviceId && selectedId && recoveryStream?.threadId === selectedId && !recoveryStream.controller.signal.aborted && !recoveryChecks.has(recoveryKey(currentDeviceId, selectedId))) void checkRecoveryStatus(selectedId, currentDeviceId, recoveryStream);
    deviceCurrent.textContent = current?.name || '选择电脑';
    deviceCurrent.append(chevronIcon());
    const rows = [];
    const byHost = new Map();
    for (const device of data.devices) {
      if (!uuid.test(device.deviceId)) continue;
      const key = uuid.test(device.hostId || '') ? device.hostId : device.deviceId;
      if (!byHost.has(key) || device.deviceId === data.currentDeviceId) byHost.set(key, device);
    }
    for (const device of byHost.values()) {
      const row = element('div', 'device-row');
      const choose = element('button', 'device-choice', device.name || '电脑');
      choose.type = 'button'; choose.setAttribute('aria-current', String(device.deviceId === data.currentDeviceId));
      choose.addEventListener('click', async () => {
        if (device.deviceId === data.currentDeviceId) { deviceMenu.open = false; return; }
        if (newDraft?.pending || newDraft?.uncertain || newDraft?.prepared) { sendStatus.textContent = '请先处理当前发送'; return; }
        if ([...submissions.values()].some(item => item.pending || item.uncertain)) { sendStatus.textContent = '请先确认当前发送结果'; return; }
        choose.disabled = true;
        try {
          const result = await fetch('/api/devices/select', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: device.deviceId }) });
          if (!result.ok) throw new Error('切换电脑失败');
          invalidateDeviceState(); deviceChannel?.postMessage({ type: 'device-changed' });
          deviceMenu.open = false; await startPairedHome();
        } catch { fail('切换电脑失败'); } finally { choose.disabled = false; }
      });
      const remove = element('button', 'device-remove', '移除配对');
      remove.type = 'button'; remove.title = '移除此配对'; remove.setAttribute('aria-label', `移除 ${device.name || '电脑'} 的配对`);
      remove.addEventListener('click', async () => {
        if (newDraft?.pending || newDraft?.uncertain || newDraft?.prepared) { sendStatus.textContent = '请先处理当前发送'; return; }
        if ([...submissions.values()].some(item => item.pending || item.uncertain)) { sendStatus.textContent = '请先确认当前发送结果'; return; }
        remove.disabled = true;
        try {
          const result = await fetch('/api/devices/remove', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: device.deviceId }) });
          if (!result.ok) throw new Error('移除失败');
          deviceChannel?.postMessage({ type: 'device-changed' });
          await startPairedHome({ preserveDeviceState: true });
        } catch { fail('移除电脑失败'); } finally { remove.disabled = false; }
      });
      row.append(choose, remove); rows.push(row);
    }
    deviceList.replaceChildren(...rows); deviceMenu.hidden = false;
    return true;
  } catch { return false; /* Local development mode has no device endpoint. */ }
}
const liveTaskStatus = new Map();
const projectStatusGroups = new Map();
let projectStatusCursor = 0;
let sidebarEvents, sidebarWatchdog, sidebarEventGeneration = 0, sidebarStatusSnapshot = null;
function taskStatusIsActive(state) {
  return ['active', 'inProgress', 'running', 'busy', 'processing'].includes(state);
}
function setTaskIndicator(marker, state) {
  if (!marker) return;
  if (state === 'checking') {
    marker.hidden = false;
    marker.dataset.status = 'checking';
    marker.className = 'task-active task-status-checking';
    marker.title = '状态更新中';
    marker.setAttribute('aria-label', '状态更新中');
    return;
  }
  const active = taskStatusIsActive(state);
  marker.hidden = !active;
  marker.dataset.status = active ? 'active' : 'idle';
  marker.className = 'task-active';
  marker.title = active ? '进行中' : '';
  marker.setAttribute('aria-label', active ? '进行中' : '');
}
function applySidebarStatuses() {
  for (const task of projectList.querySelectorAll?.('.task') || []) {
    const marker = task.querySelector?.('.task-active');
    const observed = sidebarStatusSnapshot?.get(task.dataset.id) ?? task.dataset.status;
    setTaskIndicator(marker, liveTaskStatus.get(task.dataset.id) === 'active' ? 'active' : statusHandovers.has(task.dataset.id) ? 'checking' : observed);
  }
  applyProjectStatuses();
}
function applyProjectStatuses() {
  for (const [key, { tasks, indicator }] of projectStatusGroups) {
    const states = tasks.map(task => liveTaskStatus.get(task.id) === 'active' ? 'active' : statusHandovers.has(task.id) ? 'checking' : sidebarStatusSnapshot?.get(task.id) ?? task.status?.type ?? task.status ?? 'unknown');
    const state = !groupExpanded.get(key) && states.some(taskStatusIsActive) ? 'active' : 'idle';
    setTaskIndicator(indicator, state);
    indicator.className += ' project-status';
    indicator.title = state === 'active' ? '目录内有任务进行中' : state === 'checking' ? '目录任务状态更新中' : '';
    indicator.setAttribute('aria-label', indicator.title);
  }
  refreshTaskNotificationIndicators();
}
function invalidateProjectStatuses() {
  for (const group of projectStatusGroups.values()) for (const task of group.tasks) task.status = 'unknown';
}
function acceptSidebarStatuses(value) {
  // The observer also retains running tasks outside the visible slots.
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 1024 || Object.entries(value).some(([id, state]) => !uuid.test(id) || !['active', 'idle', 'unknown'].includes(state))) return;
  sidebarStatusSnapshot = new Map(Object.entries(value));
  for (const [id, state] of sidebarStatusSnapshot) if (state === 'active' || state === 'idle') clearStatusHandover(id);
  for (const task of projectList.querySelectorAll?.('.task') || []) {
    const state = sidebarStatusSnapshot.get(task.dataset.id);
    if (state) task.dataset.status = state;
  }
  for (const group of projectStatusGroups.values()) for (const task of group.tasks) task.status = value[task.id] ?? (liveTaskStatus.get(task.id) === 'active' ? 'active' : 'unknown');
  applySidebarStatuses();
}
function stopSidebarStatuses() {
  ++sidebarEventGeneration; clearTimeout(sidebarWatchdog); sidebarEvents?.abort(); sidebarEvents = undefined;
  sidebarStatusSnapshot = new Map();
  invalidateProjectStatuses();
  applySidebarStatuses();
}
function connectSidebarStatuses({ allowSelected = false, attempt = 0 } = {}) {
  stopSidebarStatuses();
  if (!historyScope || (selectedId && !allowSelected) || document.hidden === true || pageSuspended) return;
  const generation = sidebarEventGeneration, scopeGeneration = historyScopeGeneration, selectedAtOpen = selectedId;
  const controller = sidebarEvents = new AbortController();
  let retryAttempt = attempt;
  const isCurrent = () => generation === sidebarEventGeneration && scopeGeneration === historyScopeGeneration && sidebarEvents === controller && !controller.signal.aborted && selectedId === selectedAtOpen;
  const reconnect = () => { if (isCurrent()) connectSidebarStatuses({ allowSelected, attempt: retryAttempt + 1 }); };
  const arm = () => { clearTimeout(sidebarWatchdog); sidebarWatchdog = setTimeout(reconnect, 45000); sidebarWatchdog?.unref?.(); };
  const handle = block => {
    let type = '', data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (type === 'sidebar-status') {
      let value; try { value = JSON.parse(data.join('\n')); } catch { return; }
      acceptSidebarStatuses(value);
    } else if (type === 'thread-list-changed') refreshChangedThreadList();
    else if (type !== 'sidebar-heartbeat') return;
    retryAttempt = 0; arm();
  };
  arm();
  void (async () => {
    let reader;
    const cancelReader = () => { void reader?.cancel().catch(() => {}); };
    controller.signal.addEventListener('abort', cancelReader, { once: true });
    try {
      const response = await scopedFetch('/api/sidebar/events', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!isCurrent()) { void response.body?.cancel(); return; }
      if (!response.ok || !response.body) throw new Error('unavailable');
      reader = response.body.getReader();
      const decoder = new TextDecoder(); let pending = '';
      while (isCurrent()) {
        const { value, done } = await reader.read();
        if (!isCurrent()) return;
        if (done) throw new Error('closed');
        const chunk = decoder.decode(value, { stream: true });
        if (pending.endsWith('\r') && chunk.startsWith('\n')) pending = pending.slice(0, -1);
        pending += chunk.replace(/\r\n/g, '\n');
        if (pending.length > 256 * 1024) throw new Error('oversized');
        let end;
        while ((end = pending.indexOf('\n\n')) !== -1) {
          if (!isCurrent()) return;
          const block = pending.slice(0, end); pending = pending.slice(end + 2); handle(block);
        }
      }
    } catch {
      if (!isCurrent()) return;
      sidebarStatusSnapshot = new Map(); invalidateProjectStatuses(); applySidebarStatuses(); clearTimeout(sidebarWatchdog);
      sidebarWatchdog = setTimeout(reconnect, Math.min(30000, 1000 * 2 ** Math.min(retryAttempt, 5))); sidebarWatchdog?.unref?.();
    } finally {
      controller.signal.removeEventListener('abort', cancelReader);
      if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock?.(); }
    }
  })();
}
const statusHandovers = new Map();
function clearStatusHandover(id) {
  const timer = statusHandovers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  statusHandovers.delete(id);
}
function beginStatusHandover(id) {
  if (liveTaskStatus.get(id) !== 'active') { updateLiveTaskStatus(id, 'unknown'); return; }
  liveTaskStatus.delete(id);
  clearStatusHandover(id);
  sidebarStatusSnapshot?.delete(id);
  for (const task of projectList.querySelectorAll('.task')) {
    if (task.dataset.id !== id) continue;
    task.dataset.status = 'unknown';
    setTaskIndicator(task.querySelector?.('.task-active'), 'checking');
  }
  const timer = setTimeout(() => { statusHandovers.delete(id); updateLiveTaskStatus(id, 'unknown'); }, 30000);
  timer?.unref?.(); statusHandovers.set(id, timer);
  applyProjectStatuses();
}
function chevronIcon() {
  const icon = element('span', 'chevron-icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
  return icon;
}
function updateLiveTaskStatus(id, status) {
  if (!id) return;
  clearStatusHandover(id);
  if (taskStatusIsActive(status)) liveTaskStatus.set(id, 'active'); else liveTaskStatus.delete(id);
  for (const task of projectList.querySelectorAll('.task')) {
    if (task.dataset.id !== id) continue;
    task.dataset.status = taskStatusIsActive(status) ? 'active' : status === 'idle' ? 'idle' : 'unknown';
    const marker = task.querySelector?.('.task-active');
    setTaskIndicator(marker, taskStatusIsActive(status) || taskStatusIsActive(sidebarStatusSnapshot?.get(id)) ? 'active' : 'idle');
  }
  for (const group of projectStatusGroups.values()) for (const task of group.tasks) if (task.id === id) task.status = taskStatusIsActive(status) ? 'active' : status === 'idle' ? 'idle' : 'unknown';
  applyProjectStatuses();
}
// These reminders are local notification events, not native desktop unread state.
const taskNotifications = new Map();
const taskNotificationEvents = new Set();
const clearedTaskNotificationEvents = new Set();
const pendingTaskNotifications = new Map();
const taskNotificationWatermarks = new Map();
const taskNotificationReceipts = new Map();
const validNotificationTime = value => Number.isSafeInteger(value) && value >= 0;
function rememberTaskNotificationTime(notification) {
  if (!validNotificationTime(notification.createdAt)) return;
  const id = notification.threadId;
  taskNotificationWatermarks.set(id, Math.max(taskNotificationWatermarks.get(id) ?? 0, notification.createdAt));
  if (taskNotificationWatermarks.size > 512) taskNotificationWatermarks.delete(taskNotificationWatermarks.keys().next().value);
}
function trackTaskNotificationReceipt(notification, operation) {
  const generation = historyScopeGeneration, pair = { ...historyScope };
  const key = JSON.stringify([notification.threadId, notification.eventId]);
  const receipt = Promise.resolve(operation).then(result => result !== false && result?.ignored !== true && generation === historyScopeGeneration && historyScope?.hostId === pair.hostId && historyScope?.deviceId === pair.deviceId, () => false);
  taskNotificationReceipts.set(key, receipt);
  if (taskNotificationReceipts.size > 2048) taskNotificationReceipts.delete(taskNotificationReceipts.keys().next().value);
  return receipt;
}
const taskNotificationVersions = new Map();
let lastTaskNotificationListComplete = false;
let taskNotificationListGeneration = 0;
function touchTaskNotification(id) { taskNotificationVersions.set(id, (taskNotificationVersions.get(id) || 0) + 1); }
function persistTaskNotification(notification) {
  const pair = { ...historyScope }, generation = historyScopeGeneration;
  return trackTaskNotificationReceipt(notification, (async () => {
    const result = await window.taskReminderStore.put(pair, notification);
    let suppressed = result?.stale === true || result?.ignored === true;
    if (result?.duplicate === true && window.taskReminderStore.inspectEvent) {
      const inspected = await window.taskReminderStore.inspectEvent(pair, notification);
      suppressed ||= inspected.status === 'inactive' || inspected.status === 'stale' || (inspected.status === 'seen' && inspected.stored === false);
    }
    if (suppressed && generation === historyScopeGeneration && historyScope?.hostId === pair.hostId && historyScope?.deviceId === pair.deviceId && taskNotifications.get(notification.threadId)?.eventId === notification.eventId) {
      taskNotifications.delete(notification.threadId); touchTaskNotification(notification.threadId); refreshTaskNotificationIndicators();
      void window.restoreTaskReminders?.();
    }
    return result;
  })());
}
const taskNotificationLabels = { completed: '任务已完成', question: '任务需要回答', approval: '任务等待审批' };
const taskNotificationSymbols = { completed: '', question: '待回答', approval: '待审批' };
function renderTaskNotification(marker, notification, state = 'idle') {
  if (!marker) return;
  marker.hidden = !notification || (notification.kind === 'completed' && (taskStatusIsActive(state) || state === 'checking'));
  marker.dataset.kind = notification?.kind || '';
  marker.textContent = notification ? taskNotificationSymbols[notification.kind] : '';
  marker.title = notification ? taskNotificationLabels[notification.kind] : '';
  marker.setAttribute('aria-label', notification ? notification.kind === 'completed' ? '有新提醒，任务已完成' : taskNotificationSymbols[notification.kind] : '');
}
function refreshTaskNotificationIndicators(prune = false) {
  const known = new Set([...projectStatusGroups.values()].flatMap(group => group.tasks.map(task => task.id)));
  if (prune) for (const id of taskNotifications.keys()) if (!known.has(id) && !pendingTaskNotifications.has(id)) {
    taskNotifications.delete(id); touchTaskNotification(id);
    if (historyScope) void window.taskReminderStore?.remove(historyScope, id)?.catch(() => {});
  }
  for (const task of projectList.querySelectorAll('.task')) {
    const id = task.dataset.id, notification = taskNotifications.get(id);
    const state = liveTaskStatus.get(id) === 'active' ? 'active' : statusHandovers.has(id) ? 'checking' : sidebarStatusSnapshot?.get(id) ?? task.dataset.status;
    renderTaskNotification(task.querySelector?.('.task-notification'), notification, state);
    setTaskIndicator(task.querySelector?.('.task-active'), notification && notification.kind !== 'completed' ? 'idle' : state);
  }
  for (const [key, group] of projectStatusGroups) {
    const notices = group.tasks.map(task => taskNotifications.get(task.id)).filter(Boolean);
    const questions = notices.filter(item => item.kind === 'question').length;
    const approvals = notices.filter(item => item.kind === 'approval').length;
    const states = group.tasks.map(task => liveTaskStatus.get(task.id) === 'active' ? 'active' : statusHandovers.has(task.id) ? 'checking' : sidebarStatusSnapshot?.get(task.id) ?? task.status?.type ?? task.status ?? 'unknown');
    const folded = !groupExpanded.get(key), busy = states.some(state => taskStatusIsActive(state) || state === 'checking');
    const count = notices.length;
    if (!group.notificationIndicator) continue;
    group.notificationIndicator.hidden = !count || !folded || (busy && !questions && !approvals);
    group.notificationIndicator.textContent = questions || approvals ? [questions ? `待回答${questions > 1 ? ` ${questions}` : ''}` : '', approvals ? `待审批${approvals > 1 ? ` ${approvals}` : ''}` : ''].filter(Boolean).join(' · ') : count ? String(count) : '';
    group.notificationIndicator.title = questions || approvals ? '目录内有待处理提醒' : `${count} 个任务有提醒`;
    group.notificationIndicator.setAttribute('aria-label', group.notificationIndicator.title);
    const state = folded && busy && !questions && !approvals ? states.some(taskStatusIsActive) ? 'active' : 'checking' : 'idle';
    setTaskIndicator(group.indicator, state);
    group.indicator.className += ' project-status';
    group.indicator.title = state === 'active' ? '目录内有任务进行中' : state === 'checking' ? '目录任务状态更新中' : '';
    group.indicator.setAttribute('aria-label', group.indicator.title);
  }
  const count = [...taskNotifications.keys()].filter(id => known.has(id)).length;
  const entry = document.querySelector('#open-sidebar');
  if (!entry?.querySelector || !entry?.append) return;
  let marker = entry.querySelector('.sidebar-notification');
  if (!marker) { marker = element('span', 'task-notification sidebar-notification'); marker.setAttribute('aria-hidden', 'true'); entry.append(marker); }
  marker.hidden = !count; marker.textContent = count > 9 ? '9+' : String(count);
  entry.setAttribute('aria-label', count ? `打开侧栏，${count} 个任务有提醒` : '打开侧栏');
  entry.title = count ? `${count} 个任务有提醒` : '打开侧栏';
}
function clearTaskNotification(id, force = false) {
  touchTaskNotification(id);
  const changed = taskNotifications.delete(id);
  if ((changed || force) && historyScope) void window.taskReminderStore?.remove(historyScope, id)?.catch(() => {});
  if (changed) refreshTaskNotificationIndicators();
}
function clearTaskNotifications() { taskNotifications.clear(); taskNotificationEvents.clear(); clearedTaskNotificationEvents.clear(); pendingTaskNotifications.clear(); taskNotificationWatermarks.clear(); taskNotificationReceipts.clear(); taskNotificationVersions.clear(); lastTaskNotificationListComplete = false; refreshTaskNotificationIndicators(); }
window.clearTaskNotificationEvent = async notification => {
  if (!notification || !historyScope || historyScope.hostId !== notification.hostId || historyScope.deviceId !== notification.deviceId || !uuid.test(notification.threadId || '') || typeof notification.eventId !== 'string' || !notification.eventId || notification.eventId.length > 512) return false;
  const pair = { ...historyScope }, generation = historyScopeGeneration;
  const key = JSON.stringify([notification.threadId, notification.eventId]);
  clearedTaskNotificationEvents.add(key);
  if (clearedTaskNotificationEvents.size > 2048) clearedTaskNotificationEvents.delete(clearedTaskNotificationEvents.values().next().value);
  taskNotificationEvents.add(notification.eventId);
  if (taskNotificationEvents.size > 2048) taskNotificationEvents.delete(taskNotificationEvents.values().next().value);
  rememberTaskNotificationTime(notification);
  touchTaskNotification(notification.threadId);
  const current = taskNotifications.get(notification.threadId);
  const changed = current?.eventId === notification.eventId || (validNotificationTime(current?.createdAt) && validNotificationTime(notification.createdAt) && current.createdAt < notification.createdAt);
  if (changed) taskNotifications.delete(notification.threadId);
  if (pendingTaskNotifications.get(notification.threadId)?.notification.eventId === notification.eventId) pendingTaskNotifications.delete(notification.threadId);
  else {
    const pending = pendingTaskNotifications.get(notification.threadId);
    if (pending) pending.version = taskNotificationVersions.get(notification.threadId);
  }
  if (changed) refreshTaskNotificationIndicators();
  if (!window.taskReminderStore?.removeEvent) return false;
  try { const result = await window.taskReminderStore.removeEvent(pair, { threadId: notification.threadId, eventId: notification.eventId, ...(validNotificationTime(notification.createdAt) ? { createdAt: notification.createdAt } : {}) }); if (result === false || result?.ignored === true) return false; } catch { return false; }
  return generation === historyScopeGeneration && historyScope?.hostId === pair.hostId && historyScope?.deviceId === pair.deviceId;
};
window.getNotificationThreadId = () => newDraft ? null : selectedId;
function applyTaskNotification(notification, restored = false) {
  if (!notification || !historyScope || historyScope.hostId !== notification.hostId || historyScope.deviceId !== notification.deviceId || !uuid.test(notification.threadId || '') || !Object.hasOwn(taskNotificationLabels, notification.kind) || typeof notification.eventId !== 'string' || !notification.eventId || notification.eventId.length > 512) return false;
  const latest = taskNotificationWatermarks.get(notification.threadId);
  if (latest !== undefined && (!validNotificationTime(notification.createdAt) || notification.createdAt < latest)) return true;
  rememberTaskNotificationTime(notification);
  if (clearedTaskNotificationEvents.has(JSON.stringify([notification.threadId, notification.eventId]))) return true;
  if (![...projectStatusGroups.values()].some(group => group.tasks.some(task => task.id === notification.threadId))) {
    if (pendingTaskNotifications.get(notification.threadId)?.notification.eventId === notification.eventId) return true;
    if (!restored) touchTaskNotification(notification.threadId);
    pendingTaskNotifications.delete(notification.threadId);
    pendingTaskNotifications.set(notification.threadId, { generation: historyScopeGeneration, version: taskNotificationVersions.get(notification.threadId) || 0, restored, notification: { hostId: notification.hostId, deviceId: notification.deviceId, threadId: notification.threadId, eventId: notification.eventId, kind: notification.kind, ...(validNotificationTime(notification.createdAt) ? { createdAt: notification.createdAt } : {}) } });
    if (pendingTaskNotifications.size > 32) pendingTaskNotifications.delete(pendingTaskNotifications.keys().next().value);
    refreshChangedThreadList();
    return true;
  }
  const seen = taskNotificationEvents.has(notification.eventId);
  if (!seen) { taskNotificationEvents.add(notification.eventId); if (taskNotificationEvents.size > 2048) taskNotificationEvents.delete(taskNotificationEvents.values().next().value); }
  if (document.hidden !== true && !pageSuspended && !newDraft && selectedId === notification.threadId) {
    // A push for this exact event may already be in flight before the page's
    // foreground presence reaches the server. Remember the receipt even when
    // there was no stored reminder yet, so it cannot reappear after we read it.
    trackTaskNotificationReceipt(notification, window.clearTaskNotificationEvent(notification));
    clearTaskNotification(notification.threadId, true);
    return true;
  }
  if (seen) return true;
  if (!restored) touchTaskNotification(notification.threadId);
  taskNotifications.set(notification.threadId, { kind: notification.kind, eventId: notification.eventId, ...(validNotificationTime(notification.createdAt) ? { createdAt: notification.createdAt } : {}) });
  if (window.taskReminderStore?.put) persistTaskNotification(notification);
  refreshTaskNotificationIndicators();
  return true;
}
window.acceptTaskNotification = notification => applyTaskNotification(notification);
// An SSE write is only delivery after this exact event has a durable receipt.
window.taskNotificationReceipt = async notification => {
  const pair = historyScope && { ...historyScope }, generation = historyScopeGeneration;
  if (!notification || !pair || notification.hostId !== pair.hostId || notification.deviceId !== pair.deviceId) return false;
  if (window.taskReminderStore?.inspectEvent) {
    let inspected;
    try { inspected = await window.taskReminderStore.inspectEvent(pair, notification); } catch { return false; }
    if (generation !== historyScopeGeneration || historyScope?.hostId !== pair.hostId || historyScope?.deviceId !== pair.deviceId || inspected.status === 'inactive') return false;
    if (inspected.status === 'stale' || (inspected.status === 'seen' && inspected.stored === false)) return trackTaskNotificationReceipt(notification, window.clearTaskNotificationEvent(notification));
  }
  if (!applyTaskNotification(notification)) return false;
  if (pendingTaskNotifications.get(notification.threadId)?.notification.eventId === notification.eventId) return false;
  const key = JSON.stringify([notification.threadId, notification.eventId]);
  if (taskNotificationReceipts.has(key)) return taskNotificationReceipts.get(key);
  if (taskNotifications.get(notification.threadId)?.eventId === notification.eventId && window.taskReminderStore?.put) return persistTaskNotification(notification);
  if (!window.taskReminderStore?.removeEvent) return false;
  return trackTaskNotificationReceipt(notification, window.clearTaskNotificationEvent(notification));
};
function drainPendingTaskNotifications() {
  const known = new Set([...projectStatusGroups.values()].flatMap(group => group.tasks.map(task => task.id)));
  for (const [id, entry] of pendingTaskNotifications) {
    if (entry.generation !== historyScopeGeneration || historyScope?.hostId !== entry.notification.hostId || historyScope?.deviceId !== entry.notification.deviceId || entry.version !== (taskNotificationVersions.get(id) || 0)) { pendingTaskNotifications.delete(id); continue; }
    if (known.has(id)) { pendingTaskNotifications.delete(id); applyTaskNotification(entry.notification, entry.restored); }
  }
}
window.restoreTaskReminders = async () => {
  if (!historyScope || !window.taskReminderStore) return;
  const pair = { ...historyScope }, generation = historyScopeGeneration, versions = new Map(taskNotificationVersions);
  const listGeneration = taskNotificationListGeneration;
  const complete = lastTaskNotificationListComplete;
  const known = new Set([...projectStatusGroups.values()].flatMap(group => group.tasks.map(task => task.id)));
  let notifications;
  try { notifications = await window.taskReminderStore.list(pair); } catch { return; }
  if (generation !== historyScopeGeneration || listGeneration !== taskNotificationListGeneration || historyScope?.hostId !== pair.hostId || historyScope?.deviceId !== pair.deviceId || !Array.isArray(notifications)) return;
  for (const notification of notifications) {
    if (!uuid.test(notification?.threadId || '') || (versions.get(notification.threadId) || 0) !== (taskNotificationVersions.get(notification.threadId) || 0)) continue;
    if (complete && !known.has(notification.threadId) && !pendingTaskNotifications.has(notification.threadId)) {
      touchTaskNotification(notification.threadId);
      void window.taskReminderStore.remove(pair, notification.threadId)?.catch(() => {});
    } else applyTaskNotification({ ...notification, ...pair }, true);
  }
};
function renderTask(task) {
  if (!task || !uuid.test(task.id)) return null;
  const button = element('button', 'task', '');
  button.type = 'button';
  button.dataset.id = task.id;
  button.dataset.status = task.status?.type || task.status || 'unknown';
  // A confirmed list result completes the handover; its old deadline must not
  // hide the status that this replacement row just received.
  if (taskStatusIsActive(button.dataset.status) || button.dataset.status === 'idle') clearStatusHandover(task.id);
  button.setAttribute('aria-current', String(task.id === selectedId));
  button.append(element('span', 'task-title', task.title || '未命名任务'));
  const indicator = element('span', 'task-active', ''); indicator.title = '进行中'; indicator.setAttribute('aria-label', '进行中');
  const observedStatus = sidebarStatusSnapshot?.get(task.id) ?? button.dataset.status;
  button.append(indicator);
  const notificationIndicator = element('span', 'task-notification');
  renderTaskNotification(notificationIndicator, taskNotifications.get(task.id));
  button.append(notificationIndicator);
  // Unread indicators are deferred until H5 can acknowledge desktop read state.
  setTaskIndicator(indicator, liveTaskStatus.get(task.id) === 'active' ? 'active' : statusHandovers.has(task.id) ? 'checking' : observedStatus);
  button.addEventListener('click', () => { const selectionStarted = connectionDiagnosticClock(); if (newDraft?.pending || newDraft?.uncertain || newDraft?.prepared) { sendStatus.textContent = '请先处理当前发送'; return; } clearTaskNotification(task.id, true); if (newDraft) savedNewDraft = { deviceId: currentDeviceId, projectId: newDraft.projectId, text: messageInput.value, attachments: newDraft.attachments, model: newDraft.model, effort: newDraft.effort }; newDraft = null; newProjectBar.hidden = true; if (selectedId === task.id && active && !active.signal.aborted) { showSidebar(false); window.refreshNotificationPresence?.(); return; } const previous = selectedId; if (previous) { drafts.set(previous, messageInput.value); if (previous !== task.id) { beginStatusHandover(previous); activeRecoveryAborts.get(recoveryKey(currentDeviceId, previous))?.abort(); } } selectedId = task.id; selectedTitle = task.title || '未命名任务'; messageInput.value = drafts.get(selectedId) || ''; renderImageDraft(); updateComposer(); currentProject.hidden = !threadProjectNames.has(selectedId); currentProject.disabled = true; if (threadProjectNames.has(selectedId)) currentProject.value = threadProjectNames.get(selectedId); for (const item of projectList.querySelectorAll('.task')) { const selected = item.dataset.id === selectedId; item.setAttribute('aria-current', String(selected)); } showSidebar(false); clearConversation(); status('连接中', 'connecting'); scheduleThreadConnect(task.id, beginConnectionDiagnostic('selection', selectionStarted)); if (statusHandovers.has(previous)) { clearTimeout(visibleStatusTimer); visibleStatusTimer = undefined; void loadThreads(); } });
  return button;
}
function renderGroup(key, name, tasks, recent = false, initialExpanded = recent) {
  const group = element('section', `project-group${recent ? ' recent' : ''}`);
  const heading = element('button', 'project-heading');
  heading.type = 'button';
  if (!groupExpanded.has(key)) groupExpanded.set(key, initialExpanded === true);
  const collapsed = !groupExpanded.get(key);
  heading.setAttribute('aria-expanded', String(!collapsed));
  const icon = element('span', recent ? 'group-chevron' : 'folder-icon', '');
  icon.setAttribute('aria-hidden', 'true');
  if (!recent) icon.innerHTML = '<svg class="folder-closed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l2 3h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z"/></svg><svg class="folder-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2"/><path d="M3 18l2-6a2 2 0 0 1 2-1.4h14a1 1 0 0 1 .9 1.4l-2.3 6.5A2 2 0 0 1 17.7 20H5a2 2 0 0 1-2-2Z"/></svg>';
  const projectIndicator = element('span', 'task-active project-status');
  const notificationIndicator = element('span', 'task-notification project-notification'); notificationIndicator.hidden = true;
  heading.append(icon, element('span', 'project-name', name), projectIndicator, notificationIndicator, chevronIcon());
  const contents = element('div', 'project-contents');
  contents.hidden = collapsed;
  heading.addEventListener('click', () => {
    const next = !contents.hidden;
    contents.hidden = next;
    heading.setAttribute('aria-expanded', String(!next));
    groupExpanded.set(key, !next);
    applyProjectStatuses();
    refreshTaskNotificationIndicators();
    scheduleVisibleStatusRefresh();
  });
  const valid = tasks.filter(task => task && uuid.test(task.id));
  projectStatusGroups.set(key, { heading, tasks: valid.map(task => ({ ...task })), indicator: projectIndicator, notificationIndicator,
    showTask(id) {
      if (!valid.some(task => task.id === id)) return false;
      contents.hidden = false; heading.setAttribute('aria-expanded', 'true'); groupExpanded.set(key, true);
      expandedGroups.add(key); renderItems(); applyProjectStatuses(); refreshTaskNotificationIndicators();
      return true;
    },
  });
  applyProjectStatuses();
  const more = element('button', 'show-more');
  more.type = 'button';
  function renderItems() {
    const expanded = expandedGroups.has(key);
    const nodes = (expanded ? valid : valid.slice(0, 5)).map(renderTask).filter(Boolean);
    contents.replaceChildren(...nodes);
    if (!valid.length) contents.append(element('p', 'list-status project-empty', '暂无任务'));
    if (valid.length > 5) {
      more.textContent = expanded ? '收起' : '展开显示';
      more.setAttribute('aria-expanded', String(expanded));
      contents.append(more);
    }
    refreshTaskNotificationIndicators();
  }
  more.addEventListener('click', () => {
    if (expandedGroups.has(key)) expandedGroups.delete(key); else expandedGroups.add(key);
    renderItems();
    scheduleVisibleStatusRefresh();
  });
  renderItems();
  if (recent) group.append(heading, contents);
  else { const row = element('div', 'project-heading-row'); const add = element('button', 'project-new-chat'); add.type = 'button'; add.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>'; add.title = '在此项目中新聊天'; add.setAttribute('aria-label', `在${name}中新聊天`); add.addEventListener('click', () => openNewChat(key.slice('project:'.length))); row.append(heading, add); group.append(row, contents); }
  return group;
}
let listRetryTimer;
let visibleStatusTimer;
let lastVisibleStatusKey = '';
let pendingStatusRefreshes = 0;
let pageSuspended = false;
function pauseBackgroundPolling({ includePairing = true } = {}) {
  if (includePairing) { clearTimeout(pairingStatusTimer); pairingStatusTimer = undefined; ++pairingStatusGeneration; }
  clearTimeout(listRetryTimer); listRetryTimer = undefined;
  clearTimeout(visibleStatusTimer); visibleStatusTimer = undefined;
  clearTimeout(hostStatusTimer); hostStatusTimer = undefined;
  clearTimeout(deviceIdentityRetryTimer); deviceIdentityRetryTimer = undefined;
  ++listRequestGeneration; ++hostStatusGeneration;
}
function scheduleVisibleStatusRefresh() {
  clearTimeout(visibleStatusTimer);
  if (document.hidden === true || pageSuspended) return;
  visibleStatusTimer = setTimeout(() => { visibleStatusTimer = undefined; void loadThreads(); }, 250);
  visibleStatusTimer?.unref?.();
}
projectList.addEventListener('scroll', scheduleVisibleStatusRefresh, { passive: true });
function visibleStatusIds() {
  const ids = [...statusHandovers.keys()];
  if (uuid.test(selectedId || '')) ids.push(selectedId);
  const bounds = projectList.getBoundingClientRect();
  for (const task of projectList.querySelectorAll('.task')) {
    const rect = task.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom &&
        rect.right > 0 && rect.left < window.innerWidth && rect.bottom > 0 && rect.top < window.innerHeight && uuid.test(task.dataset.id)) ids.push(task.dataset.id);
  }
  const visibleGroups = [...projectStatusGroups.values()].filter(({ heading }) => {
    const rect = heading.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom && rect.right > 0 && rect.left < window.innerWidth && rect.bottom > 0 && rect.top < window.innerHeight;
  });
  const grouped = [...new Set(visibleGroups.flatMap(group => group.tasks.map(task => task.id)))];
  const knownRunning = new Set(visibleGroups.flatMap(group => group.tasks.filter(task => taskStatusIsActive(task.status?.type ?? task.status)).map(task => task.id)));
  const running = grouped.filter(id => liveTaskStatus.get(id) === 'active' || sidebarStatusSnapshot?.get(id) === 'active' || knownRunning.has(id));
  const priority = [...new Set([...statusHandovers.keys(), ...running, ...(uuid.test(selectedId || '') ? [selectedId] : [])])];
  const visible = [...new Set(ids)].filter(id => !priority.includes(id));
  const hidden = grouped.filter(id => !priority.includes(id) && !visible.includes(id));
  // Folded directories must keep observing their children. Reserve a bounded
  // rotating share for hidden children while keeping confirmed running tasks.
  const selected = [...priority, ...visible.slice(0, hidden.length ? Math.max(0, 24 - priority.length) : 32)];
  const remaining = [...visible.filter(id => !selected.includes(id)), ...hidden];
  const capacity = Math.max(0, 32 - selected.length);
  if (remaining.length) {
    const start = projectStatusCursor % remaining.length;
    for (let index = 0; index < Math.min(capacity, remaining.length); index++) selected.push(remaining[(start + index) % remaining.length]);
    if (remaining.length > capacity) projectStatusCursor = (start + capacity) % remaining.length;
  }
  return [...new Set(selected)].slice(0, 32);
}
let listRequestGeneration = 0;
let listLoadInFlight = null;
const listPointers = new Set();
let listGesturePending = false, listGestureTimer, listGestureWatchdog, deferredListRender;
function discardDeferredListRender() {
  clearTimeout(listGestureTimer); listGestureTimer = undefined;
  clearTimeout(listGestureWatchdog); listGestureWatchdog = undefined;
  listPointers.clear(); listGesturePending = false; deferredListRender = undefined;
}
function flushDeferredListRender() {
  clearTimeout(listGestureTimer); listGestureTimer = undefined;
  if (listPointers.size) return;
  clearTimeout(listGestureWatchdog); listGestureWatchdog = undefined;
  listGesturePending = false;
  const pending = deferredListRender; deferredListRender = undefined;
  if (pending && pending.generation === listRequestGeneration && !pageSuspended && document.hidden !== true) renderThreadList(pending.data);
}
function finishListPointer(event, cancelled = false) {
  if (!listPointers.delete(event.pointerId)) return;
  if (!listPointers.size) {
    clearTimeout(listGestureTimer);
    listGestureTimer = setTimeout(flushDeferredListRender, cancelled ? 0 : 400);
  }
}
projectList.addEventListener('pointerdown', event => {
  clearTimeout(listGestureTimer); listGestureTimer = undefined;
  listPointers.add(event.pointerId); listGesturePending = true;
  clearTimeout(listGestureWatchdog);
  listGestureWatchdog = setTimeout(() => { listPointers.clear(); flushDeferredListRender(); }, 15000);
  listGestureWatchdog?.unref?.();
});
document.addEventListener?.('pointerup', event => finishListPointer(event), true);
document.addEventListener?.('pointercancel', event => finishListPointer(event, true), true);
document.addEventListener?.('click', () => {
  if (listGesturePending && !listPointers.size) {
    clearTimeout(listGestureTimer);
    listGestureTimer = setTimeout(flushDeferredListRender, 0);
  }
}, true);
window.addEventListener('blur', () => { listPointers.clear(); flushDeferredListRender(); });
// Back off when the desktop peer is down so a dead bridge is not hammered.
let listFailureStreak = 0;
let listChangeTimer;
function refreshChangedThreadList() {
  clearTimeout(listChangeTimer);
  listChangeTimer = setTimeout(() => { listChangeTimer = undefined; void loadThreads(); }, 100);
}
let hostStatusTimer;
let pairingAvailable = !window.pairingReady;
let hostStatusGeneration = 0;
let pairingStatusTimer;
let pairingStatusGeneration = 0;
let replacedActiveDeviceId = null;
let pairingWasReplaced = false, pairingRestorePending = false, notifiedActiveDeviceId;
function closePairingConflict() { pairingConflict.hidden = true; pairingConflictError.hidden = true; pairingConflictError.textContent = ''; }
function showPairingConflict(activeDeviceId) {
  if (!pairingConflict) return;
  if (!pairingWasReplaced) { showUnpaired(); pairingWasReplaced = true; }
  replacedActiveDeviceId = typeof activeDeviceId === 'string' ? activeDeviceId : null;
  if (notifiedActiveDeviceId !== replacedActiveDeviceId) {
    notifiedActiveDeviceId = replacedActiveDeviceId;
    pairingConflict.hidden = false; pairingConflictError.hidden = true;
    pairingConflictRestore.disabled = pairingRestorePending;
    pairingConflictRestore.focus?.();
  }
  const control = document.querySelector('#unpaired-control');
  if (control) control.textContent = '配对已切换 · 恢复本机';
  status('配对已切换', 'error');
}
window.showPairingRecovery = () => { if (!pairingWasReplaced) return false; pairingConflict.hidden = false; pairingConflictRestore.focus?.(); return true; };
pairingConflictDismiss?.addEventListener('click', closePairingConflict);
document.querySelector('#pairing-conflict-scrim')?.addEventListener('click', closePairingConflict);
pairingConflictRestore?.addEventListener('click', async () => {
  if (!pairingWasReplaced || pairingRestorePending) return;
  pairingRestorePending = true; clearTimeout(pairingStatusTimer); ++pairingStatusGeneration;
  pairingConflictRestore.disabled = true; pairingConflictError.hidden = true;
  try {
    const response = await fetch('/api/pairing/restore', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedActiveDeviceId: replacedActiveDeviceId }) });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      if (body?.error === 'pairing-changed') { throw new Error('配对状态刚刚有变化，请再点一次恢复本机。'); }
      if (response.status === 401) { pairingWasReplaced = false; closePairingConflict(); showUnpaired(); return; }
      throw new Error('恢复失败，请稍后再试。');
    }
    pairingConflictRestore.disabled = false; closePairingConflict(); replacedActiveDeviceId = null; pairingWasReplaced = false; notifiedActiveDeviceId = undefined; await checkPairingStatus();
  } catch (error) { pairingConflictError.textContent = error.message || '恢复失败，请稍后再试。'; pairingConflictError.hidden = false; }
  finally { pairingRestorePending = false; pairingConflictRestore.disabled = false; if (pairingWasReplaced || pairingAvailable) void refreshPairingStatus(); }
});
async function refreshPairingStatus() {
  clearTimeout(pairingStatusTimer); pairingStatusTimer = undefined;
  if (pageSuspended || document.hidden === true || pairingRestorePending) return;
  const generation = ++pairingStatusGeneration;
  try {
    const response = await fetch('/api/pairing/status', { credentials: 'same-origin', cache: 'no-store' });
    if (generation !== pairingStatusGeneration || pageSuspended || document.hidden === true || response.status === 404) return;
    if (response.status === 401 || response.status === 403) { closePairingConflict(); pairingWasReplaced = false; notifiedActiveDeviceId = undefined; showUnpaired(); return; }
    if (!response.ok) throw new Error('pairing status unavailable');
    const result = await response.json();
    if (generation !== pairingStatusGeneration || pageSuspended || document.hidden === true) return;
    if (result.state === 'replaced') showPairingConflict(result.activeDeviceId);
    else if (result.state === 'active' && pairingWasReplaced) { closePairingConflict(); pairingWasReplaced = false; notifiedActiveDeviceId = undefined; await checkPairingStatus(); return; }
  } catch { /* Host status polling remains the source of connection errors. */ }
  if (!pageSuspended && document.hidden !== true && generation === pairingStatusGeneration) { clearTimeout(pairingStatusTimer); pairingStatusTimer = setTimeout(refreshPairingStatus, 4000); pairingStatusTimer?.unref?.(); }
}
async function refreshHostStatus() {
  if (document.hidden === true || pageSuspended) return;
  const generation = ++hostStatusGeneration;
  clearTimeout(hostStatusTimer);
  try {
    const response = await scopedFetch('/api/host-status', { credentials: 'same-origin', cache: 'no-store' });
    if (generation !== hostStatusGeneration) return;
    if (response.status === 401 || response.status === 403) {
      const body = await response.clone().json().catch(() => null);
      if (body?.error === 'device-replaced') { showPairingConflict(body.activeDeviceId); return; }
      if (generation === hostStatusGeneration) showUnpaired(); return;
    }
    if (!response.ok) throw new Error('offline');
    const result = await response.json();
    if (typeof result.online !== 'boolean') return;
    if (generation !== hostStatusGeneration) return;
    if (result.online === true) homeConnectionConfirmed = true;
    if (!selectedId) {
      if (turns.querySelector?.('.conversation-loading')) turns.replaceChildren();
      if (result.online) clearHomeError('host'); else showHomeError('host', '电脑未连接');
      status(result.online === true ? '已连接' : '电脑未连接', result.online === true ? 'ready' : 'error');
      if (result.online) showConversationEmpty();
    }
  } catch {
    if (generation !== hostStatusGeneration) return;
    if (!selectedId) {
      if (homeConnectionConfirmed) { if (turns.querySelector?.('.conversation-empty')) turns.replaceChildren(); status('连接中断', 'error'); }
      else { status('连接中', 'connecting'); if (!homeErrorSource) showConversationLoading(); }
    }
  }
  if (generation === hostStatusGeneration) { hostStatusTimer = setTimeout(refreshHostStatus, 20000); hostStatusTimer?.unref?.(); }
}
function invalidateThreadList() {
  discardDeferredListRender();
  stopSidebarStatuses();
  clearTimeout(listRetryTimer);
  listRetryTimer = undefined;
  ++listRequestGeneration;
  listLoadInFlight = null;
  lastVisibleStatusKey = '';
  pendingStatusRefreshes = 0;
  projectStatusGroups.clear(); projectStatusCursor = 0;
  liveTaskStatus.clear();
  for (const id of statusHandovers.keys()) clearStatusHandover(id);
  projectList.replaceChildren(element('p', 'list-status', '正在加载任务'));
}
async function loadThreads() {
  if (document.hidden === true || pageSuspended) return;
  if (listLoadInFlight) {
    listLoadInFlight.refresh = true;
    return listLoadInFlight.promise;
  }
  const request = { refresh: false, promise: null };
  listLoadInFlight = request;
  request.promise = (async () => {
    try {
      const canRefresh = await fetchThreadList();
      if (canRefresh !== false && listLoadInFlight === request && request.refresh) {
        request.refresh = false;
        await fetchThreadList();
      }
    } finally {
      if (listLoadInFlight === request) listLoadInFlight = null;
    }
  })();
  return request.promise;
}
function renderThreadList(data) {
  ++taskNotificationListGeneration;
  projectStatusGroups.clear();
  const fragment = document.createDocumentFragment();
  for (const project of data.projects) {
    if (!project || !Array.isArray(project.threads)) continue;
    fragment.append(renderGroup(`project:${project.id}`, project.name || '未命名项目', project.threads, false, project.expanded));
  }
  if (data.recent.length) fragment.append(renderGroup('recent', '最近', data.recent, true));
  if (data.truncated === true) fragment.append(element('p', 'list-status', '任务较多，仅显示最近的部分任务'));
  if (!fragment.childNodes.length) fragment.append(element('p', 'list-status', '暂无任务'));
  const previousScroll = projectList.scrollTop;
  projectList.replaceChildren(fragment);
  if (Number.isFinite(previousScroll)) projectList.scrollTop = previousScroll;
  lastTaskNotificationListComplete = data.truncated !== true;
  refreshTaskNotificationIndicators(lastTaskNotificationListComplete);
  drainPendingTaskNotifications();
  void window.restoreTaskReminders?.();
  const notification = window.takeNotificationTarget?.(historyScope);
  if (notification) window.openNotificationTask?.(notification);
}
window.openNotificationTask = target => {
  if (!historyScope || historyScope.hostId !== target?.hostId || historyScope.deviceId !== target?.deviceId || newDraft) return false;
  let task = [...projectList.querySelectorAll('.task')].find(node => node.dataset.id === target.threadId);
  if (!task) {
    const group = [...projectStatusGroups.values()].find(group => group.tasks.some(task => task.id === target.threadId));
    if (!group?.showTask?.(target.threadId)) return false;
    task = [...projectList.querySelectorAll('.task')].find(node => node.dataset.id === target.threadId);
  }
  if (!task) return false;
  task.click(); return true;
};
async function fetchThreadList() {
  if (document.hidden === true || pageSuspended) return false;
  clearTimeout(listRetryTimer);
  listRetryTimer = undefined;
  if (document.hidden === true || pageSuspended) return false;
  const generation = ++listRequestGeneration;
  let retry = true;
  try {
    const visible = visibleStatusIds();
    const visibleKey = visible.join(',');
    const handover = [...statusHandovers.keys()][0];
    let body = JSON.stringify({ visibleThreads: visible, ...(handover && visible.includes(handover) ? { handoverThread: handover } : {}) });
    if (visible.length > 1024 || body.length > 1048576) body = JSON.stringify({ visibleThreads: [] });
    const response = await scopedFetch('/api/threads', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body });
    if (generation !== listRequestGeneration) return false;
    if (response.status === 401 || response.status === 403) retry = false;
    if (!response.ok) throw new Error(await responseError(response, `任务列表加载失败 (${response.status})`));
    const data = await response.json();
    if (generation !== listRequestGeneration) return false;
    if (!Array.isArray(data.projects) || !Array.isArray(data.recent)) throw new Error('任务列表数据不可用');
    clearHomeError('list');
    listFailureStreak = 0;
    availableProjects = data.projects.filter(project => project && typeof project.id === 'string' && project.id && typeof project.name === 'string');
    threadProjectNames.clear();
    for (const project of data.projects) for (const task of Array.isArray(project?.threads) ? project.threads : []) if (uuid.test(task?.id)) threadProjectNames.set(task.id, project.id);
    for (const task of data.recent) if (uuid.test(task?.id) && typeof task.projectId === 'string') threadProjectNames.set(task.id, task.projectId);
    if (selectedId && !newDraft && (!selectedTitle || selectedTitle === '新聊天')) {
      const selected = [...data.recent, ...data.projects.flatMap(project => Array.isArray(project?.threads) ? project.threads : [])].find(task => task?.id === selectedId);
      if (typeof selected?.title === 'string' && selected.title.trim()) { selectedTitle = selected.title; title.textContent = selectedTitle; }
    }
    updateNewProjectOptions();
    if (listGesturePending) deferredListRender = { data, generation };
    else renderThreadList(data);
    if (visibleKey !== lastVisibleStatusKey) {
      lastVisibleStatusKey = visibleKey;
      pendingStatusRefreshes = visibleKey ? 2 : 0;
    }
    const nextDelay = pendingStatusRefreshes ? (pendingStatusRefreshes-- === 2 ? 1500 : 3000) : 20000;
    listRetryTimer = setTimeout(() => { listRetryTimer = undefined; void loadThreads(); }, nextDelay);
    listRetryTimer?.unref?.();
  } catch (e) {
    if (generation !== listRequestGeneration) return false;
    const message = e instanceof TypeError ? '连接中断，正在重试' : (e.message || '任务列表加载失败');
    const notice = projectList.querySelector('.list-error') || element('p', 'list-status list-error');
    notice.textContent = retry && !message.includes('正在重试') ? `${message}，正在重试` : message;
    if (retry && projectList.querySelector('.task')) {
      if (!projectList.querySelector('.list-error')) projectList.append(notice);
    } else { discardDeferredListRender(); projectList.replaceChildren(notice); }
    if (!(e instanceof TypeError)) showHomeError('list', message);
    if (retry) {
      listFailureStreak = Math.min(listFailureStreak + 1, 4);
      const retryDelay = Math.min(30000, 3000 * (2 ** (listFailureStreak - 1)));
      listRetryTimer = setTimeout(() => { listRetryTimer = undefined; void loadThreads(); }, retryDelay);
      listRetryTimer?.unref?.();
    }
    return retry;
  }
}
let loadedHistory = null, historyRequest = null, recordedHistory = null;
function historyIsStale() { return Boolean(loadedHistory?.stale || recordedHistory?.stale); }
function mergeHistoryOrder(older, newer, key, update = (old, latest) => latest) {
  const previous = new Map(older.map(value => [key(value), value]).filter(([id]) => id));
  const latest = new Map(), before = new Map();
  let pending = [];
  for (const value of newer) {
    const id = key(value);
    if (id && previous.has(id)) {
      latest.set(id, value);
      if (pending.length) {
        if (before.has(id)) for (const inserted of pending) before.get(id).push(inserted);
        else before.set(id, pending);
        pending = [];
      }
    } else pending.push(value);
  }
  // Recorded order is authoritative. Live-only entries precede their next
  // shared anchor; entries without a later anchor append to the newest edge.
  const merged = [];
  for (const value of older) {
    const id = key(value);
    if (before.has(id)) {
      for (const inserted of before.get(id)) merged.push(inserted);
      before.delete(id); // A repeated recorded anchor must not duplicate its inserted segment.
    }
    merged.push(latest.has(id) ? update(value, latest.get(id)) : value);
  }
  for (const value of pending) merged.push(value);
  return merged;
}
function mergeHistoryTurns(older, newer) {
  const key = turn => typeof turn.id === 'string' && turn.id ? `id:${turn.id}` : typeof turn.viewKey === 'string' && turn.viewKey ? `view:${turn.viewKey}` : null;
  return mergeHistoryOrder(older, newer, key, (old, turn) => {
    // A live steering row keeps its local UI ID, while recorded history uses
    // the acknowledged server user-message ID. Link only explicit identities;
    // identical text can be separate messages and must remain separate rows.
    const aliases = new Map();
    for (const item of [...(old.items || []), ...(turn.items || [])]) {
      if (item?.type === 'userMessage' && typeof item.id === 'string' && item.id && typeof item.serverUserMessageId === 'string' && item.serverUserMessageId) aliases.set(item.id, item.serverUserMessageId);
    }
    const itemKey = item => typeof item.id === 'string' && item.id ? aliases.get(item.id) || item.id : null;
    const linkedIds = new Set([...aliases.keys(), ...aliases.values()]);
    const collapseLinkedRows = values => {
      const result = [], positions = new Map();
      for (const item of values) {
        const id = itemKey(item);
        if (item?.type !== 'userMessage' || !linkedIds.has(item.id) || !positions.has(id)) {
          if (item?.type === 'userMessage' && linkedIds.has(item.id)) positions.set(id, result.length);
          result.push(item);
        } else {
          const index = positions.get(id);
          // Retain the first recorded position and the acknowledged live row's
          // local identity, attachments and explicit server link.
          if (item.serverUserMessageId || !result[index].serverUserMessageId) result[index] = item;
        }
      }
      return result;
    };
    const items = mergeHistoryOrder(collapseLinkedRows(old.items || []), collapseLinkedRows(turn.items || []), itemKey);
    const pagination = old.itemsPagination || turn.itemsPagination;
    return { ...old, ...turn, items, ...(pagination ? { itemsPagination: { ...pagination,
      hasLoadedNewest: Boolean(old.itemsPagination?.hasLoadedNewest || turn.itemsPagination?.hasLoadedNewest),
      hasLoadedOldest: Boolean(old.itemsPagination?.hasLoadedOldest || turn.itemsPagination?.hasLoadedOldest) } } : {}) };
  });
}
function validateRecordedPage(page, id) {
  if (page?.id !== id || page.history?.readOnly !== true || !Array.isArray(page.turns) || page.turns.length > 50 ||
      typeof page.history.olderComplete !== 'boolean' || !(page.nextCursor === null || (typeof page.nextCursor === 'string' && page.nextCursor.length > 0 && page.nextCursor.length <= 8192)) ||
      (page.history.olderComplete !== (page.nextCursor === null))) throw new Error('invalid recorded history');
  const turns = new Set();
  for (const turn of page.turns) {
    if (!turn || typeof turn.id !== 'string' || !turn.id || turns.has(turn.id) || !Array.isArray(turn.items)) throw new Error('invalid recorded turn');
    turns.add(turn.id); const items = new Set();
    for (const item of turn.items) { if (!item || typeof item.id !== 'string' || !item.id || items.has(item.id)) throw new Error('invalid recorded item'); items.add(item.id); }
  }
}
function recordedHistoryAvailable() {
  const liveComplete = streamView && (streamView.history?.complete === true || (loadedHistory?.complete === true && !loadedHistory.stale));
  const indexedCandidate = !streamView || recordedHistory || ['history-paginated', 'items-paginated', 'mixed-history', 'on-demand', 'recorded-history'].includes(streamView.history?.reason);
  return Boolean(selectedId && indexedCandidate && !liveComplete && !recordedHistory?.olderComplete);
}
async function loadRecordedPage() {
  const id = selectedId;
  if (!id || historyRequest || !recordedHistoryAvailable()) return;
  const refresh = recordedHistory?.stale === true, previous = recordedHistory;
  const cursor = !refresh && previous?.initialized ? previous.nextCursor : null;
  const controller = new AbortController(), scopeGeneration = historyScopeGeneration;
  historyRequest = controller; updateHistoryControl();
  try {
    const query = cursor ? `?${new URLSearchParams({ cursor })}` : '';
    const response = await scopedFetch(`/api/threads/${encodeURIComponent(id)}/recorded-history${query}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { 'x-codex-history-chunks': '1' } });
    if ([409, 410].includes(response.status)) throw Object.assign(new Error('history changed'), { stale: true });
    const page = await readHistoryPage(response, controller.signal);
    if (page?.error === 'history-changed') throw Object.assign(new Error('history changed'), { stale: true });
    if (historyRequest !== controller || controller.signal.aborted || scopeGeneration !== historyScopeGeneration || selectedId !== id) return;
    validateRecordedPage(page, id);
    if (cursor && page.nextCursor === cursor) throw new Error('history cursor did not advance');
    const turns = refresh ? page.turns : mergeHistoryTurns(page.turns, previous?.turns || []);
    const baseView = refresh && !streamView ? page : previous?.baseView || { id, title: page.title, turns: [], history: { readOnly: true }, requests: [], runtimeStatus: 'unknown' };
    recordedHistory = { id, baseView, turns, nextCursor: page.nextCursor, initialized: true, olderComplete: page.history.olderComplete, stale: false };
    historyAutoBlocked = false;
    const height = conversation?.scrollHeight || 0, top = conversation?.scrollTop || 0;
    followLatest = false; showState(streamView || baseView, Boolean(streamView));
    if (conversation) conversation.scrollTop = top + Math.max(0, conversation.scrollHeight - height);
  } catch (error) {
    if (!controller.signal.aborted && historyRequest === controller && scopeGeneration === historyScopeGeneration && selectedId === id) {
      historyAutoBlocked = true;
      if (error.stale) recordedHistory = { ...(previous || { id, turns: [], initialized: false, olderComplete: false }), stale: true };
      history.textContent = '';
    }
  } finally { if (historyRequest === controller) { historyRequest = null; updateHistoryControl(); } }
}
function historyHasOlder() {
  return Boolean(loadedHistory?.nextBefore || streamView?.history?.cursor || recordedHistory?.nextCursor || displayedHistoryId);
}
function updateHistoryControl() {
  const shortContent = !conversation || !Number.isFinite(conversation.scrollHeight) || !Number.isFinite(conversation.clientHeight) || conversation.scrollHeight <= conversation.clientHeight + 1;
  // A short window is only worth a manual control when something older exists;
  // a brand-new chat must never advertise "加载更早消息".
  loadEarlier.hidden = Boolean(newDraft) || !historyCanLoad || (!historyRequest && !historyAutoBlocked && !historyIsStale() && !(shortContent && historyHasOlder()));
  loadEarlier.disabled = Boolean(historyRequest);
  loadEarlier.textContent = historyRequest ? '加载中...' : historyIsStale() ? '历史已变化，刷新' : historyAutoBlocked ? '重新加载更早消息' : '加载更早消息';
}
async function readHistoryPage(response, signal, limits = {}) {
  if (!response.ok) throw new Error('history unavailable');
  if (!response.headers?.get?.('content-type')?.includes('application/x-ndjson')) return response.json();
  if (!response.body) throw new Error('history unavailable');
  const { StateChunkAssembler } = await import('/state-chunks.mjs');
  const assembler = new StateChunkAssembler(limits), reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', result = null, complete = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (signal.aborted) throw new Error('cancelled');
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line || line.length > 131072 || result) throw new Error('invalid history frame');
        result = await assembler.accept(JSON.parse(line));
        if (signal.aborted) throw new Error('cancelled');
      }
      if (pending.length > 131072) throw new Error('invalid history frame');
    }
    if (pending || !result || result.seq !== 1) throw new Error('incomplete history');
    complete = true;
    return result.value;
  } finally { assembler.cancel(); if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function loadEarlierPage() {
  const source = streamView, id = selectedId, metadata = source?.history;
  if (!id || loadEarlier.disabled) return;
  const liveBefore = loadedHistory ? loadedHistory.nextBefore : metadata?.cursor;
  if (recordedHistory?.stale || !connected || !metadata?.historicalHash || (!liveBefore && !loadedHistory?.stale)) return loadRecordedPage();
  if (loadedHistory?.stale) { loadedHistory = null; showState(streamView); }
  const previous = loadedHistory?.hash === metadata.historicalHash ? loadedHistory : null;
  const before = previous?.nextBefore ?? (previous ? null : metadata.cursor);
  if (!before) return;
  const controller = new AbortController(), scopeGeneration = historyScopeGeneration; historyRequest = controller;
  updateHistoryControl();
  try {
    const response = await scopedFetch(`/api/threads/${encodeURIComponent(id)}/history-page?${new URLSearchParams({ before, hash: metadata.historicalHash })}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { 'x-codex-history-chunks': '1' } });
    const page = await readHistoryPage(response, controller.signal);
    const current = streamView?.history;
    if (historyRequest !== controller || scopeGeneration !== historyScopeGeneration || selectedId !== id || !connected || current?.historicalHash !== metadata.historicalHash || current?.mediaRevision !== metadata.mediaRevision) return;
    if (page.threadId !== id || page.historicalHash !== metadata.historicalHash || page.before !== before || page.keyField !== metadata.keyField || !Array.isArray(page.turns) || !page.turns.length || page.turns.length > 1000 || (page.nextBefore !== null && page.nextBefore !== page.turns[0]?.[page.keyField])) throw new Error('invalid page');
    const keys = new Set([...(previous?.turns || []), ...streamView.turns].map(turn => turn[page.keyField]));
    if (page.turns.some(turn => !turn || typeof turn[page.keyField] !== 'string' || keys.has(turn[page.keyField]) || !keys.add(turn[page.keyField]))) throw new Error('invalid page');
    loadedHistory = { hash: metadata.historicalHash, mediaRevision: metadata.mediaRevision, turns: [...page.turns, ...(previous?.turns || [])], nextBefore: page.nextBefore, complete: page.complete };
    historyAutoBlocked = false;
    history.textContent = '';
    const height = conversation?.scrollHeight || 0, top = conversation?.scrollTop || 0;
    followLatest = false; showState(streamView);
    if (conversation) conversation.scrollTop = top + Math.max(0, conversation.scrollHeight - height);
  } catch { if (!controller.signal.aborted && selectedId === id) { historyAutoBlocked = true; history.textContent = ''; } }
  finally { if (historyRequest === controller) { historyRequest = null; updateHistoryControl(); } }
}
loadEarlier.addEventListener('click', () => loadEarlierPage());
function questionPanelSignature(view, controlTurns, scope) {
  const questions = turns => turns.filter(turn => (turn.items || []).some(item => item?.questions?.length)).map(turn => [turn.viewKey || turn.id, (turn.items || [])
    .filter(item => item?.questions?.length || item?.type === 'userMessage')
    .map(item => [item.id, item.type, item.questions, item.pendingQuestionIds, item.submittingQuestionIds, item.questionReplyIds])]);
  const legacyTail = controlTurns.some(turn => (turn.items || []).some(item => item?.questions?.length && !Array.isArray(item.pendingQuestionIds))) ? (controlTurns.at(-1)?.viewKey || controlTurns.at(-1)?.id) : null;
  return JSON.stringify([scope, (view.requests || []).filter(request => request.kind === 'userInput'), questions(controlTurns), legacyTail, view.unknownQuestionItemIds]);
}
function reconcileQuestionDraft(draft, questions) {
  draft.questionSchemas ||= new Map();
  for (const question of questions) {
    const schema = questionInputSchema(question);
    if (draft.questionSchemas.has(question.id) && draft.questionSchemas.get(question.id) !== schema) delete draft.answers[question.id];
    draft.questionSchemas.set(question.id, schema);
  }
}
function questionInputSchema(question) { return JSON.stringify([question.question, question.options, question.isOther]); }
function questionControlTurns(view) {
  const source = view.turns || [], keys = new Set(source.map(turn => turn.viewKey || turn.id)), turns = new Map();
  for (const turn of Array.isArray(view.pendingQuestionTurns) ? view.pendingQuestionTurns : []) {
    if (!turn || typeof (turn.viewKey || turn.id) !== 'string' || !Array.isArray(turn.items)) continue;
    if (!keys.has(turn.viewKey || turn.id)) turns.set(turn.viewKey || turn.id, turn);
  }
  // Preserve invalid duplicates within the authoritative source so the existing
  // ambiguity guards still reject them; only supplemental copies are deduped.
  return [...turns.values(), ...source];
}
function showState(view, live = true, loadingPreview = false, immediateWork = null) {
  recoveryGuardedControls = [];
  const viewThread = selectedId;
  const sourceView = view;
  reconcileToolOutputRefs(live && view.id === selectedId ? view : null);
  const playingVideos = new Set();
  for (const entry of videoPreviews.values()) for (const video of entry.players.values()) if (!video.paused && !video.ended) playingVideos.add(video);
  const focusedWork = document.activeElement?.closest?.('details.work-activity[data-work-key]');
  let workFocus = null;
  if (focusedWork && turns.contains?.(focusedWork)) {
    const target = document.activeElement, path = [];
    for (let node = target; node && node !== focusedWork; node = node.parentElement) path.unshift([...node.parentElement.children].indexOf(node));
    workFocus = { key: focusedWork.dataset.workKey, path, tag: target.tagName, className: target.className, text: target.textContent };
  }
  const immediateKeys = new Map();
  for (const group of turns.querySelectorAll('details.work-activity[data-work-key]')) {
    if (group.open) expandedWork.add(group.dataset.workKey);
    else expandedWork.delete(group.dataset.workKey);
    if (immediateWork && transientWorkKeys.has(group.dataset.workKey)) immediateKeys.set(`${group.dataset.turnIndex}:${group.dataset.groupIndex}`, group.dataset.workKey);
  }
  for (const key of transientWorkKeys) if (key !== immediateWork?.key && (!immediateWork || ![...immediateKeys.values()].includes(key))) expandedWork.delete(key);
  transientWorkKeys.clear();
  const controlTurns = questionControlTurns(sourceView);
  if (!live && typeof view.id === 'string' && view.id && view.id === selectedId && recordedHistory?.baseView !== view) {
    const indexed = view.history?.readOnly === true;
    if (indexed) validateRecordedPage(view, selectedId);
    const old = recordedHistory && recordedHistory.id === view.id ? recordedHistory : null;
    recordedHistory = { id: view.id, baseView: view, turns: mergeHistoryTurns(old?.turns || [], view.turns || []),
      nextCursor: indexed ? view.nextCursor : null, initialized: indexed, olderComplete: indexed && view.history.olderComplete, stale: false };
  }
  if (live && view.history?.historicalHash) {
    if (loadedHistory && (loadedHistory.hash !== view.history.historicalHash || loadedHistory.mediaRevision !== view.history.mediaRevision)) loadedHistory.stale = true;
    const previous = loadedHistory, field = view.history.keyField;
    historyCanLoad = previous?.stale ? true : Boolean(previous ? previous.nextBefore : view.history.cursor);
    if (previous && ['id', 'viewKey'].includes(field) && previous.turns.every(turn => typeof turn?.[field] === 'string' && turn[field])) {
      const liveKeys = new Set(view.turns.map(turn => turn[field]));
      const old = previous.turns.filter(turn => !liveKeys.has(turn[field]));
      view = { ...view, turns: [...old, ...view.turns], history: { ...view.history, complete: !previous.stale && previous.complete } };
    }
  } else { loadedHistory = null; historyCanLoad = false; }
  if (recordedHistory && recordedHistory.id === view.id) view = { ...view, turns: mergeHistoryTurns(recordedHistory.turns, view.turns || []) };
  if (recordedHistoryAvailable()) historyCanLoad = true;
  displayedHistoryId = !live && view.id === selectedId ? selectedId : null;
  clearImageObservers();
  liveMode = live && ['default', 'plan'].includes(view.collaborationMode) ? view.collaborationMode : null;
  liveModel = live && typeof view.model === 'string' ? { model: view.model, effort: view.reasoningEffort } : null;
  const modelChange = selectedId && modelChanges.get(selectedId);
  if (modelChange && typeof modelChange.model === 'string' && liveModel?.model === modelChange.model && liveModel.effort === modelChange.effort) { modelChange.observed = true; if (modelChange.confirmed) modelChanges.delete(selectedId); }
  liveRuntimeStatus = live ? view.runtimeStatus : null;
  flushPendingModelChange();
  flushPendingModeChange();
  const modeChange = selectedId && modeChanges.get(selectedId);
  if (modeChange && liveMode === modeChange.target) modeChanges.delete(selectedId);
  const goal = live ? view.goal : null;
  const goalLabels = { active: '进行中的目标', paused: '目标已暂停', blocked: '目标已停滞', usageLimited: '目标已达用量限制', budgetLimited: '目标已达预算限制', complete: '目标已完成' };
  goalPanel.hidden = !goal || !Object.hasOwn(goalLabels, goal.status) || typeof goal.objective !== 'string';
  if (!goalPanel.hidden) {
    goalStatus.textContent = goalLabels[goal.status];
    goalObjective.textContent = goal.objective;
    renderGoalClock(goal, selectedId);
  } else stopGoalClock();
  const firstRender = renderedThreadId !== selectedId;
  if (firstRender) { followLatest = true; renderedThreadId = selectedId; }
  const oldScrollTop = conversation?.scrollTop;
  const running = (sourceView.turns || []).filter(turn => turn.status === 'inProgress' && uuid.test(turn.id || ''));
  activeTurnId = live && running.length === 1 ? running[0].id : null;
  updateLiveTaskStatus(selectedId, live && (taskStatusIsActive(view.runtimeStatus) || running.length > 0 || Boolean(activeTurnId)) ? 'active' : 'unknown');
  if (selectedId && stops.has(selectedId) && stops.get(selectedId).turnId !== activeTurnId && !stops.get(selectedId).pending && !stops.get(selectedId).goalPauseFailed && (activeTurnId || !stops.get(selectedId).error)) stops.delete(selectedId);
  selectedTitle = view.title || selectedTitle || '未命名任务';
  title.textContent = selectedTitle;
  history.textContent = '';
  error.hidden = true;
  const fragment = document.createDocumentFragment();
  const questionNodes = [];
  const questionScope = JSON.stringify([historyScope?.hostId, historyScope?.deviceId, currentDeviceId, selectedId, historyScopeGeneration]);
  questionLiveConfirmed = live && sourceView.id === selectedId;
  if (live) unknownQuestionItems = new Set(Array.isArray(sourceView.unknownQuestionItemIds) ? sourceView.unknownQuestionItemIds : []);
  // Recorded pages may add display history, but only this live control source
  // can change an already attached question editor.
  const questionSignature = questionPanelSignature(sourceView, controlTurns, questionScope);
  // Keeping the actual form attached preserves the iOS keyboard, selection and
  // an in-flight IME composition. Refocusing a newly created input cannot do so.
  const preserveQuestions = !live && renderedQuestionPanel?.live === true && renderedQuestionPanel.scope === questionScope;
  const reuseQuestions = preserveQuestions || (renderedQuestionPanel?.signature === questionSignature && renderedQuestionPanel.live === live);
  const questionControls = reuseQuestions ? renderedQuestionPanel.controls : [];
  const questionCards = reuseQuestions ? renderedQuestionPanel.cards : new Map();
  const previousQuestionCards = renderedQuestionPanel?.scope === questionScope && renderedQuestionPanel.live ? renderedQuestionPanel.cards : null;
  const retainQuestionCard = record => {
    questionNodes.push(record.card); questionCards.set(record.key, record);
    questionControls.push(...record.controls); recoveryGuardedControls.push(...record.controls); pendingQuestionCount++;
  };
  if (reuseQuestions) recoveryGuardedControls.push(...questionControls);
  let pendingQuestionCount = 0;
  const fileTargets = new Map();
  if (live && Array.isArray(view.requests) && view.requests.length) {
    for (const request of view.requests) {
      if (request.unsupported || !request.kind) { fragment.append(element('p', 'pending-request', '此任务有待处理请求，请在电脑上的 Codex 中查看并处理。')); continue; }
      const card = element('div', request.kind === 'userInput' ? 'question-card' : 'pending-request');
      if (request.kind === 'userInput') {
        if (reuseQuestions) continue;
        const cardKey = JSON.stringify(['request', request.id]), cardSignature = JSON.stringify(request.questions);
        const previousCard = previousQuestionCards?.get(cardKey);
        if (previousCard?.signature === cardSignature && questionPanel.contains(previousCard.card)) { retainQuestionCard(previousCard); continue; }
        const firstCardControl = questionControls.length;
        card.append(element('div', 'question-card-title', '问题'));
        const threadId = selectedId;
        const deviceId = currentDeviceId, scopeGeneration = historyScopeGeneration;
        const key = JSON.stringify([historyScope?.hostId || '', historyScope?.deviceId || '', threadId, 'request', request.id]);
        let draft = inputDrafts.get(key);
        if (!draft) { draft = { answers: Object.create(null), pending: false }; inputDrafts.set(key, draft); }
        reconcileQuestionDraft(draft, request.questions);
        const form = element('form', 'user-input-form');
        const isCurrentScope = () => selectedId === threadId && currentDeviceId === deviceId && historyScopeGeneration === scopeGeneration && inputDrafts.get(key) === draft;
        const isCurrentForm = () => isCurrentScope() && draft.controls?.form === form && questionPanel.contains?.(form) !== false;
        const canSubmit = () => isCurrentForm() && connected && questionLiveConfirmed;
        for (const question of request.questions) {
          const group = element('fieldset', 'user-input-question');
          const legend = element('legend', '', question.question);
          group.append(legend);
          if (question.options.length) {
            for (const option of question.options) {
              const label = element('label', 'user-input-option');
              const radio = element('input'); radio.type = 'radio'; radio.name = question.id; radio.value = option.label;
              radio.checked = draft.answers[question.id] === option.label;
              radio.addEventListener('change', () => {
                if (!isCurrentForm()) return;
                draft.answers[question.id] = option.label;
                const other = group.querySelectorAll('.user-input-text')[0];
                if (other) other.value = '';
              });
              const text = element('span', '', option.label);
              if (option.description) text.append(element('small', '', option.description));
              label.append(radio, text); group.append(label);
            }
          }
          if (!question.options.length || question.isOther) {
            const input = element('input', 'user-input-text'); input.type = 'text'; input.placeholder = question.options.length ? '其他回答' : '输入回答';
            input.dataset.inputDraftKey = key; input.dataset.inputQuestionId = question.id; input.dataset.inputQuestionSchema = questionInputSchema(question);
            input.value = question.options.some(o => o.label === draft.answers[question.id]) ? '' : (draft.answers[question.id] || '');
            input.addEventListener('input', () => { if (!isCurrentForm()) return; draft.answers[question.id] = input.value; for (const radio of group.querySelectorAll('input[type=radio]')) radio.checked = false; });
            group.append(input);
          }
          form.append(group);
        }
        const submit = element('button', 'approval-accept', draft.pending ? (draft.outcome || '正在提交') : '提交'); submit.type = 'submit'; guardRecoveryControl(submit, () => draft.pending || !canSubmit());
        questionControls.push(recoveryGuardedControls.at(-1));
        const status = element('p', 'list-error', draft.feedback || ''); form.append(submit, status);
        draft.controls = { submit, status, form };
        form.addEventListener('submit', async event => {
          event.preventDefault();
          if (draft.pending || !canSubmit() || recoveryBlocksWrite()) return;
          if (!request.questions.every(q => draft.answers[q.id]?.trim())) { status.textContent = '请回答所有问题'; return; }
          draft.pending = true; submit.disabled = true; status.textContent = '';
          try {
            const response = await scopedFetch(`/api/threads/${encodeURIComponent(threadId)}/user-input`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: request.id, answers: draft.answers }) });
            if (!response.ok) throw new Error();
            draft.feedback = '已提交，等待任务更新'; draft.outcome = '已提交';
          } catch { draft.feedback = '结果暂不确定，请查看电脑上的任务状态'; draft.outcome = '结果待确认'; }
          if (isCurrentScope()) { draft.controls.status.textContent = draft.feedback; draft.controls.submit.textContent = draft.outcome; }
        });
        card.append(form); questionNodes.push(card); pendingQuestionCount++;
        questionCards.set(cardKey, { key: cardKey, kind: 'request', signature: cardSignature, card, controls: questionControls.slice(firstCardControl) });
        continue;
      }
      {
        const threadId = selectedId;
        const approvalKey = JSON.stringify([currentDeviceId, threadId, request.id, request.kind]);
        let draft = approvalDrafts.get(approvalKey);
        if (!draft) { draft = { pending: false, completed: false }; approvalDrafts.set(approvalKey, draft); }
        draft.card = card;
        if (draft.completed) { card.append(element('p', '', draft.message)); fragment.append(card); continue; }
        card.append(element('p', '', request.kind === 'command' ? `需要确认命令：${request.command}` : '需要确认文件变更'));
        const actions = element('div', 'approval-actions');
        const decisions = Array.isArray(request.decisions) ? request.decisions : ['accept', 'decline'];
        const labels = { accept: decisions.includes('cancel') ? '允许一次' : '允许', decline: '拒绝', cancel: '拒绝并中断' };
        for (const decision of decisions.filter(value => Object.hasOwn(labels, value))) {
          const label = labels[decision];
          const button = element('button', decision === 'accept' ? 'approval-accept' : 'approval-decline', label);
          button.type = 'button';
          guardRecoveryControl(button, () => draft.pending || draft.completed || draft.uncertain);
          button.addEventListener('click', async () => {
            if (selectedId !== threadId || draft.pending || draft.completed || draft.uncertain || recoveryBlocksWrite()) return;
            draft.pending = true; updateRecoveryGuardedControls();
            try {
              const response = await scopedFetch(`/api/threads/${encodeURIComponent(threadId)}/approvals`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: request.id, kind: request.kind, decision }) });
              if (!response.ok) throw new Error();
              draft.completed = true; draft.message = decision === 'accept' ? '已允许，等待任务更新' : '已拒绝，等待任务更新';
              draft.card.replaceChildren(element('p', '', draft.message));
            } catch { draft.uncertain = true; draft.card.append(element('p', 'list-error', '结果待确认，请查看电脑上的任务状态')); }
            finally { draft.pending = false; updateRecoveryGuardedControls(); }
          });
          actions.append(button);
        }
        card.append(actions);
      }
      fragment.append(card);
    }
  }
  let hasLiveActivityHeading = false;
  const renderedWorkScopes = new Set();
  const questionLookup = new Map();
  const answeredQuestions = answeredQuestionIds(view.turns || [], questionLookup);
  const asyncItemCounts = new Map(), asyncQuestionCounts = new Map();
  for (const sourceTurn of controlTurns) for (const sourceItem of sourceTurn.items || []) {
    if (sourceItem?.type !== 'agentMessage' || !sourceItem.questions?.length) continue;
    asyncItemCounts.set(sourceItem.id, (asyncItemCounts.get(sourceItem.id) || 0) + 1);
    for (const question of sourceItem.questions) asyncQuestionCounts.set(question.id, (asyncQuestionCounts.get(question.id) || 0) + 1);
  }
  const turnKeyCounts = new Map();
  for (const turn of view.turns || []) { const key = turn.viewKey || turn.id; turnKeyCounts.set(key, (turnKeyCounts.get(key) || 0) + 1); }
  const timelineTurns = view.turns || [], timelineKeys = new Set(timelineTurns.map(turn => turn.viewKey || turn.id));
  const controlOnlyTurns = live ? controlTurns.filter(turn => !timelineKeys.has(turn.viewKey || turn.id)) : [];
  for (const [turnIndex, turn] of [...timelineTurns, ...controlOnlyTurns].entries()) {
    const controlOnly = turnIndex >= timelineTurns.length;
    const turnDisplayKey = turn.viewKey || turn.id;
    const row = element('article', 'turn');
    if (turn.status === 'interrupted' || turn.status === 'failed') row.append(element('div', 'turn-meta', turn.status === 'interrupted' ? '已中断' : '失败'));
    const turnItems = turn.items || [];
    const controlTurn = live ? controlTurns.find(candidate => (candidate.viewKey || candidate.id) === (turn.viewKey || turn.id)) : null;
    const controlItems = new Map();
    for (const candidate of controlTurn?.items || []) controlItems.set(candidate?.id, controlItems.has(candidate?.id) ? null : candidate);
    const liveTurn = Boolean(controlTurn && controlTurn.status === 'inProgress');
    const lastMessageIndex = liveTurn ? turnItems.findLastIndex(item => item?.type === 'agentMessage' || item?.type === 'userMessage') : -1;
    const liveReasoningIndex = liveTurn ? turnItems.findLastIndex((item, index) => index > lastMessageIndex && item?.type === 'reasoning' && Array.isArray(item.summary) && item.summary.some(text => typeof text === 'string' && text.trim())) : -1;
    const finalIndex = turn.status === 'completed' ? turnItems.findLastIndex(item => item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim() && (item.phase === 'final_answer' || !item.phase)) : -1;
    let workGroup = null, workKey = null, activityGroup = null, workGroupIndex = 0;
    const itemIdCounts = new Map();
    for (const item of turnItems) itemIdCounts.set(item?.id, (itemIdCounts.get(item?.id) || 0) + 1);
    const isWorkActivity = (item, index) => item && item.status !== 'inProgress' && !item.questions?.length && finalIndex >= 0 && index < finalIndex && (['reasoning', 'subAgentActivity', 'collabAgentToolCall', 'mcpToolCall', 'commandExecution', 'fileChange', 'imageView', 'imageGeneration'].includes(item.type) || (item.type === 'agentMessage' && item.phase === 'commentary'));
    const groups = [];
    let currentGroup = null;
    for (const [index, item] of turnItems.entries()) {
      if (item?.type === 'reasoning' && !hasReasoningSummary(item)) continue;
      if (!['userMessage', 'agentMessage', 'reasoning', 'subAgentActivity', 'collabAgentToolCall', 'mcpToolCall', 'commandExecution', 'fileChange', 'imageView', 'imageGeneration', 'error'].includes(item?.type)) continue;
      if (!isWorkActivity(item, index)) { currentGroup = null; continue; }
      if (!currentGroup) groups.push(currentGroup = { ids: [], stable: true, items: [] });
      currentGroup.items.push(item);
      if (typeof item.id === 'string' && item.id && itemIdCounts.get(item.id) === 1) currentGroup.ids.push(item.id);
      else currentGroup.stable = false;
    }
    for (const group of groups) if (!group.stable) group.ids = [];
    const stableTurn = typeof turnDisplayKey === 'string' && turnDisplayKey && turnKeyCounts.get(turnDisplayKey) === 1;
    const scope = stableTurn ? JSON.stringify([selectedId, turnDisplayKey]) : JSON.stringify([selectedId, 'unstable-turn', turnIndex]);
    if (stableTurn) renderedWorkScopes.add(scope);
    const groupKeys = stableTurn ? reconcileWorkGroups(scope, groups, new Set([...immediateKeys.values(), ...(immediateWork ? [immediateWork.key] : [])])) : groups.map(() => { const key = JSON.stringify([scope, 'unstable', ++nextWorkGroupId]); transientWorkKeys.add(key); return key; });
    if (immediateWork?.threadId === selectedId) for (let index = 0; index < groupKeys.length; index++) {
      if (stableTurn && groups[index].stable) continue;
      const previousKey = immediateKeys.get(`${turnIndex}:${index}`);
      if (previousKey) { transientWorkKeys.delete(groupKeys[index]); groupKeys[index] = previousKey; transientWorkKeys.add(previousKey); }
    }
    if (immediateWork?.threadId === selectedId && immediateWork.turnIndex === turnIndex && groupKeys[immediateWork.groupIndex] && (!stableTurn || !groups[immediateWork.groupIndex].stable)) {
      const generated = groupKeys[immediateWork.groupIndex]; transientWorkKeys.delete(generated); groupKeys[immediateWork.groupIndex] = immediateWork.key; transientWorkKeys.add(immediateWork.key);
    }
    if (stableTurn) priorWorkGroups.set(scope, groups.map((group, index) => ({ ids: group.ids, key: groupKeys[index] })));
    for (const [itemIndex, item] of turnItems.entries()) {
      if (item?.type === 'reasoning' && !hasReasoningSummary(item)) continue;
      const stableVideoItem = typeof turnDisplayKey === 'string' && turnDisplayKey && turnKeyCounts.get(turnDisplayKey) === 1 && typeof item.id === 'string' && item.id && itemIdCounts.get(item.id) === 1;
      const videoOccurrence = index => stableVideoItem ? JSON.stringify([turnDisplayKey, item.id, index]) : Symbol('video');
      const types = { userMessage: '你', agentMessage: 'Codex', reasoning: '思考', subAgentActivity: '子智能体', collabAgentToolCall: '子智能体', mcpToolCall: '工具', commandExecution: '命令', fileChange: '文件变更', imageView: '图片', imageGeneration: '图片', error: '错误' };
      if (!types[item.type]) continue;
      const activity = isWorkActivity(item, itemIndex);
      if (!activity) { workGroup = null; workKey = null; }
      else if (!workGroup) {
        const groupIndex = workGroupIndex++;
        workKey = groupKeys[groupIndex];
        workGroup = element('details', 'work-activity'); workGroup.open = expandedWork.has(workKey);
        const key = workKey;
        workGroup.addEventListener('toggle', () => {
          if (!workGroupForToggle.isConnected) return;
          if (workGroupForToggle.open) {
            expandedWork.add(key);
            if (workGroupForToggle.dataset.lazy === 'true' && selectedId === viewThread) {
              const previousStatus = connection.textContent, previousState = connection.dataset.state, previousHistory = history.textContent;
              const immediate = transientWorkKeys.has(key) ? { threadId: viewThread, turnIndex, groupIndex, key } : null;
              const latest = live && streamView?.id === viewThread ? streamView : sourceView;
              const advanced = latest !== sourceView;
              if (advanced) cancelPendingRender();
              showState(latest, live, loadingPreview, advanced ? null : immediate);
              if (!advanced) { history.textContent = previousHistory; status(previousStatus, previousState); }
              const expanded = [...turns.querySelectorAll('details.work-activity')].find(node => node.dataset.workKey === key);
              expanded?.querySelector('summary')?.focus({ preventScroll: true });
            }
          } else expandedWork.delete(key);
        });
        const workGroupForToggle = workGroup;
        workGroup.dataset.workKey = key;
        workGroup.dataset.turnIndex = String(turnIndex); workGroup.dataset.groupIndex = String(groupIndex);
        workGroup.append(element('summary', 'work-title', '工作过程'));
        row.append(workGroup);
      }
      let destination = workGroup || row;
      const groupable = candidate => candidate && ['reasoning', 'commandExecution', 'fileChange', 'mcpToolCall'].includes(candidate.type) && (candidate.type !== 'reasoning' || hasReasoningSummary(candidate));
      const settled = candidate => groupable(candidate) && !['inProgress', 'failed', 'interrupted', 'declined'].includes(candidate.status) && !(candidate.type === 'subAgentActivity' && candidate.kind === 'interrupted');
      let start = itemIndex, end = itemIndex;
      while (start > 0 && settled(turnItems[start - 1])) start--;
      while (end + 1 < turnItems.length && settled(turnItems[end + 1])) end++;
      const followedByMessage = ['agentMessage', 'userMessage'].includes(turnItems[end + 1]?.type);
      const sequenceItems = turnItems.slice(start, end + 1);
      const commandSequence = sequenceItems.filter(entry => entry.type === 'commandExecution').length > 1 && sequenceItems.every(entry => entry.type === 'reasoning' || (entry.type === 'commandExecution' && (!entry.actions || !entry.actions.length)));
      const inSequence = settled(item) && end > start && (turn.status !== 'inProgress' || followedByMessage || commandSequence);
      if (!inSequence) activityGroup = null;
      else {
        if (!activityGroup || activityGroup.parent !== destination) {
          const key = JSON.stringify([selectedId, turnDisplayKey, item.id || itemIndex, 'activities']);
          const group = element('details', 'work-activity combined-activity');
          group.open = expandedActivities.has(key);
          group.addEventListener('toggle', () => { if (group.open) expandedActivities.add(key); else expandedActivities.delete(key); });
          const sequence = [];
          for (let i = itemIndex; i <= end; i++) sequence.push(turnItems[i]);
          const tail = live && turn.status === 'inProgress' && !turnItems.slice(itemIndex + sequence.length).some(candidate => candidate?.type === 'agentMessage' || candidate?.type === 'userMessage');
          const running = sequence.some(entry => ['commandExecution', 'mcpToolCall'].includes(entry.type) && entry.status === 'inProgress');
          const commands = sequence.filter(entry => entry.type === 'commandExecution');
          const hasRead = commands.some(entry => (entry.actions || []).some(action => action.type === 'read'));
          const hasSearch = commands.some(entry => (entry.actions || []).some(action => action.type === 'search' || action.type === 'listFiles'));
          const hasCommand = commands.some(entry => !Array.isArray(entry.actions) || !entry.actions.length);
          const operations = [sequence.some(entry => entry.type === 'fileChange') ? '编辑文件' : '', hasRead ? '读取文件' : '', hasSearch ? '搜索文件' : '', hasCommand ? '运行命令' : '', sequence.some(entry => entry.type === 'mcpToolCall') ? '调用工具' : '', sequence.some(entry => entry.type === 'imageView') ? '查看图片' : '', sequence.some(entry => entry.type === 'imageGeneration') ? '生成图片' : '', sequence.some(entry => ['subAgentActivity', 'collabAgentToolCall'].includes(entry.type)) ? '子智能体活动' : ''].filter(Boolean);
          const label = operations.join('、') || '思考';
          const summary = tail ? sequence.filter(entry => entry.type === 'reasoning').flatMap(entry => Array.isArray(entry.summary) ? entry.summary : []).filter(text => typeof text === 'string' && text.trim()).at(-1) : null;
          const liveTitle = summary?.trim().replace(/^\*\*(.+?)\*\*$/s, '$1') || (running ? '正在运行' : '正在思考');
          const liveGroup = tail && !commandSequence;
          const heading = element('summary', liveGroup ? 'work-title live-activity-title' : 'work-title', liveGroup ? liveTitle : commandSequence ? '运行了命令' : `${running ? '正在' : '已'}${label}`);
          if (commandSequence) heading.append(activityIcon('command'));
          group.append(heading);
          if (liveGroup) hasLiveActivityHeading = true;
          destination.append(group); activityGroup = { parent: destination, group };
        }
        destination = activityGroup.group;
      }
      let content = '';
      const images = live && Array.isArray(item.images) ? item.images.filter(handle => typeof handle === 'string' && /^[A-Za-z0-9_-]{32}$/.test(handle)) : [];
      const videos = live && Array.isArray(item.videos) ? item.videos.filter(media => media && typeof media.id === 'string' && /^[A-Za-z0-9_-]{32}$/.test(media.id) && typeof media.mime === 'string') : [];
      if (item.type === 'agentMessage' || item.type === 'userMessage') content = [item.text, item.imageCount > images.length ? `图片 ${item.imageCount - images.length} 张，暂不支持预览` : ''].filter(Boolean).join('\n');
      else if (item.type === 'imageView' || item.type === 'imageGeneration') content = images.length || videos.length ? '' : '暂不支持预览';
      else if (item.type === 'reasoning') content = (item.summary || []).join('\n');
      else if (item.type === 'subAgentActivity') {
        if (item.kind === 'interacted' && !workGroup) continue;
        const labels = { started: '开始工作', interacted: '已更新', interrupted: '已中断', completed: '已完成' };
        const name = item.agentPath?.split('/').filter(Boolean).at(-1) || '子智能体';
        const sameNamedEvent = candidate => ['started', 'completed'].includes(item.kind) && candidate?.type === 'subAgentActivity' && candidate.kind === item.kind && typeof candidate.agentPath === 'string' && Boolean(candidate.agentPath.split('/').filter(Boolean).at(-1));
        if (turn.status === 'inProgress' && !inSequence && sameNamedEvent(item) && sameNamedEvent(turnItems[itemIndex - 1])) continue;
        const names = [name];
        if (turn.status === 'inProgress' && !inSequence && sameNamedEvent(item)) {
          for (let i = itemIndex + 1; sameNamedEvent(turnItems[i]); i++) names.push(turnItems[i].agentPath.split('/').filter(Boolean).at(-1));
        }
        const line = element('div', 'activity-line', [[...new Set(names)].join('、'), labels[item.kind] || item.kind].filter(Boolean).join(' · '));
        line.dataset.activityIcon = 'agent'; line.append(activityIcon('agent')); destination.append(line);
        continue;
      }
      else if (item.type === 'collabAgentToolCall') {
        const labels = { inProgress: '进行中', completed: '已完成', failed: '失败', interrupted: '已中断' };
        const names = (item.agents || []).map(agent => agent.id?.split('/').filter(Boolean).at(-1)).filter(Boolean);
        const line = element('div', 'activity-line', [names.join('、') || '子智能体', labels[item.status] || item.status].filter(Boolean).join(' · '));
        line.dataset.activityIcon = 'agent'; line.append(activityIcon('agent')); destination.append(line);
        continue;
      }
      else if (item.type === 'mcpToolCall') {
        const labels = { inProgress: '正在调用', completed: '已调用', failed: '调用失败' };
        if (live && turn.status === 'inProgress' && item.status === 'inProgress') hasLiveActivityHeading = true;
        const sameCompletedTool = candidate => candidate?.type === 'mcpToolCall' && candidate.status === 'completed' && item.status === 'completed' && item.server && item.tool && candidate.server === item.server && candidate.tool === item.tool;
        if (turn.status === 'inProgress' && sameCompletedTool(turnItems[itemIndex - 1])) continue;
        let count = 1;
        if (turn.status === 'inProgress') while (sameCompletedTool(turnItems[itemIndex + count])) count++;
        const label = [labels[item.status] || '工具', [item.server, item.tool].filter(Boolean).join(' · ')].filter(Boolean).join(' ');
        const line = element('div', 'activity-line', count > 1 ? `${label}（${count} 次）` : label);
        line.dataset.activityIcon = 'tool'; line.append(activityIcon('tool')); destination.append(line);
        continue;
      }
      else if (item.type === 'commandExecution') {
        if (live && turn.status === 'inProgress' && item.status === 'inProgress') hasLiveActivityHeading = true;
        const key = JSON.stringify([selectedId, turnDisplayKey, item.id]);
        const details = element('details', 'command-details');
        details.open = expandedCommands.has(key);
        details.addEventListener('toggle', () => { if (details.open) expandedCommands.add(key); else expandedCommands.delete(key); });
        const labels = { inProgress: '正在运行', completed: '已完成', failed: '失败', declined: '已拒绝', interrupted: '已中断' };
        const actionLabels = { read: '读取', search: '搜索', listFiles: '列出文件' };
        const actions = (Array.isArray(item.actions) ? item.actions : []).map(action => [actionLabels[action.type], action.name].filter(Boolean).join(' ')).filter(Boolean);
        const status = labels[item.status] || '命令';
        const heading = element('summary', `command-title ${item.actions?.length === 1 && item.actions[0]?.type === 'read' ? 'activity-read' : 'activity-command'}`);
        const runningRead = item.status === 'inProgress' && item.actions?.length === 1 && item.actions[0]?.type === 'read';
        const completedRead = item.status === 'completed' && item.actions?.length === 1 && item.actions[0]?.type === 'read';
        const commandLabels = { inProgress: '正在运行命令', completed: '运行了命令', failed: '命令运行失败', declined: '命令已拒绝', interrupted: '命令已中断' };
        const title = runningRead || completedRead ? `${runningRead ? '正在读取' : '已读取'}${item.actions[0].name ? ` ${item.actions[0].name}` : '文件'}` : actions.length ? `${status} ${actions.join('、')}` : (commandLabels[item.status] || '命令');
        heading.append(element('span', 'command-title-text', title));
        heading.append(activityIcon(item.actions?.length === 1 && item.actions[0]?.type === 'read' ? 'read' : 'command'));
        details.append(heading);
        if (item.command) details.append(element('pre', 'item-code', item.command));
        if (item.output) details.append(element('pre', 'item-code', item.output));
        else if (item.outputRef) renderToolOutput(details, item, live ? toolOutputEntries.get(toolOutputKey(selectedId, turn.viewKey ?? turn.id, item.id)) : null);
        destination.append(details);
        continue;
      }
      else if (item.type === 'fileChange') {
        if (live && turn.status === 'inProgress' && item.status === 'inProgress') hasLiveActivityHeading = true;
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const key = JSON.stringify([selectedId, turnDisplayKey, item.id]);
        const details = element('details', 'file-changes');
        details.open = expandedChanges.has(key);
        details.addEventListener('toggle', () => { if (details.open) expandedChanges.add(key); else expandedChanges.delete(key); });
        const stats = diffStats(changes);
        const filename = changes.length === 1 && typeof changes[0]?.path === 'string' ? changes[0].path.split(/[\\/]/).filter(Boolean).at(-1) : '';
        const changeLabels = { inProgress: '正在编辑', completed: '已编辑', failed: '编辑失败', declined: '编辑已拒绝', interrupted: '编辑已中断' };
        const changeLabel = changeLabels[item.status] || '文件变更';
        const title = changes.length ? `${changeLabel} ${filename || `${changes.length} 个文件`}${stats ? ` +${stats.added} -${stats.removed}` : ''}` : changeLabel;
        const heading = element('summary', 'file-changes-title', title); heading.append(activityIcon('edit')); details.append(heading);
        if (!changes.length) details.append(element('p', 'file-change-empty', '文件列表不可用'));
        for (const [changeIndex, change] of changes.entries()) {
          const file = element('div', 'file-change');
          const fileKey = JSON.stringify([key, changeIndex, change?.path]);
          const fileHeading = element(live ? 'button' : 'span', 'file-change-path', typeof change?.path === 'string' && change.path ? change.path : '未知文件');
          if (live) fileHeading.type = 'button';
          file.append(fileHeading);
          if (typeof change?.path === 'string' && change.path) fileTargets.set(change.path, { details, file, key, fileKey, workGroup, workKey });
          if (live && typeof turn.id === 'string' && typeof item.id === 'string') {
            const fileThreadId = selectedId;
            const open = () => openFilePreview(change.path, fileThreadId, turn.id, item.id, changeIndex);
            fileHeading.addEventListener('click', open);
            if (typeof change?.path === 'string' && change.path) fileTargets.set(change.path, { open });
          }
          if (typeof change?.diff === 'string' && change.diff) {
            const limit = 200000;
            const diff = element('details', 'file-diff-details');
            diff.open = expandedChanges.has(fileKey);
            diff.addEventListener('toggle', () => { if (diff.open) expandedChanges.add(fileKey); else expandedChanges.delete(fileKey); });
            diff.append(element('summary', 'file-diff-title', '查看差异'), element('pre', 'file-change-diff', change.diff.slice(0, limit)));
            if (change.diff.length > limit) diff.append(element('p', 'file-change-empty', '差异过长，已截断'));
            file.append(diff);
          } else file.append(element('p', 'file-change-empty', '差异不可用'));
          details.append(file);
        }
        destination.append(details);
        continue;
      }
      else if (item.type === 'error') content = item.message || '';
      const asyncQuestions = item.type === 'agentMessage' && Array.isArray(item.questions) ? item.questions : [];
      const controlItem = controlItems.get(item.id);
      const pendingIds = Array.isArray(controlItem?.pendingQuestionIds) ? controlItem.pendingQuestionIds : null;
      const knownPending = pendingIds !== null && new Set(pendingIds).size === pendingIds.length && asyncQuestions.every(question => typeof question.id === 'string' && question.id && asyncQuestionCounts.get(question.id) === 1) && pendingIds.every(id => typeof id === 'string' && asyncQuestions.filter(question => question.id === id).length === 1);
      const formQuestions = knownPending ? asyncQuestions.filter(question => pendingIds.includes(question.id)) : asyncQuestions;
      const remoteSubmitting = Array.isArray(controlItem?.submittingQuestionIds) && formQuestions.some(question => controlItem.submittingQuestionIds.includes(question.id));
      const pendingAsync = asyncQuestions.length && live && !unknownQuestionItems.has(item.id) && controlItem && asyncItemCounts.get(item.id) === 1 && (remoteSubmitting || (pendingIds !== null ? knownPending && formQuestions.length > 0 : controlTurn === controlTurns.at(-1) && !turnItems.slice(itemIndex + 1).some(entry => entry.type === 'userMessage' || entry.questions?.length)));
      const skipKey = formQuestions.length === 1 && item.id ? JSON.stringify([historyScope?.hostId || '', historyScope?.deviceId || '', selectedId, turn.id, item.id, formQuestions[0].id]) : null;
      if (skipKey && !pendingAsync) skippedAsyncQuestions.delete(skipKey);
      const showAsyncForm = pendingAsync && (remoteSubmitting || !(skipKey && skippedAsyncQuestions.has(skipKey)));
      const answeredAsync = asyncQuestions.length && ((knownPending && !pendingIds.length) || asyncQuestions.every(question => answeredQuestions.has(question.id)));
      if (showAsyncForm || answeredAsync) content = questionBodyWithoutLabels(content, asyncQuestions);
      if (!content && !images.length && !videos.length && !asyncQuestions.length) continue;
      if (item.type === 'reasoning') {
        const summaries = (Array.isArray(item.summary) ? item.summary : []).filter(text => typeof text === 'string' && text.trim());
        if (!summaries.length) continue;
        if (liveTurn && (itemIndex > lastMessageIndex || !inSequence)) continue;
        const key = JSON.stringify([selectedId, turnDisplayKey, item.id]);
        const details = element('details', 'thinking');
        details.open = expandedThinking.has(key);
        details.addEventListener('toggle', () => { if (details.open) expandedThinking.add(key); else expandedThinking.delete(key); });
        details.append(element('summary', 'thinking-title', '思考'));
        details.append(element('p', 'item-text thinking-content', content));
        destination.append(details);
        continue;
      }
      const section = element('div', item.type === 'userMessage' ? 'item user-message' : item.type === 'agentMessage' ? 'item assistant-message' : 'item');
      if (item.type !== 'userMessage' && item.type !== 'agentMessage' && !(['imageView', 'imageGeneration'].includes(item.type) && (images.length || videos.length))) section.append(element('div', 'item-label', types[item.type]));
      else section.setAttribute('aria-label', item.type === 'userMessage' ? '你' : 'Codex');
      const questionReply = item.type === 'userMessage' && !images.length ? questionReplyParts(view.turns || [], turnIndex, itemIndex, content, item.questionReplyIds, questionLookup) : null;
      if (questionReply) {
        const question = element('button', 'question-reply-question', questionReply.question); question.type = 'button';
        question.setAttribute('aria-expanded', 'false'); question.title = questionReply.question;
        question.addEventListener('click', () => { const expanded = question.getAttribute('aria-expanded') === 'true'; question.setAttribute('aria-expanded', String(!expanded)); });
        section.append(question, element('p', 'item-text question-reply-answer', questionReply.answer));
      } else if (content && item.type === 'userMessage' && (content.length > 600 || content.split('\n').length > 10)) {
        const key = JSON.stringify([selectedId, turnDisplayKey, item.id || itemIndex]);
        const text = element('p', 'item-text', content);
        const toggle = element('button', 'message-expand', expandedMessages.has(key) ? '收起' : '查看更多');
        toggle.type = 'button';
        text.classList.toggle('message-clamped', !expandedMessages.has(key));
        toggle.addEventListener('click', () => {
          if (expandedMessages.has(key)) expandedMessages.delete(key); else expandedMessages.add(key);
          text.classList.toggle('message-clamped', !expandedMessages.has(key));
          toggle.textContent = expandedMessages.has(key) ? '收起' : '查看更多';
        });
        section.append(text, toggle);
      } else if (content) section.append(item.type === 'agentMessage' ? assistantContent(content, live && turn.id && item.id ? { threadId: selectedId, turnId: turn.id, itemId: item.id } : null) : element('p', item.type === 'commandExecution' ? 'item-code' : 'item-text', content));
      if (item.type === 'userMessage' && item.questionReplyPendingIds?.length) section.append(element('p', 'file-change-empty', '结果待确认'));
      const asyncCardSignature = JSON.stringify([formQuestions, remoteSubmitting]);
      const asyncCardKey = JSON.stringify(['async', item.id]);
      const previousCard = previousQuestionCards?.get(asyncCardKey);
      const reuseAsyncCard = showAsyncForm && !reuseQuestions && previousCard?.signature === asyncCardSignature && questionPanel.contains(previousCard.card);
      if (reuseAsyncCard) retainQuestionCard(previousCard);
      if (showAsyncForm && !reuseQuestions && !reuseAsyncCard) {
        const firstCardControl = questionControls.length;
        const threadId = selectedId, key = JSON.stringify([historyScope?.hostId || '', historyScope?.deviceId || '', threadId, 'async', item.id]);
        let draft = inputDrafts.get(key);
        if (!draft) { draft = { answers: Object.create(null), pending: false }; inputDrafts.set(key, draft); }
        reconcileQuestionDraft(draft, formQuestions);
        if (knownPending && draft.pending && draft.sentQuestionIds?.every(id => !pendingIds.includes(id))) {
          draft.pending = false; draft.feedback = ''; draft.outcome = ''; draft.attempt = null;
        }
        const scopeGeneration = historyScopeGeneration, deviceId = currentDeviceId;
        const writeKey = JSON.stringify([deviceId, scopeGeneration, threadId]);
        if (draft.pending && draft.pendingGeneration !== scopeGeneration) { draft.feedback = '结果暂不确定，请查看电脑上的任务状态'; draft.outcome = '结果待确认'; }
        const card = element('div', 'question-card');
        const heading = element('div', 'question-card-heading');
        heading.append(element('div', 'question-card-title', '问题'));
        const collapse = element('button', 'question-collapse', draft.collapsed ? '展开问题' : '收起问题');
        collapse.type = 'button'; collapse.setAttribute('aria-expanded', String(!draft.collapsed));
        heading.append(collapse); card.append(heading);
        const form = element('form', 'user-input-form');
        const isCurrentScope = () => selectedId === threadId && currentDeviceId === deviceId && historyScopeGeneration === scopeGeneration && inputDrafts.get(key) === draft;
        const isCurrentForm = () => isCurrentScope() && draft.controls?.form === form && questionPanel.contains?.(form) !== false;
        const canSubmit = () => isCurrentForm() && connected && questionLiveConfirmed && !unknownQuestionItems.has(item.id);
        form.hidden = Boolean(draft.collapsed);
        collapse.addEventListener('click', () => {
          if (!isCurrentForm()) return;
          draft.collapsed = !draft.collapsed;
          form.hidden = draft.collapsed;
          collapse.textContent = draft.collapsed ? '展开问题' : '收起问题';
          collapse.setAttribute('aria-expanded', String(!draft.collapsed));
        });
        for (const question of formQuestions) {
          const group = element('fieldset', 'user-input-question'); group.append(element('legend', '', question.question));
          const compact = question.options.length >= 2 && question.options.length <= 4 && question.options.every(option => option.length <= 12);
          const choices = element('div', `user-input-choices${compact ? ' compact' : ''}`);
          for (const option of question.options) {
            const label = element('label', 'user-input-option'); const radio = element('input'); radio.type = 'radio'; radio.name = question.id; radio.value = option;
            radio.checked = draft.answers[question.id] === option;
            radio.addEventListener('change', () => {
              if (!isCurrentForm()) return;
              draft.answers[question.id] = option;
              const other = group.querySelectorAll('.user-input-text')[0];
              if (other) other.value = '';
            });
            label.append(radio, element('span', '', option)); choices.append(label);
          }
          if (question.options.length) group.append(choices);
          const input = element('input', 'user-input-text'); input.type = 'text'; input.placeholder = question.options.length ? '其他回答' : '输入回答';
          input.dataset.inputDraftKey = key; input.dataset.inputQuestionId = question.id; input.dataset.inputQuestionSchema = questionInputSchema(question);
          input.value = question.options.includes(draft.answers[question.id]) ? '' : (draft.answers[question.id] || '');
          input.addEventListener('input', () => { if (!isCurrentForm()) return; draft.answers[question.id] = input.value; for (const radio of group.querySelectorAll('input[type=radio]')) radio.checked = false; });
          group.append(input); form.append(group);
        }
        const submit = element('button', 'approval-accept', draft.pending ? (draft.outcome || '正在提交') : remoteSubmitting ? '结果待确认' : '提交'); submit.type = 'submit'; guardRecoveryControl(submit, () => draft.pending || remoteSubmitting || asyncQuestionWrites.has(writeKey) || !canSubmit());
        questionControls.push(recoveryGuardedControls.at(-1));
        const feedback = element('p', 'list-error', draft.feedback || (remoteSubmitting ? '回答结果待确认，请查看电脑上的任务状态' : ''));
        const actions = element('div', 'question-actions');
        if (skipKey) {
          const skip = element('button', 'question-skip', '跳过'); skip.type = 'button'; guardRecoveryControl(skip, () => draft.pending || remoteSubmitting || !canSubmit()); questionControls.push(recoveryGuardedControls.at(-1));
          skip.addEventListener('click', () => {
            if (draft.pending || remoteSubmitting || !canSubmit() || skipKey !== JSON.stringify([historyScope?.hostId || '', historyScope?.deviceId || '', selectedId, turn.id, item.id, formQuestions[0].id])) return;
            if (skippedAsyncQuestions.size >= 1024) skippedAsyncQuestions.delete(skippedAsyncQuestions.values().next().value);
            skippedAsyncQuestions.add(skipKey); delete draft.answers[formQuestions[0].id]; card.remove();
            if (!questionPanel.querySelector('.question-card, .pending-request')) questionPanel.hidden = true;
          });
          actions.append(skip);
        }
        actions.append(submit); form.append(actions, feedback);
        draft.controls = { submit, status: feedback, form };
        form.addEventListener('submit', async event => {
          event.preventDefault();
          if (draft.pending || remoteSubmitting || asyncQuestionWrites.has(writeKey) || !canSubmit() || recoveryBlocksWrite()) return;
          if (!formQuestions.every(q => draft.answers[q.id]?.trim())) { feedback.textContent = '请回答所有问题'; return; }
          const attempt = {}; draft.attempt = attempt;
          draft.pending = true; draft.pendingGeneration = scopeGeneration; draft.sentQuestionIds = formQuestions.map(question => question.id); submit.disabled = true;
          const write = { attempt, draft, controller: new AbortController() }; asyncQuestionWrites.set(writeKey, write);
          updateRecoveryGuardedControls();
          try {
            const answers = Object.fromEntries(formQuestions.map(question => [question.id, draft.answers[question.id]]));
            const response = await scopedFetch(`/api/threads/${encodeURIComponent(threadId)}/async-question`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: write.controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: item.id, answers }) });
            if (write.controller.signal.aborted || !isCurrentScope() || draft.attempt !== attempt) return;
            if (!response.ok) throw new Error();
            draft.feedback = '已提交，等待任务更新'; draft.outcome = '已提交';
          } catch { if (write.controller.signal.aborted || !isCurrentScope() || draft.attempt !== attempt) return; draft.feedback = '结果暂不确定，请查看电脑上的任务状态'; draft.outcome = '结果待确认'; }
          finally {
            if (asyncQuestionWrites.get(writeKey) === write) asyncQuestionWrites.delete(writeKey);
            if (isCurrentScope()) updateRecoveryGuardedControls();
          }
          draft.controls.status.textContent = draft.feedback;
          draft.controls.submit.textContent = draft.outcome;
        });
        card.append(form); questionNodes.push(card); pendingQuestionCount++;
        questionCards.set(asyncCardKey, { key: asyncCardKey, kind: 'async', itemId: item.id, signature: asyncCardSignature, card, controls: questionControls.slice(firstCardControl) });
      }
      if (!content && !images.length && !videos.length) continue;
      if (item.type === 'userMessage' && images.length) {
        const group = element('div', 'user-message-group');
        const imageRow = element('div', 'user-message-images');
        for (const handle of images) imageRow.append(imagePreviewButton(handle, selectedId, true));
        group.append(imageRow);
        if (content || asyncQuestions.length || videos.length) group.append(section);
        for (const [index, media] of videos.entries()) section.append(videoPreviewButton(media, selectedId, videoOccurrence(index)));
        destination.append(group);
        continue;
      }
      for (const handle of images) section.append(imagePreviewButton(handle, selectedId, false, item.type === 'imageView' ? '已查看 1 张图像' : '查看图片'));
      for (const [index, media] of videos.entries()) section.append(videoPreviewButton(media, selectedId, videoOccurrence(index)));
      destination.append(section);
    }
    if (liveReasoningIndex >= 0) {
      const item = turnItems[liveReasoningIndex];
      const summaries = item.summary.filter(text => typeof text === 'string' && text.trim());
      const heading = summaries[0].trim().replace(/^\*\*(.+?)\*\*$/s, '$1');
      if (summaries.length === 1) row.append(element('div', 'thinking-title live-activity-title', heading));
      else {
        const key = JSON.stringify([selectedId, turnDisplayKey, item.id]);
        const details = element('details', 'thinking');
        details.open = expandedThinking.has(key);
        details.addEventListener('toggle', () => { if (details.open) expandedThinking.add(key); else expandedThinking.delete(key); });
        details.append(element('summary', 'thinking-title live-activity-title', heading), element('p', 'item-text thinking-content', summaries.slice(1).join('\n')));
        row.append(details);
      }
      hasLiveActivityHeading = true;
    }
    if (liveTurn && running.some(candidate => candidate.id === turn.id) && !hasLiveActivityHeading) {
      row.append(element('div', 'thinking-title live-activity-title live-thinking', '正在思考'));
    }
    if (!controlOnly) fragment.append(row);
  }
  if (live && !reuseQuestions) for (const itemId of unknownQuestionItems) {
    const key = JSON.stringify(['async', itemId]), previousCard = previousQuestionCards?.get(key);
    if (previousCard && questionPanel.contains(previousCard.card) && !questionCards.has(key)) retainQuestionCard(previousCard);
  }
  for (const [scope, groups] of priorWorkGroups) if (!renderedWorkScopes.has(scope)) {
    for (const group of groups) expandedWork.delete(group.key);
    priorWorkGroups.delete(scope);
  }
  const focusedInput = document.activeElement;
  const inputFocus = !reuseQuestions && renderedQuestionPanel?.scope === questionScope && focusedInput?.dataset?.inputDraftKey ? { key: focusedInput.dataset.inputDraftKey, question: focusedInput.dataset.inputQuestionId, schema: focusedInput.dataset.inputQuestionSchema, start: focusedInput.selectionStart, end: focusedInput.selectionEnd, direction: focusedInput.selectionDirection } : null;
  const oldQuestionScroll = questionPanel.scrollTop;
  turns.replaceChildren(fragment);
  if (live && sourceView.id === selectedId) syncOutgoingWithView(sourceView); else renderOutgoingMessages();
  pruneVideoPreviews();
  for (const video of playingVideos) if (video.isConnected && video.paused) void video.play().catch(() => {});
  if (workFocus) {
    let target = [...turns.querySelectorAll('details.work-activity')].find(node => node.dataset.workKey === workFocus.key);
    for (const index of workFocus.path) target = target?.children[index];
    if (target?.tagName === workFocus.tag && target.className === workFocus.className && target.textContent === workFocus.text) target.focus?.({ preventScroll: true });
  }
  if (!reuseQuestions) {
    // Keep retained editors attached. Moving them through a fragment would
    // dismiss the iOS keyboard even when the same nodes are appended again.
    const wanted = new Set(questionNodes);
    for (const child of [...questionPanel.children]) if (!wanted.has(child)) child.remove();
    for (let index = 0; index < questionNodes.length; index++) {
      const card = questionNodes[index];
      if (questionPanel.contains(card)) continue;
      const next = questionNodes.slice(index + 1).find(node => questionPanel.contains(node));
      if (next) next.before(card); else questionPanel.append(card);
    }
    questionPanel.hidden = pendingQuestionCount === 0;
    renderedQuestionPanel = { signature: questionSignature, scope: questionScope, controls: questionControls, cards: questionCards, live };
  }
  updateRecoveryGuardedControls();
  if (Number.isFinite(oldQuestionScroll)) questionPanel.scrollTop = oldQuestionScroll;
  if (inputFocus) {
    const replacement = [...questionPanel.querySelectorAll('.user-input-text')].find(input => input.dataset.inputDraftKey === inputFocus.key && input.dataset.inputQuestionId === inputFocus.question && input.dataset.inputQuestionSchema === inputFocus.schema);
    const form = replacement?.closest('form');
    if (replacement && replacement !== focusedInput && !replacement.disabled && !form?.hidden && !form?.querySelector('button[type="submit"]')?.disabled) { replacement.focus({ preventScroll: true }); replacement.setSelectionRange(inputFocus.start, inputFocus.end, inputFocus.direction); }
  }
  if (conversation) {
    if (followLatest) conversation.scrollTop = conversation.scrollHeight;
    else if (Number.isFinite(oldScrollTop)) conversation.scrollTop = oldScrollTop;
    if (historyScrollThread !== selectedId) { historyScrollThread = selectedId; previousHistoryScrollTop = conversation.scrollTop; }
  }
  reconcileOutgoing(view);
  updateHistoryControl();
  updateScrollButton();
  renderSummary(view, fileTargets);
  status(live ? '已连接' : '仅查看历史', live ? 'ready' : 'error');
}
// A dispatched placeholder must not survive once the same text shows up as a
// real user turn, otherwise it lingers under the conversation as a duplicate.
function reconcileOutgoing(view) {
  const key = outgoingScopeKey(view.id), entries = outgoingMessages.get(key);
  if (!entries?.length) return;
  const delivered = new Set();
  for (const turn of Array.isArray(view.turns) ? view.turns : []) {
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      if (item?.type === 'userMessage' && typeof item.text === 'string') delivered.add(item.text);
    }
  }
  if (!delivered.size) return;
  const remaining = entries.filter(entry => !(entry.messageDispatched && delivered.has(entry.text)));
  if (remaining.length === entries.length) return;
  if (remaining.length) outgoingMessages.set(key, remaining); else outgoingMessages.delete(key);
  renderOutgoingMessages();
  updateComposer();
}
let summaryFilesExpanded = false, summaryAgentsExpanded = false;
function renderSummary(view, fileTargets = new Map()) {
  const agents = new Map(), files = new Map();
  for (const turn of view.turns || []) for (const item of turn.items || []) {
    if (item.type === 'subAgentActivity' && item.agentPath) agents.set(item.agentPath, { status: item.kind || '', id: item.agentThreadId || agents.get(item.agentPath)?.id });
    if (item.type === 'collabAgentToolCall') for (const agent of item.agents || []) if (agent.id) agents.set(agent.id, { status: agent.status || '' });
    if (item.type === 'fileChange') for (const change of item.changes || []) if (typeof change.path === 'string') files.set(change.path, item.status || '');
  }
  const fragment = document.createDocumentFragment();
  function section(name, values, empty, collapsible = false, agentSection = false) {
    const group = element(collapsible ? 'details' : 'section', 'summary-section');
    if (collapsible) { group.open = agentSection ? summaryAgentsExpanded : summaryFilesExpanded; group.addEventListener('toggle', () => { if (agentSection) summaryAgentsExpanded = group.open; else summaryFilesExpanded = group.open; }); }
    const heading = element(collapsible ? 'summary' : 'h2', 'summary-heading');
    heading.append(element('span', 'summary-heading-label', collapsible ? `${name} · ${values.length}` : name));
    if (collapsible) heading.append(chevronIcon());
    group.append(heading);
    if (!values.length) group.append(element('p', 'summary-empty', empty));
    for (const [name, detail] of values) {
      const row = element('div', 'summary-row');
      const target = !agentSection ? fileTargets.get(name) : (uuid.test(detail?.id || '') && selectedId ? { open: () => openAgentHistory(displayName, selectedId, detail.id) } : null);
      const parts = name.split('/').filter(Boolean);
      const displayName = parts.at(-1) || name;
      const label = element(target?.open ? 'button' : 'span', target?.open ? 'summary-name summary-file-link' : 'summary-name', displayName);
      label.title = name;
      if (target?.open) { label.type = 'button'; label.addEventListener('click', () => target.open()); }
      const statusLabels = { started: '进行中', interacted: '进行中', completed: '已完成', interrupted: '已中断', inProgress: '进行中', failed: '失败' };
      const description = agentSection ? (statusLabels[detail.status] || '') : (parts.length > 1 ? name.slice(0, name.lastIndexOf('/')) : '');
      const info = element('div', 'summary-row-content');
      info.append(label);
      if (description) info.append(element('span', 'summary-detail', description));
      row.append(info);
      group.append(row);
    }
    fragment.append(group);
  }
  const activeAgentStates = new Set(['started', 'interacted', 'inProgress']);
  const sortedAgents = [...agents].sort((a, b) => Number(activeAgentStates.has(b[1].status)) - Number(activeAgentStates.has(a[1].status)));
  section('子智能体', sortedAgents, view.history?.complete ? '暂无活动' : '当前加载内容中暂无活动', true, true);
  section('文件变更', [...files], view.history?.complete ? '暂无变更' : '当前加载内容中暂无变更', true);
  summaryContent.replaceChildren(fragment);
}
let streamView = null, streamSeq = null;
let pendingRender = null, renderFrame = null, renderGeneration = 0;
function cancelPendingRender() {
  renderGeneration++;
  if (renderFrame !== null) window.cancelAnimationFrame?.(renderFrame);
  renderFrame = null; pendingRender = null;
}
function flushPendingRender() {
  const view = pendingRender;
  cancelPendingRender();
  if (view && view.id === selectedId && streamView === view) { rememberView(view); showState(view); }
}
function queueDeltaRender(view) {
  pendingRender = view;
  if (renderFrame !== null) return;
  if (typeof window.requestAnimationFrame !== 'function') return flushPendingRender();
  const generation = renderGeneration;
  renderFrame = window.requestAnimationFrame(() => {
    if (generation !== renderGeneration) return;
    renderFrame = null; flushPendingRender();
  });
}
function controlSignature(view) {
  return JSON.stringify([view.runtimeStatus, view.collaborationMode, view.model, view.reasoningEffort, view.goal, view.requests, view.unknownQuestionItemIds,
    questionControlTurns(view).map(turn => [turn.viewKey || turn.id, turn.status, (turn.items || []).filter(item => item?.questions?.length || item?.type === 'userMessage').map(item => [item.id, item.type, item.questions, item.pendingQuestionIds, item.questionReplyIds, item.submittingQuestionIds, item.questionReplyPendingIds])])]);
}
const recentViews = new Map();
let recentViewBytes = 0;
function clearRecentViews() { recentViews.clear(); recentViewBytes = 0; }
function rememberView(view) {
  try {
    const safe = { id: view.id, title: view.title, history: view.history, turns: view.turns.map(turn => ({ ...turn, items: (turn.items || []).map(item => { const { images, videos, ...rest } = item; return rest; }) })) };
    const serialized = JSON.stringify(safe);
    const bytes = new TextEncoder().encode(serialized).byteLength;
    const old = recentViews.get(view.id);
    if (old) { recentViewBytes -= old.bytes; recentViews.delete(view.id); }
    if (bytes > 4 * 1024 * 1024) return;
    while (recentViews.size >= 3 || recentViewBytes + bytes > 8 * 1024 * 1024) { const key = recentViews.keys().next().value; recentViewBytes -= recentViews.get(key).bytes; recentViews.delete(key); }
    recentViews.set(view.id, { view: JSON.parse(serialized), bytes, expires: Date.now() + 30000 });
    recentViewBytes += bytes;
  } catch { /* Caching must never interrupt live updates. */ }
}
function recentView(id) {
  const entry = recentViews.get(id);
  if (!entry) return null;
  if (Date.now() >= entry.expires) { recentViewBytes -= entry.bytes; recentViews.delete(id); return null; }
  return entry.view;
}
function handleEvent(block) {
  let type = 'message'; const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) type = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return false;
  const payload = JSON.parse(data.join('\n'));
  if (type === 'sidebar-status') { acceptSidebarStatuses(payload); return false; }
  if (type === 'thread-list-changed') { refreshChangedThreadList(); return false; }
  if (type === 'state') {
    cancelPendingRender();
    if (!payload.conversation || payload.conversation.id !== selectedId || !Array.isArray(payload.conversation.turns)) throw new Error('状态无效');
    if (payload.seq !== undefined && (!Number.isSafeInteger(payload.seq) || payload.seq < 1 || (streamSeq !== null && payload.seq <= streamSeq))) throw new Error('状态版本错误');
    recoverableHistoryId = null;
    historyRecoveryAttempts.delete(recoveryKey(currentDeviceId, selectedId));
    unboundAcceptedRetries.delete(recoveryKey(currentDeviceId, selectedId));
    missingAttemptCancellations.delete(recoveryKey(currentDeviceId, selectedId));
    if (recoveryStream?.threadId === selectedId) recoveryStream.liveState = true;
    const recovery = recoveries.get(recoveryKey(currentDeviceId, selectedId));
    if (recovery && ['pending', 'awaiting-state', 'unknown'].includes(recovery.status)) { recovery.liveStream = recoveryStream; finishAcceptedRecovery(selectedId, currentDeviceId, recoveryStream); }
    streamView = payload.conversation; streamSeq = payload.seq ?? null;
    rememberView(streamView);
    showState(streamView); return true;
  } else if (type === 'state-delta') {
    const { baseSeq, seq, metadata, order, changed, itemChanges = [], keyField = 'id' } = payload;
    if (!['id', 'viewKey'].includes(keyField)) throw new Error('状态无效');
    if (!streamView || streamSeq === null || baseSeq !== streamSeq || !Number.isSafeInteger(seq) || seq !== baseSeq + 1 || !metadata || metadata.id !== selectedId || !Array.isArray(order) || !Array.isArray(changed) || !Array.isArray(itemChanges) || order.length > 100000 || new Set(order).size !== order.length || order.some(id => typeof id !== 'string' || !id)) throw new Error('状态版本错误');
    const turns = new Map(streamView.turns.map(turn => [turn[keyField], turn])), ids = new Set(order);
    if (turns.size !== streamView.turns.length || streamView.turns.some(turn => !turn || typeof turn[keyField] !== 'string' || !turn[keyField]) || changed.some(turn => !turn || typeof turn[keyField] !== 'string' || !ids.has(turn[keyField])) || new Set(changed.map(turn => turn[keyField])).size !== changed.length) throw new Error('状态无效');
    for (const turn of changed) turns.set(turn[keyField], turn);
    const changedTurns = new Set(changed.map(turn => turn[keyField])), patchedTurns = new Set();
    for (const patch of itemChanges) {
      if (!patch || typeof patch.id !== 'string' || !ids.has(patch.id) || changedTurns.has(patch.id) || patchedTurns.has(patch.id) || !patch.metadata || patch.metadata[keyField] !== patch.id || !Array.isArray(patch.order) || !Array.isArray(patch.changed) || patch.order.length > 100000 || patch.order.some(id => typeof id !== 'string' || !id) || new Set(patch.order).size !== patch.order.length) throw new Error('条目状态无效');
      const previous = turns.get(patch.id);
      if (!previous || !Array.isArray(previous.items)) throw new Error('条目状态缺失');
      if (patch.metadata.id !== previous.id) throw new Error('条目状态无效');
      const items = new Map(previous.items.map(item => [item.id, item])), itemIds = new Set(patch.order);
      if (items.size !== previous.items.length || previous.items.some(item => !item || typeof item.id !== 'string' || !item.id) || patch.changed.some(item => !item || typeof item.id !== 'string' || !itemIds.has(item.id)) || new Set(patch.changed.map(item => item.id)).size !== patch.changed.length) throw new Error('条目状态无效');
      for (const item of patch.changed) items.set(item.id, item);
      if (patch.order.some(id => !items.has(id))) throw new Error('条目状态缺失');
      turns.set(patch.id, { id: patch.metadata.id, ...(keyField === 'viewKey' ? { viewKey: patch.metadata.viewKey } : {}), status: patch.metadata.status, startedAt: patch.metadata.startedAt, items: patch.order.map(id => items.get(id)) });
      patchedTurns.add(patch.id);
    }
    if (order.some(id => !turns.has(id))) throw new Error('状态缺失');
    const previousControls = controlSignature(streamView);
    streamView = { id: metadata.id, title: metadata.title, runtimeStatus: metadata.runtimeStatus, collaborationMode: metadata.collaborationMode, model: metadata.model, reasoningEffort: metadata.reasoningEffort, goal: metadata.goal, history: metadata.history, requests: metadata.requests, pendingQuestionTurns: metadata.pendingQuestionTurns, unknownQuestionItemIds: metadata.unknownQuestionItemIds, turns: order.map(id => turns.get(id)) };
    streamSeq = seq;
    if (controlSignature(streamView) !== previousControls) { cancelPendingRender(); rememberView(streamView); showState(streamView); }
    else queueDeltaRender(streamView);
    return true;
  } else if (type === 'history') { cancelPendingRender(); if (!payload.conversation || payload.conversation.id !== selectedId || !Array.isArray(payload.conversation.turns)) throw new Error('状态无效'); if (recoveryStream) recoveryStream.liveState = false; recoverableHistoryId = selectedId; streamView = null; streamSeq = null; showState(payload.conversation, false); scheduleHistoryRecovery(selectedId, currentDeviceId); return false; }
  else if (type === 'status' && payload.status === 'unavailable') { cancelPendingRender(); if (recoveryStream) recoveryStream.liveState = false; streamView = null; streamSeq = null; updateLiveTaskStatus(selectedId, 'unknown'); if (displayedHistoryId === selectedId && selectedId) status('仅查看历史', 'error'); else fail('任务状态暂不可用'); }
  return false;
}
// Opening one IPC follower per tap made fast switching stutter on both ends.
// The old stream is dropped immediately; the new one waits for the tap to
// settle so a swipe across the list opens a single session.
let pendingConnectTimer = null;
let pendingConnectDiagnostic = null;
function scheduleThreadConnect(id, diagnostic = beginConnectionDiagnostic('selection')) {
  clearTimeout(pendingConnectTimer);
  pendingConnectDiagnostic?.close('superseded');
  active?.abort(); active = undefined; recoveryStream = null;
  pendingConnectDiagnostic = currentConnectionDiagnostic = diagnostic;
  diagnostic.mark('debounce');
  if (!messageInput.disabled) diagnostic.mark('input-enabled');
  pendingConnectTimer = setTimeout(() => {
    pendingConnectTimer = null;
    pendingConnectDiagnostic = null;
    if (selectedId !== id || newDraft) { diagnostic.close('superseded'); return; }
    void connect(id, 0, false, diagnostic);
  }, 220);
  pendingConnectTimer?.unref?.();
}
async function connect(id, attempt = 0, preserveView = false, diagnostic = beginConnectionDiagnostic(attempt ? 'reconnect' : 'direct')) {
  diagnostic.mark('connect');
  const statusDevice = modelDeviceGeneration, statusWrite = modelWriteGeneration;
  const checkModelStatus = async () => {
    try {
      const response = await scopedFetch(`/api/threads/${encodeURIComponent(id)}/model-status`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) return;
      const result = await response.json();
      if (active !== current || current.signal.aborted || selectedId !== id || statusDevice !== modelDeviceGeneration || statusWrite !== modelWriteGeneration) return;
      let change = modelChanges.get(id);
      if (result.locked === false) {
        if (change && !change.cancelling && typeof change.model !== 'string') { modelChanges.delete(id); updateComposer(); }
        return;
      }
      if (result.locked !== true) return;
      if (!change) { change = { message: '模型切换结果未知，请查看电脑上的模型' }; modelChanges.set(id, change); }
      if (!change.checkAfterCancel && !change.cancelling && /未知/.test(change.message || '') && uuid.test(result.preparedOperationId || '')) change.preparedOperationId = result.preparedOperationId;
      updateComposer();
    } catch {}
  };
  cancelPendingRender();
  stopSidebarStatuses();
  streamView = null; streamSeq = null;
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  active?.abort();
  const current = new AbortController(); active = current;
  currentConnectionDiagnostic = diagnostic;
  recoveryStream = null;
  if (currentDeviceId) recoveryChecks.delete(recoveryKey(currentDeviceId, id));
  let watchdog, assembler, receivedView = false, receivedModelState = false;
  const clearWatchdog = () => { clearTimeout(watchdog); watchdog = undefined; };
  current.signal.addEventListener('abort', () => { diagnostic.close('cancelled'); if (currentConnectionDiagnostic === diagnostic) currentConnectionDiagnostic = null; clearWatchdog(); assembler?.cancel(); if (active === current) { sidebarStatusSnapshot = new Map(); invalidateProjectStatuses(); applySidebarStatuses(); } }, { once: true });
  function disconnected() {
    if (current.signal.aborted || active !== current) return;
    diagnostic.close('disconnected');
    current.abort();
    updateLiveTaskStatus(id, 'unknown');
    error.hidden = true;
    if (!receivedView && !preserveView) showConversationLoading('连接中断，正在重试');
    status('重新连接中', 'connecting');
    const delay = Math.min(10000, 500 * (2 ** Math.min(attempt, 5)));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (active === current) void connect(id, attempt + 1, preserveView || receivedView);
    }, delay);
  }
  function resetWatchdog() {
    clearWatchdog();
    watchdog = setTimeout(disconnected, 45000);
  }
  if (preserveView) {
    historyRequest?.abort(); historyRequest = null; stopGoalClock();
    activeTurnId = null; liveMode = null; liveRuntimeStatus = null;
    goalPanel.hidden = true; questionLiveConfirmed = false;
  } else clearConversation();
  homeErrorSource = null; error.hidden = true; status(preserveView ? '重新连接中' : '连接中', 'connecting');
  if (!preserveView) showConversationLoading();
  if (!uuid.test(id)) { diagnostic.close('invalid'); current.abort(); fail('任务 ID 格式不正确'); return; }
  const cached = recentView(id);
  if (cached) void scopedFetch('/api/host-status', { credentials: 'same-origin', cache: 'no-store', signal: current.signal }).then(response => {
    if ((response.status === 401 || response.status === 403) && active === current) clearRecentViews();
    if (response.ok && active === current && !current.signal.aborted && !connected && !receivedView) { showState(cached, false); status('连接中', 'connecting'); }
  }).catch(() => {});
  if (!cached && !preserveView && currentDeviceId && historyScope?.deviceId === currentDeviceId) {
    const deviceId = currentDeviceId, scopeGeneration = historyScopeGeneration;
    const canPreview = () => active === current && !current.signal.aborted && selectedId === id && currentDeviceId === deviceId && historyScopeGeneration === scopeGeneration && !newDraft && !connected && !receivedView;
    // Indexed history can be read while owner discovery is pending. It is only
    // a preview: the stream alone may establish attachment or request recovery.
    void (async () => {
      try {
        const response = await scopedFetch(`/api/threads/${encodeURIComponent(id)}/recorded-history`, { credentials: 'same-origin', cache: 'no-store', signal: current.signal,
          headers: { 'x-codex-expected-device': deviceId, 'x-codex-history-chunks': '1' } });
        if (!response.ok || !canPreview()) { await response.body?.cancel(); return; }
        const page = await readHistoryPage(response, current.signal, { maxBytes: 4 * 1024 * 1024 });
        if (!canPreview()) return;
        validateRecordedPage(page, id);
        showState(page, false); receivedView = true;
        status('连接中', 'connecting');
      } catch { /* The live stream and its normal history fallback remain authoritative. */ }
    })();
  }
  resetWatchdog();
  try {
    diagnostic.mark('fetch');
    const response = await scopedFetch(`/api/threads/${encodeURIComponent(id)}/events`, { credentials: 'same-origin', signal: current.signal, cache: 'no-store', headers: { 'x-codex-view-delta': '3', 'x-codex-sidebar-status': '1', 'x-codex-history-window': '1', 'x-codex-lazy-output': '1' } });
    if (current.signal.aborted || active !== current) return;
    diagnostic.mark('headers'); diagnostic.correlate(response.headers?.get?.('x-codex-stream-id'));
    if (response.status === 401 || response.status === 403) { const message = await responseError(response, '配对状态不可用'); if (active !== current || current.signal.aborted) return; clearRecentViews(); current.abort(); fail(message); return; }
    if (!response.ok || !response.body) throw new Error(await responseError(response, `连接失败 (${response.status})`));
    recoveryStream = { threadId: id, controller: current };
    void checkModelStatus();
    if (currentDeviceId) void checkRecoveryStatus(id, currentDeviceId, recoveryStream);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = '';
    const handleLiveBlock = block => {
      const isState = /^event:\s*state\s*$/m.test(block);
      if (isState) { diagnostic.mark('first-state'); diagnostic.mark('handle-start'); }
      const ready = handleEvent(block);
      if (isState) { diagnostic.mark('handle-end'); if (ready && connected) diagnostic.mark('connected'); }
      return ready;
    };
    while (true) {
      const { value, done } = await reader.read();
      if (current.signal.aborted || active !== current) return;
      if (done) break;
      if (value?.byteLength) { diagnostic.mark('first-bytes'); resetWatchdog(); }
      const chunk = decoder.decode(value, { stream: true });
      if (pending.endsWith('\r') && chunk.startsWith('\n')) pending = pending.slice(0, -1);
      pending += chunk.replace(/\r\n/g, '\n');
      if (pending.length > 64 * 1024 * 1024) throw new Error('消息过大');
      let end;
      while ((end = pending.indexOf('\n\n')) !== -1) {
        if (current.signal.aborted || active !== current) return;
        const block = pending.slice(0, end); pending = pending.slice(end + 2);
        if (/^event:\s*state-chunk\s*$/m.test(block)) {
          const line = /^data:\s*(.+)$/m.exec(block); if (!line) throw new Error('状态分片无效');
          const frame = JSON.parse(line[1]);
          if (frame.type === 'begin') diagnostic.mark('chunk-begin');
          if (!assembler) { const { StateChunkAssembler } = await import('/state-chunks.mjs'); assembler = new StateChunkAssembler(); }
          if (current.signal.aborted || active !== current) return;
          const assembled = await assembler.accept(frame);
          if (current.signal.aborted || active !== current) return;
          if (assembled) {
            if (assembled.value?.event !== 'state' || assembled.value?.data?.seq !== assembled.seq) throw new Error('状态分片无效');
            diagnostic.mark('chunk-end');
            if (handleLiveBlock(`event: state\ndata: ${JSON.stringify(assembled.value.data)}`)) attempt = 0;
            receivedView = true;
          }
          continue;
        }
        if (/^event:\s*stream-error\s*$/m.test(block)) {
          const line = /^data:\s*(.+)$/m.exec(block);
          let detail; try { detail = line && JSON.parse(line[1]); } catch { /* Invalid events are treated as a connection error. */ }
          if (!['state-too-large', 'state-invalid'].includes(detail?.code)) throw new Error('连接失败');
          diagnostic.close('stream-error'); current.abort(); updateLiveTaskStatus(id, 'unknown'); fail(detail.code === 'state-too-large' ? '聊天内容过大，暂无法加载' : '聊天暂时无法加载，请在电脑上查看'); connectSidebarStatuses({ allowSelected: true }); return;
        }
        const isView = /^event:\s*(?:state|history)\s*$/m.test(block);
        if (handleLiveBlock(block)) attempt = 0;
        if (isView) receivedView = true;
      }
    }
    if (!current.signal.aborted && active === current) throw new Error('连接已断开');
  } catch (e) {
    if (current.signal.aborted || active !== current) return;
    disconnected();
  }
}
function showUnpaired() {
  discardDeferredListRender();
  pairingAvailable = false;
  resetHistoryScope(true);
  stopSidebarStatuses(); pauseBackgroundPolling({ includePairing: false }); ++listRequestGeneration; ++hostStatusGeneration;
  clearTimeout(reconnectTimer); active?.abort(); active = undefined; selectedId = null;
  clearRecentViews(); clearConversation(); homeErrorSource = null; error.hidden = true; error.textContent = '';
  deviceMenu.hidden = true;
  connection.hidden = true;
  const control = document.querySelector('#unpaired-control'); if (control) { control.hidden = false; control.textContent = '未配对 · 去配对'; }
  projectList.replaceChildren(element('p', 'list-status', '配对电脑后查看任务'));
  status('未配对', 'idle');
}
async function startPairedHome({ preserveDeviceState = false } = {}) {
  const scopeGeneration = historyScopeGeneration;
  pairingAvailable = true;
  connection.hidden = false;
  const control = document.querySelector('#unpaired-control'); if (control) control.hidden = true;
  const devicesLoaded = await loadDevices();
  if (!pairingAvailable) return;
  if (!devicesLoaded || !historyScope) {
    if (!pageSuspended && document.hidden !== true) {
      clearTimeout(deviceIdentityRetryTimer);
      deviceIdentityRetryTimer = setTimeout(() => { deviceIdentityRetryTimer = undefined; void startPairedHome({ preserveDeviceState }); }, 5000); deviceIdentityRetryTimer?.unref?.();
    }
    return;
  }
  clearTimeout(deviceIdentityRetryTimer); deviceIdentityRetryTimer = undefined;
  if (preserveDeviceState && scopeGeneration === historyScopeGeneration) return;
  connectSidebarStatuses(); void loadThreads(); void loadCapabilities(); void loadModels(); void refreshHostStatus();
  if (pairingConflict) void refreshPairingStatus();
}
async function checkPairingStatus(pending) {
  if (pageSuspended || document.hidden === true) return;
  const generation = ++hostStatusGeneration;
  let result;
  try {
    if (pending) result = await pending;
    else {
      const response = await fetch('/api/host-status', { credentials: 'same-origin', cache: 'no-store' });
      const detail = response.status === 401 ? await response.json().catch(() => null) : null;
      if (detail?.error === 'device-replaced') window.pairingConflictState = detail;
      result = response.ok ? 'paired' : detail?.error === 'device-replaced' ? 'replaced' : response.status === 401 || response.status === 403 ? 'unpaired' : 'unavailable';
    }
  } catch { result = 'unavailable'; }
  if (pageSuspended || document.hidden === true || generation !== hostStatusGeneration) return;
  if (result === 'paired') startPairedHome();
  else if (result === 'replaced') { showPairingConflict(window.pairingConflictState?.activeDeviceId); void refreshPairingStatus(); }
  else if (result === 'unpaired') showUnpaired();
  else {
    connection.hidden = false;
    const control = document.querySelector('#unpaired-control'); if (control) control.hidden = true;
    projectList.replaceChildren(element('p', 'list-status', '正在连接'));
    if (homeConnectionConfirmed) status('连接中断', 'error');
    else { status('连接中', 'connecting'); showConversationLoading(); }
    hostStatusTimer = setTimeout(() => { void checkPairingStatus(); }, 5000); hostStatusTimer?.unref?.();
  }
}
if (window.pairingReady) { status('连接中', 'connecting'); showConversationLoading(); void checkPairingStatus(window.pairingReady); }
else startPairedHome();
document.addEventListener?.('visibilitychange', () => {
  if (document.hidden !== true && !pageSuspended && !newDraft && selectedId) clearTaskNotification(selectedId);
  window.refreshNotificationPresence?.();
  if (document.hidden !== true && !pageSuspended && (pairingAvailable || pairingWasReplaced)) void refreshPairingStatus();
  if (document.hidden === true) { discardDeferredListRender(); pauseBackgroundPolling(); }
  else if (!pageSuspended && pairingAvailable) { if (!historyScope) void startPairedHome(); else { void loadThreads(); void refreshHostStatus(); } }
  else if (!pageSuspended && window.pairingReady) void checkPairingStatus();
});
window.addEventListener('pagehide', () => { discardDeferredListRender(); cancelPendingRender(); pageSuspended = true; stopSidebarStatuses(); stopGoalClock(); clearRecentViews(); stopVoice(); clearImagePreviews(); voiceStatus.textContent = ''; clearTimeout(reconnectTimer); reconnectTimer = undefined; pauseBackgroundPolling(); for (const id of statusHandovers.keys()) clearStatusHandover(id); active?.abort(); });
window.addEventListener('pageshow', async event => {
  if (!event.persisted) return;
  pageSuspended = false;
  if (pairingConflict) void refreshPairingStatus();
  if (!pairingAvailable) { if (window.pairingReady) void checkPairingStatus(); return; }
  await loadDevices();
  if (pageSuspended) return;
  if (!historyScope) { if (pairingAvailable) void startPairedHome(); return; }
  if (!selectedId) connectSidebarStatuses();
  void loadThreads();
  void loadModels();
  void loadCapabilities();
  void refreshHostStatus();
  if (selectedId) void connect(selectedId);
});
