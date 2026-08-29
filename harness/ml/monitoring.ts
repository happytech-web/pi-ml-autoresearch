import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureDir, readJson, writeJsonAtomic } from './io.js';
import {
  decideAlert,
  appendAlertObservation,
  loadAlertLedger,
  type AlertLedgerEntry,
  type AlertPolicy,
} from './alerts.js';
import type { HealthObservation, HealthSeverity } from './health.js';

export type LeaseStatus = 'active' | 'reauth-required';

export interface ConnectionLease {
  schemaVersion: 1;
  campaignId: string;
  leaseId: string;
  transport: 'background-pty' | 'ssh-control-master';
  createdAtMs: number;
  expiresAtMs: number;
  lastUsedAtMs: number;
  status: LeaseStatus;
}

export function establishConnectionLease(
  file: string,
  campaignId: string,
  nowMs: number,
  ttlMs: number,
  transport: ConnectionLease['transport'] = 'background-pty'
): ConnectionLease {
  if (!campaignId.trim()) throw new Error('campaignId is required');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('lease ttl must be positive');
  const lease: ConnectionLease = {
    schemaVersion: 1,
    campaignId,
    leaseId: randomUUID(),
    transport,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
    lastUsedAtMs: nowMs,
    status: 'active',
  };
  ensureDir(path.dirname(file));
  writeJsonAtomic(file, lease);
  fs.chmodSync(file, 0o600);
  return lease;
}

export function readConnectionLease(file: string): ConnectionLease | null {
  if (!fs.existsSync(file)) return null;
  const lease = readJson<ConnectionLease>(file);
  if (lease.schemaVersion !== 1 || !lease.campaignId || !lease.leaseId) {
    throw new Error('Invalid connection lease');
  }
  return lease;
}

export type LeaseReuseResult =
  | { usable: true; lease: ConnectionLease }
  | { usable: false; reason: 'missing' | 'campaign-mismatch' | 'reauth-required' };

export function reuseConnectionLease(
  file: string,
  campaignId: string,
  nowMs: number
): LeaseReuseResult {
  const lease = readConnectionLease(file);
  if (!lease) return { usable: false, reason: 'missing' };
  if (lease.campaignId !== campaignId) return { usable: false, reason: 'campaign-mismatch' };
  if (lease.status !== 'active' || nowMs >= lease.expiresAtMs) {
    const expired = { ...lease, status: 'reauth-required' as const };
    writeJsonAtomic(file, expired);
    fs.chmodSync(file, 0o600);
    return { usable: false, reason: 'reauth-required' };
  }
  const touched = { ...lease, lastUsedAtMs: nowMs };
  writeJsonAtomic(file, touched);
  fs.chmodSync(file, 0o600);
  return { usable: true, lease: touched };
}

export interface MonitorSchedule {
  campaignId: string;
  everyMs: number;
  nextDueAtMs: number;
  activeUntilMs?: number;
}

export type ScheduleDecision =
  | { due: true; reason: 'due' }
  | { due: false; reason: 'not-due' | 'overlap-skip' };

export function decideScheduleTick(nowMs: number, schedule: MonitorSchedule): ScheduleDecision {
  if (schedule.everyMs <= 0 || !Number.isFinite(schedule.everyMs)) {
    throw new Error('schedule everyMs must be positive');
  }
  if (schedule.activeUntilMs !== undefined && nowMs < schedule.activeUntilMs) {
    return { due: false, reason: 'overlap-skip' };
  }
  return nowMs >= schedule.nextDueAtMs
    ? { due: true, reason: 'due' }
    : { due: false, reason: 'not-due' };
}

export interface MinimalNotification {
  schemaVersion: 1;
  eventId: string;
  campaignId: string;
  runId: string;
  attemptId: string;
  state: HealthObservation['state'];
  severity: HealthSeverity;
  reasonCodes: string[];
  observedAtMs: number;
}

export interface NotificationAdapter {
  send(event: MinimalNotification): Promise<void>;
}

export interface NotificationDeliveryPolicy {
  maxAttempts: number;
  timeoutMs: number;
  backoffMs: number;
}

const defaultNotificationDeliveryPolicy: NotificationDeliveryPolicy = {
  maxAttempts: 1,
  timeoutMs: 30_000,
  backoffMs: 0,
};

export async function deliverNotification(
  adapter: NotificationAdapter,
  event: MinimalNotification,
  policy: NotificationDeliveryPolicy = defaultNotificationDeliveryPolicy,
  sleep: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs))
): Promise<void> {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts <= 0) {
    throw new Error('notification maxAttempts must be a positive integer');
  }
  if (!Number.isFinite(policy.timeoutMs) || policy.timeoutMs <= 0) {
    throw new Error('notification timeoutMs must be positive');
  }
  if (!Number.isFinite(policy.backoffMs) || policy.backoffMs < 0) {
    throw new Error('notification backoffMs must be non-negative');
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('notification delivery timed out')),
          policy.timeoutMs
        );
      });
      await Promise.race([adapter.send(event), timeoutPromise]);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < policy.maxAttempts && policy.backoffMs > 0) {
        await sleep(policy.backoffMs * 2 ** (attempt - 1));
      }
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function buildMinimalNotification(observation: HealthObservation): MinimalNotification {
  const severity: HealthSeverity = observation.evidence.reduce<HealthSeverity>((highest, item) => {
    const rank = { info: 0, warning: 1, critical: 2 } as const;
    return rank[item.severity] > rank[highest] ? item.severity : highest;
  }, 'info');
  return {
    schemaVersion: 1,
    eventId: observation.fingerprint,
    campaignId: observation.campaignId,
    runId: observation.runId,
    attemptId: observation.attemptId,
    state: observation.state,
    severity,
    reasonCodes: [...new Set(observation.evidence.map((item) => item.reasonCode))].sort(),
    observedAtMs: observation.observedAtMs,
  };
}

export async function dispatchNotification(
  adapter: NotificationAdapter,
  alertFile: string,
  alertPolicy: AlertPolicy,
  observation: HealthObservation,
  nowMs: number,
  deliveryPolicy?: NotificationDeliveryPolicy
): Promise<{ sent: boolean; decision: string; ledger: AlertLedgerEntry }> {
  const existing = loadAlertLedger(alertFile).get(observation.fingerprint);
  const decision = decideAlert(alertPolicy, observation, nowMs, existing);
  const notification = buildMinimalNotification(observation);
  if (decision.notify) await deliverNotification(adapter, notification, deliveryPolicy);
  const severity = notification.severity;
  const ledger = appendAlertObservation(
    alertFile,
    observation,
    nowMs,
    decision.notify,
    severity,
    existing
  );
  return { sent: decision.notify, decision: decision.reason, ledger };
}
