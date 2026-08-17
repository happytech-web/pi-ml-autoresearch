import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { trialContractHash } from '../campaign.js';
import { packRemoteBundle } from '../remote-bundle.js';
import type { MlSearchConfig, MlTrialSpec } from '../types.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function fixture(
  metric: number,
  target?: number
): {
  root: string;
  bundle: string;
  config: MlSearchConfig;
  trial: MlTrialSpec;
  configFile: string;
  trialFile: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ml-remote-'));
  dirs.push(root);
  const workdir = path.join(root, 'work');
  const outputRoot = path.join(root, 'outputs');
  const outputDir = path.join(outputRoot, 'trial-1');
  const bundle = path.join(root, 'bundle');
  fs.mkdirSync(workdir, { recursive: true });
  fs.writeFileSync(path.join(workdir, 'tracked.txt'), 'fixture\n', 'utf8');
  for (const args of [
    ['init'],
    ['add', 'tracked.txt'],
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', args, { cwd: workdir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  const gitSha = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: workdir,
    encoding: 'utf8',
  }).stdout.trim();
  const trial: MlTrialSpec = {
    schemaVersion: 1,
    trialId: 'trial-1',
    runId: 'run-1',
    searchRevision: 'rev-1',
    phase: 'pilot',
    seed: 7,
    configHash: `sha256:${'d'.repeat(64)}`,
    gitSha,
    workdir,
    outputDir,
    command: {
      executable: 'python3',
      args: [
        '-c',
        `import json,os,pathlib; p=pathlib.Path(os.environ['PI_ML_METRIC_FILE']); p.parent.mkdir(parents=True,exist_ok=True); p.write_text(json.dumps({'val_loss':${metric},'steps':10}))`,
      ],
    },
    metricFile: path.join(outputDir, 'metric.json'),
    dataset: 'dataset-v1',
    split: 'validation-v1',
    budget: { stepLimit: 10, wallClockMinutes: 1, gpuCount: 1, gpuHours: 0.1 },
  };
  const config: MlSearchConfig = {
    schemaVersion: 1,
    experimentId: 'exp-remote',
    searchRevision: 'rev-1',
    approval: 'approved',
    agentLevel: 1,
    primaryMetric: { name: 'val_loss', direction: 'lower', target },
    budget: {
      maxTrials: 2,
      maxParallel: 1,
      maxGpuHours: 1,
      maxWallClockMinutes: 5,
      maxFailures: 2,
      maxRetriesPerTrial: 1,
    },
    approvedTrials: [{ trialId: trial.trialId, contractHash: trialContractHash(trial) }],
    paths: { trialsMarkdown: '../TRIALS.md', outputRoot },
  };
  const configFile = path.join(root, 'search.json');
  const trialFile = path.join(root, 'trial.json');
  writeJson(configFile, config);
  writeJson(trialFile, trial);
  return { root, bundle, config, trial, configFile, trialFile };
}

function runExecutor(bundle: string, action = 'run') {
  return spawnSync(
    'python3',
    [path.join(bundle, 'remote-executor.py'), action, '--campaign', bundle],
    {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    }
  );
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for remote executor state');
}

function packViaCli(configFile: string, trialFiles: string[], bundle: string) {
  return spawnSync(
    process.execPath,
    [
      path.resolve('harness/pi-ml-autoresearch.mjs'),
      'pack-remote',
      '--config',
      configFile,
      ...trialFiles.flatMap((file) => ['--trial', file]),
      '--output',
      bundle,
    ],
    { cwd: process.cwd(), encoding: 'utf8' }
  );
}

