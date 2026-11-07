import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only structured local image references authorize a file lookup. Text and
// remote/data URLs never grant access to a local path.
export function userInputImagePath(part) {
  if (part?.type === 'localImage' && typeof part.path === 'string' && isAbsolute(part.path)) return part.path;
  if (part?.type !== 'image' || typeof part.url !== 'string') return null;
  if (isAbsolute(part.url)) return part.url;
  try {
    const url = new URL(part.url);
    return url.protocol === 'file:' && !url.hostname ? fileURLToPath(url) : null;
  } catch { return null; }
}
