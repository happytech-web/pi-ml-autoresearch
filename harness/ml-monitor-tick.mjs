#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { tsImport } from 'tsx/esm/api';

const scheduleStore = await tsImport(
  new URL('./ml/schedule-store.ts', import.meta.url).href,
  import.meta.url
);

function flag(args, name) {
  const index = args.indexOf(`--${name}`);
  if (index < 0 || !args[index + 1]) throw new Error(`Missing --${name}`);
  return args[index + 1];
}

function commandArgs(args) {
  const index = args.indexOf('--command');
  if (index < 0 || index === args.length - 1) throw new Error('Missing --command');
  return args.slice(index + 1);
}

function runCommand(argv) {
  return new Promise((resolve, reject) => {
    const [executable, ...args] = argv;
    const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`monitor runner exited with ${signal ?? `code ${code ?? 'unknown'}`}`));
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const scheduleFile = path.resolve(flag(args, 'schedule'));
  const result = await scheduleStore.runDueMonitorSchedule(scheduleFile, Date.now(), () =>
    runCommand(commandArgs(args))
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.ran && result.runnerError) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
