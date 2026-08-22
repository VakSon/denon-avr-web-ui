// server.js — zero-dependency HTTP server that exposes a REST API + SSE stream
// for controlling Denon AVRs, and serves the static web UI.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DenonDevice } from './denon.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Wait for the receiver to echo back a state change (or give up after `ms`), so
// an action's HTTP response can carry the fresh state. This makes the UI update
// on every button press even when the live SSE stream can't reach the browser.
function settle(dev, ms = 350) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); dev.off('status', onStatus); resolve(); };
    const onStatus = () => done();
    const t = setTimeout(done, ms);
    dev.once('status', onStatus);
  });
}
const PUBLIC_DIR = path.join(__dirname, 'public');
// Where the receiver list is persisted. Override with DATA_DIR to point it at a
// mounted volume (e.g. in Docker) so it survives container restarts.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const STORE_FILE = path.join(DATA_DIR, 'receivers.json');
const PORT = process.env.PORT || 3000;

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- Receiver registry (persisted to receivers.json) ----
const devices = new Map(); // id -> DenonDevice

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    for (const r of raw) addDevice(r.id, r.host, r.name, r.labels, false);
  } catch { /* no store yet */ }
}

function saveStore() {
  const list = [...devices.values()].map((d) => ({ id: d.id, host: d.host, name: d.name, labels: d.labels }));
  // Write atomically so a crash mid-write can't corrupt the store.
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

function addDevice(id, host, name, labels, persist = true) {
  if (devices.has(id)) return devices.get(id);
  const dev = new DenonDevice(id, host, name, labels);
  dev.on('status', (s) => broadcast({ type: 'status', device: s }));
  devices.set(id, dev);
  dev.connect();
  if (persist) saveStore();
  return dev;
}

function removeDevice(id) {
  const dev = devices.get(id);
  if (!dev) return false;
  dev.disconnect();
  devices.delete(id);
  saveStore();
  return true;
}

// ---- Server-Sent Events for live status ----
const sseClients = new Set();
function broadcast(obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) res.write(data);
}

// ---- Helpers ----
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---- Router ----
const server = http.createServer(async (req, res) => {
  const { url, method } = req;

  // Live status stream
  if (url === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    // Send current snapshot immediately.
    res.write(`data: ${JSON.stringify({ type: 'snapshot', devices: [...devices.values()].map((d) => d.publicState()) })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // List receivers
  if (url === '/api/devices' && method === 'GET') {
    return sendJSON(res, 200, [...devices.values()].map((d) => d.publicState()));
  }

  // Add a receiver
  if (url === '/api/devices' && method === 'POST') {
    const body = await readBody(req);
    const host = (body.host || '').trim();
    if (!host) return sendJSON(res, 400, { error: 'host (IP or hostname) is required' });
    const id = host.replace(/[^a-zA-Z0-9]/g, '_') + '_' + Date.now().toString(36);
    const dev = addDevice(id, host, (body.name || '').trim() || host, {});
    return sendJSON(res, 201, dev.publicState());
  }

  // Per-device routes: /api/devices/:id/...
  const m = url.match(/^\/api\/devices\/([^/]+)(\/[^?]*)?/);
  if (m) {
    const id = m[1];
    const sub = m[2] || '';
    const dev = devices.get(id);

    if (method === 'DELETE' && !sub) {
      return sendJSON(res, removeDevice(id) ? 200 : 404, { ok: !!dev });
    }
    if (!dev) return sendJSON(res, 404, { error: 'unknown device' });

    if (method === 'POST') {
      const body = await readBody(req);
      switch (sub) {
        case '/power': dev.setPower(!!body.on); break;
        case '/mute': dev.setMute(!!body.on); break;
        case '/volume': dev.setVolume(Number(body.value)); break;
        case '/volume/up': dev.volumeUp(); break;
        case '/volume/down': dev.volumeDown(); break;
        case '/input': dev.setInput(String(body.source)); break;
        case '/surround': dev.setSurround(String(body.mode)); break;
        case '/channel': dev.setChannel(String(body.channel), Number(body.db)); break;
        case '/labels': dev.setLabel(String(body.code), body.name); saveStore(); break;
        case '/raw': dev.raw(String(body.command)); break;
        case '/refresh': dev.refresh(); break;
        default: return sendJSON(res, 404, { error: 'unknown action' });
      }
      // Give the receiver a moment to echo the change back, then return the
      // updated state so the client reflects it without needing the SSE stream.
      await settle(dev);
      return sendJSON(res, 200, dev.publicState());
    }

    if (method === 'GET' && (sub === '' || sub === '/')) {
      return sendJSON(res, 200, dev.publicState());
    }
  }

  if (url.startsWith('/api/')) return sendJSON(res, 404, { error: 'not found' });

  // Static files (the UI)
  return serveStatic(req, res);
});

loadStore();
server.listen(PORT, () => {
  console.log(`Denon Web UI running at http://localhost:${PORT}`);
});
