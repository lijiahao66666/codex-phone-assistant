import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Append-only breadcrumb log for the desktop bridge. Recovery failures only
// reproduce against a live Codex app-server, so the runtime needs a durable
// trace the phone cannot see.
const dir = join(homedir(), '.codex-phone');
const file = join(dir, 'bridge.log');
let ready = false;

export function trace(scope, event, detail) {
  try {
    if (!ready) { mkdirSync(dir, { recursive: true }); ready = true; }
    const payload = detail === undefined ? '' : ' ' + JSON.stringify(detail);
    appendFileSync(file, `${new Date().toISOString()} ${scope} ${event}${payload}\n`);
  } catch { /* diagnostics must never break the bridge */ }
}
