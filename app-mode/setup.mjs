import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_WIN = platform() === 'win32';
const IS_MAC = platform() === 'darwin';
const IS_LINUX = platform() === 'linux';

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: opts.cwd || __dirname, ...opts });
}

function which(bin) {
  try {
    const cmd = IS_WIN ? `where ${bin}` : `which ${bin}`;
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split(/\r?\n/)[0];
  } catch { return null; }
}

function pnpmBin() {
  return IS_WIN ? 'pnpm.cmd' : 'pnpm';
}

function vencordDataDir() {
  if (IS_WIN) return join(process.env.APPDATA, 'Vencord');
  if (IS_MAC) return join(homedir(), 'Library', 'Application Support', 'Vencord');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Vencord');
}

function startupDir() {
  if (!IS_WIN) return null;
  try {
    return execSync(
      'powershell -NoProfile -Command "[Environment]::GetFolderPath(\'Startup\')"',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
  } catch { return null; }
}

function isDiscordRunning() {
  try {
    if (IS_WIN) {
      return execSync('tasklist /FI "IMAGENAME eq Discord.exe" /NH',
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).includes('Discord.exe');
    }
    execSync('pgrep -xi "discord"', { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch { return false; }
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

const vc = join(__dirname, 'vencord');
const brokerDir = join(__dirname, 'broker');
const brokerJs = join(brokerDir, 'xdr-broker.mjs');
const pluginSrc = join(__dirname, 'vencord-plugin', 'xdrRelay', 'index.ts');
const vbsTemplate = join(brokerDir, 'run-broker.vbs.template');
const vbsGenerated = join(brokerDir, 'run-broker.vbs');

function serviceId() { return 'xdr-broker'; }

function uninstall() {
  console.log('== Uninstalling xdr-broker...');

  if (IS_WIN) {
    const sd = startupDir();
    if (sd) {
      const lnk = join(sd, 'xdr-broker.lnk');
      if (existsSync(lnk)) { unlinkSync(lnk); console.log(`   Removed: ${lnk}`); }
      else console.log('   No startup shortcut found.');
    }
    if (existsSync(vbsGenerated)) { unlinkSync(vbsGenerated); console.log('   Removed generated run-broker.vbs'); }
  }

  if (IS_LINUX) {
    const unit = join(
      process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
      'systemd', 'user', `${serviceId()}.service`
    );
    if (existsSync(unit)) {
      try { execSync(`systemctl --user disable --now ${serviceId()}`, { stdio: 'inherit' }); } catch {}
      unlinkSync(unit);
      console.log(`   Removed systemd user service: ${unit}`);
    } else {
      console.log('   No systemd user service found.');
    }
  }

  if (IS_MAC) {
    const plist = join(homedir(), 'Library', 'LaunchAgents', 'com.xdr.broker.plist');
    if (existsSync(plist)) {
      try { execSync(`launchctl unload "${plist}"`, { stdio: 'inherit' }); } catch {}
      unlinkSync(plist);
      console.log(`   Removed launchd plist: ${plist}`);
    } else {
      console.log('   No launchd plist found.');
    }
  }

  console.log('');
  console.log('Startup shortcut and broker removed.');
  console.log(`To fully remove Vencord, run:  cd vencord && ${pnpmBin()} uninject`);
  process.exit(0);
}

if (process.argv.includes('--uninstall')) uninstall();

console.log('== Step 0: Checking prerequisites...');

const missing = [];
if (!which('git'))  missing.push('  - Git: https://git-scm.com');
if (!which('node')) missing.push('  - Node.js: https://nodejs.org');
if (!which('npm'))  missing.push('  - npm (comes with Node.js): https://nodejs.org');

if (missing.length) {
  console.error('Missing required tools:');
  missing.forEach(m => console.error(m));
  process.exit(1);
}

if (isDiscordRunning()) {
  console.error('Discord is running. Close it first (tray icon > Quit Discord), then re-run this script.');
  process.exit(1);
}

console.log('   git, node, npm found. Discord not running. OK.');

console.log('');
console.log('== Step 1: Vencord source...');
if (existsSync(join(vc, '.git'))) {
  console.log('   Clone exists, pulling latest...');
  run('git pull --ff-only', { cwd: vc });
} else {
  console.log('   Cloning Vencord (first run, ~1 min)...');
  run(`git clone https://github.com/Vendicated/Vencord.git "${vc}"`);
}

console.log('');
console.log('== Step 2: Copying plugin...');
const upDir = join(vc, 'src', 'userplugins', 'xdrRelay');
mkdirSync(upDir, { recursive: true });
copyFileSync(pluginSrc, join(upDir, 'index.ts'));
console.log('   Plugin copied to vencord/src/userplugins/xdrRelay');

console.log('');
console.log('== Step 3: Build + inject...');

if (!which(pnpmBin()) && !which('pnpm')) {
  console.log('   Installing pnpm...');
  try {
    run('corepack enable');
    console.log('   pnpm enabled via corepack.');
  } catch {
    console.log('   corepack failed, falling back to npm...');
    run('npm install -g pnpm');
  }
}

const pnpm = which(pnpmBin()) ? pnpmBin() : 'pnpm';

console.log('   pnpm install (first run: several minutes)...');
run(`${pnpm} install`, { cwd: vc });
console.log('   pnpm build...');
run(`${pnpm} build`, { cwd: vc });
console.log('   pnpm inject (patches the installed Discord app)...');
run(`${pnpm} inject`, { cwd: vc });

const distSrc = join(vc, 'dist');
const distDest = join(vencordDataDir(), 'dist');
copyDirContents(distSrc, distDest);
console.log(`   Fresh dist deployed to ${distDest}`);

console.log('');
console.log('== Step 4: CSP rule...');
const settingsDir = join(vencordDataDir(), 'settings');
const settingsFile = join(settingsDir, 'settings.json');
mkdirSync(settingsDir, { recursive: true });

let settings = {};
if (existsSync(settingsFile)) {
  try { settings = JSON.parse(readFileSync(settingsFile, 'utf8')); } catch {}
}
settings.customCspRules = { 'connect-src': ['http://127.0.0.1', 'ws://127.0.0.1'] };
writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
console.log('   CSP rule added (connect-src http/ws 127.0.0.1)');

console.log('');
console.log('== Step 5: Broker auto-start...');
const nodeExe = which('node');

if (IS_WIN) {
  const tpl = readFileSync(vbsTemplate, 'utf8');
  writeFileSync(vbsGenerated, tpl.replace('NODE_EXE_PATH', nodeExe).replace('BROKER_JS_PATH', brokerJs), 'ascii');

  const sd = startupDir();
  if (sd) {
    const lnk = join(sd, 'xdr-broker.lnk');
    const ps = `$s=(New-Object -COM WScript.Shell).CreateShortcut('${lnk}');$s.TargetPath='wscript.exe';$s.Arguments='"${vbsGenerated}"';$s.WorkingDirectory='${brokerDir}';$s.Description='X -> Discord relay broker';$s.Save()`;
    execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { stdio: 'inherit' });
    console.log(`   Startup shortcut installed: ${lnk}`);
  }
  spawn('wscript.exe', [vbsGenerated], { detached: true, stdio: 'ignore' }).unref();
}

if (IS_LINUX) {
  const unitDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');
  mkdirSync(unitDir, { recursive: true });
  const unitFile = join(unitDir, `${serviceId()}.service`);
  const unit = [
    '[Unit]',
    'Description=X -> Discord relay broker',
    'After=network.target',
    '',
    '[Service]',
    `ExecStart=${nodeExe} ${brokerJs}`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target'
  ].join('\n');
  writeFileSync(unitFile, unit, 'utf8');
  run('systemctl --user daemon-reload');
  run(`systemctl --user enable --now ${serviceId()}`);
  console.log(`   systemd user service installed: ${unitFile}`);
}

if (IS_MAC) {
  const agentsDir = join(homedir(), 'Library', 'LaunchAgents');
  mkdirSync(agentsDir, { recursive: true });
  const plistFile = join(agentsDir, 'com.xdr.broker.plist');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.xdr.broker</string>
  <key>ProgramArguments</key><array>
    <string>${nodeExe}</string>
    <string>${brokerJs}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>StandardOutPath</key><string>/tmp/xdr-broker.log</string>
  <key>StandardErrorPath</key><string>/tmp/xdr-broker.log</string>
</dict>
</plist>`;
  writeFileSync(plistFile, plist, 'utf8');
  run(`launchctl load "${plistFile}"`);
  console.log(`   launchd plist installed: ${plistFile}`);
}

console.log('   Broker started.');

console.log('');
console.log('DONE! Next steps:');
console.log('  1. Start Discord');
console.log("  2. Open Settings > Vencord > Plugins, search 'xdrRelay', enable it");
console.log('  3. Restart Discord (tray icon > Quit, then reopen)');
console.log('  4. On x.com, click the mode chip on any post bar to switch to App mode');
console.log("  5. Send -- toast should say 'Sent to #channel via app'");
console.log('');
console.log('To uninstall later: node setup.mjs --uninstall');
