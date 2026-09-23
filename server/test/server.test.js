'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const { createServer, sanitizePath, sanitizeRoom, sanitizeSel, safeEqual, encodingFor } = require('../server.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'unison-test-'));
}

async function startServer(overrides = {}) {
  const server = createServer(Object.assign({ dataDir: tmpDir(), logLevel: 'error' }, overrides));
  const addr = await server.listen(0, '127.0.0.1');
  return { server, url: `ws://127.0.0.1:${addr.port}` };
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

const inbox = new WeakMap();
function next(ws, type, timeout = 4000) {
  if (!inbox.has(ws)) inbox.set(ws, []);
  const box = inbox.get(ws);
  const found = box.findIndex((m) => m.type === type);
  if (found >= 0) return Promise.resolve(box.splice(found, 1)[0]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMsg); reject(new Error(`timeout waiting for ${type}`)); }, timeout);
    function onMsg(data) {
      let m;
      try { m = JSON.parse(data.toString()); } catch (e) { return; }
      if (m.type === type) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(m);
      } else {
        box.push(m);
      }
    }
    ws.on('message', onMsg);
  });
}

function send(ws, obj) { ws.send(JSON.stringify(obj)); }

async function waitFor(fn, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return false;
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test('sanitizePath strips traversal and dot segments', () => {
  assert.equal(sanitizePath('notes/a.md'), 'notes/a.md');
  assert.equal(sanitizePath('/abs/a.md'), 'abs/a.md');
  assert.equal(sanitizePath('./a.md'), 'a.md');
  assert.equal(sanitizePath('../../etc/passwd'), '');
  assert.equal(sanitizePath('.trash/x.md'), '');
  assert.equal(sanitizePath('a\\b\\c.md'), 'a/b/c.md');
  assert.equal(sanitizePath(''), '');
});

test('sanitizeRoom only allows safe identifiers', () => {
  assert.equal(sanitizeRoom('room-1_a'), 'room-1_a');
  assert.equal(sanitizeRoom('bad room'), '');
  assert.equal(sanitizeRoom('../../x'), '');
  assert.equal(sanitizeRoom(''), '');
});

test('sanitizeSel drops collapsed and huge selections', () => {
  assert.equal(sanitizeSel(null), null);
  assert.equal(sanitizeSel({ a: { line: 1, ch: 1 }, h: { line: 1, ch: 1 } }), null);
  assert.deepEqual(sanitizeSel({ a: { line: 1, ch: 0 }, h: { line: 2, ch: 3 } }), { a: { line: 1, ch: 0 }, h: { line: 2, ch: 3 } });
  assert.equal(sanitizeSel({ a: { line: 0, ch: 0 }, h: { line: 5000, ch: 0 } }), null);
});

test('safeEqual compares secrets', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual(undefined, ''), true);
});

test('encodingFor picks base64 for binaries', () => {
  assert.equal(encodingFor('a.md'), 'utf8');
  assert.equal(encodingFor('a.png'), 'base64');
  assert.equal(encodingFor('noext'), 'utf8');
});

// ---------------------------------------------------------------------------
// integration
// ---------------------------------------------------------------------------

test('rejects a wrong API key', async () => {
  const { server, url } = await startServer({ apiKey: 'secret', roomToken: '' });
  try {
    const ws = await connect(url);
    send(ws, { type: 'hello', room: 'r1', user: 'u', clientId: 'c1', apiKey: 'nope' });
    const err = await next(ws, 'error');
    assert.match(err.message, /api key/i);
  } finally { await server.close(); }
});

test('accepts the right key and syncs a file between two clients', async () => {
  const { server, url } = await startServer({ apiKey: 'secret' });
  try {
    const a = await connect(url);
    send(a, { type: 'hello', room: 'r1', user: 'alice', clientId: 'a', apiKey: 'secret' });
    await next(a, 'welcome');

    const b = await connect(url);
    send(b, { type: 'hello', room: 'r1', user: 'bob', clientId: 'b', apiKey: 'secret' });
    await next(b, 'welcome');

    send(a, { type: 'file-update', path: 'notes/x.md', content: '# hi\n', encoding: 'utf8', mtime: 1, clientId: 'a', user: 'alice' });
    const got = await next(b, 'file-update');
    assert.equal(got.path, 'notes/x.md');
    assert.equal(got.content, '# hi\n');

    const fileOnDisk = await waitFor(() => fs.existsSync(path.join(server.cfg.dataDir, 'r1', 'notes', 'x.md')));
    assert.equal(fileOnDisk, true);
  } finally { await server.close(); }
});

