import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendAlertObservation,
  decideAlert,
  loadAlertLedger,
  type AlertPolicy,
} from '../alerts.js';
import { observeHealth, type HealthInput, type HealthPolicy } from '../health.js';

const dirs: string[] = [];
const healthPolicy: HealthPolicy = {
  stale: { warningMs: 10, confirmationMs: 20 },
  disk: {
    warningBytes: 100,
    criticalBytes: 20,
    warningPercent: 10,
    criticalPercent: 2,
    warningInodes: 100,
    criticalInodes: 20,
  },
  sentinelHeartbeatMaxAgeMs: 10,
};
const alertPolicy: AlertPolicy = { cooldownMs: 10, escalationMs: 20, maxEscalations: 2 };

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function observation(nowMs = 100, fatalSignatures?: string[]) {
  const input: HealthInput = {
    nowMs,
    campaignId: 'campaign-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    sentinelHeartbeatAtMs: nowMs,
    executor: { processAlive: true, identityMatches: true },
    progress: {
      runId: 'run-1',
      attemptId: 'attempt-1',
      phase: 'train',
      sequence: 1,
      timestampMs: nowMs,
      finiteMetrics: true,
    },
    disk: { availableBytes: 1000, availablePercent: 50, availableInodes: 1000 },
    fatalSignatures,
  };
  return observeHealth(healthPolicy, input);
}

describe('durable alert ledger decisions', () => {
  it('notifies once for a new fingerprint and suppresses cooldown repeats', () => {
    const first = observation(100, ['OOM']);
    expect(decideAlert(alertPolicy, first, 100)).toEqual({ notify: true, reason: 'new' });
    const entry = {
      schemaVersion: 1 as const,
      fingerprint: first.fingerprint,
      campaignId: first.campaignId,
      runId: first.runId,
      attemptId: first.attemptId,
      state: first.state,
      severity: 'critical' as const,
      firstSeenAtMs: 100,
      lastSeenAtMs: 100,
      lastNotifiedAtMs: 100,
      notificationCount: 1,
      acked: false,
    };
    expect(decideAlert(alertPolicy, first, 105, entry)).toEqual({
      notify: false,
      reason: 'cooldown',
    });
  });

  it('allows finite escalation after cooldown and then stops', () => {
    const first = observation(100, ['OOM']);
    let entry = {
      schemaVersion: 1 as const,
      fingerprint: first.fingerprint,
      campaignId: first.campaignId,
      runId: first.runId,
      attemptId: first.attemptId,
      state: first.state,
      severity: 'critical' as const,
      firstSeenAtMs: 100,
      lastSeenAtMs: 100,
      lastNotifiedAtMs: 100,
      notificationCount: 1,
      acked: false,
    };
    expect(decideAlert(alertPolicy, first, 120, entry)).toEqual({
      notify: true,
      reason: 'escalation-due',
    });
    entry = { ...entry, lastNotifiedAtMs: 120, notificationCount: 3 };
    expect(decideAlert(alertPolicy, first, 200, entry)).toEqual({
      notify: false,
      reason: 'escalation-limit',
    });
  });

  it('notifies severity upgrades even inside cooldown', () => {
    const warning = observation(100);
    const failed = {
      ...observation(101, ['CUDA out of memory']),
      fingerprint: warning.fingerprint,
    };
    const entry = {
      schemaVersion: 1 as const,
      fingerprint: warning.fingerprint,
      campaignId: warning.campaignId,
      runId: warning.runId,
      attemptId: warning.attemptId,
      state: warning.state,
      severity: 'warning' as const,
      firstSeenAtMs: 100,
      lastSeenAtMs: 100,
      lastNotifiedAtMs: 100,
      notificationCount: 1,
      acked: false,
    };
    expect(decideAlert(alertPolicy, failed, 101, entry)).toEqual({
      notify: true,
      reason: 'severity-upgraded',
    });
  });

  it('treats a different fingerprint as a new event', () => {
    const first = observation(100, ['OOM']);
    const second = observation(101, ['NCCL error']);
    const entry = {
      schemaVersion: 1 as const,
      fingerprint: first.fingerprint,
      campaignId: first.campaignId,
      runId: first.runId,
      attemptId: first.attemptId,
      state: first.state,
      severity: 'critical' as const,
      firstSeenAtMs: 100,
      lastSeenAtMs: 100,
      lastNotifiedAtMs: 100,
      notificationCount: 1,
      acked: false,
    };
    expect(decideAlert(alertPolicy, second, 101, entry)).toEqual({ notify: true, reason: 'new' });
  });

  it('persists latest entries for session restart recovery', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-alert-ledger-'));
    dirs.push(dir);
    const file = path.join(dir, 'alerts.jsonl');
    const first = observation(100, ['OOM']);
    const entry = appendAlertObservation(file, first, 100, true, 'critical');
    appendAlertObservation(file, first, 105, false, 'critical', entry);
    expect(loadAlertLedger(file).get(first.fingerprint)?.lastSeenAtMs).toBe(105);
  });
});
