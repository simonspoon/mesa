#!/usr/bin/env node
// CDP-level screencast recorder for a khora (Chrome DevTools Protocol) page
// session. Captures Page.screencastFrame events into timestamped JPEGs —
// browser-viewport only, works headless, never touches the host display.
//
// Usage: node recorder.mjs <pageWebSocketDebuggerUrl> <outDir>
//   Writes frame_00000.jpg, frame_00001.jpg, ... plus manifest.json
//   ({frames: [{file, t}]}, t = seconds since first frame).
//   Stops on SIGTERM/SIGINT, or when <outDir>/STOP appears.

import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const [, , wsUrl, outDir] = process.argv;
if (!wsUrl || !outDir) {
  console.error('usage: recorder.mjs <pageWebSocketDebuggerUrl> <outDir>');
  process.exit(2);
}

await mkdir(outDir, { recursive: true });

const ws = new WebSocket(wsUrl);
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const frames = [];
let startTime = null;
let stopping = false;

ws.addEventListener('message', async (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== undefined) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
    return;
  }
  if (msg.method === 'Page.screencastFrame') {
    const { data, sessionId, metadata } = msg.params;
    const t = metadata.timestamp ?? Date.now() / 1000;
    if (startTime === null) startTime = t;
    const idx = frames.length;
    const file = `frame_${String(idx).padStart(5, '0')}.jpg`;
    frames.push({ file, t: t - startTime });
    await writeFile(path.join(outDir, file), Buffer.from(data, 'base64'));
    // Ack must not block on our own write; fire and forget is fine here.
    send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

await send('Page.enable');
await send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 });
console.error(`recording -> ${outDir}`);

async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await send('Page.stopScreencast');
  } catch {
    // ws may already be closing; frames captured so far are still valid.
  }
  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify({ frames }, null, 2));
  console.error(`stopped, ${frames.length} frames captured`);
  ws.close();
  process.exit(0);
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);

const stopFile = path.join(outDir, 'STOP');
const poll = setInterval(() => {
  if (existsSync(stopFile)) {
    clearInterval(poll);
    stop();
  }
}, 200);
