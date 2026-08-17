#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [specFile, statusFile, workerPidText, workerToken, childToken] = process.argv.slice(2);
if (!specFile || !statusFile || !workerPidText || !workerToken || !childToken) {
  process.stderr.write(
    'Usage: ml-command-runner.mjs <run-spec.json> <status.json> <worker-pid> <worker-token> <child-token>\n'
  );
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
const log = fs.openSync(logFile, 'a');
const startedAt = new Date().toISOString();

// Persist the process-group identity before any training process can start.
writeJsonAtomic(statusFile, {
  state: 'running',
  workerPid: Number(workerPidText),
  workerIdentity: specFile,
  workerToken,
  childPid: process.pid,
  childIdentity: specFile,
  childToken,
  startedAt,
  logFile,
});

const child = spawn(spec.command.executable, spec.command.args ?? [], {
  cwd: spec.workdir,
  env: {
    ...process.env,
    PI_ML_TRIAL_ID: spec.trialId,
    PI_ML_RUN_ID: spec.runId,
    PI_ML_OUTPUT_DIR: spec.outputDir,
    PI_ML_METRIC_FILE: spec.metricFile,
    PI_ML_STEP_LIMIT: String(spec.budget.stepLimit),
    PI_ML_RUN_TOKEN: childToken,
  },
  stdio: ['ignore', log, log],
});

child.once('error', (error) => {
  fs.writeSync(log, `Command spawn failed: ${error.message}\n`);
  fs.closeSync(log);
  process.exitCode = 1;
});

child.once('exit', (exitCode, signal) => {
  fs.closeSync(log);
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = exitCode ?? 1;
});
