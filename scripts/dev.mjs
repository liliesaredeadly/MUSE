import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const processes = [];
const withMusicgen = process.argv.includes('--musicgen');
let closing = false;
function stop(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of processes) {
    // Windows SIGTERM cannot run Python's finally block. Kill only the tree
    // we started so a supervised model worker cannot outlive its launcher.
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill();
  }
  setTimeout(() => process.exit(code), 150).unref();
}
const commands = [
  [process.execPath, ['--env-file-if-exists=.env', '--watch', 'server/index.js']],
  [process.execPath, ['node_modules/vite/bin/vite.js']],
];
if (withMusicgen) {
  const python = path.join(root, '.local', 'musicgen-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!existsSync(python)) throw new Error('Create .local/musicgen-venv and install requirements/musicgen-cpu.txt first. See docs/MUSICGEN_LOCAL.md.');
  commands.unshift([python, ['scripts/musicgen_melody_service.py', '--backend', 'transformers', '--device', 'cpu', '--quantize']]);
}
for (const [executable, args] of commands) {
  const env = withMusicgen ? { ...process.env, MUSE_MELODY_MODEL_URL: 'http://127.0.0.1:3002/generate' } : process.env;
  const child = spawn(executable, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  processes.push(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!closing) stop(code || 0); });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
