import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import QRCode from 'qrcode';
import { PairingConnector } from './connector.mjs';

// Local management only. Never proxy this listener to another device.
export function createPairingPanel({ manager, qr = link => QRCode.toDataURL(link, { margin: 2, width: 240 }) } = {}) {
  if (!manager) throw new TypeError('Pairing manager required');
  const token = randomBytes(32).toString('base64url');
  const secret = Buffer.from(token);
  const equal = value => { const b = Buffer.from(value || ''); return b.length === secret.length && timingSafeEqual(b, secret); };
  let server;
  let pairing = false;
  const send = (res, code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
  };
  server = http.createServer(async (req, res) => {
    const address = server.address();
    const host = address && typeof address === 'object' ? `127.0.0.1:${address.port}` : '';
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`)) return send(res, 403, { error: 'forbidden' });
    const cookie = (req.headers.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith('codex_pair_panel='));
    const authorized = cookie.length === 1 && equal(cookie[0].slice('codex_pair_panel='.length));
    if (req.method === 'GET' && req.url === '/') {
      const direct = req.headers['sec-fetch-site'] === 'none' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
      if (!direct && !(authorized && req.headers['sec-fetch-site'] === 'same-origin')) return send(res, 403, { error: 'forbidden' });
      if (direct) res.setHeader('set-cookie', `codex_pair_panel=${token}; Path=/; HttpOnly; SameSite=Strict`);
      res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      try { return send(res, 200, await readFile(new URL('../../public/pairing-panel.html', import.meta.url)), 'text/html; charset=utf-8'); }
      catch { return send(res, 500, { error: 'unavailable' }); }
    }
    const assets = { '/pairing-panel.js': ['pairing-panel.js', 'text/javascript; charset=utf-8'], '/pairing-panel.css': ['pairing-panel.css', 'text/css; charset=utf-8'] };
    if (req.method === 'GET' && assets[req.url]) {
      try { return send(res, 200, await readFile(new URL(`../../public/${assets[req.url][0]}`, import.meta.url)), assets[req.url][1]); }
      catch { return send(res, 500, { error: 'unavailable' }); }
    }
    if (!authorized || req.headers['sec-fetch-site'] !== 'same-origin') return send(res, 401, { error: 'unauthorized' });
    try {
      if (req.method === 'GET' && req.url === '/api/devices') {
        try { return send(res, 200, { registered: true, devices: await manager.listDevices() }); }
        catch (error) {
          if (error.code === 'ENOENT') return send(res, 200, { registered: false, devices: [] });
          throw error;
        }
      }
      if (req.method === 'GET' && req.url === '/api/pair-requests') return send(res, 200, { requests: await manager.listPairRequests() });
      if (req.method !== 'POST' || req.headers.origin !== `http://${host}` || req.headers['content-type'] !== 'application/json') return send(res, 403, { error: 'forbidden' });
      let chunks = [], size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 4096) return send(res, 413, { error: 'invalid' }); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'invalid' });
      if (req.url === '/api/pair-decision' && Object.keys(body).length === 2 && typeof body.requestId === 'string' && typeof body.approve === 'boolean') {
        await manager.decidePairRequest(body.requestId, body.approve); return send(res, 200, { ok: true });
      }
      if (req.url === '/api/pair' && Object.keys(body).length === 0) {
        if (pairing) return send(res, 409, { error: 'busy' });
        pairing = true;
        try {
          let pair;
          try { pair = await manager.issuePairing(); }
          catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await manager.enroll({ name: hostname() });
            pair = await manager.issuePairing();
          }
          return send(res, 200, { code: pair.code, expiresAt: pair.expiresAt, qr: await qr(pair.link) });
        } finally { pairing = false; }
      }
      if (req.url === '/api/enroll' && Object.keys(body).length === 1 && typeof body.name === 'string') {
        await manager.enroll({ name: body.name }); return send(res, 200, { ok: true });
      }
      if (req.url === '/api/revoke' && Object.keys(body).length === 1 && typeof body.deviceId === 'string') {
        await manager.revokeDevice(body.deviceId); return send(res, 200, { ok: true });
      }
      return send(res, 400, { error: 'invalid' });
    } catch { if (!res.destroyed) send(res, 503, { error: 'unavailable' }); }
  });
  return {
    async listen(port = 0) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() { if (server.listening) await new Promise(resolve => server.close(resolve)); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const origin = process.env.HUB_ORIGIN;
  if (!origin) throw new Error('Set HUB_ORIGIN to the relay HTTPS origin');
  const manager = new PairingConnector({ origin, configPath: join(homedir(), '.config/codex-hub/host.json') });
  const panel = createPairingPanel({ manager });
  console.log(`Pairing panel: ${await panel.listen(Number(process.env.PORT || 0))}`);
  console.log(`Computer: ${hostname()}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void panel.close().then(() => process.exit(0)); });
}
