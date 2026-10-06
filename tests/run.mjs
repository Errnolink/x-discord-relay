// run.mjs — full gate: syntax + invariants + unit suites.
// Usage: node tests/run.mjs   (before every Tampermonkey re-paste)
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = false;
const step = (name, cmd, args) => {
  console.log(`\n== ${name}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) { failed = true; console.log(`   FAILED (${r.status})`); }
};

step('syntax userscript', 'node', ['--check', 'userscript/x-discord-relay.user.js']);
step('syntax broker', 'node', ['--check', 'app-mode/broker/xdr-broker.mjs']);
step('syntax setup', 'node', ['--check', 'app-mode/setup.mjs']);
step('syntax rebuild', 'node', ['--check', 'app-mode/rebuild.mjs']);
step('invariant gate', 'node', ['tests/check.mjs']);
step('unit suites', 'node', ['--test', 'tests/transform.test.mjs', 'tests/protocol.test.mjs', 'tests/broker.test.mjs', 'tests/plugin.test.mjs']);

console.log(failed ? '\nGATE FAILED' : '\nGATE GREEN');
process.exit(failed ? 1 : 0);
