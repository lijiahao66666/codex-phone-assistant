import net from 'node:net';

// Observe the initialized owner identity and its acknowledged queue broadcasts.
// Queue requests must reach the live owner, which already drains them between turns.
// The handshake reply is matched by shape instead of by request id: the transport
// can split or replay frames, and a missed id used to leave the bridge without an
// identity, which then made every recovery look like a foreign owner.
function queuedChange(msg) {
  if (msg?.type !== 'broadcast' || msg.method !== 'thread-queued-followups-changed') return null;
  if (typeof msg.params?.conversationId !== 'string' || !Array.isArray(msg.params.messages)) return null;
  return [msg.params.conversationId, msg.params.messages.length > 0];
}

export function identityNet({ onQueuedFollowUpsChanged } = {}) {
  let current = null, identity = null;
  const watched = new WeakSet();
  const observe = socket => {
    if (watched.has(socket)) return;
    watched.add(socket);
    let input = Buffer.alloc(0);
    socket.prependListener('data', chunk => {
      input = Buffer.concat([input, chunk]);
      while (input.length >= 4) {
        const length = input.readUInt32LE(0);
        if (length > 1024 * 1024) { input = Buffer.alloc(0); return; }
        if (input.length < 4 + length) return;
        const body = input.subarray(4, 4 + length);
        input = input.subarray(4 + length);
        let msg;
        try { msg = JSON.parse(body); } catch { continue; }
        if (msg?.type === 'response' && typeof msg.result?.clientId === 'string' && msg.result.clientId) {
          current = socket; identity = msg.result.clientId;
          continue;
        }
        const change = queuedChange(msg);
        if (change) onQueuedFollowUpsChanged?.(change[0], change[1]);
      }
    });
    // The owner acknowledges a queue update by broadcasting it back over the same
    // socket, so the write side carries the state the sidebar needs.
    const write = socket.write;
    socket.write = function (chunk, ...rest) {
      if (Buffer.isBuffer(chunk) && chunk.length >= 4 && chunk.readUInt32LE(0) === chunk.length - 4) {
        try {
          const change = queuedChange(JSON.parse(chunk.subarray(4)));
          if (change) onQueuedFollowUpsChanged?.(change[0], change[1]);
        } catch { /* not a single JSON frame */ }
      }
      return write.call(this, chunk, ...rest);
    };
    socket.once('close', () => { if (current === socket) { current = null; identity = null; } });
  };
  return {
    get ownerId() { return current && !current.destroyed ? identity : null; },
    createServer: (...args) => net.createServer(...args),
    createConnection(...args) {
      const socket = net.createConnection(...args);
      observe(socket);
      return socket;
    },
  };
}