test('file-pull returns the stored content and history is kept', async () => {
  const { server, url } = await startServer({});
  try {
    const ws = await connect(url);
    send(ws, { type: 'hello', room: 'rm', user: 'u', clientId: 'c', apiKey: '' });
    await next(ws, 'welcome');

    send(ws, { type: 'file-update', path: 'a.md', content: 'v1', encoding: 'utf8', mtime: 1 });
    send(ws, { type: 'file-update', path: 'a.md', content: 'v2', encoding: 'utf8', mtime: 2 });

    send(ws, { type: 'file-pull', path: 'a.md' });
    const pulled = await next(ws, 'file-update');
    assert.equal(pulled.content, 'v2');
    assert.equal(pulled.version, 2);

    send(ws, { type: 'history-list', path: 'a.md' });
    const hist = await next(ws, 'history');
    assert.equal(hist.versions.length, 1);
    assert.equal(hist.versions[0].version, 1);
  } finally { await server.close(); }
});

test('file-delete removes content and notifies others', async () => {
  const { server, url } = await startServer({});
  try {
    const a = await connect(url);
    send(a, { type: 'hello', room: 'rd', user: 'a', clientId: 'a', apiKey: '' });
    await next(a, 'welcome');
    const b = await connect(url);
    send(b, { type: 'hello', room: 'rd', user: 'b', clientId: 'b', apiKey: '' });
    await next(b, 'welcome');

    send(a, { type: 'file-update', path: 'gone.md', content: 'x', encoding: 'utf8', mtime: 1 });
    await next(b, 'file-update');
    send(a, { type: 'file-delete', path: 'gone.md' });
    const del = await next(b, 'file-delete');
    assert.equal(del.path, 'gone.md');
  } finally { await server.close(); }
});

test('rate limiting kicks in for file floods', async () => {
  const { server, url } = await startServer({ rateBurst: 5, rateRefillPerSec: 1 });
  try {
    const ws = await connect(url);
    send(ws, { type: 'hello', room: 'rr', user: 'u', clientId: 'c', apiKey: '' });
    await next(ws, 'welcome');
    for (let i = 0; i < 20; i++) {
      send(ws, { type: 'file-update', path: `f${i}.md`, content: 'x', encoding: 'utf8', mtime: i });
    }
    const err = await next(ws, 'error');
    assert.match(err.message, /rate limit/i);
  } finally { await server.close(); }
});

test('room storage limit is enforced', async () => {
  const { server, url } = await startServer({ maxRoomBytes: 1024 * 1024 + 100 });
  try {
    const ws = await connect(url);
    send(ws, { type: 'hello', room: 'rb', user: 'u', clientId: 'c', apiKey: '' });
    await next(ws, 'welcome');
    send(ws, { type: 'file-update', path: 'big.bin', content: 'A'.repeat(1024 * 1024), encoding: 'utf8', mtime: 1 });
    send(ws, { type: 'file-update', path: 'big2.bin', content: 'A'.repeat(1024 * 1024), encoding: 'utf8', mtime: 2 });
    const err = await next(ws, 'error');
    assert.match(err.message, /storage limit/i);
  } finally { await server.close(); }
});

test('responds to a WebSocket ping with a pong', async () => {
  const { server, url } = await startServer({});
  try {
    const ws = await connect(url);
    send(ws, { type: 'hello', room: 'rp', user: 'u', clientId: 'c', apiKey: '' });
    await next(ws, 'welcome');
    const pong = new Promise((resolve) => ws.once('pong', resolve));
    ws.ping();
    await pong;
    assert.ok(true);
  } finally { await server.close(); }
});

test('health endpoint reports version and auth', async () => {
  const { server } = await startServer({ apiKey: 'secret' });
  try {
    const addr = server.httpServer.address();
    const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, 'unison');
    assert.equal(body.authRequired, true);
  } finally { await server.close(); }
});

test('idle room is unloaded from memory but survives on disk', async () => {
  const { server, url } = await startServer({ idleUnloadMs: 100 });
  try {
    const ws = await connect(url);
    send(ws, { type: 'hello', room: 'idle', user: 'u', clientId: 'c', apiKey: '' });
    await next(ws, 'welcome');
    send(ws, { type: 'file-update', path: 'a.md', content: 'keep', encoding: 'utf8', mtime: 1 });
    ws.close();
    assert.equal(await waitFor(() => server.rooms.size === 0, 3000), true);
    const ws2 = await connect(url);
    send(ws2, { type: 'hello', room: 'idle', user: 'u', clientId: 'c2', apiKey: '' });
    const welcome = await next(ws2, 'welcome');
    assert.equal(welcome.files.length, 1);
    assert.equal(welcome.files[0].path, 'a.md');
  } finally { await server.close(); }
});
