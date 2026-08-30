import { describe, expect, it } from 'vitest';
import { readHealthInput, validateHealthInputPayload } from '../health-adapter.js';
import type { HealthInput } from '../health.js';

function validInput(): HealthInput {
  return {
    nowMs: 0,
    campaignId: 'campaign-adapter',
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

describe('project health input adapter contract', () => {
  it('validates the required identity and observation schema', async () => {
    const source = validInput();
    let clock = 1234;
    const result = await readHealthInput(
      { read: async () => source },
      { campaignId: 'campaign-adapter', runId: 'run-1', attemptId: 'attempt-1' },
      () => clock
    );
    expect(result.nowMs).toBe(1234);
    clock = 5678;
    expect(
      (
        await readHealthInput(
          { read: () => source },
          { campaignId: 'campaign-adapter', runId: 'run-1', attemptId: 'attempt-1' },
          () => clock
        )
      ).nowMs
    ).toBe(5678);
  });

  it('rejects stale or cross-run identity and malformed observations', async () => {
    expect(() =>
      validateHealthInputPayload({
        ...validInput(),
        progress: { ...validInput().progress!, sequence: -1 },
      })
    ).toThrow('sequence');
    expect(() =>
      validateHealthInputPayload({
        ...validInput(),
        disk: { ...validInput().disk!, availableBytes: Number.NaN },
      })
    ).toThrow('availableBytes');
    await expect(
      readHealthInput(
        { read: () => ({ ...validInput(), runId: 'old-run' }) },
        { campaignId: 'campaign-adapter', runId: 'run-1', attemptId: 'attempt-1' },
        () => 123
      )
    ).rejects.toThrow('identity does not match');
  });

  it('does not accept an invalid adapter clock', async () => {
    await expect(
      readHealthInput(
        { read: () => validInput() },
        { campaignId: 'campaign-adapter', runId: 'run-1', attemptId: 'attempt-1' },
        () => Number.POSITIVE_INFINITY
      )
    ).rejects.toThrow('clock must return a finite number');
  });

  it('requires expectedStopped to describe an actually stopped executor', async () => {
    await expect(
      readHealthInput(
        {
          read: () => ({
            ...validInput(),
            executor: { processAlive: true, identityMatches: true, expectedStopped: true },
          }),
        },
        { campaignId: 'campaign-adapter', runId: 'run-1', attemptId: 'attempt-1' }
      )
    ).rejects.toThrow('expectedStopped requires processAlive false');
  });
});
