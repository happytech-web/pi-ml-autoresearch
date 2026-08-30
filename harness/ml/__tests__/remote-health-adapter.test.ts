import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const adapter = path.resolve('harness/ml-remote-health-adapter.py');
const sentinel = path.resolve('harness/ml-health-sentinel.py');
const dirs: string[] = [];

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
    sentinelHeartbeatMaxAgeMs: 10_000,
  };
}

describe('remote executor health adapter', () => {
  it('maps a verified terminal state to expectedStopped and completed health', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-remote-health-'));
    dirs.push(dir);
    const state = path.join(dir, 'remote-state.json');
    const terminal = path.join(dir, 'terminal.json');
    const progress = path.join(dir, 'progress.json');
    const config = path.join(dir, 'adapter.json');
    const output = path.join(dir, 'input.json');
    const policyFile = path.join(dir, 'policy.json');
    const health = path.join(dir, 'health.json');
    const events = path.join(dir, 'events.jsonl');
    writeJson(state, { status: 'completed', executorPid: null, executorStartTicks: null });
    writeJson(terminal, {
      campaignId: 'remote-health',
      runId: 'run-1',
      attemptId: 'attempt-1',
      contractVerified: true,
      artifactsVerified: true,
      reconcileVerified: true,
      allRanksExited: true,
    });
    writeJson(progress, {
      runId: 'run-1',
      attemptId: 'attempt-1',
      phase: 'finalize',
      sequence: 10,
      timestampMs: Date.now(),
      finiteMetrics: true,
    });
    writeJson(config, {
      campaignId: 'remote-health',
      runId: 'run-1',
      attemptId: 'attempt-1',
      campaignDir: dir,
      terminalFile: terminal,
      diskPath: dir,
      progressFile: progress,
    });
    writeJson(policyFile, policy());
    const adapterResult = spawnSync('python3', [adapter, '--config', config, '--output', output], {
      encoding: 'utf8',
    });
    expect(adapterResult.status, adapterResult.stderr).toBe(0);
    const input = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(input.executor).toEqual({
      processAlive: false,
      identityMatches: false,
      expectedStopped: true,
    });
    const sentinelResult = spawnSync(
      'python3',
      [sentinel, '--input', output, '--policy', policyFile, '--output', health, '--events', events],
      { encoding: 'utf8' }
    );
    expect(sentinelResult.status, sentinelResult.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(health, 'utf8')).state).toBe('completed');
  });

  it('keeps an active state with an unverifiable PID failed/unknown rather than healthy', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-remote-health-'));
    dirs.push(dir);
    const state = path.join(dir, 'remote-state.json');
    const config = path.join(dir, 'adapter.json');
    const output = path.join(dir, 'input.json');
    writeJson(state, { status: 'running', executorPid: 99_999_999, executorStartTicks: 1 });
    writeJson(config, {
      campaignId: 'remote-health',
      runId: 'run-1',
      attemptId: 'attempt-1',
      campaignDir: dir,
    });
    const result = spawnSync('python3', [adapter, '--config', config, '--output', output], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(output, 'utf8')).executor).toEqual({
      processAlive: false,
      identityMatches: false,
    });
  });

  it('does not mark a terminal record for another run as expected stopped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-remote-health-identity-'));
    dirs.push(dir);
    const state = path.join(dir, 'remote-state.json');
    const terminal = path.join(dir, 'terminal.json');
    const config = path.join(dir, 'adapter.json');
    const output = path.join(dir, 'input.json');
    writeJson(state, { status: 'completed', executorPid: null, executorStartTicks: null });
    writeJson(terminal, {
      campaignId: 'remote-health',
      runId: 'different-run',
      attemptId: 'attempt-1',
      contractVerified: true,
      artifactsVerified: true,
      reconcileVerified: true,
      allRanksExited: true,
    });
    writeJson(config, {
      campaignId: 'remote-health',
      runId: 'run-1',
      attemptId: 'attempt-1',
      campaignDir: dir,
      terminalFile: terminal,
    });
    const result = spawnSync('python3', [adapter, '--config', config, '--output', output], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(output, 'utf8')).executor).toEqual({
      processAlive: false,
      identityMatches: false,
    });
  });

  it('requires the configured run identity and run token in active remote state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-remote-health-running-'));
    dirs.push(dir);
    const state = path.join(dir, 'remote-state.json');
    const statusDir = path.join(dir, 'remote-runs', 'run-1');
    const status = path.join(statusDir, 'status.json');
    const config = path.join(dir, 'adapter.json');
    const output = path.join(dir, 'input.json');
    fs.mkdirSync(statusDir, { recursive: true });
    writeJson(state, {
      status: 'running',
      currentRunId: 'different-run',
      executorPid: 99_999_999,
      executorStartTicks: 1,
    });
    writeJson(status, { state: 'running', runId: 'run-1', runToken: 'token' });
    writeJson(config, {
      campaignId: 'remote-health',
      runId: 'run-1',
      attemptId: 'attempt-1',
      campaignDir: dir,
    });
    const result = spawnSync('python3', [adapter, '--config', config, '--output', output], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(output, 'utf8')).executor).toEqual({
      processAlive: false,
      identityMatches: false,
    });
  });
});
