import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  finishTrial,
  loadConfig,
  markTrialStarted,
  preflightTrial,
  rejectTrialPreflight,
  snapshot,
  validateTrialSpec,
} from './campaign.js';
import { ensureDir, readJson, writeJsonAtomic } from './io.js';
import type { MlEvent, MlTrialSpec } from './types.js';

export interface WorkerStatus {
  state: 'starting' | 'running' | 'finished';
  workerPid: number;
  workerIdentity?: string;
  workerToken?: string;
  childPid?: number;
  childIdentity?: string;
  childToken?: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  error?: string;
  logFile: string;
}

function runDir(campaignDir: string, runId: string): string {
  return path.join(campaignDir, 'runs', runId);
}

function specPath(campaignDir: string, runId: string): string {
  return path.join(runDir(campaignDir, runId), 'run-spec.json');
}

function statusPath(campaignDir: string, runId: string): string {
  return path.join(runDir(campaignDir, runId), 'status.json');
}

function runGuard(trial: MlTrialSpec): void {
  const head = spawnSync('git', ['-C', trial.workdir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (head.status !== 0 || head.stdout.trim() !== trial.gitSha) {
    throw new Error(`workdir HEAD does not match approved gitSha ${trial.gitSha}`);
  }
  const dirty = spawnSync(
    'git',
    ['-C', trial.workdir, 'status', '--porcelain', '--untracked-files=no'],
    {
      encoding: 'utf8',
      timeout: 30_000,
    }
  );
  if (dirty.status !== 0 || dirty.stdout.trim()) {
    throw new Error('workdir has tracked changes or Git status could not be verified');
  }
  if (!trial.guardCommand) return;
  const result = spawnSync(trial.guardCommand.executable, trial.guardCommand.args ?? [], {
    cwd: trial.workdir,
    encoding: 'utf8',
    timeout: 5 * 60_000,
  });
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(`Guard failed before launch${detail ? `: ${detail}` : ''}`);
  }
}

export function submitLocalTrial(campaignDir: string, trial: MlTrialSpec): MlEvent {
  validateTrialSpec(loadConfig(campaignDir), trial);
  preflightTrial(campaignDir, trial);
  try {
    runGuard(trial);
    const runtimeDir = runDir(campaignDir, trial.runId);
    ensureDir(runtimeDir);
    const workerSpec = specPath(campaignDir, trial.runId);
    const workerStatus = statusPath(campaignDir, trial.runId);
    writeJsonAtomic(workerSpec, trial);
    const started = markTrialStarted(campaignDir, trial);
    const worker = fileURLToPath(new URL('../ml-worker.mjs', import.meta.url));
    const child = spawn(process.execPath, [worker, workerSpec, workerStatus, randomUUID()], {
      cwd: trial.workdir,
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    child.unref();
    return started;
  } catch (error) {
    const state = snapshot(campaignDir);
    const latest = state.latestByTrial.get(trial.trialId);
    const detail = `Preflight or worker launch failed: ${error instanceof Error ? error.message : String(error)}`;
    if (latest?.runId === trial.runId && latest.status === 'preflight') {
      rejectTrialPreflight(campaignDir, trial, detail);
    } else if (latest?.runId === trial.runId && latest.status === 'running') {
      finishTrial(campaignDir, trial.trialId, trial.runId, 'failed', { detail });
    }
    throw error;
  }
}

export function readWorkerStatus(campaignDir: string, runId: string): WorkerStatus | null {
  const file = statusPath(campaignDir, runId);
  return fs.existsSync(file) ? readJson<WorkerStatus>(file) : null;
}

function parseMetrics(
  trial: MlTrialSpec,
  metricName: string
): { primary: number; secondary: Record<string, number> } {
  const payload = readJson<Record<string, unknown>>(trial.metricFile);
  const metric = payload[metricName];
  if (typeof metric !== 'number' || !Number.isFinite(metric)) {
    throw new Error(`Metric file must contain finite numeric key ${metricName}`);
  }
  const secondary = Object.fromEntries(
    Object.entries(payload).filter(
      ([name, value]) => name !== metricName && typeof value === 'number' && Number.isFinite(value)
    )
  ) as Record<string, number>;
  return { primary: metric, secondary };
}

function elapsedGpuHours(status: WorkerStatus, trial: MlTrialSpec): number | undefined {
  if (!status.finishedAt) return undefined;
  const elapsedMs = Date.parse(status.finishedAt) - Date.parse(status.startedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return undefined;
  return (elapsedMs / 3_600_000) * trial.budget.gpuCount;
}

function processTreeAlive(pid: number): boolean {
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
          if (Number(fields[2]) === pid && fields[0] !== 'Z') return true;
        } catch {}
      }
      return false;
    } catch {}
  }
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processIdentityMatches(pid: number, script: string, token: string | undefined): boolean {
  if (!token) return false;
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    result.status === 0 &&
    result.stdout.includes(script) &&
    new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(result.stdout)
  );
}

