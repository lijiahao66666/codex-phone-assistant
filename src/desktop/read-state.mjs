import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailable = reason => ({ status: 'unavailable', reason, canReadUnread: false, canMarkRead: false });

// Read-only projection of Desktop's own receipts. A matching persisted scope
// proves which unread set to display; it does not authorize sending a receipt.
export function projectDesktopReadState(state) {
  const identity = state?.['electron-persisted-atom-state']?.['local-document-identity'];
  if (!object(identity) || typeof identity.accountId !== 'string' || !identity.accountId
      || typeof identity.userId !== 'string' || !identity.userId) return unavailable('identity-unavailable');
  const identityKey = createHash('sha256').update(JSON.stringify(['chatgpt', identity.accountId, identity.userId])).digest('hex');
  const hosts = state?.['electron-thread-read-state-v1']?.unreadByIdentity?.[identityKey];
  if (!object(hosts)) return unavailable('scope-unavailable');
  const localKeys = Object.keys(hosts).filter(host => /^local:[a-f0-9]{64}$/.test(host));
  if (localKeys.length !== 1) return unavailable('scope-ambiguous');
  const unread = hosts[localKeys[0]];
  if (!Array.isArray(unread) || unread.some(id => typeof id !== 'string' || !id)) return unavailable('state-invalid');
  // The external IPC read-state broadcast is not handled by the current native
  // desktop runtime. Keep writes disabled until a supported path passes a real
  // unread -> read test; a successful socket write is not an acknowledgement.
  const scopeKey = createHash('sha256').update(JSON.stringify([identityKey, localKeys[0]])).digest('hex');
  return { status: 'available', canReadUnread: true, canMarkRead: false, scopeKey, unreadThreadIds: new Set(unread) };
}

export async function readDesktopReadState({ codexHome = join(homedir(), '.codex') } = {}) {
  try { return projectDesktopReadState(JSON.parse(await readFile(join(codexHome, '.codex-global-state.json'), 'utf8'))); }
  catch { return unavailable('state-unavailable'); }
}
