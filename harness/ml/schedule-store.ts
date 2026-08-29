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
