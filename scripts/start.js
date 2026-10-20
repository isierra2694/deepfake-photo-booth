const { spawn } = require('child_process');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const processes = [
  spawn(npm, ['run', 'frontend'], { stdio: 'inherit' }),
  spawn(npm, ['run', 'server'], { stdio: 'inherit' }),
];

let stopping = false;

function stopAll(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of processes) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exitCode = exitCode;
}

for (const child of processes) {
  child.on('error', error => {
    console.error('Failed to start a development server:', error.message);
    stopAll(1);
  });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    const status = code ?? (signal ? 1 : 0);
    console.error(`A development server exited with status ${status}.`);
    stopAll(status);
  });
}

process.on('SIGINT', () => stopAll(130));
process.on('SIGTERM', () => stopAll(143));
