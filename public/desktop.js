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
const cameraChoose = document.createElement('button');
cameraChoose.type = 'button'; cameraChoose.textContent = '拍照'; cameraChoose.hidden = true; cameraChoose.disabled = true;
if (attachmentMenu.insertBefore) attachmentMenu.insertBefore(cameraChoose, imageChoose); else attachmentMenu.append(cameraChoose);
const cameraInput = document.createElement('input');
cameraInput.type = 'file'; cameraInput.accept = 'image/*'; cameraInput.setAttribute('capture', 'environment'); cameraInput.hidden = true;
attachmentControl.append(cameraInput);
imageChoose.textContent = '照片'; imageFile.accept = 'image/*';
const fileChoose = document.querySelector('#file-choose');
const modeChoose = document.querySelector('#mode-choose');
const modeStatus = document.querySelector('#mode-status');
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
const deviceMenu = document.querySelector('#devices');
const deviceScrim = document.querySelector('#device-scrim');
const deviceCurrent = document.querySelector('#device-current');
const deviceList = document.querySelector('#device-list');
let historyScope = null, historyScopeGeneration = 0, deviceLoadGeneration = 0, homeConnectionConfirmed = false;
const deviceChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('codex-device-selection-v1') : null;
async function scopedFetch(url, options = {}) {
  const path = typeof url === 'string' ? url : '';
  if (!path.startsWith('/api/') || path.startsWith('/api/devices')) return fetch(url, options);
  if (!historyScope && window.pairingReady && path !== '/api/host-status') throw new Error('Device identity unavailable');
  const scopeGeneration = historyScopeGeneration;
  const response = await fetch(url, { ...options, headers: { ...options.headers, ...(historyScope ? { 'x-codex-expected-device': historyScope.deviceId } : {}) } });
  if (response.status === 401) {
    const body = await response.clone().json().catch(() => null);
    if (scopeGeneration === historyScopeGeneration && body?.error === 'device-replaced') showPairingConflict(body.activeDeviceId);
  }
  if (response.status === 409 && historyScope) {
    const body = await response.clone().json().catch(() => null);
    if (body?.error === 'device-changed') deviceChanged();
  }
  return response;
}
function resetHistoryScope(clearStored = false) {
  historyScope = null; historyScopeGeneration++; deviceLoadGeneration++; homeConnectionConfirmed = false;
}
function deviceChanged() {
  resetHistoryScope(); clearTimeout(reconnectTimer); active?.abort(); active = undefined;
  selectedId = null; clearRecentViews(); clearConversation(); invalidateThreadList(); status('电脑已切换', 'error');
  location.reload();
}
if (deviceChannel) deviceChannel.onmessage = event => { if (event.data?.type === 'device-changed') deviceChanged(); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
sessionStorage.removeItem('codex-hub-token');
sessionStorage.removeItem('codex-hub-thread');
let active;
let reconnectTimer;
let selectedId = null;
let selectedTitle = '';
const inputDrafts = new Map();
const skippedAsyncQuestions = new Set();
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
const imageChunkBytes = 128 * 1024;
async function encodeUploadChunk(chunk, signal) {
  if (signal?.aborted) throw new Error('cancelled');
  if (uploadCompression === 'gzip' && typeof CompressionStream === 'function') {
    try {
      const compressed = await new Response(chunk.stream().pipeThrough(new CompressionStream('gzip'))).blob();
      if (signal?.aborted) throw new Error('cancelled');
      if (compressed.size < chunk.size) return { body: compressed, headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip' } };
    } catch (error) { if (signal?.aborted) throw error; }
  }
  return { body: chunk, headers: { 'content-type': 'application/octet-stream' } };
}
async function loadCapabilities() {
  try {
    const response = await scopedFetch('/api/capabilities', { credentials: 'same-origin', cache: 'no-store' });
    const data = response.ok ? await response.json() : null;
    imageUploadAvailable = data?.imageUpload === true && data?.imageChunkBytes === imageChunkBytes && data?.maxImageBytes === 20 * 1024 * 1024;
    uploadCompression = data?.uploadCompression === 'gzip' ? 'gzip' : null;
  } catch { imageUploadAvailable = false; uploadCompression = null; }
  updateComposer();
}
const submissions = new Map();
const stops = new Map();
const modeChanges = new Map();
const modeNotices = new Map();
let liveMode = null, liveRuntimeStatus = null;
let activeTurnId = null;
const expandedThinking = new Set();
const expandedChanges = new Set();
const filePreviewCache = new Map();
const expandedCommands = new Set();
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
  if (upward && top < 120 && historyCanLoad && !historyAutoBlocked && !loadedHistory?.stale) void loadEarlierPage();
});
scrollBottomButton?.addEventListener('click', () => {
  followLatest = true;
  conversation.scrollTop = conversation.scrollHeight;
  updateScrollButton();
});
const groupExpanded = new Map();
const expandedGroups = new Set();
let connected = false;
let voiceSession = null;
function renderImageDraft() {
  const drafts = (selectedId && imageDrafts.get(selectedId)) || [];
  imageDraft.replaceChildren();
  imageDraft.hidden = !drafts.length;
  for (const draft of drafts) {
  const holder = document.createElement('div'); holder.className = 'image-draft-item';
  const image = document.createElement(draft.kind === 'file' ? 'span' : 'img');
  if (draft.kind === 'file') { image.className = 'attachment-name'; image.textContent = draft.file.name; }
  else { image.src = draft.url; image.alt = draft.file.name; }
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'image-draft-remove';
  remove.title = '移除附件';
  remove.setAttribute('aria-label', '移除附件');
  remove.disabled = Boolean(submissions.get(selectedId)?.pending || submissions.get(selectedId)?.uncertain);
  remove.textContent = '×';
  remove.addEventListener('click', () => {
    if (draft.url) URL.revokeObjectURL(draft.url);
    const remaining = (imageDrafts.get(selectedId) || []).filter(item => item !== draft);
    if (remaining.length) imageDrafts.set(selectedId, remaining); else imageDrafts.delete(selectedId);
    imageFile.value = '';
    renderImageDraft();
    updateComposer();
  });
  holder.append(image, remove); imageDraft.append(holder);
  }
}
function clearImageDrafts() {
  for (const drafts of imageDrafts.values()) for (const draft of drafts) if (draft.url) URL.revokeObjectURL(draft.url);
  imageDrafts.clear();
  renderImageDraft();
}
function closeAttachmentMenu() { attachmentMenu.hidden = true; attachmentToggle.setAttribute('aria-expanded', 'false'); }
attachmentToggle.addEventListener('click', () => { if (attachmentToggle.disabled) return; attachmentMenu.hidden = !attachmentMenu.hidden; attachmentToggle.setAttribute('aria-expanded', String(!attachmentMenu.hidden)); });
document.addEventListener?.('click', event => { if (!attachmentControl.contains(event.target)) closeAttachmentMenu(); });
document.addEventListener?.('keydown', event => { if (event.key === 'Escape' && !attachmentMenu.hidden) { closeAttachmentMenu(); attachmentToggle.focus(); } });
imageChoose.addEventListener('click', () => { closeAttachmentMenu(); if (imageUploadAvailable && selectedId && connected) imageFile.click(); });
cameraChoose.addEventListener('click', () => { closeAttachmentMenu(); if (imageUploadAvailable && selectedId && connected) cameraInput.click(); });
fileChoose.addEventListener('click', () => { closeAttachmentMenu(); if (imageUploadAvailable && selectedId && connected) fileInput.click(); });
modeChoose.addEventListener('click', async () => {
  const id = selectedId;
  if (!id || !connected || liveRuntimeStatus !== 'idle' || !['default', 'plan'].includes(liveMode) || modeChanges.has(id)) return;
  const change = { target: liveMode === 'plan' ? 'default' : 'plan', message: '正在切换模式' };
  modeNotices.delete(id); modeChanges.set(id, change); updateComposer();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await scopedFetch(`/api/threads/${encodeURIComponent(id)}/mode`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: change.target }),
    });
    if (modeChanges.get(id) !== change) return;
    if (response.ok) change.message = '等待电脑确认模式';
    else if (response.status === 408 || response.status >= 500) change.message = '切换结果未知，请查看电脑上的模式';
    else { modeChanges.delete(id); modeNotices.set(id, '模式切换未被接受'); }
  } catch {
    if (modeChanges.get(id) === change) change.message = '切换结果未知，请查看电脑上的模式';
  } finally {
    clearTimeout(timer);
    if (selectedId === id) updateComposer();
  }
});
function addAttachments(input, kind) {
  const files = [...(input.files || [])];
  if (!imageUploadAvailable || !selectedId || !connected || !files.length) return;
  const previous = imageDrafts.get(selectedId) || [];
  const invalidFormat = kind === 'image' && files.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type));
  if (previous.length + files.length > 4 || invalidFormat || files.some(file => file.size < 1 || file.size > 20 * 1024 * 1024 || !file.name || file.name.length > 255 || /[\x00-\x1f\x7f/\\\u2028\u2029]/.test(file.name))) {
    input.value = '';
    sendStatus.textContent = invalidFormat ? '图片仅支持 PNG、JPEG 或 WebP 格式' : '附件无效：最多 4 个，每个不超过 20 MB';
    return;
  }
  imageDrafts.set(selectedId, [...previous, ...files.map(file => ({ file, kind, ...(kind === 'image' ? { url: URL.createObjectURL(file) } : {}) }))]);
  input.value = '';
  renderImageDraft();
  updateComposer();
}
imageFile.addEventListener('change', () => addAttachments(imageFile, 'image'));
cameraInput.addEventListener('change', () => addAttachments(cameraInput, 'image'));
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
  if (!SpeechRecognition || !selectedId || !connected) return;
  let recognition;
  try { recognition = new SpeechRecognition(); } catch { voiceStatus.textContent = '语音输入不可用'; return; }
  const session = { recognition, threadId: selectedId };
  voiceSession = session;
  recognition.lang = 'zh-CN';
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.onresult = event => {
    if (voiceSession !== session || selectedId !== session.threadId || !connected) return;
    let text = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) text += event.results[i][0]?.transcript || '';
    }
    if (!text) return;
    messageInput.value = (messageInput.value + text).slice(0, 32000);
    drafts.set(session.threadId, messageInput.value);
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
  const state = selectedId && submissions.get(selectedId);
  if (messageInput.style) {
    messageInput.style.height = 'auto';
    messageInput.style.height = `${Math.min(messageInput.scrollHeight, Math.min(300, (window.innerHeight || 844) * 0.35))}px`;
  }
  messageInput.disabled = !selectedId || !connected;
  imageChoose.hidden = !imageUploadAvailable;
  imageChoose.disabled = !imageUploadAvailable || messageInput.disabled || Boolean(state?.pending || state?.uncertain);
  cameraChoose.hidden = imageChoose.hidden;
  cameraChoose.disabled = imageChoose.disabled;
  fileChoose.hidden = !imageUploadAvailable;
  fileChoose.disabled = imageChoose.disabled;
  const modeAvailable = ['default', 'plan'].includes(liveMode);
  const modeChange = selectedId && modeChanges.get(selectedId);
  modeChoose.hidden = !modeAvailable;
  modeChoose.textContent = modeChange && !modeChange.message.includes('未知') ? '正在切换模式' : liveMode === 'plan' ? '计划模式 ✓' : '计划模式';
  modeChoose.disabled = messageInput.disabled || liveRuntimeStatus !== 'idle' || Boolean(modeChange);
  modeStatus.textContent = (modeChange?.message.includes('未知') ? modeChange.message : '') || (selectedId && modeNotices.get(selectedId)) || '';
  attachmentControl.hidden = !imageUploadAvailable && !modeAvailable;
  attachmentToggle.disabled = messageInput.disabled || (imageChoose.disabled && !modeAvailable);
  if (attachmentToggle.disabled) closeAttachmentMenu();
  for (const removeImage of imageDraft.querySelectorAll?.('.image-draft-remove') || []) removeImage.disabled = Boolean(state?.pending || state?.uncertain);
  if (voiceSession && (messageInput.disabled || voiceSession.threadId !== selectedId)) { stopVoice(); voiceStatus.textContent = ''; }
  voiceButton.disabled = messageInput.disabled || !SpeechRecognition;
  if (!SpeechRecognition) voiceButton.title = '当前浏览器不支持语音输入';
  messageInput.placeholder = selectedId ? (connected ? (liveMode === 'plan' ? '输入任务生成计划' : '输入消息') : '等待连接') : '选择任务后输入消息';
  sendButton.disabled = messageInput.disabled || Boolean(state?.pending || state?.uncertain) || Boolean(selectedId && imageDrafts.has(selectedId) && !imageUploadAvailable) || (!messageInput.value.trim() && !(imageUploadAvailable && selectedId && imageDrafts.has(selectedId)));
  sendStatus.textContent = state?.message || '';
  unlockSend.hidden = !state?.uncertain;
  const stop = selectedId && stops.get(selectedId);
  const hasDraft = Boolean(messageInput.value?.trim() || (selectedId && imageDrafts.has(selectedId)));
  stopButton.hidden = !activeTurnId || hasDraft;
  sendButton.hidden = Boolean(activeTurnId && !hasDraft);
  stopButton.disabled = !connected || !activeTurnId || Boolean(stop && stop.turnId === activeTurnId);
  const stopping = stop?.turnId === activeTurnId && !stop?.error;
  stopButton.title = stopping ? '正在停止' : '停止任务';
  stopButton.setAttribute('aria-label', stopping ? '正在停止' : '停止任务');
  stopStatus.textContent = stop?.error ? stop.message : '';
}
stopButton.addEventListener('click', async () => {
  flushPendingRender();
  const id = selectedId, turnId = activeTurnId;
  if (!id || !turnId || !connected || stops.get(id)?.turnId === turnId) return;
  stops.set(id, { turnId, pending: true, message: '正在停止...' });
  updateComposer();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await scopedFetch(`/api/threads/${encodeURIComponent(id)}/stop`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ turnId }),
    });
    if (stops.get(id)?.turnId !== turnId) return;
    if (response.ok) {
      let result; try { result = await response.json(); } catch { /* Older relays may return no body. */ }
      if (stops.get(id)?.turnId !== turnId) return;
      if (result?.status === 'stopped-goal-pause-failed') stops.set(id, { turnId, error: true, goalPauseFailed: true, message: '任务已停止，但目标暂停失败，请在电脑上检查目标状态' });
      else if (selectedId === id && activeTurnId !== turnId) stops.delete(id);
      else stops.set(id, { turnId, message: '已发送停止请求，等待任务状态更新' });
    }
    else if (response.status === 408 || response.status >= 500) stops.set(id, { turnId, error: true, message: '停止结果未知，请查看任务状态' });
    else stops.set(id, { turnId, error: true, message: '停止请求未被接受，请查看任务状态' });
  } catch {
    if (stops.get(id)?.turnId === turnId) stops.set(id, { turnId, error: true, message: '停止结果未知，请查看任务状态' });
  } finally {
    clearTimeout(timer);
    const latestStop = stops.get(id);
    if (selectedId === id && activeTurnId && activeTurnId !== turnId && latestStop?.turnId === turnId && !latestStop.goalPauseFailed) stops.delete(id);
    if (selectedId === id) updateComposer();
  }
});
unlockSend.addEventListener('click', () => { if (selectedId && submissions.get(selectedId)?.uncertain) submissions.delete(selectedId); updateComposer(); });
messageInput.addEventListener('input', () => {
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
  const id = selectedId;
  const text = messageInput.value;
  const images = imageDrafts.get(id) || [];
  if (!id || !connected || (!text.trim() && !images.length) || (images.length && !imageUploadAvailable) || submissions.get(id)?.pending || submissions.get(id)?.uncertain) return;
  stopVoice();
  voiceStatus.textContent = '';
  submissions.set(id, { pending: true, message: '发送中...' });
  updateComposer();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  let uploadId;
  const attachmentIds = [];
  let messageDispatched = false;
  let uploadStage = '初始化', uploadStatus = '', uploadReason = '';
  const uploadBegan = Date.now();
  const checkUpload = async response => {
    uploadStatus = String(response.status);
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      if (['busy', 'host-offline', 'unavailable', 'invalid', 'device-replaced', 'unsupported-encoding', 'invalid-compressed-chunk'].includes(result?.error)) uploadReason = result.error;
      throw new Error('upload');
    }
  };
  try {
    for (const [fileIndex, image] of images.entries()) {
      uploadStage = '初始化'; uploadStatus = ''; uploadReason = '';
      const base = `/api/threads/${encodeURIComponent(id)}/uploads`;
      const start = await scopedFetch(base, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: image.file.name, size: image.file.size, kind: image.kind || 'image' }) });
      await checkUpload(start);
      const created = await start.json();
      if (!uuid.test(created?.uploadId)) throw new Error('upload');
      uploadId = created.uploadId;
      for (let offset = 0, seq = 0; offset < image.file.size; offset += imageChunkBytes, seq++) {
        uploadStage = `传输 ${seq + 1}/${Math.ceil(image.file.size / imageChunkBytes)}`; uploadStatus = ''; uploadReason = '';
        const chunk = await encodeUploadChunk(image.file.slice(offset, offset + imageChunkBytes), controller.signal);
        const response = await scopedFetch(`${base}/${encodeURIComponent(uploadId)}/chunks/${seq}`, {
          method: 'PUT', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
          headers: chunk.headers, body: chunk.body,
        });
        await checkUpload(response);
        submissions.set(id, { pending: true, message: `上传附件 ${fileIndex + 1}/${images.length} · ${Math.round(Math.min(image.file.size, offset + imageChunkBytes) / image.file.size * 100)}%` });
        if (selectedId === id) updateComposer();
      }
      uploadStage = '完成'; uploadStatus = ''; uploadReason = '';
      const finish = await scopedFetch(`${base}/${encodeURIComponent(uploadId)}/finish`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      await checkUpload(finish);
      const staged = await finish.json();
      if (!uuid.test(staged?.attachmentId)) throw new Error('upload');
      attachmentIds.push(staged.attachmentId); uploadId = undefined;
    }
    messageDispatched = true;
    const response = await scopedFetch(`/api/threads/${encodeURIComponent(id)}/messages`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(attachmentIds.length ? { text, attachmentIds } : { text }),
    });
    if (response.ok) {
      if (drafts.get(id) === text) drafts.delete(id);
      if (images.length && imageDrafts.get(id) === images) { for (const image of images) if (image.url) URL.revokeObjectURL(image.url); imageDrafts.delete(id); if (selectedId === id) renderImageDraft(); }
      submissions.delete(id);
      if (selectedId === id && messageInput.value === text) messageInput.value = '';
    } else {
      const uncertain = response.status === 408 || response.status >= 500;
      if (!uncertain) for (const attachmentId of [...attachmentIds, ...(uploadId ? [uploadId] : [])]) void scopedFetch(`/api/threads/${encodeURIComponent(id)}/uploads/${encodeURIComponent(attachmentId)}`, { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' }).catch(() => {});
      submissions.set(id, { pending: false, uncertain, message: uncertain ? '发送结果未知，请先检查聊天记录' : `发送失败 (${response.status})` });
    }
  } catch {
    if (!messageDispatched) for (const attachmentId of [...attachmentIds, ...(uploadId ? [uploadId] : [])]) void scopedFetch(`/api/threads/${encodeURIComponent(id)}/uploads/${encodeURIComponent(attachmentId)}`, { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' }).catch(() => {});
    submissions.set(id, { pending: false, uncertain: messageDispatched, message: messageDispatched ? '发送结果未知，请先检查聊天记录' : `附件上传失败（${uploadStage} · ${uploadStatus || '网络异常'}${uploadReason ? ` · ${uploadReason}` : ''} · ${Math.round((Date.now() - uploadBegan) / 1000)}秒）` });
  } finally {
    clearTimeout(timer);
    if (selectedId === id) updateComposer();
  }
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

function status(text, state) { connection.textContent = text; connection.dataset.state = state; connected = state === 'ready'; updateComposer(); }
async function responseError(response, fallback) {
  if (response.status === 401 || response.status === 403) return '配对状态不可用，请重新配对';
  try {
    const data = await response.json();
    if (response.status === 503 && data?.error === 'host-offline') return '电脑未连接，请打开 Codex 手机助手';
  } catch { /* Use the generic error if the response has no JSON body. */ }
  return fallback;
}
let displayedHistoryId = null, homeErrorSource = null;
function clearConversation() { cancelPendingRender(); historyRequest?.abort(); historyRequest = null; loadEarlier.disabled = false; loadedHistory = null; loadEarlier.hidden = true; historyCanLoad = false; historyAutoBlocked = false; historyScrollThread = null; previousHistoryScrollTop = null; displayedHistoryId = null; stopGoalClock(); clearImagePreviews(); clearWorkGroupRecords(); filePreviewCache.clear(); activeTurnId = null; liveMode = null; liveRuntimeStatus = null; goalPanel.hidden = true; questionPanel.hidden = true; questionPanel.replaceChildren(); title.textContent = selectedId ? (selectedTitle || '未命名任务') : '尚未选择任务'; history.textContent = ''; turns.replaceChildren(); summaryContent.replaceChildren(); }
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
}
function clearHomeError(source) {
  if (homeErrorSource !== source) return;
  homeErrorSource = null; error.hidden = true; error.textContent = '';
  showConversationEmpty();
}
function element(tag, className, text) { const node = document.createElement(tag); node.className = className; node.textContent = text ?? ''; return node; }
function showConversationEmpty() {
  if (selectedId || !pairingAvailable || !connected || homeErrorSource || !error.hidden) return;
  turns.replaceChildren(element('div', 'conversation-empty', '打开左上角任务面板，选择一个任务'));
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
function renderAgentHistoryTurn(turn) {
  const row = element('article', 'turn');
  if (turn.status === 'interrupted' || turn.status === 'failed') row.append(element('div', 'turn-meta', turn.status === 'interrupted' ? '已中断' : '失败'));
  const items = Array.isArray(turn.items) ? turn.items : [];
  const finalIndex = turn.status === 'completed' ? items.findLastIndex(item => item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) : -1;
  let work = null;
  for (const [index, item] of items.entries()) {
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
function questionReplyParts(turns, turnIndex, itemIndex, text) {
  if (typeof text !== 'string') return null;
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
    const response = await scopedFetch('/api/devices', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    if (generation !== deviceLoadGeneration) return;
    if (!Array.isArray(data.devices) || !data.devices.length) return;
    const current = data.devices.find(item => item.deviceId === data.currentDeviceId);
    if (current && uuid.test(current.hostId || '') && uuid.test(current.deviceId || '')) {
      if (historyScope && (historyScope.hostId !== current.hostId || historyScope.deviceId !== current.deviceId)) resetHistoryScope();
      historyScope = { hostId: current.hostId, deviceId: current.deviceId };
    } else resetHistoryScope();
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
        if ([...submissions.values()].some(item => item.pending || item.uncertain)) { sendStatus.textContent = '请先确认当前发送结果'; return; }
        choose.disabled = true;
        try {
          const result = await scopedFetch('/api/devices/select', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: device.deviceId }) });
          if (!result.ok) throw new Error('切换电脑失败');
          deviceChannel?.postMessage({ type: 'device-changed' });
          resetHistoryScope(); clearRecentViews(); invalidateThreadList();
          clearTimeout(reconnectTimer); active?.abort(); active = undefined; selectedId = null;
          drafts.clear(); clearImageDrafts(); submissions.clear(); modeChanges.clear(); modeNotices.clear(); messageInput.value = ''; clearConversation(); status('未连接', 'idle');
          deviceMenu.open = false; connectSidebarStatuses(); await loadDevices(); await loadThreads(); void refreshHostStatus();
        } catch { fail('切换电脑失败'); } finally { choose.disabled = false; }
      });
      const remove = element('button', 'device-remove', '移除配对');
      remove.type = 'button'; remove.title = '移除此配对'; remove.setAttribute('aria-label', `移除 ${device.name || '电脑'} 的配对`);
      remove.addEventListener('click', async () => {
        if ([...submissions.values()].some(item => item.pending || item.uncertain)) { sendStatus.textContent = '请先确认当前发送结果'; return; }
        remove.disabled = true;
        try {
          const result = await scopedFetch('/api/devices/remove', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: device.deviceId }) });
          if (!result.ok) throw new Error('移除失败');
          deviceChannel?.postMessage({ type: 'device-changed' });
          const removedScope = { hostId: device.hostId, deviceId: device.deviceId };
          if (historyScope?.hostId === removedScope.hostId && historyScope?.deviceId === removedScope.deviceId) resetHistoryScope();
          clearRecentViews(); invalidateThreadList();
          clearTimeout(reconnectTimer); active?.abort(); active = undefined; selectedId = null;
          drafts.clear(); clearImageDrafts(); submissions.clear(); modeChanges.clear(); modeNotices.clear(); messageInput.value = ''; clearConversation(); status('未连接', 'idle');
          const refresh = await scopedFetch('/api/devices', { credentials: 'same-origin', cache: 'no-store' });
          const remaining = refresh.ok ? await refresh.json() : { devices: [] };
          if (!remaining.devices?.length) { location.assign('/'); return; }
          connectSidebarStatuses(); await loadDevices(); await loadThreads(); void refreshHostStatus();
        } catch { fail('移除电脑失败'); } finally { remove.disabled = false; }
      });
      row.append(choose, remove); rows.push(row);
    }
    deviceList.replaceChildren(...rows); deviceMenu.hidden = false;
  } catch { /* Local development mode has no device endpoint. */ }
}
const liveTaskStatus = new Map();
let sidebarEvents, sidebarWatchdog, sidebarEventGeneration = 0, sidebarStatusSnapshot = null;
function setTaskIndicator(marker, state) {
  if (!marker) return;
  marker.hidden = state !== 'active';
  const unread = marker.nextElementSibling;
  if (unread?.classList.contains('task-unread')) unread.hidden = !marker.hidden;
  marker.className = 'task-active';
  marker.title = '进行中';
  marker.setAttribute('aria-label', marker.title);
}
function applySidebarStatuses() {
  for (const task of projectList.querySelectorAll?.('.task') || []) {
    const marker = task.querySelector?.('.task-active');
    setTaskIndicator(marker, liveTaskStatus.get(task.dataset.id) === 'active' ? 'active' : sidebarStatusSnapshot?.get(task.dataset.id));
  }
}
function acceptSidebarStatuses(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([id, state]) => !uuid.test(id) || !['active', 'idle', 'unknown'].includes(state))) return;
  sidebarStatusSnapshot = new Map(Object.entries(value));
  for (const [id, state] of sidebarStatusSnapshot) {
    if (statusHandovers.has(id) && state !== 'unknown') { clearStatusHandover(id); liveTaskStatus.delete(id); }
  }
  applySidebarStatuses();
}
function stopSidebarStatuses() { ++sidebarEventGeneration; clearTimeout(sidebarWatchdog); sidebarEvents?.close(); sidebarEvents = undefined; sidebarStatusSnapshot = typeof EventSource === 'undefined' ? null : new Map(); applySidebarStatuses(); }
function connectSidebarStatuses({ allowSelected = false } = {}) {
  stopSidebarStatuses();
  if (typeof EventSource === 'undefined' || (selectedId && !allowSelected)) return;
  const generation = sidebarEventGeneration;
  const selectedAtOpen = selectedId;
  const source = sidebarEvents = new EventSource('/api/sidebar/events');
  const arm = () => { clearTimeout(sidebarWatchdog); sidebarWatchdog = setTimeout(() => { if (generation === sidebarEventGeneration && sidebarEvents === source && selectedId === selectedAtOpen) connectSidebarStatuses({ allowSelected }); }, 45000); };
  source.addEventListener('sidebar-status', event => {
    if (generation !== sidebarEventGeneration || sidebarEvents !== source) return;
    let value; try { value = JSON.parse(event.data); } catch { return; }
    acceptSidebarStatuses(value); arm();
  });
  source.addEventListener('sidebar-heartbeat', () => { if (generation === sidebarEventGeneration && sidebarEvents === source) arm(); });
  source.onerror = () => { if (generation !== sidebarEventGeneration || sidebarEvents !== source) return; sidebarStatusSnapshot = new Map(); applySidebarStatuses(); };
  arm();
}
const statusHandovers = new Map();
function clearStatusHandover(id) {
  const timer = statusHandovers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  statusHandovers.delete(id);
}
function beginStatusHandover(id) {
  if (liveTaskStatus.get(id) !== 'active') { updateLiveTaskStatus(id, 'unknown'); return; }
  clearStatusHandover(id);
  const timer = setTimeout(() => { statusHandovers.delete(id); updateLiveTaskStatus(id, 'unknown'); }, 1500);
  timer?.unref?.(); statusHandovers.set(id, timer);
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
  if (status === 'active') liveTaskStatus.set(id, status); else liveTaskStatus.delete(id);
  for (const task of projectList.querySelectorAll('.task')) {
    if (task.dataset.id !== id) continue;
    const marker = task.querySelector?.('.task-active');
    setTaskIndicator(marker, status === 'active' ? 'active' : sidebarStatusSnapshot?.get(id));
  }
}
function renderTask(task) {
  if (!task || !uuid.test(task.id)) return null;
  const button = element('button', 'task', '');
  button.type = 'button';
  button.dataset.id = task.id;
  button.setAttribute('aria-current', String(task.id === selectedId));
  button.append(element('span', 'task-title', task.title || '未命名任务'));
  const indicator = element('span', 'task-active', ''); indicator.title = '进行中'; indicator.setAttribute('aria-label', '进行中');
  const observedStatus = sidebarStatusSnapshot ? sidebarStatusSnapshot.get(task.id) : (task.status?.type || task.status);
  button.append(indicator);
  if (task.unread === true && task.id !== selectedId) { const dot = element('span', 'task-unread', ''); dot.title = '未读'; dot.setAttribute('aria-label', '未读'); button.append(dot); }
  setTaskIndicator(indicator, liveTaskStatus.get(task.id) === 'active' ? 'active' : observedStatus);
  button.addEventListener('click', () => { if (selectedId === task.id && active && !active.signal.aborted) { showSidebar(false); return; } const previous = selectedId; if (previous) { drafts.set(previous, messageInput.value); if (previous !== task.id) beginStatusHandover(previous); } selectedId = task.id; selectedTitle = task.title || '未命名任务'; messageInput.value = drafts.get(selectedId) || ''; renderImageDraft(); updateComposer(); for (const item of projectList.querySelectorAll('.task')) { const selected = item.dataset.id === selectedId; item.setAttribute('aria-current', String(selected)); if (selected) item.querySelector?.('.task-unread')?.remove(); } showSidebar(false); void connect(task.id); if (statusHandovers.has(previous)) { clearTimeout(visibleStatusTimer); visibleStatusTimer = undefined; void loadThreads(); } });
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
  heading.append(icon, element('span', 'project-name', name), chevronIcon());
  const contents = element('div', 'project-contents');
  contents.hidden = collapsed;
  heading.addEventListener('click', () => {
    const next = !contents.hidden;
    contents.hidden = next;
    heading.setAttribute('aria-expanded', String(!next));
    groupExpanded.set(key, !next);
    scheduleVisibleStatusRefresh();
  });
  const valid = tasks.filter(task => task && uuid.test(task.id));
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
  }
  more.addEventListener('click', () => {
    if (expandedGroups.has(key)) expandedGroups.delete(key); else expandedGroups.add(key);
    renderItems();
    scheduleVisibleStatusRefresh();
  });
  renderItems();
  group.append(heading, contents);
  return group;
}
let listRetryTimer;
let visibleStatusTimer;
let lastVisibleStatusKey = '';
let pendingStatusRefreshes = 0;
let homeSuspended = false;
function scheduleVisibleStatusRefresh() {
  clearTimeout(visibleStatusTimer);
  visibleStatusTimer = setTimeout(() => { visibleStatusTimer = undefined; void loadThreads(); }, 250);
  visibleStatusTimer?.unref?.();
}
projectList.addEventListener('scroll', scheduleVisibleStatusRefresh, { passive: true });
function visibleStatusIds() {
  const pending = [...statusHandovers.keys()];
  if (!sidebar.classList.contains?.('open')) return pending;
  const bounds = projectList.getBoundingClientRect();
  const visible = [...projectList.querySelectorAll('.task')].filter(task => {
    const rect = task.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom;
  }).map(task => task.dataset.id).filter(id => uuid.test(id));
  return [...new Set([...pending, ...visible])];
}
let listRequestGeneration = 0;
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
  if (homeSuspended || pairingRestorePending) return;
  const generation = ++pairingStatusGeneration;
  try {
    const response = await fetch('/api/pairing/status', { credentials: 'same-origin', cache: 'no-store' });
    if (generation !== pairingStatusGeneration || homeSuspended || response.status === 404) return;
    if (response.status === 401 || response.status === 403) { closePairingConflict(); pairingWasReplaced = false; notifiedActiveDeviceId = undefined; showUnpaired(); return; }
    if (!response.ok) throw new Error('pairing status unavailable');
    const result = await response.json();
    if (generation !== pairingStatusGeneration || homeSuspended) return;
    if (result.state === 'replaced') showPairingConflict(result.activeDeviceId);
    else if (result.state === 'active' && pairingWasReplaced) { closePairingConflict(); pairingWasReplaced = false; notifiedActiveDeviceId = undefined; await checkPairingStatus(); return; }
  } catch { /* Host status polling remains the source of connection errors. */ }
  if (!homeSuspended && generation === pairingStatusGeneration) { clearTimeout(pairingStatusTimer); pairingStatusTimer = setTimeout(refreshPairingStatus, 4000); pairingStatusTimer?.unref?.(); }
}
async function refreshHostStatus() {
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
  stopSidebarStatuses();
  clearTimeout(listRetryTimer);
  listRetryTimer = undefined;
  ++listRequestGeneration;
  lastVisibleStatusKey = '';
  pendingStatusRefreshes = 0;
  liveTaskStatus.clear();
  for (const id of statusHandovers.keys()) clearStatusHandover(id);
  projectList.replaceChildren(element('p', 'list-status', '正在加载任务'));
}
async function loadThreads() {
  clearTimeout(listRetryTimer);
  listRetryTimer = undefined;
  const generation = ++listRequestGeneration;
  let retry = true;
  try {
    const visible = visibleStatusIds();
    const visibleKey = visible.join(',');
    const handover = [...statusHandovers.keys()][0];
    let body = JSON.stringify({ visibleThreads: visible, ...(handover && visible.includes(handover) ? { handoverThread: handover } : {}) });
    const statusUnavailable = visible.length > 1024 || body.length > 1048576;
    if (statusUnavailable) body = JSON.stringify({ visibleThreads: [] });
    const response = await scopedFetch('/api/threads', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body });
    if (generation !== listRequestGeneration) return;
    if (response.status === 401 || response.status === 403) retry = false;
    if (!response.ok) throw new Error(await responseError(response, `任务列表加载失败 (${response.status})`));
    const data = await response.json();
    if (generation !== listRequestGeneration) return;
    if (!Array.isArray(data.projects) || !Array.isArray(data.recent)) throw new Error('任务列表数据不可用');
    clearHomeError('list');
    const fragment = document.createDocumentFragment();
    if (statusUnavailable) fragment.append(element('p', 'list-status', '任务状态暂不可用'));
    for (const project of data.projects) {
      if (!project || !Array.isArray(project.threads)) continue;
      fragment.append(renderGroup(`project:${project.id}`, project.name || '未命名项目', project.threads, false, project.expanded));
    }
    if (data.recent.length) {
      fragment.append(renderGroup('recent', '最近', data.recent, true));
    }
    if (data.truncated === true) fragment.append(element('p', 'list-status', '任务较多，仅显示最近的部分任务'));
    if (!fragment.childNodes.length) fragment.append(element('p', 'list-status', '暂无任务'));
    const previousScroll = projectList.scrollTop;
    projectList.replaceChildren(fragment);
    if (Number.isFinite(previousScroll)) projectList.scrollTop = previousScroll;
    if (visibleKey !== lastVisibleStatusKey) {
      lastVisibleStatusKey = visibleKey;
      pendingStatusRefreshes = visibleKey ? 2 : 0;
    }
    const nextDelay = pendingStatusRefreshes ? (pendingStatusRefreshes-- === 2 ? 1000 : 2000) : 10000;
    listRetryTimer = setTimeout(() => { listRetryTimer = undefined; void loadThreads(); }, nextDelay);
    listRetryTimer?.unref?.();
  } catch (e) {
    if (generation !== listRequestGeneration) return;
    const message = e instanceof TypeError ? '连接中断，正在重试' : (e.message || '任务列表加载失败');
    projectList.replaceChildren(element('p', 'list-status list-error', message));
    if (!(e instanceof TypeError)) showHomeError('list', message);
    if (retry) {
      listRetryTimer = setTimeout(() => { listRetryTimer = undefined; void loadThreads(); }, 5000);
      listRetryTimer?.unref?.();
    }
  }
}
let loadedHistory = null, historyRequest = null;
function updateHistoryControl() {
  const shortContent = !conversation || !Number.isFinite(conversation.scrollHeight) || !Number.isFinite(conversation.clientHeight) || conversation.scrollHeight <= conversation.clientHeight + 1;
  loadEarlier.hidden = !historyCanLoad || (!historyRequest && !historyAutoBlocked && !loadedHistory?.stale && !shortContent);
  loadEarlier.disabled = Boolean(historyRequest);
  loadEarlier.textContent = historyRequest ? '加载中...' : loadedHistory?.stale ? '历史已变化，刷新' : historyAutoBlocked ? '重新加载更早消息' : '加载更早消息';
}
async function readHistoryPage(response, signal) {
  if (!response.ok) throw new Error('history unavailable');
  if (!response.headers?.get?.('content-type')?.includes('application/x-ndjson')) return response.json();
  if (!response.body) throw new Error('history unavailable');
  const { StateChunkAssembler } = await import('/state-chunks.mjs');
  const assembler = new StateChunkAssembler(), reader = response.body.getReader(), decoder = new TextDecoder();
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
  if (!connected || !id || !metadata?.historicalHash || loadEarlier.disabled) return;
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
  } catch { if (!controller.signal.aborted && selectedId === id) { historyAutoBlocked = true; history.textContent = '历史加载失败，请重试'; } }
  finally { if (historyRequest === controller) { historyRequest = null; updateHistoryControl(); } }
}
loadEarlier.addEventListener('click', () => loadEarlierPage());
function showState(view, live = true, loadingPreview = false, immediateWork = null) {
  const viewThread = selectedId;
  const sourceView = view;
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
  const controlTurns = view.turns || [];
  if (live && view.history?.historicalHash) {
    if (loadedHistory && (loadedHistory.hash !== view.history.historicalHash || loadedHistory.mediaRevision !== view.history.mediaRevision)) loadedHistory.stale = true;
    const previous = loadedHistory, field = view.history.keyField;
    historyCanLoad = previous?.stale ? true : Boolean(previous ? previous.nextBefore : view.history.cursor);
    if (previous && !previous.stale) {
      const liveKeys = new Set(view.turns.map(turn => turn[field]));
      const old = previous.turns.filter(turn => !liveKeys.has(turn[field]));
      view = { ...view, turns: [...old, ...view.turns], history: { ...view.history, complete: previous.complete } };
    }
  } else { loadedHistory = null; historyCanLoad = false; }
  displayedHistoryId = !live && view.id === selectedId ? selectedId : null;
  clearImageObservers();
  liveMode = live && ['default', 'plan'].includes(view.collaborationMode) ? view.collaborationMode : null;
  liveRuntimeStatus = live ? view.runtimeStatus : null;
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
  const running = controlTurns.filter(turn => turn.status === 'inProgress' && uuid.test(turn.id || ''));
  activeTurnId = live && running.length === 1 ? running[0].id : null;
  updateLiveTaskStatus(selectedId, live && (view.runtimeStatus === 'active' || (view.runtimeStatus == null && running.length > 0)) ? 'active' : 'unknown');
  if (selectedId && stops.has(selectedId) && stops.get(selectedId).turnId !== activeTurnId && !stops.get(selectedId).pending && !stops.get(selectedId).goalPauseFailed && (activeTurnId || !stops.get(selectedId).error)) stops.delete(selectedId);
  selectedTitle = view.title || selectedTitle || '未命名任务';
  title.textContent = selectedTitle;
  history.textContent = live ? (loadedHistory?.gap ? '历史可能存在缺口，请刷新' : view.history?.complete ? '' : '部分历史未加载') : '已保存的历史，非实时内容';
  error.hidden = true;
  const fragment = document.createDocumentFragment();
  const questionFragment = document.createDocumentFragment();
  let pendingQuestionCount = 0;
  const fileTargets = new Map();
  if (live && Array.isArray(view.requests) && view.requests.length) {
    for (const request of view.requests) {
      if (request.unsupported || !request.kind) { fragment.append(element('p', 'pending-request', '此任务有待处理请求，请在电脑上的 Codex 中查看并处理。')); continue; }
      const card = element('div', request.kind === 'userInput' ? 'question-card' : 'pending-request');
      if (request.kind === 'userInput') {
        card.append(element('div', 'question-card-title', '问题'));
        const threadId = selectedId;
        const key = JSON.stringify([threadId, request.id]);
        let draft = inputDrafts.get(key);
        if (!draft) { draft = { answers: Object.create(null), pending: false }; inputDrafts.set(key, draft); }
        const form = element('form', 'user-input-form');
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
            input.dataset.inputDraftKey = key; input.dataset.inputQuestionId = question.id;
            input.value = question.options.some(o => o.label === draft.answers[question.id]) ? '' : (draft.answers[question.id] || '');
            input.addEventListener('input', () => { draft.answers[question.id] = input.value; for (const radio of group.querySelectorAll('input[type=radio]')) radio.checked = false; });
            group.append(input);
          }
          form.append(group);
        }
        const submit = element('button', 'approval-accept', draft.pending ? (draft.outcome || '正在提交') : '提交'); submit.type = 'submit'; submit.disabled = draft.pending;
        const status = element('p', 'list-error', draft.feedback || ''); form.append(submit, status);
        draft.controls = { submit, status };
        form.addEventListener('submit', async event => {
          event.preventDefault();
          if (draft.pending) return;
          if (!request.questions.every(q => draft.answers[q.id]?.trim())) { status.textContent = '请回答所有问题'; return; }
          draft.pending = true; submit.disabled = true; status.textContent = '';
          try {
            const response = await scopedFetch(`/api/threads/${encodeURIComponent(threadId)}/user-input`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: request.id, answers: draft.answers }) });
            if (!response.ok) throw new Error();
            draft.feedback = '已提交，等待任务更新'; draft.outcome = '已提交';
          } catch { draft.feedback = '结果暂不确定，请查看电脑上的任务状态'; draft.outcome = '结果待确认'; }
          draft.controls.status.textContent = draft.feedback;
          draft.controls.submit.textContent = draft.outcome;
        });
        card.append(form); questionFragment.append(card); pendingQuestionCount++; continue;
      }
      {
        card.append(element('p', '', request.kind === 'command' ? `需要确认命令：${request.command}` : '需要确认文件变更'));
        const actions = element('div', 'approval-actions');
        for (const [decision, label] of [['accept', '允许'], ['decline', '拒绝']]) {
          const button = element('button', decision === 'accept' ? 'approval-accept' : 'approval-decline', label);
          button.type = 'button';
          button.addEventListener('click', async () => {
            button.disabled = true;
            try {
              const response = await scopedFetch(`/api/threads/${encodeURIComponent(selectedId)}/approvals`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: request.id, kind: request.kind, decision }) });
              if (!response.ok) throw new Error();
              card.replaceChildren(element('p', '', decision === 'accept' ? '已允许，等待任务更新' : '已拒绝，等待任务更新'));
            } catch { button.disabled = false; card.append(element('p', 'list-error', '处理失败，请查看任务状态')); }
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
  const turnKeyCounts = new Map();
  for (const turn of view.turns || []) { const key = turn.viewKey || turn.id; turnKeyCounts.set(key, (turnKeyCounts.get(key) || 0) + 1); }
  for (const [turnIndex, turn] of (view.turns || []).entries()) {
    const turnDisplayKey = turn.viewKey || turn.id;
    const row = element('article', 'turn');
    if (turn.status === 'interrupted' || turn.status === 'failed') row.append(element('div', 'turn-meta', turn.status === 'interrupted' ? '已中断' : '失败'));
    const turnItems = turn.items || [];
    const liveTurn = live && turn.status === 'inProgress';
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
      if (activity && !expandedWork.has(workKey)) {
        workGroup.dataset.lazy = 'true';
        if (live && item.type === 'fileChange' && typeof turn.id === 'string' && typeof item.id === 'string') {
          for (const [index, change] of (Array.isArray(item.changes) ? item.changes : []).entries()) {
            if (typeof change?.path === 'string' && change.path) fileTargets.set(change.path, { open: () => openFilePreview(change.path, viewThread, turn.id, item.id, index) });
          }
        }
        continue;
      }
      let destination = workGroup || row;
      const groupable = candidate => candidate && ['reasoning', 'commandExecution', 'fileChange', 'mcpToolCall'].includes(candidate.type);
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
      if (item.type === 'agentMessage' || item.type === 'userMessage') content = [item.text, item.imageCount > images.length ? (loadingPreview ? '图片加载中' : `图片 ${item.imageCount - images.length} 张，暂不支持预览`) : ''].filter(Boolean).join('\n');
      else if (item.type === 'imageView' || item.type === 'imageGeneration') content = images.length || videos.length ? '' : loadingPreview ? '图片加载中' : '暂不支持预览';
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
        destination.append(details);
        continue;
      }
      else if (item.type === 'fileChange') {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const key = JSON.stringify([selectedId, turnDisplayKey, item.id]);
        const details = element('details', 'file-changes');
        details.open = expandedChanges.has(key);
        details.addEventListener('toggle', () => { if (details.open) expandedChanges.add(key); else expandedChanges.delete(key); });
        const stats = diffStats(changes);
        const filename = changes.length === 1 && typeof changes[0]?.path === 'string' ? changes[0].path.split(/[\\/]/).filter(Boolean).at(-1) : '';
        const title = changes.length ? `已编辑 ${filename || `${changes.length} 个文件`}${stats ? ` +${stats.added} -${stats.removed}` : ''}` : '文件变更';
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
      const pendingAsync = asyncQuestions.length && live && turn === (view.turns || []).at(-1) && !turnItems.slice(itemIndex + 1).some(entry => entry.type === 'userMessage' || entry.questions?.length);
      const skipKey = asyncQuestions.length === 1 && item.id ? JSON.stringify([historyScope?.hostId || '', historyScope?.deviceId || '', selectedId, turn.id, item.id]) : null;
      if (skipKey && !pendingAsync) skippedAsyncQuestions.delete(skipKey);
      const duplicateQuestion = pendingAsync && asyncQuestions.length === 1 && content?.trim() === asyncQuestions[0].question.trim();
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
      const questionReply = item.type === 'userMessage' && !images.length ? questionReplyParts(view.turns || [], turnIndex, itemIndex, content) : null;
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
      } else if (content && !duplicateQuestion) section.append(item.type === 'agentMessage' ? assistantContent(content, live && turn.id && item.id ? { threadId: selectedId, turnId: turn.id, itemId: item.id } : null) : element('p', item.type === 'commandExecution' ? 'item-code' : 'item-text', content));
      if (pendingAsync && !(skipKey && skippedAsyncQuestions.has(skipKey))) {
        const threadId = selectedId, key = JSON.stringify([historyScope?.hostId || '', historyScope?.deviceId || '', threadId, 'async', item.id]);
        let draft = inputDrafts.get(key);
        if (!draft) { draft = { answers: Object.create(null), pending: false }; inputDrafts.set(key, draft); }
        const card = element('div', 'question-card');
        card.append(element('div', 'question-card-title', '问题'));
        const form = element('form', 'user-input-form');
        for (const question of asyncQuestions) {
          const group = element('fieldset', 'user-input-question'); group.append(element('legend', '', question.question));
          for (const option of question.options) {
            const label = element('label', 'user-input-option'); const radio = element('input'); radio.type = 'radio'; radio.name = question.id; radio.value = option;
            radio.checked = draft.answers[question.id] === option;
            radio.addEventListener('change', () => {
              draft.answers[question.id] = option;
              const other = group.querySelectorAll('.user-input-text')[0];
              if (other) other.value = '';
            });
            label.append(radio, element('span', '', option)); group.append(label);
          }
          const input = element('input', 'user-input-text'); input.type = 'text'; input.placeholder = question.options.length ? '其他回答' : '输入回答';
          input.dataset.inputDraftKey = key; input.dataset.inputQuestionId = question.id;
          input.value = question.options.includes(draft.answers[question.id]) ? '' : (draft.answers[question.id] || '');
          input.addEventListener('input', () => { draft.answers[question.id] = input.value; for (const radio of group.querySelectorAll('input[type=radio]')) radio.checked = false; });
          group.append(input); form.append(group);
        }
        const submit = element('button', 'approval-accept', draft.pending ? (draft.outcome || '正在提交') : '提交'); submit.type = 'submit'; submit.disabled = draft.pending;
        const feedback = element('p', 'list-error', draft.feedback || '');
        const actions = element('div', 'question-actions');
        if (skipKey) {
          const skip = element('button', 'question-skip', '跳过'); skip.type = 'button'; skip.disabled = draft.pending;
          skip.addEventListener('click', () => {
            if (draft.pending || selectedId !== threadId || skipKey !== JSON.stringify([historyScope?.hostId || '', historyScope?.deviceId || '', selectedId, turn.id, item.id])) return;
            if (skippedAsyncQuestions.size >= 1024) skippedAsyncQuestions.delete(skippedAsyncQuestions.values().next().value);
            skippedAsyncQuestions.add(skipKey); delete draft.answers[asyncQuestions[0].id]; card.remove();
            if (!questionPanel.querySelector('.question-card, .pending-request')) questionPanel.hidden = true;
          });
          actions.append(skip);
        }
        actions.append(submit); form.append(actions, feedback);
        draft.controls = { submit, status: feedback };
        form.addEventListener('submit', async event => {
          event.preventDefault();
          if (draft.pending) return;
          if (!asyncQuestions.every(q => draft.answers[q.id]?.trim())) { feedback.textContent = '请回答所有问题'; return; }
          draft.pending = true; submit.disabled = true;
          try {
            const response = await scopedFetch(`/api/threads/${encodeURIComponent(threadId)}/async-question`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: item.id, answers: draft.answers }) });
            if (!response.ok) throw new Error();
            draft.feedback = '已提交，等待任务更新'; draft.outcome = '已提交';
          } catch { draft.feedback = '结果暂不确定，请查看电脑上的任务状态'; draft.outcome = '结果待确认'; }
          draft.controls.status.textContent = draft.feedback;
          draft.controls.submit.textContent = draft.outcome;
        });
        card.append(form); questionFragment.append(card); pendingQuestionCount++;
      }
      if (pendingAsync && (!content || duplicateQuestion) && !images.length && !videos.length) continue;
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
    fragment.append(row);
  }
  for (const [scope, groups] of priorWorkGroups) if (!renderedWorkScopes.has(scope)) {
    for (const group of groups) expandedWork.delete(group.key);
    priorWorkGroups.delete(scope);
  }
  const focusedInput = document.activeElement;
  const inputFocus = focusedInput?.dataset?.inputDraftKey ? { key: focusedInput.dataset.inputDraftKey, question: focusedInput.dataset.inputQuestionId, start: focusedInput.selectionStart, end: focusedInput.selectionEnd } : null;
  const oldQuestionScroll = questionPanel.scrollTop;
  turns.replaceChildren(fragment);
  pruneVideoPreviews();
  for (const video of playingVideos) if (video.isConnected && video.paused) void video.play().catch(() => {});
  if (workFocus) {
    let target = [...turns.querySelectorAll('details.work-activity')].find(node => node.dataset.workKey === workFocus.key);
    for (const index of workFocus.path) target = target?.children[index];
    if (target?.tagName === workFocus.tag && target.className === workFocus.className && target.textContent === workFocus.text) target.focus?.({ preventScroll: true });
  }
  questionPanel.replaceChildren(questionFragment);
  questionPanel.hidden = pendingQuestionCount === 0;
  if (Number.isFinite(oldQuestionScroll)) questionPanel.scrollTop = oldQuestionScroll;
  if (inputFocus) {
    const replacement = [...questionPanel.querySelectorAll('.user-input-text')].find(input => input.dataset.inputDraftKey === inputFocus.key && input.dataset.inputQuestionId === inputFocus.question);
    if (replacement) { replacement.focus({ preventScroll: true }); replacement.setSelectionRange(inputFocus.start, inputFocus.end); }
  }
  if (conversation) {
    if (followLatest) conversation.scrollTop = conversation.scrollHeight;
    else if (Number.isFinite(oldScrollTop)) conversation.scrollTop = oldScrollTop;
    if (historyScrollThread !== selectedId) { historyScrollThread = selectedId; previousHistoryScrollTop = conversation.scrollTop; }
  }
  updateHistoryControl();
  updateScrollButton();
  renderSummary(view, fileTargets);
  status(live ? '已连接' : '仅查看历史', live ? 'ready' : 'error');
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
  return JSON.stringify([view.runtimeStatus, view.collaborationMode, view.goal, view.requests,
    (view.turns || []).map(turn => [turn.id, turn.status, (turn.items || []).filter(item => item?.questions?.length || item?.type === 'userMessage').map(item => [item.id, item.type, item.questions])])]);
}
const recentViews = new Map();
let recentViewBytes = 0;
function recentKey(id) { return JSON.stringify([historyScope?.hostId || '', historyScope?.deviceId || '', id]); }
function clearRecentViews() { recentViews.clear(); recentViewBytes = 0; }
function rememberView(view) {
  try {
    const safe = { id: view.id, title: view.title, history: view.history, turns: view.turns.map(turn => ({ ...turn, items: (turn.items || []).map(item => { const { images, videos, ...rest } = item; return rest; }) })) };
    const serialized = JSON.stringify(safe), bytes = new TextEncoder().encode(serialized).byteLength, key = recentKey(view.id), old = recentViews.get(key);
    if (old) { recentViewBytes -= old.bytes; recentViews.delete(key); }
    if (bytes > 4 * 1024 * 1024) return;
    while (recentViews.size >= 3 || recentViewBytes + bytes > 8 * 1024 * 1024) { const first = recentViews.keys().next().value; recentViewBytes -= recentViews.get(first).bytes; recentViews.delete(first); }
    recentViews.set(key, { view: JSON.parse(serialized), bytes, expires: Date.now() + 30000 }); recentViewBytes += bytes;
  } catch { /* Caching must never interrupt live updates. */ }
}
function recentView(id) {
  const key = recentKey(id), entry = recentViews.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expires) { recentViewBytes -= entry.bytes; recentViews.delete(key); return null; }
  return entry.view;
}
function carryHistoryWindow(previous, next) {
  if (!loadedHistory || !previous || previous.id !== next?.id) return;
  const field = previous.history?.keyField;
  if (!['id', 'viewKey'].includes(field) || next.history?.keyField !== field || !Array.isArray(previous.turns) || !Array.isArray(next.turns)) { loadedHistory.gap = true; loadedHistory.stale = true; return; }
  const oldKeys = previous.turns.map(turn => turn?.[field]), newKeys = next.turns.map(turn => turn?.[field]);
  if ([...oldKeys, ...newKeys].some(key => typeof key !== 'string' || !key) || new Set(oldKeys).size !== oldKeys.length || new Set(newKeys).size !== newKeys.length) { loadedHistory.gap = true; loadedHistory.stale = true; return; }
  if (oldKeys.length === newKeys.length && oldKeys.every((key, index) => key === newKeys[index])) return;
  if (oldKeys.length <= newKeys.length && oldKeys.every((key, index) => key === newKeys[index])) return;
  const overlap = oldKeys.findIndex(key => key === newKeys[0]);
  if (overlap <= 0 || !oldKeys.slice(overlap).every((key, index) => key === newKeys[index])) { loadedHistory.gap = true; loadedHistory.stale = true; return; }
  const existing = new Set(loadedHistory.turns.map(turn => turn[field]));
  const moved = previous.turns.slice(0, overlap).filter(turn => !existing.has(turn[field]));
  loadedHistory = { ...loadedHistory, turns: [...loadedHistory.turns, ...moved], stale: true };
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
  if (type === 'preview') {
    if (streamSeq !== null || !payload.conversation || payload.conversation.id !== selectedId || !Array.isArray(payload.conversation.turns)) return false;
    showState(payload.conversation, false, true); history.textContent = '实时内容加载中'; status('连接中', 'connecting'); return false;
  }
  if (type === 'state') {
    cancelPendingRender();
    if (!payload.conversation || payload.conversation.id !== selectedId || !Array.isArray(payload.conversation.turns)) throw new Error('状态无效');
    if (payload.seq !== undefined && (!Number.isSafeInteger(payload.seq) || payload.seq < 1 || (streamSeq !== null && payload.seq <= streamSeq))) throw new Error('状态版本错误');
    carryHistoryWindow(streamView, payload.conversation);
    streamView = payload.conversation; streamSeq = payload.seq ?? null; rememberView(streamView);
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
    const nextView = { id: metadata.id, title: metadata.title, runtimeStatus: metadata.runtimeStatus, collaborationMode: metadata.collaborationMode, goal: metadata.goal, history: metadata.history, requests: metadata.requests, turns: order.map(id => turns.get(id)) };
    carryHistoryWindow(streamView, nextView);
    streamView = nextView;
    streamSeq = seq;
    if (controlSignature(streamView) !== previousControls) { cancelPendingRender(); rememberView(streamView); showState(streamView); }
    else queueDeltaRender(streamView);
    return true;
  } else if (type === 'history') { cancelPendingRender(); if (!payload.conversation || payload.conversation.id !== selectedId || !Array.isArray(payload.conversation.turns)) throw new Error('状态无效'); streamView = null; streamSeq = null; showState(payload.conversation, false); return false; }
  else if (type === 'status' && payload.status === 'unavailable') { cancelPendingRender(); streamView = null; streamSeq = null; updateLiveTaskStatus(selectedId, 'unknown'); if (displayedHistoryId === selectedId && selectedId) status('仅查看历史', 'error'); else fail('任务状态暂不可用'); }
  return false;
}
async function connect(id, attempt = 0, preserveView = false) {
  cancelPendingRender();
  stopSidebarStatuses();
  streamView = null; streamSeq = null;
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  active?.abort();
  const current = new AbortController(); active = current;
  let assembler;
  let watchdog, receivedView = false;
  const clearWatchdog = () => { clearTimeout(watchdog); watchdog = undefined; };
  current.signal.addEventListener('abort', () => { clearWatchdog(); assembler?.cancel(); if (active === current) { sidebarStatusSnapshot = new Map(); applySidebarStatuses(); } }, { once: true });
  function disconnected() {
    if (current.signal.aborted || active !== current) return;
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
    goalPanel.hidden = true; questionPanel.hidden = true;
  } else clearConversation();
  homeErrorSource = null; error.hidden = true; status(preserveView ? '重新连接中' : '连接中', 'connecting');
  if (!preserveView) showConversationLoading();
  if (!uuid.test(id)) { current.abort(); fail('任务 ID 格式不正确'); return; }
  const cached = recentView(id);
  if (cached) void scopedFetch('/api/host-status', { credentials: 'same-origin', cache: 'no-store', signal: current.signal }).then(response => {
    if ((response.status === 401 || response.status === 403) && active === current) clearRecentViews();
    if (response.ok && active === current && !current.signal.aborted && !connected && !receivedView) { showState(cached, false); status('连接中', 'connecting'); }
  }).catch(() => {});
  resetWatchdog();
  try {
    const response = await scopedFetch(`/api/threads/${encodeURIComponent(id)}/events`, { credentials: 'same-origin', signal: current.signal, cache: 'no-store', headers: { 'x-codex-view-delta': '3', 'x-codex-sidebar-status': '1', 'x-codex-history-window': '1' } });
    if (current.signal.aborted || active !== current) return;
    if (response.status === 401 || response.status === 403) { const message = await responseError(response, '配对状态不可用'); if (active !== current || current.signal.aborted) return; clearRecentViews(); current.abort(); fail(message); return; }
    if (!response.ok || !response.body) throw new Error(await responseError(response, `连接失败 (${response.status})`));
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = '';
    while (true) {
      const { value, done } = await reader.read();
      if (current.signal.aborted || active !== current) return;
      if (done) break;
      if (value?.byteLength) resetWatchdog();
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
          if (!assembler) { const { StateChunkAssembler } = await import('/state-chunks.mjs'); assembler = new StateChunkAssembler(); }
          if (current.signal.aborted || active !== current) return;
          const assembled = await assembler.accept(JSON.parse(line[1]));
          if (current.signal.aborted || active !== current) return;
          if (assembled) {
            if (assembled.value?.event !== 'state' || assembled.value?.data?.seq !== assembled.seq) throw new Error('状态分片无效');
            if (handleEvent(`event: state\ndata: ${JSON.stringify(assembled.value.data)}`)) attempt = 0;
            receivedView = true;
          }
          continue;
        }
        if (/^event:\s*stream-error\s*$/m.test(block)) {
          const line = /^data:\s*(.+)$/m.exec(block);
          let detail; try { detail = line && JSON.parse(line[1]); } catch { /* Invalid events are treated as a connection error. */ }
          if (!['state-too-large', 'state-invalid'].includes(detail?.code)) throw new Error('连接失败');
          current.abort(); updateLiveTaskStatus(id, 'unknown'); fail(detail.code === 'state-too-large' ? '聊天内容过大，暂无法加载' : '聊天暂时无法加载，请在电脑上查看'); connectSidebarStatuses({ allowSelected: true }); return;
        }
        const isView = /^event:\s*(?:state|history)\s*$/m.test(block);
        if (handleEvent(block)) attempt = 0;
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
  pairingAvailable = false;
  resetHistoryScope(true);
  stopSidebarStatuses(); clearTimeout(listRetryTimer); clearTimeout(visibleStatusTimer); clearTimeout(hostStatusTimer); ++listRequestGeneration; ++hostStatusGeneration;
  clearTimeout(reconnectTimer); active?.abort(); active = undefined; selectedId = null;
  clearRecentViews(); clearConversation(); homeErrorSource = null; error.hidden = true; error.textContent = '';
  deviceMenu.hidden = true;
  connection.hidden = true;
  const control = document.querySelector('#unpaired-control'); if (control) { control.hidden = false; control.textContent = '未配对 · 去配对'; }
  projectList.replaceChildren(element('p', 'list-status', '配对电脑后查看任务'));
  status('未配对', 'idle');
}
async function startPairedHome() {
  pairingAvailable = true;
  connection.hidden = false;
  const control = document.querySelector('#unpaired-control'); if (control) control.hidden = true;
  if (window.pairingReady) await loadDevices();
  else void loadDevices();
  if (window.pairingReady && !historyScope) { status('电脑信息不可用', 'error'); return; }
  connectSidebarStatuses(); void loadThreads(); void loadCapabilities(); void refreshHostStatus();
  if (pairingConflict) void refreshPairingStatus();
}
async function checkPairingStatus(pending) {
  if (homeSuspended) return;
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
  if (homeSuspended || generation !== hostStatusGeneration) return;
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
window.addEventListener('pagehide', () => { homeSuspended = true; cancelPendingRender(); stopSidebarStatuses(); stopGoalClock(); clearRecentViews(); stopVoice(); clearImagePreviews(); voiceStatus.textContent = ''; clearTimeout(reconnectTimer); reconnectTimer = undefined; clearTimeout(listRetryTimer); listRetryTimer = undefined; clearTimeout(visibleStatusTimer); visibleStatusTimer = undefined; for (const id of statusHandovers.keys()) clearStatusHandover(id); clearTimeout(hostStatusTimer); clearTimeout(pairingStatusTimer); pairingStatusTimer = undefined; ++pairingStatusGeneration; ++hostStatusGeneration; ++listRequestGeneration; active?.abort(); });
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  homeSuspended = false;
  if (pairingConflict) void refreshPairingStatus();
  if (!pairingAvailable) { if (window.pairingReady) void checkPairingStatus(); return; }
  if (!selectedId) connectSidebarStatuses();
  void loadDevices();
  void loadThreads();
  void refreshHostStatus();
  if (selectedId) void connect(selectedId);
});
