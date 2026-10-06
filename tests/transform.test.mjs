// transform.test.mjs — extract-and-eval of the shipped content transforms.
// Pins what the Discord side SENDS without a login (in-page interception is
// unreliable: webpack identity churns between evaluate calls).
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

// fixupLink uses location.origin — stub it.
globalThis.location = { origin: 'https://x.com' };
const fixupLink = eval(`(${extractFn('fixupLink')})`);

test('fixupLink converts post URLs to fixupx', () => {
  assert.equal(fixupLink('https://x.com/someuser/status/123'), 'https://fixupx.com/someuser/status/123');
  assert.equal(fixupLink('https://twitter.com/someuser/status/123?s=20'), 'https://fixupx.com/someuser/status/123');
  assert.equal(fixupLink('https://x.com/someuser/status/123/photo/1'), 'https://fixupx.com/someuser/status/123');
});

test('fixupLink rejects non-post URLs', () => {
  for (const u of [
    'https://x.com/home', 'https://x.com/i/status/123', 'https://x.com/search?q=a',
    'https://x.com/settings/account', 'https://example.com/a/status/123',
    'https://x.com/intent/tweet?text=hi', 'not a url',
  ]) assert.equal(fixupLink(u), null, u);
});

test('ping filter keeps only snowflakes, order preserved', () => {
  assert.ok(src.includes("filter(id => /^\\d{17,20}$/.test(id))"), 'ping filter shipped');
  const ids = ['123456789012345678', '123', 'abc', '12345678901234567890', '12345678901234567'];
  const kept = ids.filter(id => /^\d{17,20}$/.test(id));
  assert.deepEqual(kept, ['123456789012345678', '12345678901234567890', '12345678901234567']);
  assert.equal(' ' + kept.map(id => '<@' + id + '>').join(' '), ' <@123456789012345678> <@12345678901234567890> <@12345678901234567>');
});
