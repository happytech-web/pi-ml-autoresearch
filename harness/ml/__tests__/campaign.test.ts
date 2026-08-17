import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  finishTrial,
  initCampaign,
  markTrialStarted,
  preflightTrial,
  reconcileCampaign,
  snapshot,
  trialContractHash,
} from '../campaign.js';
import type { MlSearchConfig, MlTrialSpec } from '../types.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(): { campaignDir: string; config: MlSearchConfig; trial: MlTrialSpec } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ml-campaign-'));
  dirs.push(root);
  const campaignDir = path.join(root, 'campaign');
  const workdir = path.join(root, 'work');
  const outputDir = path.join(root, 'outputs', 'trial-1');
  fs.mkdirSync(workdir, { recursive: true });
  const trial: MlTrialSpec = {
    schemaVersion: 1,
    trialId: 'trial-1',
    runId: 'run-1',
    searchRevision: 'rev-1',
    phase: 'pilot',
    seed: 7,
    configHash: `sha256:${'b'.repeat(64)}`,
    gitSha: 'a'.repeat(40),
    workdir,
    outputDir,
    command: { executable: 'true' },
    metricFile: path.join(outputDir, 'metric.json'),
    dataset: 'dataset-v1',
    split: 'validation-v1',
    budget: { stepLimit: 100, wallClockMinutes: 10, gpuCount: 1, gpuHours: 0.5 },
  };
  const config: MlSearchConfig = {
    schemaVersion: 1,
    experimentId: 'exp-lr',
    searchRevision: 'rev-1',
    approval: 'approved',
    agentLevel: 1,
    primaryMetric: { name: 'val_loss', direction: 'lower', minimumMeaningfulImprovement: 0.01 },
    budget: {
      maxTrials: 2,
      maxParallel: 1,
      maxGpuHours: 2,
      maxWallClockMinutes: 30,
      maxFailures: 2,
      maxRetriesPerTrial: 1,
    },
    approvedTrials: [{ trialId: trial.trialId, contractHash: trialContractHash(trial) }],
    paths: { trialsMarkdown: '../TRIALS.md', outputRoot: path.join(root, 'outputs') },
  };
  return { campaignDir, config, trial };
}

