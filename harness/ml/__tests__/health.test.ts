import { describe, expect, it } from 'vitest';
import { observeHealth, type HealthPolicy, type HealthInput } from '../health.js';

const policy: HealthPolicy = {
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

function input(overrides: Partial<HealthInput> = {}): HealthInput {
  return {
    nowMs: 100,
    campaignId: 'campaign-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    sentinelHeartbeatAtMs: 100,
    executor: { processAlive: true, identityMatches: true },
    progress: {
      runId: 'run-1',
      attemptId: 'attempt-1',
      phase: 'train',
      step: 10,
      sequence: 10,
      timestampMs: 100,
      finiteMetrics: true,
    },
    disk: { availableBytes: 1000, availablePercent: 50, availableInodes: 1000 },
    ...overrides,
  };
}

describe('deterministic ML health observation', () => {
  it('reports healthy only with fresh, identity-matched evidence', () => {
    const result = observeHealth(policy, input());
    expect(result.state).toBe('healthy');
    expect(result.evidence).toHaveLength(0);
    expect(result.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('does not treat a dead executor as completed', () => {
    const result = observeHealth(
      policy,
      input({ executor: { processAlive: false, identityMatches: false }, terminal: undefined })
    );
    expect(result.state).toBe('failed');
    expect(result.evidence.map((item) => item.reasonCode)).toContain('executor-not-running');
  });

  it('accepts an explicitly verified stopped executor for a complete run', () => {
    const result = observeHealth(
      policy,
      input({
        executor: { processAlive: false, identityMatches: false, expectedStopped: true },
        terminal: {
          contractVerified: true,
          artifactsVerified: true,
          reconcileVerified: true,
          allRanksExited: true,
        },
      })
    );
    expect(result.state).toBe('completed');
    expect(result.evidence).toHaveLength(0);
  });

  it('fails closed when expectedStopped contradicts executor liveness', () => {
    const result = observeHealth(
      policy,
      input({ executor: { processAlive: true, identityMatches: true, expectedStopped: true } })
    );
    expect(result.state).toBe('unknown');
    expect(result.evidence.map((item) => item.reasonCode)).toContain('observation-unavailable');
  });

  it('fails on explicit fatal signatures and non-finite metrics', () => {
    const result = observeHealth(
      policy,
      input({
        fatalSignatures: ['CUDA out of memory'],
        progress: { ...input().progress!, finiteMetrics: false },
      })
    );
    expect(result.state).toBe('failed');
    expect(result.evidence.map((item) => item.reasonCode)).toEqual(
      expect.arrayContaining(['fatal-signature', 'nan-or-inf'])
    );
  });

  it('escalates stale progress only after confirmation probes', () => {
    const warning = observeHealth(
      policy,
      input({ progress: { ...input().progress!, timestampMs: 80 } })
    );
    expect(warning.state).toBe('degraded');
    const failed = observeHealth(
      policy,
      input({
        progress: { ...input().progress!, timestampMs: 80 },
        staleProbeCount: 2,
      })
    );
    expect(failed.state).toBe('failed');
  });

  it('uses the stricter bytes/percent/inode disk thresholds', () => {
    const result = observeHealth(
      policy,
      input({ disk: { availableBytes: 1000, availablePercent: 1, availableInodes: 10 } })
    );
    expect(result.state).toBe('failed');
    expect(result.evidence.map((item) => item.reasonCode)).toEqual(
      expect.arrayContaining(['disk-headroom-critical', 'inode-headroom-critical'])
    );
  });

  it('returns unknown when required observations are unavailable', () => {
    const result = observeHealth(
      policy,
      input({
        sentinelHeartbeatAtMs: undefined,
        progress: undefined,
        disk: undefined,
        executor: { processAlive: true, identityMatches: true },
      })
    );
    expect(result.state).toBe('unknown');
    expect(result.evidence.map((item) => item.reasonCode)).toEqual(
      expect.arrayContaining(['sentinel-heartbeat-stale', 'observation-unavailable'])
    );
  });

  it('fails closed for malformed runtime observations', () => {
    const malformedDisk = observeHealth(
      policy,
      input({ disk: { availableBytes: Number.NaN, availablePercent: 50, availableInodes: 1000 } })
    );
    expect(malformedDisk.state).toBe('unknown');
    expect(malformedDisk.evidence.map((item) => item.reasonCode)).toContain(
      'observation-unavailable'
    );

    const missingExecutor = observeHealth(
      policy,
      input({ executor: undefined as unknown as HealthInput['executor'] })
    );
    expect(missingExecutor.state).toBe('unknown');
    expect(missingExecutor.evidence.map((item) => item.reasonCode)).toContain(
      'observation-unavailable'
    );
  });

  it('rejects malformed health policy and progress timestamps', () => {
    expect(() =>
      observeHealth({ ...policy, stale: { warningMs: 20, confirmationMs: 10 } }, input())
    ).toThrow('confirmationMs must be >= stale.warningMs');
    expect(() =>
      observeHealth(
        { ...policy, disk: { ...policy.disk, criticalBytes: Number.POSITIVE_INFINITY } },
        input()
      )
    ).toThrow('finite numbers');

    const malformedProgress = observeHealth(
      policy,
      input({ progress: { ...input().progress!, timestampMs: Number.NaN } })
    );
    expect(malformedProgress.state).toBe('unknown');
    expect(malformedProgress.evidence.map((item) => item.reasonCode)).toContain(
      'observation-unavailable'
    );
  });

  it('requires terminal contract, artifacts, reconcile, and rank exit for completed', () => {
    const result = observeHealth(
      policy,
      input({
        terminal: {
          contractVerified: true,
          artifactsVerified: true,
          reconcileVerified: true,
          allRanksExited: true,
        },
      })
    );
    expect(result.state).toBe('completed');
    expect(result.evidence).toEqual([]);
  });

  it('emits recovered as a transition event after degraded/unknown', () => {
    const result = observeHealth(policy, input(), 'degraded');
    expect(result.state).toBe('recovered');
    expect(result.evidence.map((item) => item.reasonCode)).toContain('progress-restored');
  });

  it('fingerprints equivalent evidence independent of evidence order', () => {
    const first = observeHealth(policy, input({ fatalSignatures: ['OOM', 'NCCL error'] }));
    const second = observeHealth(policy, input({ fatalSignatures: ['NCCL error', 'OOM'] }));
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('keeps a stable fingerprint while stale elapsed evidence changes', () => {
    const first = observeHealth(
      policy,
      input({ progress: { ...input().progress!, timestampMs: 80 } })
    );
    const second = observeHealth(
      { ...policy, stale: { warningMs: 5, confirmationMs: 50 } },
      input({ progress: { ...input().progress!, timestampMs: 70 } })
    );
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.evidence.find((item) => item.reasonCode === 'progress-stale')?.detail).not.toBe(
      second.evidence.find((item) => item.reasonCode === 'progress-stale')?.detail
    );
  });
});
