#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [specFile, statusFile, workerToken] = process.argv.slice(2);
if (!specFile || !statusFile || !workerToken) {
  process.stderr.write('Usage: ml-worker.mjs <run-spec.json> <status.json> <worker-token>\n');
  process.exit(2);
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
fs.mkdirSync(spec.outputDir, { recursive: true });
const logFile = path.join(spec.outputDir, 'run.log');
const startedAt = new Date().toISOString();
const childToken = randomUUID();

writeJsonAtomic(statusFile, {
  state: 'starting',
  workerPid: process.pid,
  workerIdentity: specFile,
  workerToken,
  childToken,
  startedAt,
  logFile,
});

const commandRunner = fileURLToPath(new URL('./ml-command-runner.mjs', import.meta.url));
const child = spawn(
  process.execPath,
  [commandRunner, specFile, statusFile, String(process.pid), workerToken, childToken],
  {
    cwd: spec.workdir,
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  }
);

let timedOut = false;
let terminating = false;
let finalized = false;
const timeoutMs = Math.max(1, Math.floor(spec.budget.wallClockMinutes * 60_000));
const timeout = setTimeout(() => {
  timedOut = true;
  signalChildTree('SIGTERM');
  setTimeout(() => signalChildTree('SIGKILL'), 5_000).unref();
}, timeoutMs);

function signalChildTree(signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {}
}

function childTreeAlive() {
  if (!child.pid) return false;
  if (process.platform === 'linux') {
    try {
      for (const entry of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
          const fields = stat
            .slice(stat.lastIndexOf(')') + 2)
            .trim()
            .split(/\s+/);
          if (Number(fields[2]) === child.pid && fields[0] !== 'Z') return true;
        } catch {}
      }
      return false;
    } catch {}
  }
  try {
    if (process.platform === 'win32') process.kill(child.pid, 0);
    else process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminateChildTree() {
  signalChildTree('SIGTERM');
  for (let attempt = 0; attempt < 10 && childTreeAlive(); attempt++) await delay(50);
  if (childTreeAlive()) signalChildTree('SIGKILL');
  for (let attempt = 0; attempt < 40 && childTreeAlive(); attempt++) await delay(50);
  return !childTreeAlive();
}

function finishStatus(exitCode, signal, error) {
  if (finalized) return;
  finalized = true;
  clearTimeout(timeout);
  writeJsonAtomic(statusFile, {
    state: 'finished',
    workerPid: process.pid,
    workerIdentity: specFile,
    workerToken,
    childPid: child.pid,
    childIdentity: specFile,
    childToken,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode,
    signal,
    timedOut,
    error,
    logFile,
  });
  process.exitCode = exitCode ?? 1;
}

function terminate(signal) {
  if (terminating) return;
  terminating = true;
  signalChildTree(signal);
  setTimeout(() => signalChildTree('SIGKILL'), 5_000).unref();
}

process.on('SIGTERM', () => terminate('SIGTERM'));
process.on('SIGINT', () => terminate('SIGINT'));

child.once('error', (error) => {
  finishStatus(null, null, error.message);
});

child.once('exit', async (exitCode, signal) => {
  const leftDescendants = childTreeAlive();
  if (leftDescendants && !(await terminateChildTree())) {
    writeJsonAtomic(statusFile, {
      state: 'running',
      workerPid: process.pid,
      workerIdentity: specFile,
      workerToken,
      childPid: child.pid,
      childIdentity: specFile,
      childToken,
      startedAt,
      error: 'Command leader exited but its descendant process group could not be terminated',
      logFile,
    });
    process.exitCode = 1;
    return;
  }
  finishStatus(
    exitCode,
    signal,
    leftDescendants
      ? 'Command leader exited while descendant processes were still running'
      : undefined
  );
});
