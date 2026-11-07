import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { createGzip, gunzip, constants as zlibConstants } from 'node:zlib';
import { promisify } from 'node:util';
import { PairingRegistry } from '../pairing/registry.mjs';
import { serveAttachmentPreviewAsset } from '../transport/attachment-preview-assets.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const decompressUploadChunk = promisify(gunzip);

// Experimental relay. TLS must terminate at a trusted loopback-only proxy.
export function createPairRelay({ origin, database = ':memory:', production = false, trustedProxy = false, imageUpload = false, imagePreview = false, now = Date.now, pairTtlMs = 120000, requestTimeoutMs = 10000, historyMaxDurationMs = 120000, heartbeatMs = 15000, bodyTimeoutMs = 10000, maxHosts = 10000, unpairedTtlMs = 604800000, onChunkForTests } = {}) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw new TypeError('HTTPS origin required');
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) throw new TypeError('Invalid timeout');
  if (!Number.isSafeInteger(historyMaxDurationMs) || historyMaxDurationMs < 1) throw new TypeError('Invalid history timeout');
  if (production && database === ':memory:') throw new TypeError('Persistent database required in production');
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1) throw new TypeError('Invalid heartbeat');
  if (!Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs < 1) throw new TypeError('Invalid body timeout');
  const registry = new PairingRegistry(database, { now, pairTtlMs, maxHosts, unpairedTtlMs });
  const peers = new Map(), pending = new Map(), bodyReads = new Set(), phonePresence = new Map();
  const maxPairPending = 5;
  const pairPendingCount = (entries, phone) => [...entries, ...bodyReads].filter(entry => entry.hostId === phone.hostId && entry.deviceId === phone.deviceId).length;
  function rejectBodyRead(entry, error) {
    entry.res.once('finish', () => { if (!entry.req.complete) entry.req.destroy(); });
    send(entry.res, 401, { error });
  }
  function activatePair(paired) {
    if (paired.previousDeviceId) {
      phonePresence.delete(paired.previousDeviceId);
      const peer = peers.get(paired.hostId);
      if (peer?.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: 'device-revoked', deviceId: paired.previousDeviceId }));
    }
    for (const [id, entry] of pending) if (entry.hostId === paired.hostId && entry.deviceId !== paired.deviceId) cancel(id, { unknown: entry.writing });
    for (const entry of bodyReads) if (entry.hostId === paired.hostId && entry.deviceId !== paired.deviceId) rejectBodyRead(entry, 'device-replaced');
    const peer = peers.get(paired.hostId);
    if (peer?.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: 'device-restored', deviceId: paired.deviceId }));
  }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: { threshold: 1024 } });
  let closed = false, pairRequests = 0, enrollmentRequests = 0;
  const limits = new Map();
  let globalPairWindow = { attempts: 0, until: 0 };
  const enrollmentLimits = new Map();
  const source = req => {
    const peer = req.socket.remoteAddress;
    if (!trustedProxy) return peer;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)) return null;
    const forwarded = req.headers['x-real-ip'];
    return typeof forwarded === 'string' && isIP(forwarded) ? forwarded : null;
  };
  const send = (res, status, payload) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    res.end(JSON.stringify(payload));
  };
  const sameOrigin = req => req.headers.origin === base.origin && req.headers['sec-fetch-site'] === 'same-origin';
  const sameOriginRead = req => (!req.headers.origin || req.headers.origin === base.origin) && req.headers['sec-fetch-site'] === 'same-origin';
  const assets = {
    '/pair': ['desktop.html', 'text/html; charset=utf-8'],
    '/app-icon.png': ['app-icon.png', 'image/png'],
    '/app-icon-20261104.png': ['app-icon.png', 'image/png'],
    '/app-icon-20261106.png': ['app-icon.png', 'image/png'],
    '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
    '/install-prompt.js': ['install-prompt.js', 'text/javascript; charset=utf-8'],
    '/pair.js': ['pair.js', 'text/javascript; charset=utf-8'],
    '/history-projection.mjs': ['history-projection.mjs', 'text/javascript; charset=utf-8'],
    '/state-chunks.mjs': ['state-chunks.mjs', 'text/javascript; charset=utf-8'],
    '/state-chunks-prototype.mjs': ['state-chunks.mjs', 'text/javascript; charset=utf-8'],
    '/jsQR.js': ['../node_modules/jsqr/dist/jsQR.js', 'text/javascript; charset=utf-8'],
    '/pair.css': ['pair.css', 'text/css; charset=utf-8'],
    '/': ['desktop.html', 'text/html; charset=utf-8'],
    '/desktop.js': ['desktop.js', 'text/javascript; charset=utf-8'],
    '/recovery-attempt-store.js': ['recovery-attempt-store.js', 'text/javascript; charset=utf-8'],
    '/markdown-parser.js': ['../node_modules/marked/lib/marked.umd.js', 'text/javascript; charset=utf-8'],
    '/html-sanitizer.js': ['../node_modules/dompurify/dist/purify.min.js', 'text/javascript; charset=utf-8'],
    '/desktop.css': ['desktop.css', 'text/css; charset=utf-8'],
  };
  const hostSecret = req => req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
  const cookieAttrs = 'Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Strict';
  const cookies = req => (req.headers.cookie || '').split(';').map(part => part.trim()).filter(Boolean);
  const devices = req => {
    const result = [], seen = new Set();
    for (const part of cookies(req)) {
      const match = /^__Host-codex-device-([0-9a-f-]{36})=([A-Za-z0-9_-]{43})$/i.exec(part);
      if (!match || !uuid.test(match[1]) || seen.has(match[1])) continue;
      seen.add(match[1]);
      const found = registry.authenticateDevice(match[2]);
      if (found?.deviceId === match[1]) result.push(found);
    }
    const legacy = cookies(req).filter(part => part.startsWith('__Host-codex-device='));
    if (legacy.length === 1) {
      const found = registry.authenticateDevice(legacy[0].slice('__Host-codex-device='.length));
      if (found && !seen.has(found.deviceId)) result.push(found);
    }
    return result;
  };
  const device = req => {
    const all = devices(req);
    const selected = cookies(req).filter(part => part.startsWith('__Host-codex-current='));
    if (selected.length === 1) return all.find(item => item.deviceId === selected[0].slice('__Host-codex-current='.length)) ?? all[0] ?? null;
    return all.length === 1 ? all[0] : null;
  };
  async function body(req, limit = 4096) {
    let size = 0, chunks = [];
    const timer = setTimeout(() => req.destroy(), bodyTimeoutMs);
    try { for await (const chunk of req) { size += chunk.length; if (size > limit) return null; chunks.push(chunk); } }
    catch { return null; }
    finally { clearTimeout(timer); }
    try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; }
  }
  async function bytesBody(req, limit) {
    let size = 0, chunks = [];
    const timer = setTimeout(() => req.destroy(), bodyTimeoutMs);
    try { for await (const chunk of req) { size += chunk.length; if (size > limit) return null; chunks.push(chunk); } return Buffer.concat(chunks); }
    catch { return null; } finally { clearTimeout(timer); }
  }
  async function reservedBody(req, res, phone, limit) {
    if (pairPendingCount([...pending.values()], phone) >= maxPairPending) { send(res, 503, { error: 'busy' }); return null; }
    const reservation = { hostId: phone.hostId, deviceId: phone.deviceId, req, res };
    bodyReads.add(reservation);
    res.once('close', () => bodyReads.delete(reservation));
    res.once('finish', () => bodyReads.delete(reservation));
    const data = await body(req, limit);
    if (!registry.isActiveDevice(phone.hostId, phone.deviceId)) { send(res, 401, { error: 'device-replaced' }); return null; }
    return { data, reservation };
  }
  function cancel(id, { unknown = false } = {}) {
    const entry = pending.get(id); if (!entry) return;
    if (entry.uploadSent) console.warn('upload-observation', 'response-timeout-or-disconnect');
    pending.delete(id); clearTimeout(entry.timer); clearTimeout(entry.hardTimer); clearInterval(entry.heartbeat);
    const peer = peers.get(entry.hostId);
    if (peer?.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: entry.writing ? 'cancel-reply' : entry.uploadSent ? 'cancel-upload' : 'cancel', id }));
    if (entry.streaming) entry.output.end();
    else if (entry.res.headersSent) entry.res.destroy();
    else send(entry.res, unknown || entry.writing ? 504 : 503, { error: unknown || entry.writing ? 'outcome-unknown' : 'unavailable' });
  }
  function revokeDevice(hostCredential, deviceId) {
    const ok = registry.revokeDevice(hostCredential, deviceId);
    if (ok) { for (const [id, entry] of pending) if (entry.deviceId === deviceId) cancel(id, { unknown: entry.writing }); for (const entry of bodyReads) if (entry.deviceId === deviceId) rejectBodyRead(entry, 'unauthorized'); for (const peer of peers.values()) if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: 'device-revoked', deviceId })); }
    return ok;
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (closed || req.headers.host !== base.host) return send(res, 403, { error: 'forbidden' });
      if (await serveAttachmentPreviewAsset(req, res)) return;
      if (req.method === 'GET' && Object.hasOwn(assets, req.url)) {
        const [file, type] = assets[req.url];
        const content = await readFile(new URL(`../../public/${file}`, import.meta.url));
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; img-src 'self' blob:; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
        return res.end(content);
      }
      if (req.method === 'POST' && req.url === '/api/enroll') {
        if (req.headers['content-type'] !== 'application/json') return send(res, 400, { error: 'invalid' });
        const ip = source(req); if (!ip) return send(res, 403, { error: 'forbidden' });
        for (const [key, item] of enrollmentLimits) if (item.until <= now()) enrollmentLimits.delete(key);
        const limit = enrollmentLimits.get(ip);
        if ((limit && limit.attempts >= 10) || enrollmentRequests >= 64 || (!limit && enrollmentLimits.size >= 10000)) return send(res, 429, { error: 'rate-limited' });
        enrollmentLimits.set(ip, { attempts: (limit?.attempts ?? 0) + 1, until: limit?.until ?? now() + 60000 });
        enrollmentRequests++;
        let data;
        try { data = await body(req); } finally { enrollmentRequests--; }
        if (!data || typeof data.name !== 'string' || Object.keys(data).length !== 1) return send(res, 400, { error: 'invalid' });
        let result; try { result = registry.createHost(data.name); } catch (error) { return send(res, error.code === 'capacity' ? 503 : 400, { error: error.code === 'capacity' ? 'capacity' : 'invalid' }); }
        return send(res, 201, result);
      }
      if (req.method === 'POST' && req.url === '/api/pair') {
        if (!sameOrigin(req) || req.headers['content-type'] !== 'application/json') return send(res, 403, { error: 'forbidden' });
        const ip = source(req); if (!ip) return send(res, 403, { error: 'forbidden' });
        const limit = limits.get(ip);
        if (limit && limit.attempts >= 5 && now() < limit.until) return send(res, 429, { error: 'rate-limited' });
        if (limit && now() >= limit.until) limits.delete(ip);
        if (pairRequests >= 64) return send(res, 429, { error: 'rate-limited' });
        for (const [key, item] of limits) if (item.until <= now()) limits.delete(key);
        if (!limits.has(ip) && limits.size >= 10000) return send(res, 429, { error: 'rate-limited' });
        if (now() >= globalPairWindow.until) globalPairWindow = { attempts: 0, until: now() + 60000 };
        if (globalPairWindow.attempts >= 30) return send(res, 429, { error: 'rate-limited' });
        globalPairWindow.attempts++;
        const attempt = { attempts: (limits.get(ip)?.attempts ?? 0) + 1, until: now() + 60000 };
        limits.set(ip, attempt);
        pairRequests++;
        let paired, request;
        try {
          const data = await body(req);
          if (data && Object.keys(data).length === 1 && typeof data.code === 'string') request = registry.requestCode(data.code);
          else if (data && Object.keys(data).length === 1 && typeof data.qrToken === 'string') paired = registry.redeemQr(data.qrToken);
        }
        finally { pairRequests--; }
        if (!paired && !request) return send(res, attempt.attempts >= 5 ? 429 : 401, { error: attempt.attempts >= 5 ? 'rate-limited' : 'invalid-code' });
        // Do not erase later concurrent attempts reserved for the same source.
        if (limits.get(ip) === attempt) limits.delete(ip);
        if (request) return send(res, 202, { pending: true, claimToken: request.claimToken });
        activatePair(paired);
        res.setHeader('set-cookie', [`__Host-codex-device-${paired.deviceId}=${paired.token}; ${cookieAttrs}`, `__Host-codex-current=${paired.deviceId}; ${cookieAttrs}`]);
        return send(res, 200, { hostId: paired.hostId, deviceId: paired.deviceId });
      }
      if (req.method === 'POST' && req.url === '/api/pair/claim') {
        if (!sameOrigin(req) || req.headers['content-type'] !== 'application/json') return send(res, 403, { error: 'forbidden' });
        const data = await body(req);
        const paired = data && Object.keys(data).length === 1 && registry.claimRequest(data.claimToken);
        if (!paired || paired.rejected) return send(res, 401, { error: 'invalid-code' });
        if (paired.pending) return send(res, 202, { pending: true });
        activatePair(paired);
        res.setHeader('set-cookie', [`__Host-codex-device-${paired.deviceId}=${paired.token}; ${cookieAttrs}`, `__Host-codex-current=${paired.deviceId}; ${cookieAttrs}`]);
        return send(res, 200, { hostId: paired.hostId, deviceId: paired.deviceId });
      }
      const secret = hostSecret(req), host = registry.authenticateHost(secret);
      if (req.method === 'GET' && req.url === '/api/host/pair-requests') {
        if (!host) return send(res, 401, { error: 'unauthorized' });
        return send(res, 200, { requests: registry.pendingRequests(secret) });
      }
      const confirmation = /^\/api\/host\/pair-requests\/([0-9a-f-]{36})\/(approve|reject)$/i.exec(req.url || '');
      if (req.method === 'POST' && confirmation) {
        if (!host) return send(res, 401, { error: 'unauthorized' });
        const ok = confirmation[2] === 'approve' ? registry.approveRequest(secret, confirmation[1]) : registry.rejectRequest(secret, confirmation[1]);
        return send(res, ok ? 200 : 404, { ok });
      }
      if (req.method === 'POST' && req.url === '/api/host/pair-code') {
        if (!host) return send(res, 401, { error: 'unauthorized' });
        return send(res, 200, registry.issueCode(secret));
      }
      if (req.method === 'GET' && req.url === '/api/host/devices') {
        if (!host) return send(res, 401, { error: 'unauthorized' });
        const time = now();
        for (const [id, seen] of phonePresence) if (time - seen >= 60000) phonePresence.delete(id);
        return send(res, 200, { devices: registry.listDevices(secret).map(item => ({ ...item, phoneConnected: phonePresence.has(item.deviceId) })) });
      }
      if (req.method === 'POST' && req.url === '/api/host/revoke') {
        if (!host) return send(res, 401, { error: 'unauthorized' });
        registry.revokeHost(secret);
        for (const [id, entry] of pending) if (entry.hostId === host.id) cancel(id, { unknown: entry.writing });
        for (const entry of bodyReads) if (entry.hostId === host.id) rejectBodyRead(entry, 'unauthorized');
        peers.get(host.id)?.terminate();
        return send(res, 200, { ok: true });
      }
      const revoke = /^\/api\/host\/devices\/([0-9a-f-]{36})\/revoke$/i.exec(req.url || '');
      if (req.method === 'POST' && revoke) {
        if (!host) return send(res, 401, { error: 'unauthorized' });
        return send(res, revokeDevice(secret, revoke[1]) ? 200 : 404, { ok: true });
      }
      if (req.url === '/api/devices' && req.method === 'GET') {
        if (!sameOriginRead(req)) return send(res, 403, { error: 'forbidden' });
        const all = devices(req), current = device(req);
        return send(res, 200, { devices: all.map(({ deviceId, hostId, hostName }) => ({ deviceId, hostId, name: hostName })), currentDeviceId: current?.deviceId ?? null });
      }
      if (req.url === '/api/devices/select' && req.method === 'POST') {
        if (!sameOrigin(req) || req.headers['content-type'] !== 'application/json') return send(res, 403, { error: 'forbidden' });
        const data = await body(req);
        const chosen = devices(req).find(item => item.deviceId === data?.deviceId);
        if (!chosen) return send(res, 403, { error: 'forbidden' });
        res.setHeader('set-cookie', `__Host-codex-current=${chosen.deviceId}; ${cookieAttrs}`);
        return send(res, 200, { ok: true });
      }
      if (req.url === '/api/devices/remove' && req.method === 'POST') {
        if (!sameOrigin(req) || req.headers['content-type'] !== 'application/json') return send(res, 403, { error: 'forbidden' });
        const data = await body(req);
        const all = devices(req), chosen = all.find(item => item.deviceId === data?.deviceId);
        if (!chosen) return send(res, 403, { error: 'forbidden' });
        const legacy = cookies(req).filter(part => part.startsWith('__Host-codex-device='));
        const legacyChosen = legacy.length === 1 && registry.authenticateDevice(legacy[0].slice('__Host-codex-device='.length))?.deviceId === chosen.deviceId;
        registry.revokeDeviceId(chosen.deviceId);
        for (const [id, entry] of pending) if (entry.deviceId === chosen.deviceId) cancel(id, { unknown: entry.writing });
        for (const entry of bodyReads) if (entry.deviceId === chosen.deviceId) rejectBodyRead(entry, 'unauthorized');
        const selectedPeer = peers.get(chosen.hostId); if (selectedPeer?.readyState === WebSocket.OPEN) selectedPeer.send(JSON.stringify({ type: 'device-revoked', deviceId: chosen.deviceId }));
        const clear = `__Host-codex-device-${chosen.deviceId}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;
        const next = all.find(item => item.deviceId !== chosen.deviceId);
        const currentCookie = next ? `__Host-codex-current=${next.deviceId}; ${cookieAttrs}` : '__Host-codex-current=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict';
        res.setHeader('set-cookie', [clear, ...(legacyChosen ? ['__Host-codex-device=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict'] : []), currentCookie]);
        return send(res, 200, { ok: true });
      }
      const phone = device(req);
      if (!phone) return send(res, 401, { error: 'unauthorized' });
      if (req.url === '/api/pairing/status' && req.method === 'GET') {
        if (!sameOriginRead(req)) return send(res, 403, { error: 'forbidden' });
        const state = registry.devicePairingState(phone.hostId, phone.deviceId);
        if (!state) return send(res, 401, { error: 'unauthorized' });
        return send(res, 200, { state: state.activeDeviceId === phone.deviceId ? 'active' : 'replaced', activeDeviceId: state.activeDeviceId });
      }
      if (req.url === '/api/pairing/restore' && req.method === 'POST') {
        if (!sameOrigin(req) || req.headers['content-type'] !== 'application/json') return send(res, 403, { error: 'forbidden' });
        const data = await body(req);
        if (!data || Object.keys(data).join(',') !== 'expectedActiveDeviceId' || (data.expectedActiveDeviceId !== null && (typeof data.expectedActiveDeviceId !== 'string' || !uuid.test(data.expectedActiveDeviceId)))) return send(res, 400, { error: 'invalid' });
        const restored = registry.restoreDevice(phone.hostId, phone.deviceId, data.expectedActiveDeviceId);
        if (!restored) return send(res, 401, { error: 'unauthorized' });
        if (restored.conflict) return send(res, 409, { error: 'pairing-changed' });
        if (!restored.alreadyActive) activatePair(restored);
        return send(res, 200, { ok: true });
      }
      if (!registry.isActiveDevice(phone.hostId, phone.deviceId)) {
        const state = registry.devicePairingState(phone.hostId, phone.deviceId);
        return send(res, 401, { error: 'device-replaced', activeDeviceId: state?.activeDeviceId ?? null });
      }
      if (req.headers['x-codex-expected-device'] && req.headers['x-codex-expected-device'] !== phone.deviceId) return send(res, 409, { error: 'device-changed' });
      if (!(req.method === 'GET' ? sameOriginRead(req) : sameOrigin(req))) return send(res, 403, { error: 'forbidden' });
      const requested = req.url || '';
      if (['/api/chats/prepare', '/api/chats/submit'].includes(requested) && req.method === 'POST') {
        if (req.headers['content-type'] !== 'application/json') return send(res, 400, { error: 'invalid' });
        const reserved = await reservedBody(req, res, phone, 65536);
        if (res.writableEnded || res.destroyed) return;
        const data = reserved?.data, prepare = requested.endsWith('/prepare');
        const allowed = prepare ? ['requestId', 'projectId', 'digest', 'model', 'effort'] : ['requestId', 'text', 'model', 'effort', 'attachmentIds'];
        if (!data || Object.keys(data).some(k => !allowed.includes(k)) || !uuid.test(data.requestId || '') || (data.model !== undefined && (typeof data.model !== 'string' || !data.model || data.model.length > 200)) || (data.effort !== undefined && (typeof data.effort !== 'string' || !data.effort || !data.model || data.effort.length > 100)) || (prepare ? typeof data.projectId !== 'string' || !data.projectId || data.projectId.length > 4096 || !/^[a-f0-9]{64}$/.test(data.digest || '') : typeof data.text !== 'string' || Buffer.byteLength(data.text) > 32768 || !Array.isArray(data.attachmentIds) || !data.attachmentIds.length || data.attachmentIds.length > 4 || new Set(data.attachmentIds).size !== data.attachmentIds.length || data.attachmentIds.some(id => !uuid.test(id)))) return send(res, 400, { error: 'invalid' });
        if (!registry.isActiveDevice(phone.hostId, phone.deviceId)) return send(res, 401, { error: 'device-replaced' });
        const peer = peers.get(phone.hostId); if (!peer || peer.readyState !== WebSocket.OPEN) return send(res, 503, { error: 'host-offline' });
        if (pairPendingCount([...pending.values()], phone) - Number(Boolean(reserved?.reservation)) >= maxPairPending) return send(res, 503, { error: 'busy' });
        const id = randomUUID(), timer = setTimeout(() => cancel(id), requestTimeoutMs);
        pending.set(id, { res, timer, streaming: false, writing: true, creating: true, hostId: phone.hostId, deviceId: phone.deviceId });
        if (reserved?.reservation) bodyReads.delete(reserved.reservation);
        res.once('close', () => cancel(id));
        peer.send(JSON.stringify({ type: prepare ? 'prepare-chat' : 'submit-chat', id, deviceId: phone.deviceId, ...data }));
        return;
      }
      if (requested === '/api/chats/status' && req.method === 'POST') {
        if (req.headers['content-type'] !== 'application/json') return send(res, 400, { error: 'invalid' });
        const reserved = await reservedBody(req, res, phone, 1024);
        if (res.writableEnded || res.destroyed) return;
        if (!reserved?.data || Object.keys(reserved.data).length !== 1 || !uuid.test(reserved.data.requestId || '')) return send(res, 400, { error: 'invalid' });
        if (!registry.isActiveDevice(phone.hostId, phone.deviceId)) return send(res, 401, { error: 'device-replaced' });
        const peer = peers.get(phone.hostId); if (!peer || peer.readyState !== WebSocket.OPEN) return send(res, 503, { error: 'host-offline' });
        if (pairPendingCount([...pending.values()], phone) - Number(Boolean(reserved.reservation)) >= maxPairPending) return send(res, 503, { error: 'busy' });
        const id = randomUUID(), timer = setTimeout(() => cancel(id), requestTimeoutMs);
        pending.set(id, { res, timer, streaming: false, writing: false, hostId: phone.hostId, deviceId: phone.deviceId });
        if (reserved.reservation) bodyReads.delete(reserved.reservation);
        res.once('close', () => cancel(id));
        peer.send(JSON.stringify({ type: 'creation-status', id, deviceId: phone.deviceId, requestId: reserved.data.requestId }));
        return;
      }
      if (requested === '/api/chats' && req.method === 'POST') {
        if (req.headers['content-type'] !== 'application/json') return send(res, 400, { error: 'invalid' });
        const reserved = await reservedBody(req, res, phone, 65536);
        if (res.writableEnded || res.destroyed) return;
        const data = reserved?.data;
        if (!data || Object.keys(data).some(k => !['projectId', 'text', 'requestId', 'model', 'effort'].includes(k)) || !uuid.test(data.requestId || '') || typeof data.projectId !== 'string' || !data.projectId || data.projectId.length > 4096 || typeof data.text !== 'string' || !data.text.trim() || Buffer.byteLength(data.text) > 32768 || (data.model !== undefined && (typeof data.model !== 'string' || !data.model || data.model.length > 200)) || (data.effort !== undefined && (typeof data.effort !== 'string' || !data.effort || data.effort.length > 100 || !data.model))) return send(res, 400, { error: 'invalid' });
        if (!registry.isActiveDevice(phone.hostId, phone.deviceId)) return send(res, 401, { error: 'device-replaced' });
        const peer = peers.get(phone.hostId); if (!peer || peer.readyState !== WebSocket.OPEN) return send(res, 503, { error: 'host-offline' });
        if (pairPendingCount([...pending.values()], phone) - Number(Boolean(reserved?.reservation)) >= maxPairPending) return send(res, 503, { error: 'busy' });
        const id = randomUUID(), timer = setTimeout(() => cancel(id), requestTimeoutMs);
        pending.set(id, { res, timer, streaming: false, writing: true, creating: true, hostId: phone.hostId, deviceId: phone.deviceId });
        if (reserved?.reservation) bodyReads.delete(reserved.reservation);
        res.once('close', () => cancel(id));
        peer.send(JSON.stringify({ type: 'create-chat', id, deviceId: phone.deviceId, ...data }));
        return;
      }
      const historyPage = /^\/api\/threads\/([0-9a-f-]{36})\/(history-page|history-validate)\?(.+)$/i.exec(requested);
      if (historyPage) {
        if (req.method !== 'GET' || !uuid.test(historyPage[1])) return send(res, 404, { error: 'not-found' });
        const params = new URLSearchParams(historyPage[3]), before = params.get('before'), hash = params.get('hash'), pageHash = params.get('pageHash'), validate = historyPage[2] === 'history-validate';
        if ([...params.keys()].length !== (validate ? 3 : 2) || !before || before.length > 4096 || !/^[0-9a-f]{64}$/.test(hash || '') || (validate && !/^[0-9a-f]{64}$/.test(pageHash || ''))) return send(res, 400, { error: 'invalid' });
        const peer = peers.get(phone.hostId); if (!peer || peer.readyState !== WebSocket.OPEN) return send(res, 503, { error: 'host-offline' });
        if (pairPendingCount([...pending.values()], phone) >= maxPairPending) return send(res, 503, { error: 'busy' });
        const id = randomUUID(), timer = setTimeout(() => cancel(id), requestTimeoutMs);
        const chunkedHistory = !validate && req.headers['x-codex-history-chunks'] === '1';
        const hardTimer = chunkedHistory ? setTimeout(() => cancel(id), historyMaxDurationMs) : null;
        pending.set(id, { res, timer, hardTimer, streaming: false, historyChunks: chunkedHistory, writing: false, hostId: phone.hostId, deviceId: phone.deviceId });
        res.once('close', () => cancel(id));
        peer.send(JSON.stringify({ type: 'history-page', id, conversationId: historyPage[1], deviceId: phone.deviceId, before, historicalHash: hash, ...(chunkedHistory ? { chunks: true } : {}), ...(validate ? { validatePageHash: pageHash } : {}) }));
        return;
      }
      if (req.method === 'GET' && requested === '/api/host-status') {
        const peer = peers.get(phone.hostId);
        phonePresence.set(phone.deviceId, now());
        return send(res, 200, { online: Boolean(peer && peer.readyState === WebSocket.OPEN) });
      }
      if (req.method === 'GET' && requested === '/api/capabilities') return send(res, 200, { imageUpload, maxImageBytes: 20971520, imageChunkBytes: 131072, uploadCompression: 'gzip' });
      const modelCancel = /^\/api\/threads\/([0-9a-f-]{36})\/model-cancel$/i.exec(requested);
      if (modelCancel) {
        if (!uuid.test(modelCancel[1])) return send(res, 404, { error: 'not-found' });
        if (req.method !== 'POST') return send(res, 405, { error: 'method-not-allowed' });
        if (req.headers['content-type'] !== 'application/json') return send(res, 400, { error: 'invalid' });
        const reserved = await reservedBody(req, res, phone, 1024);
        if (res.writableEnded || res.destroyed) return;
        if (!reserved?.data || Array.isArray(reserved.data) || Object.keys(reserved.data).length !== 1 || !uuid.test(reserved.data.operationId || '')) return send(res, 400, { error: 'invalid' });
        if (!registry.isActiveDevice(phone.hostId, phone.deviceId)) return send(res, 401, { error: 'device-replaced' });
        const peer = peers.get(phone.hostId); if (!peer || peer.readyState !== WebSocket.OPEN) return send(res, 503, { error: 'host-offline' });
        if (pairPendingCount([...pending.values()], phone) - Number(Boolean(reserved.reservation)) >= maxPairPending) return send(res, 503, { error: 'busy' });
        const id = randomUUID(), timer = setTimeout(() => cancel(id), requestTimeoutMs);
        pending.set(id, { res, timer, streaming: false, writing: true, hostId: phone.hostId, deviceId: phone.deviceId });
        if (reserved.reservation) bodyReads.delete(reserved.reservation);
        res.once('close', () => cancel(id));
        peer.send(JSON.stringify({ type: 'model-cancel', id, deviceId: phone.deviceId, conversationId: modelCancel[1], operationId: reserved.data.operationId }));
        return;
      }
      const cancelUnseen = /^\/api\/threads\/([0-9a-f-]{36})\/recovery-cancel$/i.exec(requested);
      if (cancelUnseen) {
        if (!uuid.test(cancelUnseen[1])) return send(res, 404, { error: 'not-found' });
        if (req.method !== 'POST') return send(res, 405, { error: 'method-not-allowed' });
        if (req.headers['content-type'] !== 'application/json') return send(res, 400, { error: 'invalid' });
        const reserved = await reservedBody(req, res, phone, 1024);
        if (res.writableEnded || res.destroyed) return;
        if (!reserved?.data || Array.isArray(reserved.data) || Object.keys(reserved.data).length !== 1 || !uuid.test(reserved.data.requestId || '')) return send(res, 400, { error: 'invalid' });
        if (!registry.isActiveDevice(phone.hostId, phone.deviceId)) return send(res, 401, { error: 'device-replaced' });
        const peer = peers.get(phone.hostId); if (!peer || peer.readyState !== WebSocket.OPEN) return send(res, 503, { error: 'host-offline' });
        if (pairPendingCount([...pending.values()], phone) - Number(Boolean(reserved.reservation)) >= maxPairPending) return send(res, 503, { error: 'busy' });
        const id = randomUUID(), timer = setTimeout(() => cancel(id), requestTimeoutMs);
        pending.set(id, { res, timer, streaming: false, writing: true, hostId: phone.hostId, deviceId: phone.deviceId });
        if (reserved.reservation) bodyReads.delete(reserved.reservation);
        res.once('close', () => cancel(id));
        peer.send(JSON.stringify({ type: 'cancel-unseen-recovery', id, deviceId: phone.deviceId, conversationId: cancelUnseen[1], requestId: reserved.data.requestId }));
        return;
      }
      const recovery = /^\/api\/threads\/([0-9a-f-]{36})\/recover$/i.exec(requested);
      if (recovery) {
        if (!uuid.test(recovery[1])) return send(res, 404, { error: 'not-found' });
        if (req.method !== 'POST') return send(res, 405, { error: 'method-not-allowed' });
        if (req.headers['content-type'] !== 'application/json') return send(res, 400, { error: 'invalid' });
        const reserved = await reservedBody(req, res, phone, 1024);
        if (res.writableEnded || res.destroyed) return;
        if (!reserved?.data || Array.isArray(reserved.data) || Object.keys(reserved.data).length !== 1 || !uuid.test(reserved.data.requestId || '')) return send(res, 400, { error: 'invalid' });
        if (!registry.isActiveDevice(phone.hostId, phone.deviceId)) return send(res, 401, { error: 'device-replaced' });
        const peer = peers.get(phone.hostId); if (!peer || peer.readyState !== WebSocket.OPEN) return send(res, 503, { error: 'host-offline' });
        if (pairPendingCount([...pending.values()], phone) - Number(Boolean(reserved.reservation)) >= maxPairPending) return send(res, 503, { error: 'busy' });
        const id = randomUUID(), timer = setTimeout(() => cancel(id), requestTimeoutMs);
        pending.set(id, { res, timer, streaming: false, writing: true, hostId: phone.hostId, deviceId: phone.deviceId });
        if (reserved.reservation) bodyReads.delete(reserved.reservation);
        res.once('close', () => cancel(id));
        peer.send(JSON.stringify({ type: 'recover-chat', id, deviceId: phone.deviceId, conversationId: recovery[1], requestId: reserved.data.requestId }));
        return;
      }
      const agentHistory = /^\/api\/threads\/([0-9a-f-]{36})\/agents\/([0-9a-f-]{36})\/history$/i.exec(requested);
      if (agentHistory) {
        if (req.method !== 'GET' || !uuid.test(agentHistory[1]) || !uuid.test(agentHistory[2])) return send(res, 404, { error: 'not-found' });
        const peer = peers.get(phone.hostId); if (!peer || peer.readyState !== WebSocket.OPEN) return send(res, 503, { error: 'host-offline' });
        const entries = [...pending.values()];
        if (pairPendingCount(entries, phone) >= maxPairPending) return send(res, 503, { error: 'busy' });
        const id = randomUUID(), timer = setTimeout(() => cancel(id), requestTimeoutMs);
        pending.set(id, { res, timer, streaming: false, writing: false, hostId: phone.hostId, deviceId: phone.deviceId });
        res.once('close', () => cancel(id));
        peer.send(JSON.stringify({ type: 'agent-history', id, deviceId: phone.deviceId, conversationId: agentHistory[1], agentThreadId: agentHistory[2] }));
        return;
      }
      const filePreview = /^\/api\/threads\/([0-9a-f-]{36})\/file-preview$/i.exec(requested);
      if (filePreview) {
        if (req.method !== 'POST' || !uuid.test(filePreview[1]) || req.headers['content-type'] !== 'application/json') return send(res, 400, { error: 'invalid' });
        const reserved = await reservedBody(req, res, phone, 4096);
        if (res.writableEnded || res.destroyed) return;
        const data = reserved?.data;
        const changedFile = data && Object.keys(data).sort().join(',') === 'index,itemId,turnId' && Number.isSafeInteger(data.index) && data.index >= 0 && data.index <= 1000;
        const linkedFile = data && Object.keys(data).sort().join(',') === 'itemId,path,turnId' && typeof data.path === 'string' && data.path.startsWith('/') && data.path.length <= 4096 && !data.path.includes('\0');
        if ((!changedFile && !linkedFile) || typeof data.turnId !== 'string' || typeof data.itemId !== 'string' || data.turnId.length > 128 || data.itemId.length > 128) return send(res, 400, { error: 'invalid' });
        if (!registry.isActiveDevice(phone.hostId, phone.deviceId)) return send(res, 401, { error: 'device-replaced' });
        const peer = peers.get(phone.hostId); if (!peer || peer.readyState !== WebSocket.OPEN) return send(res, 503, { error: 'host-offline' });
        const entries = [...pending.values()];
        if (pairPendingCount(entries, phone) - Number(Boolean(reserved?.reservation)) >= maxPairPending) return send(res, 503, { error: 'busy' });
        const id = randomUUID(), timer = setTimeout(() => cancel(id), requestTimeoutMs);
        pending.set(id, { res, timer, streaming: false, writing: false, hostId: phone.hostId, deviceId: phone.deviceId });
        bodyReads.delete(reserved.reservation);
        res.once('close', () => cancel(id));
        peer.send(JSON.stringify({ type: 'file-preview', id, conversationId: filePreview[1], deviceId: phone.deviceId, ...data }));
        return;
      }
      const preview = /^\/api\/threads\/([0-9a-f-]{36})\/images\/([A-Za-z0-9_-]{32})\/chunks\/(\d+)$/i.exec(requested);
      if (preview) {
        if (!imagePreview || req.method !== 'GET' || !uuid.test(preview[1])) return send(res, 404, { error: 'not-found' });
        const offset = Number(preview[3]);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset >= 32 * 1024 * 1024 || offset % 131072 !== 0) return send(res, 400, { error: 'invalid' });
        const peer = peers.get(phone.hostId); if (!peer || peer.readyState !== WebSocket.OPEN) return send(res, 503, { error: 'host-offline' });
        const entries = [...pending.values()];
        if (pairPendingCount(entries, phone) >= maxPairPending) return send(res, 503, { error: 'busy' });
        const id = randomUUID(), timer = setTimeout(() => cancel(id), requestTimeoutMs);
        pending.set(id, { res, timer, streaming: false, writing: false, hostId: phone.hostId, deviceId: phone.deviceId });
        res.once('close', () => cancel(id));
        peer.send(JSON.stringify({ type: 'image-chunk', id, conversationId: preview[1], handle: preview[2], offset, deviceId: phone.deviceId }));
        return;
      }
      const upload = /^\/api\/threads\/([0-9a-f-]{36})\/uploads(?:\/([0-9a-f-]{36})(?:\/(finish|chunks\/(\d+)))?)?$/i.exec(requested);
      if (upload) {
        const uploadBegan = Date.now();
        res.once('finish', () => { if (res.statusCode >= 400) console.warn('upload-observation', JSON.stringify({ status: res.statusCode, elapsedMs: Date.now() - uploadBegan, phase: upload[3] || 'start', bytes: Number(req.headers['content-length']) || null })); });
        if (!imageUpload) return send(res, 404, { error: 'not-found' });
        if (!uuid.test(upload[1]) || (upload[2] && !uuid.test(upload[2]))) return send(res, 404, { error: 'not-found' });
        const entries = [...pending.values()];
        if (pairPendingCount(entries, phone) >= maxPairPending) return send(res, 503, { error: 'busy' });
        const id = randomUUID();
        const timer = setTimeout(() => cancel(id), requestTimeoutMs + bodyTimeoutMs);
        pending.set(id, { res, timer, streaming: false, writing: false, hostId: phone.hostId, deviceId: phone.deviceId });
        res.once('close', () => cancel(id));
        try {
        let action, data;
        if (!upload[2] && req.method === 'POST' && req.headers['content-type'] === 'application/json') {
          data = await body(req); action = 'start';
          if (!data || Object.keys(data).some(key => !['name','size','kind'].includes(key)) || typeof data.name !== 'string' || !data.name || data.name.length > 255 || /[\x00-\x1f\x7f/\\\u2028\u2029]/.test(data.name) || (data.kind !== undefined && !['image','file'].includes(data.kind)) || !Number.isSafeInteger(data.size) || data.size < 1 || data.size > 20971520) return send(res, 400, { error: 'invalid' });
        } else if (upload[2] && upload[3]?.startsWith('chunks/') && req.method === 'PUT' && req.headers['content-type'] === 'application/octet-stream') {
          const encoding = req.headers['content-encoding'];
          if (encoding !== undefined && encoding !== 'identity' && encoding !== 'gzip') return send(res, 415, { error: 'unsupported-encoding' });
          let chunk = await bytesBody(req, 131072);
          if (!chunk?.length) return send(res, 400, { error: 'invalid' });
          if (encoding === 'gzip') {
            try { chunk = await decompressUploadChunk(chunk, { maxOutputLength: 131072 }); }
            catch (error) { return send(res, error.code === 'ERR_BUFFER_TOO_LARGE' ? 413 : 400, { error: 'invalid-compressed-chunk' }); }
            if (!chunk.length) return send(res, 400, { error: 'invalid' });
          }
          action = 'chunk'; data = { seq: Number(upload[4]), data: chunk.toString('base64') };
          if (!Number.isSafeInteger(data.seq)) return send(res, 400, { error: 'invalid' });
        } else if (upload[2] && upload[3] === 'finish' && req.method === 'POST') { action = 'finish'; data = {}; }
        else if (upload[2] && !upload[3] && req.method === 'DELETE') { action = 'delete'; data = {}; }
        else return send(res, 405, { error: 'method-not-allowed' });
        if (!registry.isActiveDevice(phone.hostId, phone.deviceId)) return send(res, 401, { error: 'device-replaced' });
        const peer = peers.get(phone.hostId); if (!peer || peer.readyState !== WebSocket.OPEN) return send(res, 503, { error: 'host-offline' });
        const entry = pending.get(id);
        if (!entry || res.destroyed) return;
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => cancel(id), requestTimeoutMs);
        const creationId = req.headers['x-creation-id'];
        if (creationId !== undefined && !uuid.test(creationId)) return send(res, 400, { error: 'invalid' });
        entry.uploadSent = true;
        peer.send(JSON.stringify({ type: 'upload', id, action, conversationId: upload[1], deviceId: phone.deviceId, uploadId: upload[2], creationId, ...data }));
        return;
        } finally {
          const entry = pending.get(id);
          if (entry && !entry.uploadSent) { clearTimeout(entry.timer); pending.delete(id); }
        }
      }
      const localPath = /^\/api(\/models|\/sidebar\/events|\/threads(?:\/[0-9a-f-]{36}\/(?:events|messages|stop|approvals|user-input|async-question|mode|model|model-status|recovery-status|recovery-attempt\/[0-9a-f-]{36}))?)$/i.exec(requested);
      const match = localPath ? [requested, phone.hostId, localPath[1]] : /^\/api\/hosts\/([0-9a-f-]{36})(\/models|\/sidebar\/events|\/threads(?:\/[0-9a-f-]{36}\/(?:events|messages|stop|approvals|user-input|async-question|mode|model|model-status|recovery-status|recovery-attempt\/[0-9a-f-]{36}))?)$/i.exec(requested);
      if (!match || !uuid.test(match[1])) return send(res, 404, { error: 'not-found' });
      if (phone.hostId !== match[1]) return send(res, 403, { error: 'forbidden' });
      const threadId = /^\/threads\/([^/]+)\/(?:events|messages|stop|approvals|user-input|async-question|mode|model|model-status|recovery-status|recovery-attempt\/[0-9a-f-]{36})$/i.exec(match[2])?.[1];
      if (threadId && !uuid.test(threadId)) return send(res, 404, { error: 'not-found' });
      const recoveryAttemptId = /\/recovery-attempt\/([^/]+)$/i.exec(match[2])?.[1];
      if (recoveryAttemptId && !uuid.test(recoveryAttemptId)) return send(res, 404, { error: 'not-found' });
      const stop = match[2].endsWith('/stop');
      const approval = match[2].endsWith('/approvals');
      const modeUpdate = match[2].endsWith('/mode');
      const modelUpdate = match[2].endsWith('/model');
      const asyncQuestion = match[2].endsWith('/async-question');
      const userInput = match[2].endsWith('/user-input') || asyncQuestion;
      const write = match[2].endsWith('/messages') || stop || approval || userInput || modeUpdate || modelUpdate;
      let text, reservation, visibleThreads, handoverThread;
      if (match[2] === '/threads' && req.method === 'POST') {
        if (req.headers['content-type'] !== 'application/json') return send(res, 400, { error: 'invalid' });
        const reserved = await reservedBody(req, res, phone, 1048576);
        if (res.writableEnded || res.destroyed) return;
        const data = reserved?.data; reservation = reserved?.reservation;
        if (!data || Object.keys(data).some(key => !['visibleThreads', 'handoverThread'].includes(key)) || !Array.isArray(data.visibleThreads) || data.visibleThreads.length > 1024 || data.visibleThreads.some(id => typeof id !== 'string' || !uuid.test(id)) || (data.handoverThread !== undefined && (typeof data.handoverThread !== 'string' || !data.visibleThreads.includes(data.handoverThread)))) return send(res, 400, { error: 'invalid-visible-threads' });
        visibleThreads = [...new Set(data.visibleThreads)]; handoverThread = data.handoverThread;
      }
      if (write && req.method === 'POST') {
        if (req.headers['content-type'] !== 'application/json') return send(res, 400, { error: 'invalid' });
        const reserved = await reservedBody(req, res, phone, 65536);
        if (res.writableEnded || res.destroyed) return;
        const data = reserved?.data; reservation = reserved?.reservation;
        if (modeUpdate && (!data || Object.keys(data).length !== 1 || !['default', 'plan'].includes(data.mode))) return send(res, 400, { error: 'invalid' });
        if (modelUpdate && (!data || Object.keys(data).some(k => !['model', 'effort'].includes(k)) || typeof data.model !== 'string' || !data.model || data.model.length > 200 || (data.effort !== undefined && (typeof data.effort !== 'string' || !data.effort || data.effort.length > 64)))) return send(res, 400, { error: 'invalid' });
        if (!modeUpdate && !modelUpdate && (stop ? (!data || Object.keys(data).length !== 1 || typeof data.turnId !== 'string' || !uuid.test(data.turnId)) : approval ? (!data || Object.keys(data).some(k => !['requestId','kind','decision'].includes(k)) || !['command','file'].includes(data.kind) || !['accept','decline'].includes(data.decision) || !['string','number'].includes(typeof data.requestId)) : userInput ? (!data || Object.keys(data).some(k => !['requestId','answers'].includes(k)) || !['string','number'].includes(typeof data.requestId) || !data.answers || typeof data.answers !== 'object' || Array.isArray(data.answers) || Object.keys(data.answers).length > 10 || Object.values(data.answers).some(v => typeof v !== 'string' || Buffer.byteLength(v) > 8192)) : (!data || Object.keys(data).some(k => !['text','attachmentId','attachmentIds'].includes(k)) || typeof data.text !== 'string' || (data.attachmentId !== undefined && data.attachmentIds !== undefined) || (!data.text.trim() && !data.attachmentId && !data.attachmentIds?.length) || Buffer.byteLength(data.text) > 32768 || (data.attachmentId !== undefined && (!imageUpload || !uuid.test(data.attachmentId))) || (data.attachmentIds !== undefined && (!imageUpload || !Array.isArray(data.attachmentIds) || data.attachmentIds.length < 1 || data.attachmentIds.length > 4 || new Set(data.attachmentIds).size !== data.attachmentIds.length || data.attachmentIds.some(id => typeof id !== 'string' || !uuid.test(id))))))) return send(res, 400, { error: 'invalid' });
        if (!registry.isActiveDevice(phone.hostId, phone.deviceId)) return send(res, 401, { error: 'device-replaced' });
        text = data.text; var attachmentId = data.attachmentId, attachmentIds = data.attachmentIds, turnId = data.turnId, requestId = data.requestId, kind = data.kind, decision = data.decision, answers = data.answers, mode = data.mode, model = data.model, effort = data.effort;
      } else if ((req.method !== 'GET' && !(match[2] === '/threads' && req.method === 'POST')) || write) return send(res, 405, { error: 'method-not-allowed' });
      const peer = peers.get(phone.hostId); if (!peer || peer.readyState !== WebSocket.OPEN) return send(res, 503, { error: 'host-offline' });
      const entries = [...pending.values()];
      if (pairPendingCount(entries, phone) - Number(Boolean(reservation)) >= maxPairPending) return send(res, 503, { error: 'busy' });
      const id = randomUUID(), streaming = match[2].endsWith('/events');
      let output = res;
      if (streaming) {
        const gzip = /(?:^|,)\s*gzip\s*(?:;\s*q=(?!0(?:\.0*)?(?:\s*(?:,|$)))\d(?:\.\d+)?)?\s*(?:,|$)/i.test(req.headers['accept-encoding'] || '');
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff', vary: 'Accept-Encoding', ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
        res.flushHeaders();
        if (gzip) { output = createGzip({ flush: zlibConstants.Z_SYNC_FLUSH }); output.on('error', () => res.destroy()); output.pipe(res); }
      }
      const timer = setTimeout(() => { if (streaming) console.warn('stream lifetime expired'); cancel(id); }, streaming ? 12 * 3600000 : requestTimeoutMs);
      const heartbeat = streaming ? setInterval(() => { const entry = pending.get(id); if (res.destroyed) return; if (entry?.flowPaused) return; if (output.writableLength > 16 * 1024 * 1024) return res.destroy(); output.write(entry?.sidebar ? 'event: sidebar-heartbeat\ndata: {}\n\n' : ': heartbeat\n\n'); }, heartbeatMs) : null;
      pending.set(id, { res, output, timer, heartbeat, streaming, sidebar: match[2] === '/sidebar/events', writing: write, stop, hostId: phone.hostId, deviceId: phone.deviceId });
      if (reservation) bodyReads.delete(reservation);
      res.once('close', () => { if (streaming && pending.has(id)) console.warn('stream client disconnected'); cancel(id); if (output !== res) output.destroy(); });
      if (write) peer.send(JSON.stringify({ type: stop ? 'stop' : approval ? 'approve' : userInput ? 'user-input' : modeUpdate ? 'mode' : modelUpdate ? 'model' : 'write', id, conversationId: match[2].split('/')[2], deviceId: phone.deviceId, ...(stop ? { turnId } : approval ? { requestId, kind, decision } : userInput ? { requestId, answers, ...(asyncQuestion ? { asyncQuestion: true } : {}) } : modeUpdate ? { mode } : modelUpdate ? { model, ...(effort ? { effort } : {}) } : { text, ...(attachmentId ? { attachmentId } : {}), ...(attachmentIds ? { attachmentIds } : {}) }) }));
      else {
        peer.send(JSON.stringify({ type: 'request', id, deviceId: phone.deviceId, path: `/api${match[2]}`, ...(visibleThreads ? { visibleThreads } : {}), ...(typeof handoverThread === 'string' && visibleThreads?.includes(handoverThread) ? { handoverThread } : {}), ...(streaming && req.headers['x-codex-sidebar-status'] === '1' ? { sidebarStatus: true } : {}), ...(streaming && req.headers['x-codex-history-window'] === '1' ? { historyWindow: true } : {}), ...(streaming && req.headers['x-codex-staged-preview'] === '1' ? { stagedPreview: true } : {}), ...(streaming && ['1', '2', '3'].includes(req.headers['x-codex-view-delta']) ? { viewDelta: Number(req.headers['x-codex-view-delta']) } : {}) }));
      }
    } catch { if (!res.destroyed) send(res, 500, { error: 'unavailable' }); }
  });
  server.on('upgrade', (req, socket, head) => {
    const host = registry.authenticateHost(hostSecret(req));
    if (closed || req.headers.host !== base.host || req.url !== '/connector' || !host || peers.has(host.id)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, host.id));
  });
  wss.on('connection', (ws, hostId) => {
    peers.set(hostId, ws); let alive = true, streamFlow = false;
    ws.send(JSON.stringify({ type: 'flow-probe' }));
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => { if (!alive) { console.warn('connector heartbeat timeout'); return ws.terminate(); } alive = false; ws.ping(); }, 20000);
    ws.on('error', () => {});
    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return ws.close(1007); }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return ws.close(1007);
      if (msg.type === 'capabilities') { streamFlow = msg.streamFlow === 2 ? 2 : msg.streamFlow === 1 ? 1 : false; return; }
      const entry = pending.get(msg.id); if (!entry || entry.hostId !== hostId) return;
      if (entry.historyChunks && msg.type === 'history-chunk' && msg.frame) {
        const frame = msg.frame;
        const state = entry.historyTransfer;
        if (entry.historyWriting) return cancel(msg.id);
        if (frame.type === 'begin') {
          if (state || typeof frame.transferId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(frame.transferId) || !Number.isSafeInteger(frame.generation) || frame.generation < 1 || frame.seq !== 1 || !Number.isSafeInteger(frame.size) || frame.size < 1 || frame.size > 32 * 1024 * 1024 || !Number.isSafeInteger(frame.chunkBytes) || frame.chunkBytes < 1 || frame.chunkBytes > 48 * 1024 || frame.count !== Math.ceil(frame.size / frame.chunkBytes) || !/^[0-9a-f]{64}$/.test(frame.hash || '')) return cancel(msg.id);
          entry.historyTransfer = { transferId: frame.transferId, generation: frame.generation, size: frame.size, chunkBytes: frame.chunkBytes, count: frame.count, index: 0, bytes: 0 };
        } else if (!state || frame.transferId !== state.transferId || frame.generation !== state.generation) return cancel(msg.id);
        else if (frame.type === 'chunk') {
          const expected = Math.min(state.chunkBytes, state.size - state.bytes);
          if (frame.index !== state.index || frame.index >= state.count || typeof frame.data !== 'string' || frame.data.length !== 4 * Math.ceil(expected / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) return cancel(msg.id);
          const bytes = Buffer.from(frame.data, 'base64');
          if (bytes.length !== expected || bytes.toString('base64') !== frame.data) return cancel(msg.id);
          state.index++; state.bytes += expected;
        } else if (frame.type !== 'end' || state.index !== state.count || state.bytes !== state.size) return cancel(msg.id);
        if (!entry.res.headersSent) entry.res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        entry.historyWriting = true;
        const ack = () => { if (pending.get(msg.id) !== entry || ws.readyState !== WebSocket.OPEN) return; entry.historyWriting = false; if (frame.type === 'chunk') { clearTimeout(entry.timer); entry.timer = setTimeout(() => cancel(msg.id), requestTimeoutMs); } ws.send(JSON.stringify({ type: 'history-chunk-ack', id: msg.id, transferId: frame.transferId, generation: frame.generation, index: frame.type === 'chunk' ? frame.index : frame.type })); if (frame.type === 'end') { clearTimeout(entry.timer); clearTimeout(entry.hardTimer); pending.delete(msg.id); entry.res.end(); } };
        const written = entry.res.write(`${JSON.stringify(frame)}\n`);
        if (written) ack(); else entry.res.once('drain', ack);
        return;
      }
      if (entry.streaming && msg.type === 'state-chunk' && msg.frame && !entry.flowPaused) {
        const frame = msg.frame;
        if (!['begin', 'chunk', 'end'].includes(frame.type) || typeof frame.transferId !== 'string' || !Number.isSafeInteger(frame.generation) || (frame.type === 'chunk' && (typeof frame.data !== 'string' || frame.data.length > 65536))) return entry.res.destroy();
        const ack = () => { if (pending.get(msg.id) === entry && ws.readyState === WebSocket.OPEN) { onChunkForTests?.('ack'); ws.send(JSON.stringify({ type: 'state-chunk-ack', id: msg.id, transferId: frame.transferId, generation: frame.generation, index: frame.type === 'chunk' ? frame.index : frame.type })); } };
        const written = entry.output.write(`event: state-chunk\ndata: ${JSON.stringify(frame)}\n\n`);
        onChunkForTests?.(written ? 'write' : 'wait-drain');
        if (written) ack(); else entry.output.once('drain', ack);
        return;
      }
      if (entry.streaming && msg.type === 'event' && ['sidebar-status', 'thread-list-changed'].includes(msg.event)) {
        const key = msg.event === 'sidebar-status' ? 'pendingSidebar' : 'pendingListChange';
        entry[key] = `event: ${msg.event}\ndata: ${JSON.stringify(msg.data)}\n\n`;
        if (!entry.flushSidebar) {
          const cleanup = () => { entry.output.off('drain', flush); if (entry.output !== entry.res) entry.res.off('drain', flush); entry.res.off('close', cleanup); };
          const flush = () => {
            if (pending.get(msg.id) !== entry || entry.res.destroyed) return cleanup();
            if (entry.flowPaused || entry.output.writableNeedDrain || entry.res.writableNeedDrain) return;
            for (const key of ['pendingSidebar', 'pendingListChange']) {
              const frame = entry[key]; entry[key] = null;
              if (frame && !entry.output.write(frame)) return;
            }
          };
          entry.flushSidebar = flush;
          entry.output.on('drain', flush); if (entry.output !== entry.res) entry.res.on('drain', flush);
          entry.res.once('close', cleanup);
        }
        entry.flushSidebar();
        return;
      }
      if (msg.type === 'stream-error' && entry.streaming && ['state-too-large', 'state-invalid'].includes(msg.code)) {
        entry.output.write(`event: stream-error\ndata: ${JSON.stringify({ code: msg.code })}\n\n`);
        cancel(msg.id);
        return;
      }
      const reset = msg.type === 'flow-reset' && entry.streaming && entry.flowAwaitReset && msg.generation === entry.flowGeneration && (['status', 'state'].includes(msg.event) || (streamFlow === 2 && msg.event === 'unchanged'));
      if ((msg.type === 'event' && entry.streaming && ['status', 'state', 'state-delta', 'history', 'preview'].includes(msg.event)) || reset) {
        if (entry.flowPaused && !reset) return;
        if (reset) { entry.flowPaused = false; entry.flowAwaitReset = false; }
        if (reset && msg.event === 'unchanged') { entry.flushSidebar?.(); return; }
        if (entry.output.writableLength > 16 * 1024 * 1024 || entry.res.writableLength > 16 * 1024 * 1024) { console.warn('stream backpressure limit'); return entry.res.destroy(); }
        const queued = entry.output.writableLength + (entry.output === entry.res ? 0 : entry.res.writableLength);
        const writable = entry.output.write(`event: ${msg.event}\ndata: ${JSON.stringify(msg.data)}\n\n`);
        if (reset && msg.chunkReset === true) {
          const ack = () => { if (pending.get(msg.id) === entry && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'chunk-reset-ready', id: msg.id, generation: msg.generation })); };
          if (writable) ack(); else entry.output.once('drain', ack);
        }
        // A single large frame exceeds gzip's high-water mark even for a fast reader.
        // Pause only when another frame arrives while prior output is still queued.
        if (streamFlow && !writable && queued > 0 && (streamFlow === 2 || !reset)) {
          entry.flowPaused = true; entry.flowAwaitReset = false; entry.flowGeneration = (entry.flowGeneration || 0) + 1;
          const generation = entry.flowGeneration;
          ws.send(JSON.stringify({ type: 'flow', id: msg.id, action: 'pause', generation, ...(reset && streamFlow === 2 ? { afterReset: true } : {}) }));
          const cleanup = () => {
            entry.output.off('drain', resume);
            if (entry.output !== entry.res) entry.res.off('drain', resume);
            entry.res.off('close', cleanup);
          };
          const resume = () => {
            if (pending.get(msg.id) !== entry || !entry.flowPaused || entry.flowGeneration !== generation || entry.flowAwaitReset || entry.output.writableNeedDrain || entry.res.writableNeedDrain) return;
            cleanup();
            entry.flowAwaitReset = true;
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'flow', id: msg.id, action: 'resume', generation }));
          };
          entry.output.on('drain', resume); if (entry.output !== entry.res) entry.res.on('drain', resume);
          entry.res.once('close', cleanup);
        }
        if (reset) entry.flushSidebar?.();
      } else if (msg.type === 'response' && !entry.streaming) {
        clearTimeout(entry.timer); clearTimeout(entry.hardTimer); pending.delete(msg.id);
        if (entry.res.headersSent) { entry.res.destroy(); return; }
        if (entry.creating) {
          if (msg.status === 'accepted' && uuid.test(msg.threadId || '')) send(entry.res, 202, { threadId: msg.threadId });
          else if (msg.status === 'start-unknown' && uuid.test(msg.threadId || '')) send(entry.res, 504, { error: 'start-unknown', threadId: msg.threadId });
          else send(entry.res, msg.status === 'invalid-project' ? 400 : 504, { error: msg.status === 'invalid-project' ? 'invalid-project' : 'outcome-unknown' });
        }
        else if (entry.writing) { const partial = entry.stop && msg.status === 'stopped-goal-pause-failed'; const status = msg.status === 'accepted' || partial ? 202 : msg.status === 'unavailable' ? 409 : 504; send(entry.res, status, status === 202 ? { status: partial ? 'stopped-goal-pause-failed' : 'accepted' } : { error: status === 409 ? 'unavailable' : 'outcome-unknown' }); }
        else { if (entry.uploadSent && !msg.ok) console.warn('upload-observation', 'desktop-rejected'); send(entry.res, msg.ok ? 200 : 503, msg.ok ? msg.data : { error: msg.error === 'busy' ? 'busy' : 'unavailable' }); }
      } else if (msg.type === 'end' && entry.streaming) { console.warn('connector ended stream'); cancel(msg.id); }
    });
    ws.on('close', code => { console.warn(`connector closed: ${code}`); clearInterval(heartbeat); if (peers.get(hostId) === ws) peers.delete(hostId); for (const [id, entry] of pending) if (entry.hostId === hostId) cancel(id); });
  });
  return {
    async listen(port = 0) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); return server.address().port; },
    async close() { closed = true; for (const id of pending.keys()) cancel(id); for (const ws of peers.values()) ws.terminate(); await new Promise(resolve => server.close(resolve)); wss.close(); registry.close(); },
  };
}
