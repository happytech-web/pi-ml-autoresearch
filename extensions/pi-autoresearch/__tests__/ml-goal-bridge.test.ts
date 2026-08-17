import { describe, expect, it, vi } from 'vitest';
import {
  buildGoalObjective,
  buildGoalRunId,
  goalEventChannel,
  isGoalRunEvent,
  isTerminalGoalEvent,
} from '../../pi-ml-autoresearch/goal-bridge.js';
import type { MlSearchConfig } from '../../../harness/ml/types.js';

function config(): MlSearchConfig {
  return {
    schemaVersion: 1,
    experimentId: 'exp/lr search',
    searchRevision: 'rev 1',
    approval: 'approved',
    agentLevel: 1,
    primaryMetric: { name: 'val_loss', direction: 'lower' },
    budget: {
      maxTrials: 3,
      maxParallel: 1,
      maxGpuHours: 3,
      maxWallClockMinutes: 60,
      maxFailures: 1,
      maxRetriesPerTrial: 1,
    },
    approvedTrials: [{ trialId: 'trial-1', contractHash: `sha256:${'a'.repeat(64)}` }],
    paths: { trialsMarkdown: '../TRIALS.md', outputRoot: '/tmp/outputs' },
  };
}

describe('pi-goal bridge contract', () => {
  it('builds a valid bounded run id and objective', () => {
    vi.spyOn(Date, 'now').mockReturnValue(123);
    const runId = buildGoalRunId(config());
    expect(runId).toBe('ml-exp-lr-search-rev-1-123');
    expect(goalEventChannel(runId)).toBe(`pi-goal:event:${runId}`);
    const objective = buildGoalObjective('/tmp/campaign', config());
    expect(objective).toContain('Do not expand candidates');
    expect(objective).toContain('Stop at promotion');
    expect(objective).toContain('3 trials');
    vi.restoreAllMocks();
  });

  it('recognizes fallback errors and terminal states', () => {
    const error = {
      type: 'error',
      runId: 'run-1',
      operation: 'start',
      error: { code: 'RPC_DISABLED', message: 'disabled' },
    };
    expect(isGoalRunEvent(error)).toBe(true);
    expect(isTerminalGoalEvent(error)).toBe(true);
    expect(
      isTerminalGoalEvent({ type: 'state', runId: 'run-1', goalId: 'g', status: 'active' })
    ).toBe(false);
    expect(
      isTerminalGoalEvent({ type: 'state', runId: 'run-1', goalId: 'g', status: 'complete' })
    ).toBe(true);
  });
});
