process.env.HUB_IMAGE_PREVIEW ??= '0';
process.env.HUB_IMAGE_UPLOAD ??= '0';

await import('./mac-app-runtime.mjs');
