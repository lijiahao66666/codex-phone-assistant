import { open, mkdir, lstat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { pairingLink } from './registry.mjs';
import { hardenPrivatePath, isCredentialStatSecure, isPrivateDirectoryStat } from './credential-security.mjs';
import QRCode from 'qrcode';

const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function originUrl(origin, allowInsecureForTests = false) {
  const url = new URL(origin);
  if ((url.protocol !== 'https:' && !(allowInsecureForTests && url.protocol === 'http:' && url.hostname === '127.0.0.1')) ||
      url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new TypeError('Invalid relay origin');
  return url;
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  hardenPrivatePath(path);
  const info = await lstat(path);
  if (!isPrivateDirectoryStat(info)) {
    throw new Error('Credential directory must be private and owned by the current user');
  }
}

async function readConfig(path) {
  const flags = (await import('node:fs')).constants.O_RDONLY | ((await import('node:fs')).constants.O_NOFOLLOW || 0);
  const file = await open(path, flags);
  try {
    const info = await file.stat();
    if (!isCredentialStatSecure(info) || info.size > 4096) throw new Error('Invalid credential file permissions');
    const config = JSON.parse(await file.readFile('utf8'));
    if (!uuidPattern.test(config.hostId) || !secretPattern.test(config.secret)) throw new Error('Invalid credential file');
    originUrl(config.origin);
    return config;
  } finally { await file.close(); }
}

export class PairingConnector {
  constructor({ origin, configPath, fetchImpl = fetch, allowInsecureForTests = false, writeConfig = async (file, value) => { await file.writeFile(value); await file.sync(); } }) {
    this.url = originUrl(origin, allowInsecureForTests);
    if (typeof configPath !== 'string' || !isAbsolute(configPath)) throw new TypeError('Absolute credential path required');
    this.configPath = configPath;
    this.fetch = fetchImpl;
    this.writeConfig = writeConfig;
  }

  async #call(path, { secret, body, method = 'POST' } = {}) {
    const headers = { accept: 'application/json' };
    if (secret) headers.authorization = `Bearer ${secret}`;
    if (body) headers['content-type'] = 'application/json';
    let response;
    try { response = await this.fetch(new URL(path, this.url), { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
    catch { throw new Error('Relay request failed'); }
    if (!response.ok) throw new Error(`Relay request failed (${response.status})`);
    try { return await response.json(); } catch { throw new Error('Invalid relay response'); }
  }

  async #config() {
    const config = await readConfig(this.configPath);
    if (config.origin !== this.url.origin) throw new Error('Credential belongs to a different relay');
    return config;
  }

  async enroll({ name }) {
    if (typeof name !== 'string' || !name.trim() || name.length > 120) throw new TypeError('Host name required');
    await privateDirectory(dirname(this.configPath));
    const file = await open(this.configPath, 'wx', 0o600);
    let complete = false;
    let enrolledSecret;
    try {
      hardenPrivatePath(this.configPath);
      const result = await this.#call('/api/enroll', { body: { name: name.trim() } });
      if (!uuidPattern.test(result.hostId) || !secretPattern.test(result.secret)) throw new Error('Invalid enrollment response');
      enrolledSecret = result.secret;
      await this.writeConfig(file, JSON.stringify({ origin: this.url.origin, hostId: result.hostId, secret: result.secret }) + '\n');
      complete = true;
      return { hostId: result.hostId };
    } catch (error) {
      if (enrolledSecret) {
        try { await this.#call('/api/host/revoke', { secret: enrolledSecret }); }
        catch { throw new Error('Credential storage failed and remote host cleanup could not be confirmed'); }
      }
      throw error;
    } finally {
      await file.close();
      if (!complete) await unlink(this.configPath).catch(() => {});
    }
  }

  async issuePairing() {
    const config = await this.#config();
    const result = await this.#call('/api/host/pair-code', { secret: config.secret });
    if (!Number.isSafeInteger(result.expiresAt)) throw new Error('Invalid pairing response');
    const link = pairingLink(this.url.origin, result.qrToken);
    return { code: result.code, expiresAt: result.expiresAt, link, qr: await QRCode.toString(link, { type: 'terminal', small: true }) };
  }

  async listDevices() {
    const config = await this.#config();
    const result = await this.#call('/api/host/devices', { secret: config.secret, method: 'GET' });
    if (!Array.isArray(result.devices)) throw new Error('Invalid device list');
    return result.devices;
  }

  async listPairRequests() {
    const config = await this.#config();
    const result = await this.#call('/api/host/pair-requests', { secret: config.secret, method: 'GET' });
    if (!Array.isArray(result.requests) || result.requests.some(request => !uuidPattern.test(request?.requestId))) throw new Error('Invalid pairing requests');
    return result.requests.map(({ requestId }) => ({ requestId }));
  }

  async decidePairRequest(requestId, approve) {
    if (!uuidPattern.test(requestId) || typeof approve !== 'boolean') throw new TypeError('Invalid pairing decision');
    const config = await this.#config();
    return this.#call(`/api/host/pair-requests/${requestId}/${approve ? 'approve' : 'reject'}`, { secret: config.secret });
  }

  async revokeDevice(deviceId) {
    if (!uuidPattern.test(deviceId)) throw new TypeError('Invalid device ID');
    const config = await this.#config();
    return this.#call(`/api/host/devices/${deviceId}/revoke`, { secret: config.secret });
  }
}
