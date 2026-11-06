import * as path from 'node:path';

export function absolutePath(value, api = path) {
  if (typeof value !== 'string' || !api.isAbsolute(value)) return false;
  if (api === path.win32 || (api === path && process.platform === 'win32')) {
    return /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(value);
  }
  return true;
}

export function insidePath(root, target, api = path) {
  const rel = api.relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel);
}

export function pathKey(value, api = path) {
  if (!absolutePath(value, api)) return null;
  const normalized = api.normalize(value);
  const root = api.parse(normalized).root;
  const trimmed = normalized === root ? root : normalized.replace(/[\\/]+$/, '');
  return api === path.win32 || (api === path && process.platform === 'win32') ? trimmed.toLowerCase() : trimmed;
}

export function sameOrInside(root, target, api = path) {
  const parent = pathKey(root, api), child = pathKey(target, api);
  return parent !== null && child !== null && (parent === child || insidePath(parent, child, api));
}
