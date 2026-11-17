import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const processes = [];
let closing = false;
function stop(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of processes) child.kill();
  setTimeout(() => process.exit(code), 150).unref();
}
for (const args of [['--watch', 'server/index.js'], ['node_modules/vite/bin/vite.js']]) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  processes.push(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!closing) stop(code || 0); });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
