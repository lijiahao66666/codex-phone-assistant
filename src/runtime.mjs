import { access } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPairingPanel } from './pairing/panel.mjs';
import { PairingConnector } from './pairing/connector.mjs';
import { createPairedDesktopConnector } from './pairing/paired-connector.mjs';
import { ImagePreview } from './media/image-preview.mjs';
import { createOwnerRuntime } from './desktop/owner-runtime.mjs';

if (process.platform === 'win32') {
  process.env.HUB_IMAGE_PREVIEW ??= '0';
  process.env.HUB_IMAGE_UPLOAD ??= '0';
}

const origin = process.env.HUB_ORIGIN || 'https://codex.air-inc.top';
const configPath = join(homedir(), '.config/codex-hub/host.json');
const manager = new PairingConnector({ origin, configPath });
let connector;
let ownerRuntime;
let stopping = false;
let stopChecking = false;
let startPromise;
let imagePreview = null;
if (process.env.HUB_IMAGE_PREVIEW === '1') {
  try {
    imagePreview = await ImagePreview.create({ roots: [homedir(), tmpdir(), '/private/tmp'], helperPath: fileURLToPath(new URL('../safe-media-open', import.meta.url)) });
    await access(fileURLToPath(new URL('../safe-media-open', import.meta.url)));
  } catch { imagePreview = null; console.error('图片预览不可用，文字聊天不受影响。'); }
}
function startConnector() {
  if (connector || stopping || stopChecking) return Promise.resolve();
  if (startPromise) return startPromise;
  startPromise = startConnectorOnce().finally(() => { startPromise = undefined; });
  return startPromise;
}
async function startConnectorOnce() {
  const next = await createPairedDesktopConnector({ credentialPath: configPath, imagePreview, imageUpload: process.env.HUB_IMAGE_UPLOAD === '1',
    async createOwnerRouter(hostId) {
      if (process.platform !== 'darwin') return undefined;
      try { ownerRuntime = await createOwnerRuntime({ hostId }); return ownerRuntime.router; }
      catch { console.error('新聊天服务不可用，已有桌面聊天仍可查看。'); return undefined; }
    },
    modelRequest: (method, params) => { if (!ownerRuntime) throw new Error('Model catalog unavailable'); return ownerRuntime.owner.request(method, params); },
    modelJournal: { get: (...args) => ownerRuntime ? ownerRuntime.modelJournal.get(...args) : {}, begin: (...args) => ownerRuntime ? ownerRuntime.modelJournal.begin(...args) : false, dispatch: (...args) => ownerRuntime ? ownerRuntime.modelJournal.dispatch(...args) : false, cancelPrepared: (...args) => ownerRuntime ? ownerRuntime.modelJournal.cancelPrepared(...args) : false, complete: (...args) => ownerRuntime ? ownerRuntime.modelJournal.complete(...args) : false } });
  if (stopping) return;
  connector = next;
  connector.start();
}
const panelManager = {
  async enroll(options) { const result = await manager.enroll(options); await startConnector(); return result; },
  issuePairing: () => manager.issuePairing(),
  listPairRequests: () => manager.listPairRequests(),
  decidePairRequest: (id, approve) => manager.decidePairRequest(id, approve),
  listDevices: () => manager.listDevices(),
  revokeDevice: id => manager.revokeDevice(id),
};
const panel = createPairingPanel({ manager: panelManager });
try {
  await access(configPath);
  await startConnector();
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
console.log(`PANEL_URL=${await panel.listen()}`);
async function stop() {
  if (stopping || stopChecking) return;
  stopChecking = true;
  try { await startPromise; }
  catch (error) { stopChecking = false; throw error; }
  if (ownerRuntime) {
    try { await ownerRuntime.close(); }
    catch (error) { stopChecking = false; if (error.code === 'tasks-active') { console.log('STOP_BLOCKED'); return; } throw error; }
  }
  stopping = true;
  await panel.close();
  if (connector) await connector.close();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void stop().then(() => { if (stopping) process.exit(0); }); });
