import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMinimalNotification,
  dispatchNotification,
  establishConnectionLease,
  reuseConnectionLease,
  decideScheduleTick,
  type MinimalNotification,
  type NotificationAdapter,
} from '../monitoring.js';
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
const alertPolicy = { cooldownMs: 10, escalationMs: 20, maxEscalations: 2 };

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function healthyInput(): HealthInput {
  return {
    nowMs: 100,
    campaignId: 'campaign-monitor',
    runId: 'run-1',
    attemptId: 'attempt-1',
    sentinelHeartbeatAtMs: 100,
    executor: { processAlive: true, identityMatches: true },
    progress: {
      runId: 'run-1',
      attemptId: 'attempt-1',
      phase: 'train',
      sequence: 1,
      timestampMs: 100,
      finiteMetrics: true,
    },
    disk: { availableBytes: 1000, availablePercent: 50, availableInodes: 1000 },
  };
}

function healthyObservation() {
  return observeHealth(healthPolicy, healthyInput());
}

describe('monitor control adapters', () => {
  it('reuses a lease without reauthentication until its TTL expires', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lease-'));
    dirs.push(dir);
    const file = path.join(dir, 'lease.json');
    establishConnectionLease(file, 'campaign-monitor', 100, 50);
    expect(reuseConnectionLease(file, 'campaign-monitor', 120).usable).toBe(true);
    expect(reuseConnectionLease(file, 'campaign-monitor', 150)).toEqual({
      usable: false,
      reason: 'reauth-required',
    });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).status).toBe('reauth-required');
  });

  it('rejects a lease belonging to another campaign', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lease-'));
    dirs.push(dir);
    const file = path.join(dir, 'lease.json');
    establishConnectionLease(file, 'campaign-a', 100, 50);
    expect(reuseConnectionLease(file, 'campaign-b', 110)).toEqual({
      usable: false,
      reason: 'campaign-mismatch',
    });
  });

  it('skips overlapping schedule ticks and reports due/catch-up ticks', () => {
    const schedule = {
      campaignId: 'campaign-monitor',
      everyMs: 30,
      nextDueAtMs: 100,
      activeUntilMs: 120,
    };
    expect(decideScheduleTick(110, schedule)).toEqual({ due: false, reason: 'overlap-skip' });
    expect(decideScheduleTick(120, schedule)).toEqual({ due: true, reason: 'due' });
    expect(decideScheduleTick(90, { ...schedule, activeUntilMs: undefined })).toEqual({
      due: false,
      reason: 'not-due',
    });
  });

  it('builds a minimal notification without evidence details or paths', () => {
    const observation = healthyObservation();
    const notification = buildMinimalNotification(observation);
    expect(notification).toMatchObject({
      campaignId: 'campaign-monitor',
      state: 'healthy',
      severity: 'info',
    });
    expect(JSON.stringify(notification)).not.toContain('detail');
  });

  it('dispatches through an injected adapter and records durable ledger state', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-notify-'));
    dirs.push(dir);
    const sent: MinimalNotification[] = [];
    const adapter: NotificationAdapter = { send: async (event) => void sent.push(event) };
    const alertFile = path.join(dir, 'alerts.jsonl');
    const observation = observeHealth(healthPolicy, {
      ...healthyInput(),
      executor: { processAlive: false, identityMatches: false },
    });
    const first = await dispatchNotification(adapter, alertFile, alertPolicy, observation, 100);
    const second = await dispatchNotification(adapter, alertFile, alertPolicy, observation, 105);
    expect(first.sent).toBe(true);
    expect(second.sent).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it('keeps normal healthy probes silent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-notify-'));
    dirs.push(dir);
    const sent: MinimalNotification[] = [];
    const adapter: NotificationAdapter = { send: async (event) => void sent.push(event) };
    const result = await dispatchNotification(
      adapter,
      path.join(dir, 'alerts.jsonl'),
      alertPolicy,
      healthyObservation(),
      100
    );
    expect(result.sent).toBe(false);
    expect(result.decision).toBe('normal');
    expect(sent).toHaveLength(0);
  });
});