function processTreeIdentityMatches(pid: number, identity: string, token: string): boolean {
  if (process.platform === 'win32') return false;
  if (processIdentityMatches(pid, 'ml-command-runner.mjs', token)) {
    return true;
  }
  const listing = spawnSync('ps', ['-axo', 'pid=,pgid='], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (listing.status !== 0) return false;
  const members = listing.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => Number(parts[1]) === pid)
    .map((parts) => parts[0])
    .filter((member): member is string => Boolean(member));
  return members.some((member) => {
    const command = spawnSync('ps', ['eww', '-p', member, '-o', 'command='], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return (
      command.status === 0 &&
      new RegExp(`(?:^|\\s)PI_ML_RUN_TOKEN=${escaped}(?:\\s|$)`).test(command.stdout)
    );
  });
}

function terminateProcessTree(
  pid: number,
  identity: string | undefined,
  token: string | undefined
): boolean {
  if (!processTreeAlive(pid)) return true;
  if (!identity || !token || !processTreeIdentityMatches(pid, identity, token)) return false;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGTERM');
  } catch {
    return !processTreeAlive(pid);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  if (processTreeAlive(pid)) {
    try {
      process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
    } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return !processTreeAlive(pid);
}

export function pollLocalTrial(
  campaignDir: string,
  trialId: string
): MlEvent | WorkerStatus | null {
  const state = snapshot(campaignDir);
  const latest = state.latestByTrial.get(trialId);
  if (!latest?.runId) throw new Error(`Unknown trial: ${trialId}`);
  if (latest.status !== 'running') return latest;
  const trial = latest.trial ?? [...state.events].reverse().find((event) => event.trial)?.trial;
  if (!trial || trial.trialId !== trialId) throw new Error(`Missing trial spec for ${trialId}`);

  const status = readWorkerStatus(campaignDir, latest.runId);
  if (!status) {
    const ageMs = Date.now() - Date.parse(latest.timestamp);
    if (Number.isFinite(ageMs) && ageMs > 30_000) {
      return finishTrial(campaignDir, trialId, latest.runId, 'failed', {
        detail: 'Worker did not create a status file within 30 seconds',
      });
    }
    return null;
  }
  if (status.state !== 'finished') {
    const ageMs = Date.now() - Date.parse(status.startedAt);
    if (!processIdentityMatches(status.workerPid, 'ml-worker.mjs', status.workerToken)) {
      if (status.state === 'starting' && !status.childPid) {
        if (ageMs <= 30_000) return status;
        throw new Error(
          'Worker exited before persisting process-group identity; trial remains running until operator recovery'
        );
      }
      if (
        status.childPid &&
        !terminateProcessTree(status.childPid, status.childIdentity, status.childToken)
      ) {
        throw new Error('Worker exited and its orphaned process tree could not be terminated');
      }
      return finishTrial(campaignDir, trialId, latest.runId, 'failed', {
        detail:
          status.error ?? `Worker exited before recording terminal status: pid=${status.workerPid}`,
      });
    }
    return status;
  }
  const gpuHours = elapsedGpuHours(status, trial);

  if (status.exitCode !== 0 || status.timedOut || status.error) {
    return finishTrial(campaignDir, trialId, latest.runId, 'failed', {
      gpuHours,
      detail: status.timedOut
        ? 'Local runner exceeded wall-clock budget'
        : `Local runner failed: ${status.error ?? `exit=${status.exitCode} signal=${status.signal ?? ''}`}`,
    });
  }

  try {
    const metrics = parseMetrics(trial, state.config.primaryMetric.name);
    return finishTrial(
      campaignDir,
      trialId,
      latest.runId,
      trial.phase === 'pilot' ? 'pilot-complete' : 'completed',
      {
        metric: metrics.primary,
        secondaryMetrics: metrics.secondary,
        gpuHours,
        detail: 'Strict primary metric parsed from metricFile',
      }
    );
  } catch (error) {
    return finishTrial(campaignDir, trialId, latest.runId, 'invalid', {
      gpuHours,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

export function cancelLocalTrial(campaignDir: string, trialId: string): MlEvent {
  const state = snapshot(campaignDir);
  const latest = state.latestByTrial.get(trialId);
  if (!latest?.runId) throw new Error('Unknown trial');
  if (latest.status === 'preflight' && latest.trial) {
    return rejectTrialPreflight(
      campaignDir,
      latest.trial,
      'Preflight reservation cancelled by operator before worker launch'
    );
  }
  if (latest.status !== 'running') throw new Error('Trial is not running');
  let status = readWorkerStatus(campaignDir, latest.runId);
  for (let attempt = 0; !status && attempt < 40; attempt++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    status = readWorkerStatus(campaignDir, latest.runId);
  }
  if (!status?.workerPid)
    throw new Error('Worker status is not available; cancellation was not recorded');
  if (!processIdentityMatches(status.workerPid, 'ml-worker.mjs', status.workerToken)) {
    if (
      !status.childPid ||
      !terminateProcessTree(status.childPid, status.childIdentity, status.childToken)
    ) {
      throw new Error('Worker identity is stale and its child tree could not be safely stopped');
    }
    return finishTrial(campaignDir, trialId, latest.runId, 'abandoned', {
      gpuHours: elapsedGpuHours(status, latest.trial!),
      detail: 'Cancelled orphaned child process tree after worker exit',
    });
  }
  process.kill(status.workerPid, 'SIGTERM');
  for (let attempt = 0; status.state !== 'finished' && attempt < 140; attempt++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    status = readWorkerStatus(campaignDir, latest.runId) ?? status;
  }
  if (status.state !== 'finished') {
    throw new Error('Worker termination was not confirmed; trial remains running in the ledger');
  }
  return finishTrial(campaignDir, trialId, latest.runId, 'abandoned', {
    gpuHours: elapsedGpuHours(status, latest.trial!),
    detail: `Cancelled by operator and worker exit confirmed (signal=${status.signal ?? 'none'}; cleanup=${status.error ?? 'none'})`,
  });
}