describe('ML campaign state', () => {
  it('initializes an approved revision and reconciles JSONL with TRIALS.md', () => {
    const { campaignDir, config } = fixture();
    initCampaign(campaignDir, config);
    expect(snapshot(campaignDir).config.searchRevision).toBe('rev-1');
    expect(reconcileCampaign(campaignDir)).toEqual({
      ok: true,
      missingEventIds: [],
      extraEventIds: [],
    });
  });

  it('enforces preflight before a finite-metric terminal state', () => {
    const { campaignDir, config, trial } = fixture();
    initCampaign(campaignDir, config);
    expect(() => markTrialStarted(campaignDir, trial)).toThrow('pass preflight');
    preflightTrial(campaignDir, trial);
    markTrialStarted(campaignDir, trial);
    expect(() => finishTrial(campaignDir, trial.trialId, trial.runId, 'pilot-complete')).toThrow(
      'finite primary metric'
    );
    finishTrial(campaignDir, trial.trialId, trial.runId, 'pilot-complete', { metric: 0.42 });
    expect(snapshot(campaignDir).latestByTrial.get(trial.trialId)?.metric).toBe(0.42);
    expect(reconcileCampaign(campaignDir).ok).toBe(true);
  });

  it('blocks mismatched revisions, GPU budget overflow, and duplicate active trials', () => {
    const { campaignDir, config, trial } = fixture();
    initCampaign(campaignDir, config);
    expect(() => preflightTrial(campaignDir, { ...trial, searchRevision: 'rev-2' })).toThrow(
      'does not match approved'
    );
    const expensive = { ...trial, budget: { ...trial.budget, gpuHours: 3 } };
    config.approvedTrials[0]!.contractHash = trialContractHash(expensive);
    fs.writeFileSync(path.join(campaignDir, 'search.json'), `${JSON.stringify(config, null, 2)}\n`);
    expect(() => snapshot(campaignDir)).toThrow('immutable revision');
  });

  it('blocks duplicate active trials within the parallelism ceiling', () => {
    const { campaignDir, config, trial } = fixture();
    initCampaign(campaignDir, config);
    preflightTrial(campaignDir, trial);
    expect(() => preflightTrial(campaignDir, { ...trial, runId: 'run-2' })).toThrow(
      'parallelism ceiling'
    );
  });

  it('counts preflight reservations against the GPU-hour ceiling', () => {
    const { campaignDir, config, trial } = fixture();
    const second = {
      ...trial,
      trialId: 'trial-2',
      runId: 'run-2',
      outputDir: `${trial.outputDir}-2`,
      metricFile: `${trial.outputDir}-2/metric.json`,
      budget: { ...trial.budget, gpuHours: 0.75 },
    };
    const first = { ...trial, budget: { ...trial.budget, gpuHours: 0.75 } };
    config.budget.maxParallel = 2;
    config.budget.maxGpuHours = 1;
    config.approvedTrials = [
      { trialId: first.trialId, contractHash: trialContractHash(first) },
      { trialId: second.trialId, contractHash: trialContractHash(second) },
    ];
    initCampaign(campaignDir, config);
    preflightTrial(campaignDir, first);
    expect(() => preflightTrial(campaignDir, second)).toThrow('GPU-hour ceiling');
  });

  it('allows one explicit retry of a failed run and preserves run identity', () => {
    const { campaignDir, config, trial } = fixture();
    initCampaign(campaignDir, config);
    preflightTrial(campaignDir, trial);
    markTrialStarted(campaignDir, trial);
    finishTrial(campaignDir, trial.trialId, trial.runId, 'failed', { detail: 'preempted' });

    const retry = {
      ...trial,
      runId: 'run-2',
      retryOfRunId: 'run-1',
      outputDir: `${trial.outputDir}-retry`,
      metricFile: `${trial.outputDir}-retry/metric.json`,
    };
    preflightTrial(campaignDir, retry);
    markTrialStarted(campaignDir, retry);
    finishTrial(campaignDir, retry.trialId, retry.runId, 'pilot-complete', { metric: 0.4 });

    const secondRetry = {
      ...trial,
      runId: 'run-3',
      retryOfRunId: 'run-1',
      outputDir: `${trial.outputDir}-retry-2`,
      metricFile: `${trial.outputDir}-retry-2/metric.json`,
    };
    expect(() => preflightTrial(campaignDir, secondRetry)).toThrow('Retry ceiling');
  });

  it('counts chained retries against the per-trial ceiling', () => {
    const { campaignDir, config, trial } = fixture();
    config.budget.maxRetriesPerTrial = 1;
    config.budget.maxFailures = 3;
    initCampaign(campaignDir, config);
    preflightTrial(campaignDir, trial);
    markTrialStarted(campaignDir, trial);
    finishTrial(campaignDir, trial.trialId, trial.runId, 'failed');
    const retry = {
      ...trial,
      runId: 'run-2',
      retryOfRunId: 'run-1',
      outputDir: `${trial.outputDir}-2`,
      metricFile: `${trial.outputDir}-2/metric.json`,
    };
    preflightTrial(campaignDir, retry);
    markTrialStarted(campaignDir, retry);
    finishTrial(campaignDir, retry.trialId, retry.runId, 'failed');
    const chained = {
      ...trial,
      runId: 'run-3',
      retryOfRunId: 'run-2',
      outputDir: `${trial.outputDir}-3`,
      metricFile: `${trial.outputDir}-3/metric.json`,
    };
    expect(() => preflightTrial(campaignDir, chained)).toThrow('Retry ceiling');
  });

  it('rejects confirmation, stale metric paths, and unapproved contract changes', () => {
    const { campaignDir, config, trial } = fixture();
    initCampaign(campaignDir, config);
    expect(() => preflightTrial(campaignDir, { ...trial, phase: 'confirmation' })).toThrow(
      'only executes pilot'
    );
    expect(() =>
      preflightTrial(campaignDir, { ...trial, metricFile: path.join(trial.workdir, 'old.json') })
    ).toThrow('Path escapes');
    expect(() => preflightTrial(campaignDir, { ...trial, seed: 8 })).toThrow('approved hash');
  });

  it('fails closed when Markdown and JSONL evidence diverge', () => {
    const { campaignDir, config } = fixture();
    initCampaign(campaignDir, config);
    const trialsFile = path.resolve(campaignDir, config.paths.trialsMarkdown);
    fs.appendFileSync(
      trialsFile,
      '| evt-manual | now | t | r | event | failed |  |  | manual |\n',
      'utf8'
    );
    expect(reconcileCampaign(campaignDir)).toEqual({
      ok: false,
      missingEventIds: [],
      extraEventIds: ['evt-manual'],
    });
    expect(() => preflightTrial(campaignDir, fixture().trial)).toThrow();
  });

  it('detects same-event-id content tampering', () => {
    const { campaignDir, config } = fixture();
    initCampaign(campaignDir, config);
    const trialsFile = path.resolve(campaignDir, config.paths.trialsMarkdown);
    const content = fs
      .readFileSync(trialsFile, 'utf8')
      .replace('Approved search revision', 'tampered');
    fs.writeFileSync(trialsFile, content, 'utf8');
    expect(reconcileCampaign(campaignDir).ok).toBe(false);
  });
});
