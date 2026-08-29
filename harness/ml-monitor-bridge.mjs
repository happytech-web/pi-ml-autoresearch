#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const QUIET_STATES = new Set(['healthy', 'completed', 'recovered']);

function requiredFlag(args, name) {
  const index = args.indexOf(`--${name}`);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error(`Missing --${name}`);
  }
  return args[index + 1];
}

function monitorCommand(args) {
  const index = args.indexOf('--monitor-command');
  if (index < 0 || index === args.length - 1) return [];
  return args.slice(index + 1);
}

function readHealth(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof value?.state !== 'string' || !value.state) {
      return { state: 'unknown', reason: 'health-state-missing' };
    }
    return {
      state: value.state,
      reason:
        Array.isArray(value.evidence) && value.evidence[0]?.reasonCode
          ? String(value.evidence[0].reasonCode)
          : 'health-state-not-healthy',
    };
  } catch {
    return { state: 'unknown', reason: 'health-input-unavailable' };
  }
}

function runCommand(argv, env) {
  return new Promise((resolve, reject) => {
    const [executable, ...args] = argv;
    const child = spawn(executable, args, { env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`monitor command exited with ${signal ?? `code ${code ?? 'unknown'}`}`));
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const campaign = path.resolve(requiredFlag(args, 'campaign'));
  const healthFile = path.resolve(requiredFlag(args, 'health'));
  const health = readHealth(healthFile);
  if (QUIET_STATES.has(health.state)) {
    process.stdout.write(
      `${JSON.stringify({ invoked: false, state: health.state, reason: 'normal-health' })}\n`
    );
    return;
  }

  const command = monitorCommand(args);
  if (command.length === 0) throw new Error('Missing --monitor-command for abnormal health');
  await runCommand(command, {
    ...process.env,
    PI_ML_MONITOR_CAMPAIGN: campaign,
    PI_ML_MONITOR_HEALTH: healthFile,
    PI_ML_MONITOR_STATE: health.state,
    PI_ML_MONITOR_REASON: health.reason,
  });
  process.stdout.write(
    `${JSON.stringify({ invoked: true, state: health.state, reason: health.reason })}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
