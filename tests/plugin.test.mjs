// plugin.test.mjs — Vencord plugin guards without Discord.
// The plugin imports @api/@webpack aliases, so behavior is pinned two ways:
// (1) drift-guard regexes on ordering/flags, (2) a faithful JS mirror of the
// nonce-map protocol (marked MIRROR — keep in sync with index.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'app-mode', 'vencord-plugin', 'xdrRelay', 'index.ts'), 'utf8');

test('subscribe-before-send ordering (race fix intact)', () => {
  const sub = src.indexOf('awaitDelivery(targetCh, nonce');
  const send = src.indexOf('sendMessage(targetCh, payload, false, {})');
  assert.ok(sub >= 0 && send >= 0 && sub < send, 'waiter registered before sendMessage');
});

test('send flags + long-poll + auth headers', () => {
  assert.ok(src.includes('sendMessage(targetCh, payload, false, {})'), 'waitForChannelReady=false');
  assert.ok(src.includes('/poll?wait=25000'), 'long-poll wait');
  assert.ok(src.includes('signal: ctrl.signal'), 'abortable poll');
  assert.ok(src.includes('"X-XDR-1": "1"'), 'client header sent');
  assert.ok(src.includes('"X-XDR-Token"'), 'token header wired');
  assert.ok(src.includes('brokerToken'), 'brokerToken setting exists');
});

// MIRROR of onMessageCreate + awaitDelivery in index.ts.
function makeRelay() {
  const pending = new Map();
  const onMessageCreate = ev => {
    const source = ev && ev.message ? ev.message : ev;
    const info = { channelId: source && source.channel_id, nonce: source && source.nonce };
    if (!info.nonce) return;
    const w = pending.get(info.nonce);
    if (w && w.channelId === info.channelId) {
      pending.delete(info.nonce);
      clearTimeout(w.timer);
      w.resolve(true);
    }
  };
  const awaitDelivery = (channelId, nonce, ms) => {
    let timer;
    const promise = new Promise(resolve => {
      timer = setTimeout(() => { if (pending.delete(nonce)) resolve(false); }, ms);
      pending.set(nonce, { channelId, resolve, timer });
    });
    return { promise, cancel: () => {
      const w = pending.get(nonce);
      if (w) { pending.delete(nonce); clearTimeout(w.timer); w.resolve(false); }
    } };
  };
  return { pending, onMessageCreate, awaitDelivery };
}

test('nonce map: match resolves, mismatch ignored', async () => {
  const r = makeRelay();
  const w = r.awaitDelivery('c1', 'n1', 500);
  r.onMessageCreate({ channel_id: 'c2', nonce: 'n1' });
  r.onMessageCreate({ channel_id: 'c1', nonce: 'zzz' });
  r.onMessageCreate({ type: 'x', message: { channel_id: 'c1', nonce: 'n1' } });
  assert.equal(await w.promise, true);
  assert.equal(r.pending.size, 0);
});

test('nonce map: timeout resolves false and cleans up', async () => {
  const r = makeRelay();
  const w = r.awaitDelivery('c1', 'n9', 50);
  assert.equal(await w.promise, false);
  assert.equal(r.pending.size, 0);
});

test('nonce map: cancel resolves false and clears timer', async () => {
  const r = makeRelay();
  const w = r.awaitDelivery('c1', 'n8', 5000);
  w.cancel();
  assert.equal(await w.promise, false);
  assert.equal(r.pending.size, 0);
});

test('synchronous echo inside send is caught (the v1.9.2 race)', async () => {
  const r = makeRelay();
  const fakeSend = () => { r.onMessageCreate({ channel_id: 'c1', nonce: 'n5' }); };
  const waiter = r.awaitDelivery('c1', 'n5', 1000);
  fakeSend();
  assert.equal(await waiter.promise, true);
});
