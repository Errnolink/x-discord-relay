/**
 * rebuild.mjs — redeploy the xdrRelay Vencord plugin after ANY Vencord rebuild
 * on this box (including a Vencord Installer "Reinstall", which ships a
 * userplugin-free build and silently wipes xdrRelay).
 *
 * Canonical flow: ONE Vencord clone on this box carries ALL userplugins
 * (currently C:\Users\Chef\Documents\Vencord — GifFolders + xdrRelay).
 * Never build+inject from app-mode\vencord again; it races the main clone
 * for the single %APPDATA%\Vencord\dist target.
 *
 * Usage:  node rebuild.mjs [path-to-vencord-clone]
 * After:  fully restart Discord (tray → Quit), then send a test relay.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir, platform } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_WIN = platform() === 'win32';
const pnpm = IS_WIN ? 'pnpm.cmd' : 'pnpm';

const DEFAULT_CLONE = resolve(homedir(), 'Documents', 'Vencord');
const vc = resolve(process.argv[2] || DEFAULT_CLONE);
const pluginSrc = join(__dirname, 'vencord-plugin', 'xdrRelay', 'index.ts');

function vencordDataDir() {
  if (IS_WIN) return join(process.env.APPDATA, 'Vencord');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Vencord');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Vencord');
}

function copyDirContents(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) copyDirContents(s, d);
    else copyFileSync(s, d);
  }
}

if (!existsSync(join(vc, 'package.json'))) {
  console.error(`Not a Vencord clone: ${vc}`);
  process.exit(1);
}

console.log(`== Step 1: copy plugin -> ${vc}`);
const upDir = join(vc, 'src', 'userplugins', 'xdrRelay');
mkdirSync(upDir, { recursive: true });
copyFileSync(pluginSrc, join(upDir, 'index.ts'));

console.log('== Step 1b: broker token...');
const tokenFile = join(__dirname, 'broker', '.token');
let brokerToken = '';
try { brokerToken = readFileSync(tokenFile, 'utf8').trim(); } catch {}
if (!brokerToken) {
  brokerToken = randomBytes(16).toString('hex');
  writeFileSync(tokenFile, brokerToken + '\n', 'utf8');
  console.log('   New token generated.');
} else {
  console.log('   Existing token reused.');
}
const copiedPlugin = join(upDir, 'index.ts');
writeFileSync(copiedPlugin,
  readFileSync(copiedPlugin, 'utf8').replace('default: ""', `default: "${brokerToken}"`),
  'utf8');
console.log('   Token baked into the copied plugin (broker reads the same .token file).');
console.log('   Userscript needs it too: set BROKER_TOKEN in runXSide to:');
console.log(`   ${brokerToken}`);

console.log('== Step 2: pnpm install + build');
for (const args of [['install', '--prefer-offline'], ['build']]) {
  const r = spawnSync(pnpm, args, { cwd: vc, stdio: 'inherit', shell: IS_WIN });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log('== Step 3: deploy dist');
const dest = join(vencordDataDir(), 'dist');
copyDirContents(join(vc, 'dist'), dest);

console.log('== Step 4: sanity check');
const renderer = readFileSyncSafe(join(dest, 'renderer.js'));
for (const name of ['xdrRelay', 'GifFolders']) {
  const ok = renderer.includes(name);
  console.log(`   ${name}: ${ok ? 'present' : 'MISSING'}`);
  if (!ok) process.exit(1);
}

console.log(`\nDeployed to ${dest}. Fully restart Discord (tray -> Quit) now.`);
console.log('Broker must be running: tasklist check for node xdr-broker.mjs (port 8765).');
function readFileSyncSafe(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch { return ''; }
}
