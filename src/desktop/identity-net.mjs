import net from 'node:net';

// Observe the initialized owner identity and its acknowledged queue broadcasts.
// Queue requests must reach the live owner, which already drains them between turns.
export function identityNet({ onQueuedFollowUpsChanged } = {}) {
  let current = null, identity = null;
  return {
    get ownerId() { return current && !current.destroyed ? identity : null; },
    createServer: (...args) => net.createServer(...args),
    createConnection(...args) {
      const socket = net.createConnection(...args);
      let requestId, input = Buffer.alloc(0);
      const write = socket.write;
      socket.write = function(chunk, ...rest) {
        if (Buffer.isBuffer(chunk) && chunk.length >= 4 && chunk.readUInt32LE(0) === chunk.length - 4) {
          try {
            const msg = JSON.parse(chunk.subarray(4));
            if (!requestId && msg.type === 'request' && msg.method === 'initialize') { requestId = msg.requestId; current = socket; identity = null; }
            if (socket === current && identity && msg.type === 'broadcast' && msg.method === 'thread-queued-followups-changed' && typeof msg.params?.conversationId === 'string' && Array.isArray(msg.params.messages)) {
              onQueuedFollowUpsChanged?.(msg.params.conversationId, msg.params.messages.length > 0);
            }
          } catch {}
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
      return socket;
    },
  };
}
