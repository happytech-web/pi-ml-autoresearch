import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const dirs: string[] = [];
const adapter = path.resolve('harness/ml-health-adapter.py');
const sentinel = path.resolve('harness/ml-health-sentinel.py');

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function policy() {
  return {
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
}

describe('standard project health input adapter process', () => {
  it('maps executor/progress/terminal/filesystem/log declarations into HealthInput', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-adapter-process-'));
    dirs.push(dir);
    const executorFile = path.join(dir, 'executor.json');
    const progressFile = path.join(dir, 'progress.json');
    const terminalFile = path.join(dir, 'terminal.json');
    const logFile = path.join(dir, 'train.log');
    const configFile = path.join(dir, 'adapter.json');
    const outputFile = path.join(dir, 'input.json');
    writeJson(executorFile, { processAlive: true, identityMatches: true });
    writeJson(progressFile, {
      runId: 'run-1',
      attemptId: 'attempt-1',
      phase: 'train',
      sequence: 7,
      timestampMs: Date.now(),
      finiteMetrics: true,
    });
    writeJson(terminalFile, {
      contractVerified: true,
      artifactsVerified: true,
      reconcileVerified: true,
      allRanksExited: true,
    });
    fs.writeFileSync(logFile, 'step=7\n');
    writeJson(configFile, {
      campaignId: 'adapter-campaign',
      runId: 'run-1',
      attemptId: 'attempt-1',
      executorFile,
      progressFile,
      terminalFile,
      diskPath: dir,
      logFiles: [{ path: logFile, patterns: { oom: 'out of memory', trace: 'Traceback' } }],
    });
    const result = spawnSync('python3', [adapter, '--config', configFile, '--output', outputFile], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const input = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    expect(input.campaignId).toBe('adapter-campaign');
    expect(input.executor).toEqual({ processAlive: true, identityMatches: true });
    expect(input.progress.sequence).toBe(7);
    expect(input.terminal.allRanksExited).toBe(true);
    expect(input.disk.availableBytes).toBeGreaterThan(0);
    expect(input.fatalSignatures).toBeUndefined();
    expect(fs.statSync(outputFile).mode & 0o777).toBe(0o600);

    fs.writeFileSync(logFile, 'CUDA out of memory\n');
    const rerun = spawnSync('python3', [adapter, '--config', configFile, '--output', outputFile], {
      encoding: 'utf8',
    });
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(outputFile, 'utf8')).fatalSignatures).toEqual(['oom']);
  });

  it('makes sentinel emit unknown when the adapter refresh fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-adapter-process-'));
    dirs.push(dir);
    const inputFile = path.join(dir, 'input.json');
    const policyFile = path.join(dir, 'policy.json');
    const outputFile = path.join(dir, 'health.json');
    const eventsFile = path.join(dir, 'events.jsonl');
    const configFile = path.join(dir, 'adapter.json');
    writeJson(inputFile, {
      nowMs: Date.now(),
      campaignId: 'adapter-campaign',
      runId: 'run-1',
      attemptId: 'attempt-1',
      sentinelHeartbeatAtMs: Date.now(),
      executor: { processAlive: true, identityMatches: true },
    });
    writeJson(policyFile, policy());
    writeJson(configFile, {
      campaignId: 'adapter-campaign',
      runId: 'run-1',
      attemptId: 'attempt-1',
    });
    const result = spawnSync(
      'python3',
      [
        sentinel,
        '--input',
        inputFile,
        '--policy',
        policyFile,
        '--output',
        outputFile,
        '--events',
        eventsFile,
        '--adapter',
        adapter,
        '--adapter-config',
        configFile,
      ],
      { encoding: 'utf8' }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(outputFile, 'utf8')).state).toBe('unknown');
  });
});
