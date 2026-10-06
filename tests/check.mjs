// check.mjs — release + invariant gate. Run before every Tampermonkey
// re-paste. Fails the release on drift (the recurring audit issue #5 class).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const us = readFileSync(join(root, 'userscript', 'x-discord-relay.user.js'), 'utf8');
const plugin = readFileSync(join(root, 'app-mode', 'vencord-plugin', 'xdrRelay', 'index.ts'), 'utf8');
let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ok  ' : '  FAIL') + ' ' + msg);
  if (!cond) fails++;
};

const ver = (us.match(/\/\/ @version\s+(\S+)/) || [])[1];
const logs = [...us.matchAll(/active v(\S+?)'\)/g)].map(m => m[1]);
ok(!!ver, 'header @version present');
ok(logs.length === 2 && logs.every(v => v === ver), `@version (${ver}) matches both console lines (${logs})`);

for (const g of ['GM_getValue', 'GM_setValue', 'GM_addValueChangeListener', 'GM_xmlhttpRequest', 'GM_listValues', 'GM_deleteValue'])
  ok(us.includes(`// @grant        ${g}`), `grant ${g}`);
for (const m of ['https://x.com/*', 'https://twitter.com/*', 'https://discord.com/*'])
  ok(us.includes(`// @match        ${m}`), `match ${m}`);
ok(us.includes('// @connect      127.0.0.1'), 'connect 127.0.0.1');

// Hard invariants (AGENTS.md §5).
ok(!us.includes("execCommand('insertText')"), 'no execCommand insertText');
ok(us.includes("ClipboardEvent("), 'paste via ClipboardEvent');
ok(us.includes('ma.sendMessage(channelId, payload, true, {})'), 'tab clientSend 4-arg');
ok(plugin.includes('sendMessage(targetCh, payload, false, {})'), 'plugin sendMessage 4-arg + no readiness wait');
ok(us.includes('invalidEmojis: []'), 'invalidEmojis array (not false)');
ok(!/push\s*=\s*function|defineProperty\(.*webpackChunk/i.test(us), 'no webpack push hooks');
ok(us.includes('aria-label') && us.includes('nav-verify failed'), 'nav-verify gate present');
ok(us.includes('DOMFAIL'), 'DOMFAIL short-circuit present');
ok(us.includes('OCCUPIED'), 'composer-occupied guard present');
ok(us.includes('reqQueue.push(req)'), 'leader-side send queue present');
ok(us.includes('409'), 'broker-busy handling present');
ok(plugin.includes('awaitDelivery(targetCh, nonce'), 'plugin subscribe-before-send present');

process.exit(fails ? 1 : 0);
