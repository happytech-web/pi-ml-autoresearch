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

function optionalPositiveNumber(args, name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid --${name}`);
  return value;
}

function signalProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {}
}

function processGroupExists(child) {
  if (!child.pid || process.platform === 'win32') return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function waitForProcessGroupCleanup(child, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (!processGroupExists(child)) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(poll, 25);
    };
    poll();
  });
}

function runCommand(argv, timeoutMs) {
  return new Promise((resolve, reject) => {
    const [executable, ...args] = argv;
    const child = spawn(executable, args, {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: process.platform !== 'win32',
    });
    let timedOut = false;
    let settled = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      signalProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        killTimer = undefined;
        signalProcessGroup(child, 'SIGKILL');
        waitForProcessGroupCleanup(child, 5_000).then((cleaned) =>
          finish(
            new Error(
              cleaned
                ? `monitor runner timed out after ${timeoutMs}ms`
                : `monitor runner timed out after ${timeoutMs}ms; process-group cleanup was not confirmed`
            )
          )
        );
      }, 1_000);
    }, timeoutMs);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Keep the forced group kill alive after a parent exits on SIGTERM.
      if (!timedOut && killTimer) clearTimeout(killTimer);
      if (error) reject(error);
      else resolve();
    };
    child.once('error', (error) => {
      if (!timedOut) finish(error);
    });
    child.once('exit', (code, signal) => {
      if (timedOut) {
        // Defer the timeout result until the forced group kill has been sent.
        return;
      } else if (code === 0) {
        finish();
      } else {
        finish(new Error(`monitor runner exited with ${signal ?? `code ${code ?? 'unknown'}`}`));
      }
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const scheduleFile = path.resolve(flag(args, 'schedule'));
  const commandTimeoutMs = optionalPositiveNumber(args, 'command-timeout-ms', 15 * 60 * 1000);
  const result = await scheduleStore.runDueMonitorSchedule(scheduleFile, Date.now(), () =>
    runCommand(commandArgs(args), commandTimeoutMs)
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.ran && result.runnerError) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
