/*
 * Unison server - WebSocket hub for the Unison Obsidian plugin.
 *
 *  - Rooms: clients that send the same `room` string see each other.
 *  - The server is the source of truth: files are persisted to
 *    DATA_DIR/<room>/<path>, version history to DATA_DIR/.history/<room>/.
 *  - Protocol: newline-free JSON messages, see docs/protocol.md.
 *
 * Env:
 *   PORT=3000               listen port
 *   HOST=0.0.0.0            listen address
 *   API_KEY=                shared access key; when set every client must send it
 *   REQUIRE_AUTH=false      reject clients unless a valid API_KEY is presented
 *   ROOM_TOKEN=             optional per-room shared secret
 *   DATA_DIR=./data         persistence directory
 *   PLUGIN_DIR=./plugin     optional dir served at GET /plugin/<file>
 *   CORS_ORIGINS=            comma list allowed for /plugin/* ('*' = any)
 *   LOG_LEVEL=info          error | warn | info | debug
 *   MAX_FILE_BYTES, MAX_ROOM_BYTES, MAX_CLIENTS_PER_ROOM, IDLE_UNLOAD_MS ...
 *
 * Run:
 *   npm install --production && node server.js
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let WebSocketServer;
try {
  ({ WebSocketServer } = require('ws'));
} catch (e) {
  console.error('[unison] missing dependency "ws" - run `npm install` first');
  throw e;
}

const pkg = require('./package.json');

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

function envInt(name, def, min, max) {
  const n = parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}
function envBool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}
function envList(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const BASE_CONFIG = {
  port: envInt('PORT', 3000, 1, 65535),
  host: process.env.HOST || '0.0.0.0',
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  pluginDir: process.env.PLUGIN_DIR || path.join(__dirname, 'plugin'),
  apiKey: process.env.API_KEY || '',
  requireAuth: envBool('REQUIRE_AUTH', false),
  roomToken: process.env.ROOM_TOKEN || '',
  corsOrigins: envList('CORS_ORIGINS'),
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),

  maxFileBytes: envInt('MAX_FILE_BYTES', 8 * 1024 * 1024, 1024, 128 * 1024 * 1024),
  maxHist: envInt('MAX_HIST', 20, 0, 500),
  histMaxBytes: envInt('HIST_MAX_BYTES', 256 * 1024, 0, 8 * 1024 * 1024),
  histTotalBytes: envInt('HIST_TOTAL_BYTES', 512 * 1024, 0, 32 * 1024 * 1024),
  maxRoomBytes: envInt('MAX_ROOM_BYTES', 512 * 1024 * 1024, 1024 * 1024, 8 * 1024 * 1024 * 1024),
  maxClientsPerRoom: envInt('MAX_CLIENTS_PER_ROOM', 64, 1, 4096),
  maxBufferedBytes: envInt('MAX_BUFFERED_BYTES', 8 * 1024 * 1024, 64 * 1024, 256 * 1024 * 1024),
  idleUnloadMs: envInt('IDLE_UNLOAD_MS', 30 * 60 * 1000, 0, 24 * 3600 * 1000),
  rateBurst: envInt('RATE_BURST', 300, 10, 100000),
  rateRefillPerSec: envInt('RATE_REFILL_PER_SEC', 40, 1, 10000),
};

const PLUGIN_FILES = {
  'manifest.json': 'application/json; charset=utf-8',
  'main.js': 'application/javascript; charset=utf-8',
  'styles.css': 'text/css; charset=utf-8',
};

// Extensions stored as UTF-8. Everything else is persisted as base64.
const TEXT_EXTS = new Set([
  'md', 'markdown', 'mdx', 'txt', 'canvas', 'json', 'jsonc', 'css', 'js', 'ts',
  'yml', 'yaml', 'toml', 'xml', 'html', 'htm', 'svg', 'py', 'sh', 'c', 'h',
  'cpp', 'java', 'go', 'rs', 'sql', 'log', 'ini', 'cfg', 'env', 'gitignore',
]);

const HISTORY_DIR = '.history';
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function encodingFor(p) {
  const i = p.lastIndexOf('.');
  const ext = i >= 0 ? p.slice(i + 1).toLowerCase() : '';
  if (!ext) return 'utf8';
  return TEXT_EXTS.has(ext) ? 'utf8' : 'base64';
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Length-checked constant-time comparison for secrets. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bb = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (ba.length !== bb.length) {
    // still burn a comparison so the timing stays flat for equal-size inputs
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function sanitizePath(p) {
  if (typeof p !== 'string' || !p) return '';
  p = p.replace(/\\/g, '/').trim();
  p = p.replace(/^\.\/+/, '').replace(/^\/+/, '');
  if (!p || p.includes('..') || p.startsWith('.trash/')) return '';
  if (p.length > 500) return '';
  if (p.endsWith('.tmp-' + process.pid)) return '';
  return p;
}

function sanitizeRoom(r) {
  if (typeof r !== 'string') return '';
  r = r.trim().slice(0, 64);
  if (!r || !/^[A-Za-z0-9_-]+$/.test(r)) return '';
  return r;
}

function sanitizeUser(u) {
  if (typeof u !== 'string') return 'anon';
  u = u.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32);
  return u || 'anon';
}

function sanitizeSel(sel) {
  if (!sel || typeof sel !== 'object') return null;
  const a = sel.a, h = sel.h;
  if (!a || !h) return null;
  const p = (o) => ({ line: o.line | 0, ch: o.ch | 0 });
  const A = p(a), H = p(h);
  if (A.line < 0 || H.line < 0 || A.ch < 0 || H.ch < 0) return null;
  if (A.line === H.line && A.ch === H.ch) return null;
  if (Math.abs(A.line - H.line) > 2000) return null;
  return { a: A, h: H };
}

function contentBytes(content, encoding) {
  if (typeof content !== 'string') return 0;
  return encoding === 'base64'
    ? Math.floor(content.length * 3 / 4)
    : Buffer.byteLength(content, 'utf8');
}

function makeBucket(capacity, refillPerSec) {
  return { tokens: capacity, capacity, refillPerSec, last: Date.now() };
}
function takeToken(b) {
  const now = Date.now();
  b.tokens = Math.min(b.capacity, b.tokens + ((now - b.last) / 1000) * b.refillPerSec);
  b.last = now;
  if (b.tokens >= 1) { b.tokens -= 1; return true; }
  return false;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

function createServer(overrides = {}) {
  const cfg = Object.assign({}, BASE_CONFIG, overrides);

  function log(level, ...args) {
    if ((LEVELS[level] || 0) <= (LEVELS[cfg.logLevel] == null ? 2 : LEVELS[cfg.logLevel])) {
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      fn('[unison]', ...args);
    }
  }

  // room -> { files, clients, history, loaded, bytes, idleTimer, writing }
  const rooms = new Map();
  let totalConnections = 0;
  let pendingWrites = 0;
  let shuttingDown = false;
  const startedAt = Date.now();

  const roomDir = (room) => path.join(cfg.dataDir, room);
  const histDir = (room) => path.join(cfg.dataDir, HISTORY_DIR, room);

  function diskPath(room, filePath) {
    const base = path.resolve(roomDir(room));
    const resolved = path.resolve(path.join(roomDir(room), filePath));
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
    return resolved;
  }

  function histFileFor(room, p) {
    const flat = p.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) + '-' + fnv1a(p) + '.json';
    return path.join(histDir(room), flat);
  }

  function getRoom(room) {
    let st = rooms.get(room);
    if (!st) {
      st = { files: new Map(), clients: new Map(), history: new Map(), loaded: false, bytes: 0, idleTimer: null };
      rooms.set(room, st);
    }
    return st;
  }

  function touchRoom(room) {
    const st = rooms.get(room);
    if (!st) return;
    if (st.idleTimer) { clearTimeout(st.idleTimer); st.idleTimer = null; }
  }

  function scheduleIdleUnload(room) {
    if (!cfg.idleUnloadMs) return;
    const st = rooms.get(room);
    if (!st || st.clients.size > 0) return;
    if (st.idleTimer) clearTimeout(st.idleTimer);
    st.idleTimer = setTimeout(() => {
      const cur = rooms.get(room);
      if (!cur || cur.clients.size > 0) return;
      if (pendingWrites > 0) { scheduleIdleUnload(room); return; }
      rooms.delete(room);
      log('debug', `room "${room}" unloaded (idle)`);
    }, cfg.idleUnloadMs);
    if (st.idleTimer && st.idleTimer.unref) st.idleTimer.unref();
  }

  // ---- history -----------------------------------------------------------

  async function persistHistory(room, p, hist) {
    pendingWrites++;
    try {
      await fs.promises.mkdir(histDir(room), { recursive: true });
      await fs.promises.writeFile(histFileFor(room, p), JSON.stringify({ path: p, hist }), 'utf8');
    } catch (e) {
      log('warn', 'history persist failed', room, p, e.message);
    } finally { pendingWrites--; }
  }

  async function deleteHistoryFile(room, p) {
    try { await fs.promises.unlink(histFileFor(room, p)); } catch (e) { /* absent */ }
  }

  async function loadHistory(room, st) {
    let entries;
    try { entries = await fs.promises.readdir(histDir(room)); } catch (e) { return; }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      try {
        const obj = JSON.parse(await fs.promises.readFile(path.join(histDir(room), name), 'utf8'));
        if (obj && typeof obj.path === 'string' && Array.isArray(obj.hist) && st.files.has(obj.path)) {
          st.history.set(obj.path, obj.hist);
        }
      } catch (e) { /* skip bad file */ }
    }
  }

  function pushHistory(st, p, prev) {
    if (!prev || cfg.maxHist === 0) return;
    if (contentBytes(prev.content, prev.encoding) > cfg.histMaxBytes) return;
    let hist = (st.history.get(p) || []).concat([{
      content: prev.content, encoding: prev.encoding, mtime: prev.mtime,
      version: prev.version, user: prev.user, hash: prev.hash,
    }]);
    while (hist.length > cfg.maxHist) hist.shift();
    let total = 0;
    for (let i = hist.length - 1; i >= 0; i--) {
      total += contentBytes(hist[i].content, hist[i].encoding);
      if (total > cfg.histTotalBytes) { hist = hist.slice(i + 1); break; }
    }
    st.history.set(p, hist);
    return hist;
  }

  // ---- disk load / persist ----------------------------------------------

  async function loadRoomFromDisk(room) {
    const st = getRoom(room);
    const dir = roomDir(room);
    try { await fs.promises.mkdir(dir, { recursive: true }); } catch (e) { /* ignore */ }
    let count = 0;
    async function walk(cur) {
      let entries;
      try { entries = await fs.promises.readdir(cur, { withFileTypes: true }); } catch (e) { return; }
      for (const ent of entries) {
        const full = path.join(cur, ent.name);
        if (ent.isDirectory()) { await walk(full); continue; }
        const clean = sanitizePath(path.relative(dir, full).replace(/\\/g, '/'));
        if (!clean) continue;
        try {
          const stat = await fs.promises.stat(full);
          if (stat.size > cfg.maxFileBytes) { log('warn', `skip oversized on disk: ${clean}`); continue; }
          const enc = encodingFor(clean);
          const content = await fs.promises.readFile(full, enc);
          const rec = { content, encoding: enc, mtime: stat.mtimeMs, version: 1, hash: fnv1a(content), user: 'disk' };
          st.files.set(clean, rec);
          st.bytes += contentBytes(content, enc);
          count++;
        } catch (e) { /* skip */ }
      }
    }
    await walk(dir);
    await loadHistory(room, st);
    st.loaded = true;
    log('info', `room "${room}" loaded: ${count} files, ${st.history.size} with history`);
  }

  async function persistFile(room, filePath, content, encoding) {
    const full = diskPath(room, filePath);
    if (!full) return;
    pendingWrites++;
    try {
      await fs.promises.mkdir(path.dirname(full), { recursive: true });
      const tmp = `${full}.tmp-${process.pid}`;
      await fs.promises.writeFile(tmp, content, encoding === 'base64' ? 'base64' : 'utf8');
      await fs.promises.rename(tmp, full);
    } catch (e) {
      log('error', 'persist failed', room, filePath, e.message);
    } finally { pendingWrites--; }
  }

  async function deletePersisted(room, filePath) {
    const full = diskPath(room, filePath);
    if (!full) return;
    try { await fs.promises.unlink(full); } catch (e) { /* absent */ }
  }

  async function renamePersisted(room, oldPath, newPath) {
    const a = diskPath(room, oldPath);
    const b = diskPath(room, newPath);
    if (!a || !b) return;
    pendingWrites++;
    try {
      await fs.promises.mkdir(path.dirname(b), { recursive: true });
      await fs.promises.rename(a, b);
    } catch (e) { /* ignore */ } finally { pendingWrites--; }
  }

  // ---- sending -----------------------------------------------------------

  function wsSend(ws, data) {
    if (ws.readyState !== 1) return false;
    if (ws.bufferedAmount > cfg.maxBufferedBytes) {
      log('warn', 'backpressure: dropping frame for a slow client');
      return false;
    }
    try { ws.send(data); return true; } catch (e) { return false; }
  }

  function send(ws, obj) { wsSend(ws, JSON.stringify(obj)); }

  function broadcast(room, obj, exceptClientId) {
    const st = rooms.get(room);
    if (!st) return;
    const data = JSON.stringify(obj);
    for (const [cid, c] of st.clients) {
      if (cid === exceptClientId) continue;
      wsSend(c.ws, data);
    }
  }

  function presenceList(room) {
    const st = rooms.get(room);
    if (!st) return [];
    return [...st.clients.values()].map((c) => ({
      user: c.user, clientId: c.clientId, color: c.color,
      path: c.path || '', line: c.line || 0, sel: c.sel || null,
    }));
  }

  function fileListOf(st) {
    return [...st.files.entries()].map(([p, f]) => ({
      path: p, mtime: f.mtime, size: f.content ? f.content.length : 0,
      hash: f.hash, version: f.version, encoding: f.encoding || 'utf8',
    }));
  }

  // ---- http --------------------------------------------------------------

  function corsHeaders(origin) {
    const list = cfg.corsOrigins;
    if (!list.length || !origin) return {};
    if (list.includes('*')) return { 'Access-Control-Allow-Origin': '*' };
    if (list.includes(origin)) return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    return {};
  }

  const httpServer = http.createServer((req, res) => {
    const origin = req.headers.origin;
    const security = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

    const pm = req.url && req.url.match(/^\/plugin\/([A-Za-z0-9._-]+)$/);
    if (pm && PLUGIN_FILES[pm[1]]) {
      fs.readFile(path.join(cfg.pluginDir, pm[1]), (err, data) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain', ...security }); res.end('not found'); return; }
        res.writeHead(200, {
          'Content-Type': PLUGIN_FILES[pm[1]],
          'Cache-Control': 'no-store',
          ...security,
          ...corsHeaders(origin),
        });
        res.end(data);
      });
      return;
    }

    if (req.url === '/health' || req.url === '/status') {
      let users = 0, files = 0, history = 0;
      const detail = [];
      for (const [name, st] of rooms) {
        users += st.clients.size; files += st.files.size; history += st.history.size;
        if (detail.length < 50) detail.push({ room: name, users: st.clients.size, files: st.files.size, history: st.history.size, bytes: st.bytes });
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ...security });
      res.end(JSON.stringify({
        ok: true, service: 'unison', version: pkg.version,
        authRequired: cfg.requireAuth || !!cfg.apiKey,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        rooms: rooms.size, users, files, historyFiles: history,
        totalConnections, memoryMB: Math.round(process.memoryUsage().rss / 1048576),
        roomDetail: detail,
      }));
      return;
    }

    if (req.url === '/rooms') {
      const detail = [...rooms.entries()].map(([name, st]) => ({ room: name, users: st.clients.size, files: st.files.size }));
      res.writeHead(200, { 'Content-Type': 'application/json', ...security });
      res.end(JSON.stringify({ rooms: detail }));
      return;
    }

    if (req.url === '/metrics') {
      const lines = [
        '# HELP unison_uptime_seconds Server uptime in seconds.',
        '# TYPE unison_uptime_seconds gauge',
        `unison_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`,
        '# HELP unison_rooms Number of active rooms.',
        '# TYPE unison_rooms gauge',
        `unison_rooms ${rooms.size}`,
        '# HELP unison_connections_total Total accepted WebSocket connections.',
        '# TYPE unison_connections_total counter',
        `unison_connections_total ${totalConnections}`,
        '# HELP unison_clients_online Currently connected clients.',
        '# TYPE unison_clients_online gauge',
        `unison_clients_online ${[...rooms.values()].reduce((n, s) => n + s.clients.size, 0)}`,
        '# HELP unison_room_bytes Bytes held in memory per room.',
        '# TYPE unison_room_bytes gauge',
      ];
      for (const [name, st] of rooms) {
        lines.push(`unison_room_bytes{room="${name.replace(/"/g, '')}"} ${st.bytes}`);
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4', ...security });
      res.end(lines.join('\n') + '\n');
      return;
    }

    let users = 0;
    for (const st of rooms.values()) users += st.clients.size;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...security });
    res.end(`<!doctype html><meta charset="utf-8"><h1>Unison server</h1><p>OK. Online: ${users}. Connect over WebSocket from the Unison plugin.</p><p><a href="/health">/health</a> · <a href="/rooms">/rooms</a> · <a href="/metrics">/metrics</a></p>`);
  });

  // ---- websocket ---------------------------------------------------------

  const wss = new WebSocketServer({ server: httpServer, maxPayload: 32 * 1024 * 1024 });

  wss.on('connection', (ws) => {
    totalConnections++;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws._fileBucket = makeBucket(cfg.rateBurst, cfg.rateRefillPerSec);
    ws._msgBucket = makeBucket(cfg.rateBurst * 2, cfg.rateRefillPerSec * 4);

    let room = null;
    let clientId = null;
    let user = 'anon';

    ws.on('message', async (raw) => {
      if (shuttingDown) return;
      if (!takeToken(ws._msgBucket)) { send(ws, { type: 'error', message: 'rate limit: slow down' }); return; }
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (!msg || typeof msg.type !== 'string') return;

      // ---- hello / join ----
      if (msg.type === 'hello') {
        const r = sanitizeRoom(msg.room);
        const u = sanitizeUser(msg.user);
        const cid = String(msg.clientId || '').slice(0, 64) || `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        if (!r) { send(ws, { type: 'error', message: 'invalid room' }); ws.close(1008, 'bad room'); return; }

        if (cfg.requireAuth || cfg.apiKey) {
          if (!cfg.apiKey || !safeEqual(msg.apiKey, cfg.apiKey)) {
            send(ws, { type: 'error', message: 'invalid API key' });
            ws.close(1008, 'bad api key');
            return;
          }
        }
        if (cfg.roomToken && !safeEqual(msg.token, cfg.roomToken)) {
          send(ws, { type: 'error', message: 'invalid token (ROOM_TOKEN mismatch)' });
          ws.close(1008, 'bad token');
          return;
        }

        room = r; clientId = cid; user = u;
        const st = getRoom(room);
        touchRoom(room);
        const isSame = st.clients.has(clientId);
        if (!isSame && st.clients.size >= cfg.maxClientsPerRoom) {
          send(ws, { type: 'error', message: 'room is full' });
          ws.close(1008, 'room full');
          return;
        }
        if (!st.loaded) await loadRoomFromDisk(room);

        const prev = st.clients.get(clientId);
        if (prev && prev.ws !== ws) { try { prev.ws.close(1000, 'replaced'); } catch (e) { /* ignore */ } }
        st.clients.set(clientId, { ws, user, clientId, color: String(msg.color || '#2196f3').slice(0, 16), path: '', line: 0, sel: null });

        send(ws, { type: 'welcome', you: { user, clientId }, users: presenceList(room).filter((x) => x.clientId !== clientId), files: fileListOf(st) });
        broadcast(room, { type: 'user-join', user, clientId, color: st.clients.get(clientId).color }, clientId);
        broadcast(room, { type: 'presence', users: presenceList(room) }, null);
        log('info', `join: ${user} (${clientId}) -> room "${room}" (${st.clients.size} online)`);
        return;
      }

      if (!room || !clientId) { send(ws, { type: 'error', message: 'send hello first' }); return; }
      const st = getRoom(room);

      switch (msg.type) {
        case 'ping': send(ws, { type: 'pong', t: msg.t }); break;

        case 'list': send(ws, { type: 'file-list', files: fileListOf(st) }); break;

        case 'file-update': {
          const p = sanitizePath(msg.path);
          if (!p || typeof msg.content !== 'string') break;
          const enc = msg.encoding === 'base64' ? 'base64' : 'utf8';
          const rawLen = contentBytes(msg.content, enc);
          if (rawLen > cfg.maxFileBytes) { send(ws, { type: 'error', message: `file too large: ${p}` }); break; }
          if (!takeToken(ws._fileBucket)) { send(ws, { type: 'error', message: 'rate limit: slow down' }); break; }

          const prev = st.files.get(p);
          const delta = rawLen - (prev ? contentBytes(prev.content, prev.encoding) : 0);
          if (st.bytes + delta > cfg.maxRoomBytes) { send(ws, { type: 'error', message: `room storage limit exceeded: ${p}` }); break; }

          const version = (prev ? prev.version : 0) + 1;
          const mtime = typeof msg.mtime === 'number' ? msg.mtime : Date.now();
          const saved = pushHistory(st, p, prev);
          if (saved) persistHistory(room, p, saved);
          const rec = { content: msg.content, encoding: enc, mtime, version, hash: fnv1a(msg.content), user };
          st.files.set(p, rec);
          st.bytes += delta;
          persistFile(room, p, msg.content, enc);
          broadcast(room, { type: 'file-update', path: p, content: msg.content, encoding: enc, mtime, version, user, clientId }, clientId);
          break;
        }

        case 'file-delete': {
          const p = sanitizePath(msg.path);
          if (!p) break;
          const prev = st.files.get(p);
          if (prev) st.bytes = Math.max(0, st.bytes - contentBytes(prev.content, prev.encoding));
          st.files.delete(p);
          st.history.delete(p);
          deletePersisted(room, p);
          deleteHistoryFile(room, p);
          broadcast(room, { type: 'file-delete', path: p, user, clientId }, clientId);
          log('info', `delete ${room}/${p} by ${user}`);
          break;
        }

        case 'file-rename': {
          const a = sanitizePath(msg.oldPath);
          const b = sanitizePath(msg.newPath);
          if (!a || !b || a === b) break;
          const rec = st.files.get(a);
          if (rec) { st.files.delete(a); st.files.set(b, { ...rec, version: rec.version + 1 }); }
          if (st.history.has(a)) {
            const h = st.history.get(a);
            st.history.delete(a);
            st.history.set(b, h);
            persistHistory(room, b, h);
            deleteHistoryFile(room, a);
          }
          renamePersisted(room, a, b);
          broadcast(room, { type: 'file-rename', oldPath: a, newPath: b, user, clientId }, clientId);
          log('info', `rename ${room}/${a} -> ${b} by ${user}`);
          break;
        }

        case 'file-pull': {
          const p = sanitizePath(msg.path);
          if (!p) break;
          const rec = st.files.get(p);
          if (rec) send(ws, { type: 'file-update', path: p, content: rec.content, encoding: rec.encoding || 'utf8', mtime: rec.mtime, version: rec.version, user: rec.user || 'server', clientId: 'server' });
          else send(ws, { type: 'error', message: `not found on server: ${p}` });
          break;
        }

        case 'history-list': {
          const p = sanitizePath(msg.path);
          if (!p) break;
          const hist = st.history.get(p) || [];
          send(ws, { type: 'history', path: p, versions: hist.map((h) => ({ version: h.version, mtime: h.mtime, user: h.user, hash: h.hash })) });
          break;
        }

        case 'history-get': {
          const p = sanitizePath(msg.path);
          const v = msg.version | 0;
          if (!p || !v) break;
          const h = (st.history.get(p) || []).find((x) => x.version === v);
          if (h) send(ws, { type: 'history-file', path: p, content: h.content, encoding: h.encoding || 'utf8', version: h.version, mtime: h.mtime, user: h.user });
          else send(ws, { type: 'error', message: `version not found: ${p} v${v}` });
          break;
        }

        case 'cursor': {
          const c = st.clients.get(clientId);
          const cleanSel = sanitizeSel(msg.sel);
          const p2 = sanitizePath(msg.path || '') || '';
          if (c) { c.path = p2; c.line = msg.line | 0; c.ch = msg.ch | 0; c.sel = cleanSel; }
          broadcast(room, { type: 'cursor', path: p2, line: msg.line | 0, ch: msg.ch | 0, typing: !!msg.typing, sel: cleanSel, user, clientId, color: (c || {}).color || '#2196f3' }, clientId);
          break;
        }

        default: break;
      }
    });

    ws.on('close', () => {
      if (!room || !clientId) return;
      const st = rooms.get(room);
      if (!st) return;
      const cur = st.clients.get(clientId);
      if (cur && cur.ws === ws) {
        st.clients.delete(clientId);
        broadcast(room, { type: 'user-leave', user, clientId }, null);
        broadcast(room, { type: 'presence', users: presenceList(room) }, null);
        log('info', `leave: ${user} (${clientId}) <- room "${room}" (${st.clients.size} online)`);
        scheduleIdleUnload(room);
      }
    });

    ws.on('error', () => { /* handled by close */ });
  });

  const keepalive = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) { try { ws.terminate(); } catch (e) { /* ignore */ } return; }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) { /* ignore */ }
    });
  }, 25000);
  if (keepalive.unref) keepalive.unref();

  function listen(port = cfg.port, host = cfg.host) {
    return new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, host, () => {
        httpServer.removeListener('error', reject);
        resolve(httpServer.address());
      });
    });
  }

  async function close() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(keepalive);
    for (const st of rooms.values()) {
      if (st.idleTimer) { clearTimeout(st.idleTimer); st.idleTimer = null; }
    }
    for (const ws of wss.clients) { try { ws.terminate(); } catch (e) { /* ignore */ } }
    await new Promise((res) => { try { wss.close(() => res()); } catch (e) { res(); } });
    await new Promise((res) => { try { httpServer.close(() => res()); } catch (e) { res(); } });
    const deadline = Date.now() + 3000;
    while (pendingWrites > 0 && Date.now() < deadline) await sleep(20);
  }

  return { httpServer, wss, rooms, cfg, listen, close, log };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

if (require.main === module) {
  const server = createServer();
  server.listen().then(() => {
    const c = server.cfg;
    server.log('info', `unison server ${pkg.version} listening on ${c.host}:${c.port}`);
    server.log('info', `data dir: ${c.dataDir}`);
    server.log('info', `auth ${c.apiKey ? 'ENABLED (API_KEY set)' : c.requireAuth ? 'ENABLED (REQUIRE_AUTH, no key -> all rejected!)' : 'DISABLED'}, room token ${c.roomToken ? 'set' : 'not set'}`);
    if (!c.apiKey && !c.requireAuth) server.log('warn', 'API_KEY is empty - anyone who knows the address can connect. Set API_KEY in production.');
  }).catch((e) => {
    console.error('[unison] failed to start:', e.message);
    process.exit(1);
  });

  const shutdown = async (sig) => {
    server.log('info', `received ${sig}, shutting down...`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { createServer, sanitizePath, sanitizeRoom, sanitizeUser, sanitizeSel, fnv1a, safeEqual, encodingFor };
