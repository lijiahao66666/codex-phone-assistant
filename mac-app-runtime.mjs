import { access } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPairingPanel } from './pairing-panel.mjs';
import { PairingConnector } from './pairing-connector.mjs';
import { createPairedDesktopConnector } from './paired-desktop-connector.mjs';
import { ImagePreview } from './image-preview.mjs';

const origin = process.env.HUB_ORIGIN || 'https://codex.air-inc.top';
const configPath = join(homedir(), '.config/codex-hub/host.json');
const manager = new PairingConnector({ origin, configPath });
let connector;
let stopping = false;
let imagePreview = null;
if (process.env.HUB_IMAGE_PREVIEW === '1') {
  try {
    imagePreview = await ImagePreview.create({ roots: [homedir(), tmpdir(), '/private/tmp'], helperPath: fileURLToPath(new URL('./safe-media-open', import.meta.url)) });
    await access(fileURLToPath(new URL('./safe-media-open', import.meta.url)));
  } catch { imagePreview = null; console.error('图片预览不可用，文字聊天不受影响。'); }
}
async function startConnector() {
  if (connector || stopping) return;
  const next = await createPairedDesktopConnector({ credentialPath: configPath, imagePreview, imageUpload: process.env.HUB_IMAGE_UPLOAD === '1' });
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
  if (stopping) return;
  stopping = true;
  await panel.close();
  if (connector) await connector.close();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop().then(() => process.exit(0)); });
