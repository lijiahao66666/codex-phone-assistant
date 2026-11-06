import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPreviewConnector } from '../transport/preview-connector.mjs';
import { isCredentialStatSecure } from './credential-security.mjs';

// Read the credential produced by pairing-cli without exposing it to logs.
export async function createPairedDesktopConnector({ credentialPath, allowInsecureForTests = false, ...options }) {
  if (typeof credentialPath !== 'string' || !isAbsolute(credentialPath)) throw new TypeError('Absolute credential path required');
  const file = await open(credentialPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let config;
  try {
    const info = await file.stat();
    if (!isCredentialStatSecure(info) || info.size > 4096) {
      throw new Error('Invalid credential file permissions');
    }
    config = JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
  if (!config || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.hostId) ||
      typeof config.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(config.secret)) throw new Error('Invalid credential file');
  const origin = new URL(config.origin);
  if ((origin.protocol !== 'https:' && !(allowInsecureForTests && origin.protocol === 'http:' && origin.hostname === '127.0.0.1')) ||
      origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('Invalid relay origin');
  const url = new URL('/connector', origin);
  url.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
  return createPreviewConnector({ ...options, hostId: config.hostId, url: url.href, secret: config.secret, allowInsecureForTests });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const connector = await createPairedDesktopConnector({ credentialPath: process.argv[2] });
    connector.start();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void connector.close().then(() => process.exit(0)); });
  } catch {
    console.error('Unable to start paired connector; check its credential file and relay configuration.');
    process.exitCode = 1;
  }
}
