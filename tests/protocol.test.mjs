// protocol.test.mjs — GM-protocol units with a fake store + controllable time.
// Election predicate mirrors electionTick's `take` in the userscript (kept in
// sync by the drift regex below); sweepStale is extract-and-eval'd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'userscript', 'x-discord-relay.user.js'), 'utf8');

function extractFn(name) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} found in userscript`);
  let depth = 0, started = false, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) break; }
  }
  return src.slice(i, j + 1);
}

test('election predicate shape unchanged (drift guard)', () => {
  for (const frag of [
    "const take = (qual && (!fresh || !leaderQualified || id === ME)) || (!qual && (!fresh || id === ME));",
    "isLeader = gget(PING_KEY, '').startsWith(ME + ':');",
  ]) assert.ok(src.includes(frag), frag);
});

// MIRROR of electionTick's take — keep in sync (guard above fails if it moves).
const take = (qual, fresh, leaderQualified, id, ME) =>
  (qual && (!fresh || !leaderQualified || id === ME)) || (!qual && (!fresh || id === ME));

test('leader election scenarios', () => {
  assert.equal(take(true, false, false, 'other', 'me'), true);   // qualified takes stale
  assert.equal(take(true, true, true, 'other', 'me'), false);   // qualified fresh leader holds
  assert.equal(take(true, true, false, 'other', 'me'), true);   // qualified beats unqualified
  assert.equal(take(true, true, true, 'me', 'me'), true);        // own ping re-take
  assert.equal(take(false, true, true, 'other', 'me'), false);  // unqualified yields
  assert.equal(take(false, false, false, 'other', 'me'), true); // unqualified takes stale
  assert.equal(take(false, true, false, 'me', 'me'), true);      // own ping re-take
});

function makeGM() {
  const store = new Map();
  const fns = {
    gget: (k, d = '') => (store.has(k) ? store.get(k) : d),
    gset: (k, v) => { store.set(k, v); },
    GM_listValues: () => [...store.keys()],
    GM_deleteValue: k => { store.delete(k); },
  };
  return { store, ...fns };
}

test('sweepStale deletes old + blank keys, keeps fresh', () => {
  const { store, ...fns } = makeGM();
  const now = 1700000000000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    store.set('xdr.ack.a1', JSON.stringify({ ts: now - 120000 }));
    store.set('xdr.lock.l1', JSON.stringify({ ts: now - 61000 }));
    store.set('xdr.ack.fresh', JSON.stringify({ ts: now - 1000 }));
    store.set('xdr.ack.blank', '');
    store.set('xdr.lock.garbage', 'nonsense without ts');
    store.set('xdr.target', JSON.stringify({ id: 'c1' }));
    const fn = new Function('gget', 'gset', 'GM_listValues', 'GM_deleteValue', `${extractFn('sweepStale')}; sweepStale();`);
    fn(fns.gget, fns.gset, fns.GM_listValues, fns.GM_deleteValue);
    assert.ok(!store.has('xdr.ack.a1'), 'old ack deleted');
    assert.ok(!store.has('xdr.lock.l1'), 'old lock deleted');
    assert.ok(store.has('xdr.ack.fresh'), 'fresh ack kept');
    assert.ok(!store.has('xdr.ack.blank'), 'legacy blank deleted');
    assert.ok(!store.has('xdr.lock.garbage'), 'unparseable deleted');
    assert.ok(store.has('xdr.target'), 'non ack/lock untouched');
  } finally {
    Date.now = realNow;
  }
});

test('lock claim uses read-back confirm (drift guard)', () => {
  assert.ok(src.includes("gset(lockKey(req.id), ME + ':' + Date.now());"), 'lock write shipped');
  assert.ok(src.includes("if (!gget(lockKey(req.id), '').startsWith(ME + ':')) { finish(); return; }"), 'claim confirm shipped');
  assert.ok(src.includes('reqQueue.push(req);'), 'send queue shipped');
  assert.ok(src.includes('delKey(key); delKey(lockKey(id));'), 'key deletion shipped');
});
