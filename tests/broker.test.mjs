// broker.test.mjs — contract tests against a real broker child process.
// Pins: auth gating, claim-once, consume-once, waiter wake + abort cleanup,
// 409-busy, TTL expiry (via env overrides), token mode.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const brokerJs = join(root, 'app-mode', 'broker', 'xdr-broker.mjs');
const H = { 'X-XDR-1': '1' };
try {
  const t = readFileSync(join(root, 'app-mode', 'broker', '.token'), 'utf8').trim();
  if (t) H['X-XDR-Token'] = t;
} catch { /* fresh clone without setup run: header-only mode */ }
let portNo = 18770;
const kids = [];
after(() => { for (const k of kids) try { k.kill(); } catch {} });

async function startBroker(env = {}) {
  const port = String(portNo++);
  const kid = spawn(process.execPath, [brokerJs], {
    env: { ...process.env, XDR_BROKER_PORT: port, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  kids.push(kid);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return base;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('broker did not start on ' + port);
}

async function call(base, method, path, body, headers) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
}

test('health is open, API requires the client header', async () => {
  const base = await startBroker();
  assert.equal((await call(base, 'GET', '/health')).status, 200);
  assert.equal((await call(base, 'POST', '/req', { id: 'x', link: 'https://fixupx.com/u/status/1' })).status, 401);
  assert.equal((await call(base, 'GET', '/poll')).status, 401);
});

test('claim-once + 409-busy', async () => {
  const base = await startBroker();
  const req = { id: 'c1', link: 'https://fixupx.com/u/status/1', ts: Date.now() };
  assert.equal((await call(base, 'POST', '/req', req, H)).status, 200);
  assert.equal((await call(base, 'POST', '/req', { ...req, id: 'c2' }, H)).status, 409);
  const p1 = await call(base, 'GET', '/poll', undefined, H);
  assert.equal(p1.status, 200);
  assert.equal(p1.json.req.id, 'c1');
  const p2 = await call(base, 'GET', '/poll', undefined, H);
  assert.equal(p2.json.req, null);
});

test('long-poll wakes on POST, second waiter gets null', async () => {
  const base = await startBroker();
  const parked = Promise.all([
    call(base, 'GET', '/poll?wait=8000', undefined, H),
    call(base, 'GET', '/poll?wait=8000', undefined, H),
  ]);
  await new Promise(r => setTimeout(r, 300));
  const req = { id: 'w1', link: 'https://fixupx.com/u/status/9', ts: Date.now() };
  assert.equal((await call(base, 'POST', '/req', req, H)).status, 200);
  const [a, b] = await parked;
  const got = [a.json, b.json].map(j => (j.req ? j.req.id : null)).sort();
  assert.deepEqual(got, [null, 'w1']);
});

test('aborted waiter does not break later requests', async () => {
  const base = await startBroker();
  const ctrl = new AbortController();
  const hanging = fetch(base + '/poll?wait=8000', { headers: H, signal: ctrl.signal }).catch(e => e);
  await new Promise(r => setTimeout(r, 300));
  ctrl.abort();
  await hanging;
  const req = { id: 'a1', link: 'https://fixupx.com/u/status/3', ts: Date.now() };
  assert.equal((await call(base, 'POST', '/req', req, H)).status, 200);
  const p = await call(base, 'GET', '/poll', undefined, H);
  assert.equal(p.json.req.id, 'a1');
});

test('ack consume-once + parked ack wait', async () => {
  const base = await startBroker();
  const waiting = call(base, 'GET', '/ack/k1?wait=8000', undefined, H);
  await new Promise(r => setTimeout(r, 300));
  assert.equal((await call(base, 'POST', '/ack/k1', { ok: true, via: 't' }, H)).status, 200);
  const first = await waiting;
  assert.equal(first.status, 200);
  assert.equal(first.json.ok, true);
  assert.equal((await call(base, 'GET', '/ack/k1', undefined, H)).status, 204);
});

test('bad shape rejected, spoofed host rejected (raw socket)', async () => {
  const base = await startBroker();
  assert.equal((await call(base, 'POST', '/req', { nope: 1 }, H)).status, 400);
  const { default: net } = await import('node:net');
  const port = Number(new URL(base).port);
  const rawStatus = await new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write('GET /poll HTTP/1.1\r\nHost: evil.com\r\nX-XDR-1: 1\r\nConnection: close\r\n\r\n');
    });
    let data = '';
    sock.on('data', c => { data += c; });
    sock.on('close', () => resolve(Number((data.match(/^HTTP\/\d\.\d (\d+)/) || [])[1] || 0)));
    sock.on('error', reject);
  });
  assert.equal(rawStatus, 401);
});

test('request TTL expiry via env override', async () => {
  const base = await startBroker({ XDR_REQ_TTL_MS: '300', XDR_ACK_TTL_MS: '300' });
  const req = { id: 't1', link: 'https://fixupx.com/u/status/4', ts: Date.now() };
  assert.equal((await call(base, 'POST', '/req', req, H)).status, 200);
  await new Promise(r => setTimeout(r, 500));
  assert.equal((await call(base, 'GET', '/poll', undefined, H)).json.req, null);
  assert.equal((await call(base, 'POST', '/ack/t1', { ok: true }, H)).status, 200);
  await new Promise(r => setTimeout(r, 500));
  assert.equal((await call(base, 'GET', '/ack/t1', undefined, H)).status, 204);
});

test('token mode rejects missing token, accepts it', async () => {
  const base = await startBroker({ XDR_BROKER_TOKEN: 's3cret' });
  assert.equal((await call(base, 'POST', '/req', { id: 'x', link: 'https://fixupx.com/u/status/1' }, H)).status, 401);
  assert.equal((await call(base, 'POST', '/req', { id: 'x', link: 'https://fixupx.com/u/status/1' }, { ...H, 'X-XDR-Token': 's3cret' })).status, 200);
});
