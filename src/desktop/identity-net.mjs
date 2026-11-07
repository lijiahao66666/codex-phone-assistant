import net from 'node:net';

const maxFrameBytes = 256 * 1024 * 1024;
const queueMethod = 'thread-follower-set-queued-follow-ups-state';

function guardQueueRequests(socket, getIdentity) {
  const originalOn = socket.on;
  socket.on = function(event, listener) {
    if (event !== 'data') return originalOn.call(this, event, listener);
    let header = Buffer.alloc(4), headerBytes = 0, size = null, chunks = [], bytes = 0;
    return originalOn.call(this, event, function(chunk) {
      let offset = 0;
      while (offset < chunk.length) {
        if (size === null) {
          const count = Math.min(4 - headerBytes, chunk.length - offset);
          chunk.copy(header, headerBytes, offset, offset + count);
          headerBytes += count; offset += count;
          if (headerBytes < 4) break;
          size = header.readUInt32LE(0);
          if (size > maxFrameBytes) { socket.destroy(); return; }
        }
        const count = Math.min(size - bytes, chunk.length - offset);
        if (count) chunks.push(chunk.subarray(offset, offset + count));
        bytes += count; offset += count;
        if (bytes < size) break;
        const frame = Buffer.concat([header, ...chunks], size + 4);
        header = Buffer.alloc(4); headerBytes = 0; size = null; chunks = []; bytes = 0;
        let envelope;
        try { envelope = JSON.parse(frame.subarray(4)); } catch { listener.call(socket, frame); continue; }
        if (envelope?.type !== 'request' || envelope.method !== queueMethod) { listener.call(socket, frame); continue; }
        const state = envelope.params?.state;
        const safeEmpty = state && typeof state === 'object' && !Array.isArray(state) &&
          Object.values(state).every(value => Array.isArray(value) && value.length === 0);
        if (safeEmpty) { listener.call(socket, frame); continue; }
        const identity = getIdentity();
        if (!identity || (typeof envelope.requestId !== 'string' && typeof envelope.requestId !== 'number')) { socket.destroy(); return; }
        const response = Buffer.from(JSON.stringify({ type: 'response', requestId: envelope.requestId,
          resultType: 'error', method: queueMethod, handledByClientId: identity,
          error: 'Queued follow-ups are not supported by this owner' }));
        const responseHeader = Buffer.alloc(4); responseHeader.writeUInt32LE(response.length);
        socket.write(Buffer.concat([responseHeader, response]));
      }
    });
  };
}

// Observe the initialize handshake and reject queues that cannot survive handover.
export function identityNet() {
  let current = null, identity = null;
  return {
    get ownerId() { return current && !current.destroyed ? identity : null; },
    createServer: (...args) => net.createServer(...args),
    createConnection(...args) {
      const socket = net.createConnection(...args);
      let requestId, input = Buffer.alloc(0);
      const write = socket.write;
      socket.write = function(chunk, ...rest) {
        if (!requestId && Buffer.isBuffer(chunk) && chunk.length >= 4 && chunk.readUInt32LE(0) === chunk.length - 4) {
          try { const msg = JSON.parse(chunk.subarray(4)); if (msg.type === 'request' && msg.method === 'initialize') { requestId = msg.requestId; current = socket; identity = null; } } catch {}
        }
        return write.call(this, chunk, ...rest);
      };
      const onData = chunk => {
        if (socket !== current || identity) return;
        input = Buffer.concat([input, chunk]);
        while (input.length >= 4) {
          const length = input.readUInt32LE(0);
          if (length > 65536) { socket.removeListener('data', onData); input = Buffer.alloc(0); return; }
          if (input.length < 4 + length) return;
          const body = input.subarray(4, 4 + length); input = input.subarray(4 + length);
          try {
            const msg = JSON.parse(body);
            if (requestId && msg.type === 'response' && msg.requestId === requestId && msg.resultType === 'success' && typeof msg.result?.clientId === 'string' && msg.result.clientId) {
              identity = msg.result.clientId; socket.removeListener('data', onData); input = Buffer.alloc(0); return;
            }
          } catch {}
        }
      };
      socket.prependListener('data', onData);
      socket.once('close', () => { if (current === socket) { current = null; identity = null; } });
      guardQueueRequests(socket, () => socket === current ? identity : null);
      return socket;
    },
  };
}
