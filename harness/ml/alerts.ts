import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendLine, ensureDir } from './io.js';
import type { HealthObservation, HealthSeverity } from './health.js';

export interface AlertPolicy {
  cooldownMs: number;
  escalationMs: number;
  maxEscalations: number;
}

export interface AlertLedgerEntry {
  schemaVersion: 1;
  fingerprint: string;
  campaignId: string;
  runId: string;
  attemptId: string;
  state: HealthObservation['state'];
  severity: HealthSeverity;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  lastNotifiedAtMs?: number;
  notificationCount: number;
  acked: boolean;
}

export type AlertDecision =
  | {
      notify: true;
      reason: 'new' | 'severity-upgraded' | 'escalation-due' | 'recovered' | 'completed';
    }
  | { notify: false; reason: 'cooldown' | 'escalation-limit' | 'acked' };

const severityRank: Record<HealthSeverity, number> = { info: 0, warning: 1, critical: 2 };

function readEntries(file: string): AlertLedgerEntry[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AlertLedgerEntry);
}

export function decideAlert(
  policy: AlertPolicy,
  observation: HealthObservation,
  nowMs: number,
  existing?: AlertLedgerEntry
): AlertDecision {
  if (!existing) return { notify: true, reason: 'new' };
  if (existing.fingerprint !== observation.fingerprint) return { notify: true, reason: 'new' };
  const currentSeverity = observation.evidence.reduce<HealthSeverity>(
    (highest, item) =>
      severityRank[item.severity] > severityRank[highest] ? item.severity : highest,
    'info'
  );
  if (observation.state === 'recovered') return { notify: true, reason: 'recovered' };
  if (observation.state === 'completed') return { notify: true, reason: 'completed' };
  if (existing.acked) return { notify: false, reason: 'acked' };
  if (severityRank[currentSeverity] > severityRank[existing.severity]) {
    return { notify: true, reason: 'severity-upgraded' };
  }
  const lastNotified = existing.lastNotifiedAtMs ?? existing.firstSeenAtMs;
  if (nowMs - lastNotified < policy.cooldownMs) return { notify: false, reason: 'cooldown' };
  if (existing.notificationCount >= policy.maxEscalations + 1) {
    return { notify: false, reason: 'escalation-limit' };
  }
  if (nowMs - lastNotified >= policy.escalationMs)
    return { notify: true, reason: 'escalation-due' };
  return { notify: false, reason: 'cooldown' };
}

export function loadAlertLedger(file: string): Map<string, AlertLedgerEntry> {
  const latest = new Map<string, AlertLedgerEntry>();
  for (const entry of readEntries(file)) latest.set(entry.fingerprint, entry);
  return latest;
}

export function appendAlertObservation(
  file: string,
  observation: HealthObservation,
  nowMs: number,
  notified: boolean,
  severity: HealthSeverity,
  previous?: AlertLedgerEntry
): AlertLedgerEntry {
  const entry: AlertLedgerEntry = {
    schemaVersion: 1,
    fingerprint: observation.fingerprint,
    campaignId: observation.campaignId,
    runId: observation.runId,
    attemptId: observation.attemptId,
    state: observation.state,
    severity,
    firstSeenAtMs: previous?.firstSeenAtMs ?? nowMs,
    lastSeenAtMs: nowMs,
    lastNotifiedAtMs: notified ? nowMs : previous?.lastNotifiedAtMs,
    notificationCount: (previous?.notificationCount ?? 0) + (notified ? 1 : 0),
    acked: previous?.acked ?? false,
  };
  ensureDir(path.dirname(file));
  appendLine(file, JSON.stringify(entry));
  return entry;
}
