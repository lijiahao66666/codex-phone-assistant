import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

// A relay can call this before its existing static-asset handler. Paths are fixed;
// user-supplied paths are never resolved into the filesystem.
const assets = new Map([
  ['/attachment-preview.mjs', new URL('../../public/attachment-preview.mjs', import.meta.url)],
  ['/pdf-parser.mjs?v=6.4.299', new URL('../../node_modules/pdfjs-dist/legacy/build/pdf.min.mjs', import.meta.url)],
  ['/pdf-worker.mjs?v=6.4.299', new URL('../../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url)],
]);

export async function serveAttachmentPreviewAsset(req, res) {
  if (req.method !== 'GET' || !assets.has(req.url)) return false;
  try {
    const compressed = /\bgzip\b/.test(req.headers?.['accept-encoding'] || '');
    const bytes = await readFile(assets.get(req.url)), content = compressed ? gzipSync(bytes) : bytes;
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': req.url.includes('?v=') ? 'private, max-age=86400' : 'no-store', 'x-content-type-options': 'nosniff', vary: 'Accept-Encoding', ...(compressed ? { 'content-encoding': 'gzip' } : {}) });
    res.end(content);
  } catch {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('Preview unavailable');
  }
  return true;
}
