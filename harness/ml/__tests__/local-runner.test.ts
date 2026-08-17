import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { initCampaign, preflightTrial, trialContractHash } from '../campaign.js';
import {
  cancelLocalTrial,
  pollLocalTrial,
  readWorkerStatus,
  submitLocalTrial,
} from '../local-runner.js';
import type { MlEvent, MlSearchConfig, MlTrialSpec } from '../types.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(metricExpression: string): {
  campaignDir: string;
  config: MlSearchConfig;
  trial: MlTrialSpec;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ml-runner-'));
  dirs.push(root);
  const campaignDir = path.join(root, 'campaign');
  const outputDir = path.join(root, 'outputs', 'trial-1');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'fixture\n', 'utf8');
  for (const args of [
    ['init'],
    ['add', 'tracked.txt'],
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  const gitSha = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).stdout.trim();
  const trial: MlTrialSpec = {
    schemaVersion: 1,
    trialId: 'trial-1',
    runId: 'run-1',
    searchRevision: 'rev-1',
    phase: 'pilot',
    seed: 1,
    configHash: `sha256:${'c'.repeat(64)}`,
    gitSha,
    workdir: root,
    outputDir,
    command: {
      executable: process.execPath,
      args: [
        '-e',
        `require('fs').mkdirSync(require('path').dirname(process.env.PI_ML_METRIC_FILE), {recursive:true}); require('fs').writeFileSync(process.env.PI_ML_METRIC_FILE, JSON.stringify(${metricExpression}))`,
      ],
    },
    metricFile: path.join(outputDir, 'metric.json'),
    dataset: 'dataset-v1',
    split: 'validation-v1',
    budget: { stepLimit: 10, wallClockMinutes: 1, gpuCount: 1, gpuHours: 0.1 },
  };
  const config: MlSearchConfig = {
    schemaVersion: 1,
    experimentId: 'exp-local',
    searchRevision: 'rev-1',
    approval: 'approved',
    agentLevel: 1,
    primaryMetric: { name: 'val_loss', direction: 'lower' },
    budget: {
      maxTrials: 2,
      maxParallel: 1,
      maxGpuHours: 1,
      maxWallClockMinutes: 5,
      maxFailures: 2,
      maxRetriesPerTrial: 1,
    },
    approvedTrials: [{ trialId: trial.trialId, contractHash: trialContractHash(trial) }],
    paths: { trialsMarkdown: '../TRIALS.md', outputRoot: path.join(root, 'outputs') },
  };
  return { campaignDir, config, trial };
}

async function waitForTerminal(campaignDir: string): Promise<MlEvent> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = pollLocalTrial(campaignDir, 'trial-1');
    if (result && 'eventId' in result && result.status !== 'running') return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Local runner did not finish');
}

describe('local ML runner', () => {
  it('runs out of process and accepts a strict finite primary metric', async () => {
    const { campaignDir, config, trial } = fixture('{val_loss: 0.25}');
    initCampaign(campaignDir, config);
    submitLocalTrial(campaignDir, trial);
    const terminal = await waitForTerminal(campaignDir);
    expect(terminal.status).toBe('pilot-complete');
    expect(terminal.metric).toBe(0.25);
    expect(fs.readFileSync(path.join(trial.outputDir, 'run.log'), 'utf8')).toBe('');
  });

  it('marks a successful process invalid when the metric contract is missing', async () => {
    const { campaignDir, config, trial } = fixture('{other_metric: 1}');
    initCampaign(campaignDir, config);
    submitLocalTrial(campaignDir, trial);
    const terminal = await waitForTerminal(campaignDir);
    expect(terminal.status).toBe('invalid');
    expect(terminal.detail).toContain('finite numeric key val_loss');
  });

  it('rejects tracked code changes after trial approval', () => {
    const { campaignDir, config, trial } = fixture('{val_loss: 0.25}');
    initCampaign(campaignDir, config);
    fs.writeFileSync(path.join(trial.workdir, 'tracked.txt'), 'changed\n', 'utf8');
    expect(() => submitLocalTrial(campaignDir, trial)).toThrow('tracked changes');
    const terminal = pollLocalTrial(campaignDir, trial.trialId);
    expect(terminal && 'status' in terminal ? terminal.status : undefined).toBe('invalid');
  });

  it('allows an operator to release an interrupted preflight reservation', () => {
    const { campaignDir, config, trial } = fixture('{val_loss: 0.25}');
    initCampaign(campaignDir, config);
    preflightTrial(campaignDir, trial);
    const terminal = cancelLocalTrial(campaignDir, trial.trialId);
    expect(terminal.status).toBe('invalid');
    expect(terminal.detail).toContain('Preflight reservation cancelled');
  });

  it('confirms worker termination before recording cancellation', async () => {
    const { campaignDir, config, trial } = fixture('{val_loss: 0.25}');
    trial.command = {
      executable: process.execPath,
      args: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    };
    config.approvedTrials[0]!.contractHash = trialContractHash(trial);
    initCampaign(campaignDir, config);
    submitLocalTrial(campaignDir, trial);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (readWorkerStatus(campaignDir, trial.runId)?.state === 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const terminal = cancelLocalTrial(campaignDir, trial.trialId);
    expect(terminal.status).toBe('abandoned');
    expect(terminal.detail).toContain('worker exit confirmed');
    expect(terminal.detail).toContain('descendant processes were still running');
  }, 10_000);

  it('kills descendant processes when the wall-clock budget expires', async () => {
    const { campaignDir, config, trial } = fixture('{val_loss: 0.25}');
    const marker = path.join(trial.workdir, 'descendant-finished');
    trial.command = {
      executable: process.execPath,
      args: [
        '-e',
        `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad'), 500)`)}], {stdio:'ignore'}); setInterval(() => {}, 1000)`,
      ],
    };
    trial.budget = { ...trial.budget, wallClockMinutes: 0.001, gpuHours: 0.001 };
    config.approvedTrials[0]!.contractHash = trialContractHash(trial);
    initCampaign(campaignDir, config);
    submitLocalTrial(campaignDir, trial);
    const terminal = await waitForTerminal(campaignDir);
    expect(terminal.status).toBe('failed');
    expect(terminal.detail).toContain('wall-clock budget');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('fails and kills descendants when a launcher exits before its children', async () => {
    const { campaignDir, config, trial } = fixture('{val_loss: 0.25}');
    const marker = path.join(trial.workdir, 'escaped-descendant');
    trial.command = {
      executable: process.execPath,
      args: [
        '-e',
        `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad'), 500)`)}], {stdio:'ignore'}).unref()`,
      ],
    };
    config.approvedTrials[0]!.contractHash = trialContractHash(trial);
    initCampaign(campaignDir, config);
    submitLocalTrial(campaignDir, trial);
    const terminal = await waitForTerminal(campaignDir);
    expect(terminal.status).toBe('failed');
    expect(terminal.detail).toContain('descendant processes were still running');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(fs.existsSync(marker)).toBe(false);
  });
});
