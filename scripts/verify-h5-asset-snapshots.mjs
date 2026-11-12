#!/usr/bin/env node
// Run the manifest and versioned-path integrity test before bundling H5 assets.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const result = spawnSync(process.execPath, ['--test', fileURLToPath(new URL('../test/h5-asset-snapshots.test.mjs', import.meta.url))], { stdio: 'inherit' });
process.exit(result.status ?? 1);
