import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPairRelay } from './server.mjs';

export function relayConfig(env = process.env) {
  if (!env.HUB_ORIGIN) throw new Error('HUB_ORIGIN is required (the public HTTPS origin).');
  const port = Number(env.PORT ?? 8788);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535.');
  const flag = (name, fallback) => {
    if (env[name] === undefined) return fallback;
    if (!['0', '1'].includes(env[name])) throw new Error(`${name} must be 0 or 1.`);
    return env[name] === '1';
  };
  const notifications = flag('HUB_NOTIFICATIONS', false) ? {
    database: resolve(env.HUB_PUSH_DATABASE || 'data/push.sqlite'),
    vapidDetails: { subject: env.HUB_PUSH_SUBJECT, publicKey: env.HUB_PUSH_PUBLIC_KEY, privateKey: env.HUB_PUSH_PRIVATE_KEY },
  } : null;
  if (notifications && Object.values(notifications.vapidDetails).some(value => typeof value !== 'string' || !value)) throw new Error('Push VAPID configuration is required.');
  return { port, origin: env.HUB_ORIGIN, database: resolve(env.HUB_DATABASE || 'data/relay.sqlite'),
    ...(notifications ? { notifications } : {}),
    production: true, trustedProxy: flag('HUB_TRUSTED_PROXY', false),
    imageUpload: flag('HUB_IMAGE_UPLOAD', false), imagePreview: flag('HUB_IMAGE_PREVIEW', false) };
}

export async function startRelay(env = process.env) {
  const { port, ...config } = relayConfig(env);
  await mkdir(dirname(config.database), { recursive: true, mode: 0o700 });
  if (config.notifications) await mkdir(dirname(config.notifications.database), { recursive: true, mode: 0o700 });
  const relay = createPairRelay(config);
  try {
    const boundPort = await relay.listen(port);
    return { relay, port: boundPort };
  } catch (error) { await relay.close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { relay, port } = await startRelay();
    console.log(`RELAY_LISTEN=http://127.0.0.1:${port}`);
    let closing;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      closing ??= relay.close().then(() => { process.exitCode = 0; });
    });
  } catch (error) {
    console.error(`Relay startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
