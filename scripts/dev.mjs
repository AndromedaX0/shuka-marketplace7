import { spawn } from 'node:child_process';

const children = [
  {
    name: 'API',
    process: spawn(process.execPath, ['--import', 'tsx', '--watch', 'server/src/index.ts'], {
      stdio: 'inherit',
    }),
  },
  {
    name: 'WEB',
    process: spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '0.0.0.0'], {
      stdio: 'inherit',
    }),
  },
];

let stopping = false;
const stopChildren = () => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.process.kill('SIGTERM');
};

for (const child of children) {
  child.process.on('error', error => {
    console.error(`${child.name} could not start:`, error);
    process.exitCode = 1;
    stopChildren();
  });
  child.process.on('exit', code => {
    if (!stopping) {
      process.exitCode = code ?? 1;
      stopChildren();
    }
  });
}

process.once('SIGINT', stopChildren);
process.once('SIGTERM', stopChildren);
