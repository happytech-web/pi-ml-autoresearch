#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { tsImport } from 'tsx/esm/api';

const { requestPtyLease } = await tsImport(
  new URL('./ml/pty-lease.ts', import.meta.url).href,
  import.meta.url
);

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

function flagValues(args, name) {
  const values = [];
  const monitorIndex = args.indexOf('--monitor-command');
  const optionArgs = monitorIndex < 0 ? args : args.slice(0, monitorIndex);
  for (let index = 0; index < optionArgs.length - 1; index++) {
    if (optionArgs[index] === `--${name}`) values.push(optionArgs[index + 1]);
  }
  return values;
}

async function readLease(args) {
  const socketIndex = args.indexOf('--lease-socket');
  if (socketIndex < 0) return null;
  const socket = args[socketIndex + 1];
  if (!socket || socket.startsWith('--')) throw new Error('Missing --lease-socket value');
  const probeCommands = flagValues(args, 'probe-command');
  const status = await requestPtyLease(socket, { action: 'status' });
  if (!status.ok) {
    return { socket, state: status.state, error: status.error ?? 'lease status request failed' };
  }
  if (status.state.status !== 'active') {
    return {
      socket,
      state: status.state,
      error: `connection lease is ${status.state.status}; explicit reauthentication is required`,
    };
  }
  const outputs = [];
  for (const command of probeCommands) {
    const response = await requestPtyLease(socket, { action: 'probe', command });
    if (!response.ok) {
      return {
        socket,
        state: response.state,
        error: response.error ?? 'lease probe failed',
        outputs,
      };
    }
    const output = response.output ?? '';
    outputs.push({
      command,
      output:
        output.length > 64 * 1024
          ? `${output.slice(0, 64 * 1024)}\n[lease probe output truncated]`
          : output,
    });
  }
  return { socket, state: status.state, outputs };
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
  let lease;
  try {
    lease = await readLease(args);
  } catch (error) {
    lease = { error: error instanceof Error ? error.message : String(error) };
  }
  const leaseUnavailable = lease?.error !== undefined;
  if (QUIET_STATES.has(health.state) && !leaseUnavailable) {
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
    PI_ML_MONITOR_STATE: leaseUnavailable ? 'unknown' : health.state,
    PI_ML_MONITOR_REASON: leaseUnavailable ? 'connection-lease-unavailable' : health.reason,
    PI_ML_LEASE_SOCKET: lease?.socket ?? '',
    PI_ML_LEASE_STATE: lease?.state?.status ?? 'unavailable',
    PI_ML_LEASE_ERROR: lease?.error ?? '',
    PI_ML_LEASE_OUTPUT: JSON.stringify(lease?.outputs ?? []),
  });
  process.stdout.write(
    `${JSON.stringify({
      invoked: true,
      state: leaseUnavailable ? 'unknown' : health.state,
      reason: leaseUnavailable ? 'connection-lease-unavailable' : health.reason,
      lease: lease ?? undefined,
    })}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