describe('remote fixed-queue executor', () => {
  it('packs and executes an approved queue without Node on the remote side', () => {
    const { bundle, trial, configFile, trialFile } = fixture(0.25);
    const packed = packViaCli(configFile, [trialFile], bundle);
    expect(packed.status, packed.stderr).toBe(0);

    const result = runExecutor(bundle);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('completed');
    expect(JSON.parse(fs.readFileSync(path.join(bundle, 'remote-state.json'), 'utf8')).status).toBe(
      'completed'
    );
    const events = fs
      .readFileSync(path.join(bundle, 'remote-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      events.find((event) => event.runId === trial.runId && event.metric === 0.25)?.status
    ).toBe('pilot-complete');

    const rerun = runExecutor(bundle);
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(
      fs.readFileSync(path.join(bundle, 'remote-events.jsonl'), 'utf8').trim().split('\n')
    ).toHaveLength(events.length);
  });

  it('stops the fixed queue when the approved metric target is reached', () => {
    const { root, bundle, config, trial, configFile, trialFile } = fixture(0.25, 0.3);
    const second: MlTrialSpec = {
      ...trial,
      trialId: 'trial-2',
      runId: 'run-2',
      outputDir: path.join(root, 'outputs', 'trial-2'),
      metricFile: path.join(root, 'outputs', 'trial-2', 'metric.json'),
    };
    config.approvedTrials.push({
      trialId: second.trialId,
      contractHash: trialContractHash(second),
    });
    const secondFile = path.join(root, 'trial-2.json');
    writeJson(configFile, config);
    writeJson(secondFile, second);
    packRemoteBundle(configFile, [trialFile, secondFile], bundle);

    const result = runExecutor(bundle);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('stopped');
    expect(fs.existsSync(second.outputDir)).toBe(false);
  });

  it('runs only an explicitly provisioned retry after a failed run', () => {
    const { root, bundle, config, trial, configFile, trialFile } = fixture(0.25);
    trial.command = {
      executable: 'python3',
      args: [
        '-c',
        "import json,os,pathlib,sys; run=os.environ['PI_ML_RUN_ID']; sys.exit(2) if run == 'run-1' else None; p=pathlib.Path(os.environ['PI_ML_METRIC_FILE']); p.parent.mkdir(parents=True,exist_ok=True); p.write_text(json.dumps({'val_loss':0.2}))",
      ],
    };
    const retry: MlTrialSpec = {
      ...trial,
      runId: 'run-2',
      retryOfRunId: 'run-1',
      outputDir: path.join(root, 'outputs', 'trial-1-retry'),
      metricFile: path.join(root, 'outputs', 'trial-1-retry', 'metric.json'),
    };
    config.approvedTrials[0]!.contractHash = trialContractHash(trial);
    const retryFile = path.join(root, 'retry.json');
    writeJson(configFile, config);
    writeJson(trialFile, trial);
    writeJson(retryFile, retry);
    packRemoteBundle(configFile, [trialFile, retryFile], bundle);

    const result = runExecutor(bundle);
    expect(result.status, result.stderr).toBe(0);
    const events = fs
      .readFileSync(path.join(bundle, 'remote-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      events.find((event) => event.runId === 'run-1' && event.type === 'trial-finished')?.status
    ).toBe('failed');
    expect(
      events.find((event) => event.runId === 'run-2' && event.type === 'trial-finished')?.status
    ).toBe('pilot-complete');
  });

  it('rejects queue mutation after remote initialization', () => {
    const { bundle, configFile, trialFile } = fixture(0.25);
    packRemoteBundle(configFile, [trialFile], bundle);
    expect(runExecutor(bundle).status).toBe(0);
    const queueFile = path.join(bundle, 'queue.json');
    const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    queue.trials[0].runId = 'tampered-run';
    writeJson(queueFile, queue);

    const rerun = runExecutor(bundle);
    expect(rerun.status).toBe(1);
    expect(rerun.stderr).toContain('changed after campaign initialization');
  });

  it('rejects contract extensions with undefined cross-language hashing semantics', () => {
    const { bundle, config, trial, configFile, trialFile } = fixture(0.25);
    (trial.command as typeof trial.command & { environment: Record<string, string> }).environment =
      {
        MODE: 'unexpected',
      };
    config.approvedTrials[0]!.contractHash = trialContractHash(trial);
    writeJson(configFile, config);
    writeJson(trialFile, trial);

    expect(() => packRemoteBundle(configFile, [trialFile], bundle)).toThrow(
      'command contains unsupported fields'
    );
  });

  it('requires metricFile to name a file below outputDir', () => {
    const { bundle, config, trial, configFile, trialFile } = fixture(0.25);
    trial.metricFile = trial.outputDir;
    config.approvedTrials[0]!.contractHash = trialContractHash(trial);
    writeJson(configFile, config);
    writeJson(trialFile, trial);

    expect(() => packRemoteBundle(configFile, [trialFile], bundle)).toThrow(
      'metricFile must name a file below outputDir'
    );
  });

  it('kills the remote process group when the wall-clock ceiling is reached', async () => {
    const { root, bundle, config, trial, configFile, trialFile } = fixture(0.25);
    const marker = path.join(root, 'escaped-child');
    const child = `import pathlib,time; time.sleep(0.5); pathlib.Path(${JSON.stringify(marker)}).write_text('bad')`;
    trial.command = {
      executable: 'python3',
      args: [
        '-c',
        `import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',${JSON.stringify(child)}]); time.sleep(10)`,
      ],
    };
    trial.budget = { ...trial.budget, wallClockMinutes: 0.001, gpuHours: 0.001 };
    config.approvedTrials[0]!.contractHash = trialContractHash(trial);
    writeJson(configFile, config);
    writeJson(trialFile, trial);
    packRemoteBundle(configFile, [trialFile], bundle);

    const result = runExecutor(bundle);
    expect(result.status, result.stderr).toBe(0);
    const events = fs
      .readFileSync(path.join(bundle, 'remote-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      events.find((event) => event.runId === trial.runId && event.type === 'trial-finished')?.status
    ).toBe('failed');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('holds a campaign lock for the full executor lifetime', async () => {
    const { bundle, config, trial, configFile, trialFile } = fixture(0.25);
    trial.command = {
      executable: 'python3',
      args: [
        '-c',
        "import json,os,pathlib,time; time.sleep(1); p=pathlib.Path(os.environ['PI_ML_METRIC_FILE']); p.write_text(json.dumps({'val_loss':0.25}))",
      ],
    };
    config.approvedTrials[0]!.contractHash = trialContractHash(trial);
    writeJson(configFile, config);
    writeJson(trialFile, trial);
    packRemoteBundle(configFile, [trialFile], bundle);

    const first = spawn(
      'python3',
      [path.join(bundle, 'remote-executor.py'), 'run', '--campaign', bundle],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    await waitFor(() => {
      const stateFile = path.join(bundle, 'remote-state.json');
      return (
        fs.existsSync(stateFile) &&
        JSON.parse(fs.readFileSync(stateFile, 'utf8')).currentRunId === trial.runId
      );
    });

    const second = runExecutor(bundle);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('already has an active executor');
    const firstExit = await new Promise<number | null>((resolve) => first.once('exit', resolve));
    expect(firstExit).toBe(0);
  });

  it('fails and removes descendants when the foreground leader exits first', () => {
    const { root, bundle, config, trial, configFile, trialFile } = fixture(0.25);
    const marker = path.join(root, 'orphan-finished');
    const child = `import pathlib,signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(10); pathlib.Path(${JSON.stringify(marker)}).write_text('bad')`;
    trial.command = {
      executable: 'python3',
      args: [
        '-c',
        `import json,os,pathlib,subprocess,sys; subprocess.Popen([sys.executable,'-c',${JSON.stringify(child)}]); p=pathlib.Path(os.environ['PI_ML_METRIC_FILE']); p.write_text(json.dumps({'val_loss':0.25}))`,
      ],
    };
    config.approvedTrials[0]!.contractHash = trialContractHash(trial);
    writeJson(configFile, config);
    writeJson(trialFile, trial);
    packRemoteBundle(configFile, [trialFile], bundle);

    const result = runExecutor(bundle);
    expect(result.status, result.stderr).toBe(0);
    const events = fs
      .readFileSync(path.join(bundle, 'remote-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const finished = events.find(
      (event) => event.runId === trial.runId && event.type === 'trial-finished'
    );
    expect(finished?.status).toBe('failed');
    expect(finished?.detail).toContain('descendant processes remained');
    expect(fs.existsSync(marker)).toBe(false);
  }, 15_000);

  it('rejects an output symlink that escapes the approved root on the final host', () => {
    const { root, bundle, config, trial, configFile, trialFile } = fixture(0.25);
    const external = path.join(root, 'external');
    fs.mkdirSync(path.dirname(trial.outputDir), { recursive: true });
    fs.mkdirSync(external);
    fs.symlinkSync(external, trial.outputDir);
    config.approvedTrials[0]!.contractHash = trialContractHash(trial);
    writeJson(configFile, config);
    writeJson(trialFile, trial);
    packRemoteBundle(configFile, [trialFile], bundle);

    const result = runExecutor(bundle);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('escapes approved root');
    expect(fs.existsSync(path.join(external, 'run.log'))).toBe(false);
  });

  it('marks an active trial recovery-required when status observes a hard executor crash', async () => {
    const { bundle, config, trial, configFile, trialFile } = fixture(0.25);
    trial.command = { executable: 'python3', args: ['-c', 'import time; time.sleep(10)'] };
    config.approvedTrials[0]!.contractHash = trialContractHash(trial);
    writeJson(configFile, config);
    writeJson(trialFile, trial);
    packRemoteBundle(configFile, [trialFile], bundle);

    const executor = spawn(
      'python3',
      [path.join(bundle, 'remote-executor.py'), 'run', '--campaign', bundle],
      { stdio: 'ignore' }
    );
    const runStatusFile = path.join(bundle, 'remote-runs', trial.runId, 'status.json');
    await waitFor(() => fs.existsSync(runStatusFile));
    const processGroup = JSON.parse(fs.readFileSync(runStatusFile, 'utf8')).processGroup as number;
    executor.kill('SIGKILL');
    await new Promise((resolve) => executor.once('exit', resolve));

    const observed = runExecutor(bundle, 'status');
    expect(observed.status, observed.stderr).toBe(0);
    expect(JSON.parse(observed.stdout).state.status).toBe('recovery-required');
    try {
      process.kill(-processGroup, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  });
});
