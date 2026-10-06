// xdr-broker — local relay between the X userscript (browser) and the Vencord
// plugin (Discord desktop app). Tampermonkey GM storage cannot cross the
// browser↔app boundary, so this plain HTTP broker on 127.0.0.1 is the bridge.
//
// Routes:
//   GET  /health      → {ok:true}
//   POST /req         → body = relay request JSON; stored as the single pending slot
//   GET  /poll        → delivers the pending request ONCE (claim semantics), else {req:null}
//   POST /ack/:id     → plugin posts the result
//   GET  /ack/:id     → X side polls; a fresh ack is delivered exactly once
//
// Invariants mirrored from the userscript protocol (AGENTS.md §4):
//   - single request slot, expiry 15s unclaimed
//   - acks delivered once, expiry 60s
//   - claim-on-poll: the plugin owns the request after /poll; no redelivery
//     (a failed send is ack'd explicitly — never retried, one-send invariant)
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.XDR_BROKER_PORT || process.argv[2] || 8765);
const HOST = '127.0.0.1';
const REQ_TTL = 15000;   // unclaimed request expiry (matches userscript request expiry)
const ACK_TTL = 60000;   // ack pickup window

let pending = null;      // {req, ts, claimed}
const acks = new Map();  // id -> {body, ts, consumed}

// Long-poll waiters. /poll parks at most a couple of plugin pollers;
// /ack/:id parks X-side ack waits keyed by request id. Claim/consume stays
// atomic: the waiter is answered and flagged in the same tick.
const pollWaiters = new Set(); // {res, timer}
const ackWaiters = new Map();  // id -> Set({res, timer})

function unpark(set, w) {
  set.delete(w);
  clearTimeout(w.timer);
}
function parkPoll(res, ms, onTimeout) {
  const w = { res, timer: 0 };
  w.timer = setTimeout(() => {
    pollWaiters.delete(w);
    onTimeout();
  }, ms);
  if (w.timer.unref) w.timer.unref();
  pollWaiters.add(w);
  return w;
}
function parkAck(id, res, ms) {
  let set = ackWaiters.get(id);
  if (!set) { set = new Set(); ackWaiters.set(id, set); }
  const w = { res, timer: 0 };
  w.timer = setTimeout(() => {
    set.delete(w);
    if (!set.size) ackWaiters.delete(id);
    json(res, 200, { pending: true });
  }, ms);
  if (w.timer.unref) w.timer.unref();
  set.add(w);
  return w;
}
function waitMs(url, cap) {
  const n = Number(url.searchParams.get('wait'));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), cap || 30000);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj ?? {});
  res.writeHead(code, { ...CORS, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e5) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const route = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;

  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

    if (route === 'GET /health') { json(res, 200, { ok: true, v: 1, ts: Date.now() }); return; }

    if (route === 'POST /req') {
      const body = await readBody(req);
      // ch may be null/absent — "Open tab"/"current channel" semantics are
      // resolved by the plugin (the app's currently viewed channel), just as
      // the browser-tab side resolves them from the leader tab.
      if (!body || typeof body.id !== 'string' || typeof body.link !== 'string') {
        json(res, 400, { ok: false, err: 'bad request shape (need string id + link)' }); return;
      }
      pending = { req: body, ts: Date.now(), claimed: false };
      if (pollWaiters.size) {
        const first = pollWaiters.values().next().value;
        unpark(pollWaiters, first);
        pending.claimed = true;
        json(first.res, 200, { req: pending.req });
        for (const o of [...pollWaiters]) { unpark(pollWaiters, o); json(o.res, 200, { req: null }); }
      }
      json(res, 200, { ok: true }); return;
    }

    if (route === 'GET /poll') {
      if (pending && !pending.claimed && Date.now() - pending.ts < REQ_TTL) {
        pending.claimed = true;
        json(res, 200, { req: pending.req });
      } else if (waitMs(url) > 0) {
        if (pending && Date.now() - pending.ts >= REQ_TTL) pending = null;
        const w = parkPoll(res, waitMs(url), () => {
          if (pending && Date.now() - pending.ts >= REQ_TTL) pending = null;
          json(res, 200, { req: null });
        });
        req.on('close', () => { if (pollWaiters.has(w)) unpark(pollWaiters, w); });
      } else {
        pending = null;
        json(res, 200, { req: null });
      }
      return;
    }

    const ackMatch = url.pathname.match(/^\/ack\/([a-z0-9]+)$/i);
    if (ackMatch) {
      const id = ackMatch[1];
      if (req.method === 'POST') {
        const body = await readBody(req);
        acks.set(id, { body, ts: Date.now(), consumed: false });
        const set = ackWaiters.get(id);
        if (set && set.size) {
          ackWaiters.delete(id);
          for (const w of set) { clearTimeout(w.timer); json(w.res, 200, body); }
          acks.get(id).consumed = true;
        }
        json(res, 200, { ok: true }); return;
      }
      if (req.method === 'GET') {
        const a = acks.get(id);
        if (a && !a.consumed && Date.now() - a.ts < ACK_TTL) { a.consumed = true; json(res, 200, a.body); return; }
        if (waitMs(url) > 0) {
          const w = parkAck(id, res, waitMs(url));
          req.on('close', () => {
            const s = ackWaiters.get(id);
            if (s && s.has(w)) { unpark(s, w); if (!s.size) ackWaiters.delete(id); }
          });
          return;
        }
        res.writeHead(204, CORS); res.end(); return;
      }
    }

    json(res, 404, { ok: false, err: 'no such route' });
  } catch (e) {
    json(res, 400, { ok: false, err: String(e && e.message || e) });
  }
});

setInterval(() => {
  if (pending && Date.now() - pending.ts > REQ_TTL + 5000) pending = null;
  const now = Date.now();
  for (const [id, a] of acks) if (now - a.ts > ACK_TTL + 5000) acks.delete(id);
}, 30000).unref();

server.timeout = 35000;
server.keepAliveTimeout = 35000;
server.headersTimeout = 60000;
server.listen(PORT, HOST, () => {
  console.log(`[xdr-broker] listening on http://${HOST}:${PORT} (${randomUUID().slice(0, 8)})`);
});
