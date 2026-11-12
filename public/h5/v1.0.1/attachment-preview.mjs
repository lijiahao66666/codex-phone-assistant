const textExtensions = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|ya?ml|toml|ini|conf|log|js|jsx|mjs|cjs|ts|tsx|css|html?|svg|sql|java|py|rb|go|rs|sh|bash|zsh|c|h|cpp|hpp)$/i;

export function attachmentPreviewKind(file) {
  const type = file.type || '';
  if (type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf';
  if (type.startsWith('video/') || /\.(mp4|m4v|mov|webm|ogv|avi|mkv|wmv|flv|3gp|mpeg|mpg|mts|m2ts)$/i.test(file.name)) return 'video';
  if (type.startsWith('text/') || ['application/json', 'application/xml'].includes(type) || textExtensions.test(file.name)) return 'text';
  return null;
}

function check(signal) {
  if (signal.aborted) throw new DOMException('Preview cancelled', 'AbortError');
}

function thumbnailCanvas(width, height) {
  if (!(width > 0 && height > 0)) throw new Error('Invalid preview dimensions');
  const scale = Math.min(144 / width, 144 / height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.className = 'attachment-content-thumbnail';
  return canvas;
}

async function textPreview(file, signal) {
  const bytes = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
  check(signal);
  // A binary file renamed .txt must not fill the card with control characters.
  if (bytes.includes(0)) throw new Error('Binary file');
  const text = new TextDecoder().decode(bytes).replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  const pre = document.createElement('pre');
  pre.className = 'attachment-text-thumbnail';
  pre.textContent = text.split(/\r?\n/).slice(0, 16).join('\n').slice(0, 1200) || '空文本';
  return pre;
}

let pdfLibrary;
async function pdfPreview(file, signal) {
  let task, render;
  const stop = () => { render?.cancel(); void task?.destroy().catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    const pdfjs = await (pdfLibrary ||= import('./pdf-parser.mjs?v=6.4.299').catch(error => { pdfLibrary = null; throw error; }));
    check(signal);
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf-worker.mjs?v=6.4.299', import.meta.url).href;
    const data = await file.arrayBuffer();
    check(signal);
    task = pdfjs.getDocument({ data, isEvalSupported: false, useWasm: false, useSystemFonts: true, disableFontFace: true, stopAtErrors: true });
    // Do not show password prompts for an attachment thumbnail.
    task.onPassword = () => { void task.destroy().catch(() => {}); };
    const pdf = await task.promise;
    check(signal);
    const page = await pdf.getPage(1);
    check(signal);
    const original = page.getViewport({ scale: 1 });
    const canvas = thumbnailCanvas(original.width, original.height);
    const viewport = page.getViewport({ scale: canvas.width / original.width });
    render = page.render({ canvasContext: canvas.getContext('2d'), viewport });
    await render.promise;
    check(signal);
    return canvas;
  } finally {
    signal.removeEventListener('abort', stop);
    if (task) await task.destroy().catch(() => {});
  }
}

function videoEvent(video, name, signal) {
  return new Promise((resolve, reject) => {
    const clean = () => { video.removeEventListener(name, done); video.removeEventListener('error', failed); signal.removeEventListener('abort', aborted); };
    const done = () => { clean(); resolve(); };
    const failed = () => { clean(); reject(new Error('Video preview unavailable')); };
    const aborted = () => { clean(); reject(new DOMException('Preview cancelled', 'AbortError')); };
    if (signal.aborted) return aborted();
    video.addEventListener(name, done, { once: true });
    video.addEventListener('error', failed, { once: true });
    signal.addEventListener('abort', aborted, { once: true });
  });
}

async function videoPreview(file, signal) {
  if (file.size > 10 * 1024 * 1024) throw new Error('Video exceeds 10 MB');
  const video = document.createElement('video'), url = URL.createObjectURL(file);
  video.muted = true; video.playsInline = true; video.preload = 'auto';
  try {
    const ready = videoEvent(video, 'loadeddata', signal);
    video.src = url; video.load();
    await ready;
    check(signal);
    if (Number.isFinite(video.duration) && video.duration > 0.2) {
      const seeked = videoEvent(video, 'seeked', signal);
      video.currentTime = Math.min(0.1, video.duration / 2);
      await seeked;
    }
    check(signal);
    const canvas = thumbnailCanvas(video.videoWidth, video.videoHeight);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url);
  }
}

// Keep PDF/video rendering bounded when several files are selected together.
let active = 0;
const queue = [];
function schedule(run, signal) {
  return new Promise((resolve, reject) => {
    const entry = { run, signal, resolve, reject };
    const abort = () => { const index = queue.indexOf(entry); if (index >= 0) { queue.splice(index, 1); reject(new DOMException('Preview cancelled', 'AbortError')); } };
    entry.abort = abort;
    signal.addEventListener('abort', abort, { once: true });
    queue.push(entry); drain();
  });
}
function drain() {
  while (active < 2 && queue.length) {
    const entry = queue.shift();
    entry.signal.removeEventListener('abort', entry.abort);
    active++;
    Promise.resolve().then(() => { check(entry.signal); return entry.run(); }).then(entry.resolve, entry.reject).finally(() => { active--; drain(); });
  }
}

export async function createAttachmentPreview(file, { signal } = {}) {
  const kind = attachmentPreviewKind(file);
  if (!kind) return null;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, kind === 'pdf' ? 30000 : 10000);
  let rejectCancelled;
  const cancelled = new Promise((resolve, reject) => { rejectCancelled = () => reject(new DOMException('Preview cancelled', 'AbortError')); });
  controller.signal.addEventListener('abort', rejectCancelled, { once: true });
  try {
    check(controller.signal);
    return await Promise.race([cancelled, schedule(async () => {
      const element = await ({ text: textPreview, pdf: pdfPreview, video: videoPreview })[kind](file, controller.signal);
      element.setAttribute('role', 'img');
      element.setAttribute('aria-label', `${file.name} ${kind === 'pdf' ? '第一页' : kind === 'video' ? '视频画面' : '内容预览'}`);
      return element;
    }, controller.signal)]);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectCancelled);
  }
}
