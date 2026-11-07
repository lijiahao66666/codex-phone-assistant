import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export async function payloadDigest(text, files, { model = null, effort = null } = {}) {
  const entries = [];
  for (const file of files) {
    const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== file.size) throw new Error('file changed');
      const hash = createHash('sha256'), buffer = Buffer.alloc(65536);
      let offset = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
      }
      const after = await handle.stat();
      if (offset !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('file changed');
      entries.push({ name: file.name, kind: file.kind, size: file.size, sha256: hash.digest('hex') });
    } finally { await handle.close(); }
  }
  return createHash('sha256').update(JSON.stringify({ text, model, effort, files: entries })).digest('hex');
}
