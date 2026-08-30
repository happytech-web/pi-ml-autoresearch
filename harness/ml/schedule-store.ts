import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDir, readJson, writeJsonAtomic } from './io.js';
import type { MonitorSchedule } from './monitoring.js';

export type MonitorScheduleStatus = 'active' | 'paused' | 'completed';

export interface PersistedMonitorSchedule {
  schemaVersion: 1;
  revision: number;
  status: MonitorScheduleStatus;
  schedule: MonitorSchedule;
}

export type ScheduleTickResult =
  | { ran: false; reason: 'missing' | 'paused' | 'completed' | 'not-due' | 'overlap-skip' }
  | { ran: true; reason: 'due'; revision: number; runnerError?: string };

function validateSchedule(schedule: MonitorSchedule): void {
  if (!schedule || typeof schedule.campaignId !== 'string' || !schedule.campaignId.trim()) {
    throw new Error('schedule campaignId is required');
  }
  if (!Number.isFinite(schedule.everyMs) || schedule.everyMs <= 0) {
    throw new Error('schedule everyMs must be positive');
  }
  if (!Number.isFinite(schedule.nextDueAtMs)) {
    throw new Error('schedule nextDueAtMs must be finite');
  }
  if (schedule.activeUntilMs !== undefined && !Number.isFinite(schedule.activeUntilMs)) {
    throw new Error('schedule activeUntilMs must be finite');
  }
}

function validatePersisted(value: PersistedMonitorSchedule): void {
  if (value?.schemaVersion !== 1 || !Number.isInteger(value.revision) || value.revision < 0) {
    throw new Error('Invalid persisted monitor schedule');
  }
  if (!['active', 'paused', 'completed'].includes(value.status)) {
    throw new Error('Invalid persisted monitor schedule status');
  }
  if (!value.schedule || typeof value.schedule !== 'object') {
    throw new Error('Invalid persisted monitor schedule');
  }
  validateSchedule(value.schedule);
}

export function readMonitorSchedule(file: string): PersistedMonitorSchedule | null {
  if (!fs.existsSync(file)) return null;
  const value = readJson<PersistedMonitorSchedule>(file);
  validatePersisted(value);
  return value;
}

export function createMonitorSchedule(
  file: string,
  schedule: MonitorSchedule
): PersistedMonitorSchedule {
  if (fs.existsSync(file)) throw new Error(`Monitor schedule already exists: ${file}`);
  validateSchedule(schedule);
  const value: PersistedMonitorSchedule = {
    schemaVersion: 1,
    revision: 0,
    status: 'active',
    schedule,
  };
  ensureDir(path.dirname(file));
  writeJsonAtomic(file, value);
  fs.chmodSync(file, 0o600);
  return value;
}

export function updateMonitorSchedule(
  file: string,
  expectedRevision: number,
  update: (current: PersistedMonitorSchedule) => PersistedMonitorSchedule
): PersistedMonitorSchedule {
  const current = readMonitorSchedule(file);
  if (!current) throw new Error(`Monitor schedule is missing: ${file}`);
  if (current.revision !== expectedRevision) {
    throw new Error(`Monitor schedule revision conflict: expected ${expectedRevision}`);
  }
  const next = update(current);
  validatePersisted(next);
  const persisted = { ...next, revision: current.revision + 1 } as PersistedMonitorSchedule;
  writeJsonAtomic(file, persisted);
  fs.chmodSync(file, 0o600);
  return persisted;
}

async function acquireLock(file: string, timeoutMs = 2_000): Promise<() => void> {
  const lockFile = `${file}.lock`;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const handle = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeFileSync(
        handle,
        JSON.stringify({ pid: process.pid, acquiredAtMs: Date.now() }),
        'utf8'
      );
      fs.fsyncSync(handle);
      return () => {
        fs.closeSync(handle);
        fs.rmSync(lockFile, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) {
        throw new Error(`Could not acquire monitor schedule lock: ${file}`);
      }
      let ownerAlive: boolean | undefined;
      try {
        const owner = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid?: unknown };
        if (typeof owner.pid === 'number' && Number.isInteger(owner.pid) && owner.pid > 0) {
          try {
            process.kill(owner.pid, 0);
            ownerAlive = true;
          } catch (probeError) {
            if ((probeError as NodeJS.ErrnoException).code === 'ESRCH') ownerAlive = false;
            else ownerAlive = true;
          }
        }
      } catch {
        // A partially written lock is not safe to reclaim; fail closed below.
      }
      if (ownerAlive === false) {
        try {
          fs.rmSync(lockFile);
        } catch {}
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

export async function runDueMonitorSchedule(
  file: string,
  nowMs: number,
  runner: () => Promise<void>,
  lockTimeoutMs = 2_000
): Promise<ScheduleTickResult> {
  const release = await acquireLock(file, lockTimeoutMs);
  try {
    const current = readMonitorSchedule(file);
    if (!current) return { ran: false, reason: 'missing' };
    if (current.status === 'paused') return { ran: false, reason: 'paused' };
    if (current.status === 'completed') return { ran: false, reason: 'completed' };
    if (nowMs < current.schedule.nextDueAtMs) return { ran: false, reason: 'not-due' };
    if (current.schedule.activeUntilMs !== undefined && nowMs < current.schedule.activeUntilMs) {
      return { ran: false, reason: 'overlap-skip' };
    }
    const started = updateMonitorSchedule(file, current.revision, (value) => ({
      ...value,
      schedule: { ...value.schedule, activeUntilMs: nowMs + value.schedule.everyMs },
    }));
    let runnerError: string | undefined;
    try {
      await runner();
    } catch (error) {
      runnerError = error instanceof Error ? error.message : String(error);
    }
    const finished = updateMonitorSchedule(file, started.revision, (value) => ({
      ...value,
      schedule: {
        ...value.schedule,
        nextDueAtMs: Math.max(
          value.schedule.nextDueAtMs + value.schedule.everyMs,
          nowMs + value.schedule.everyMs
        ),
        activeUntilMs: undefined,
      },
    }));
    return {
      ran: true,
      reason: 'due',
      revision: finished.revision,
      ...(runnerError ? { runnerError } : {}),
    };
  } finally {
    release();
  }
}
