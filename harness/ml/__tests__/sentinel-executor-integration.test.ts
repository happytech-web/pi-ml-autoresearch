import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const dirs: string[] = [];
const sentinel = path.resolve('harness/ml-health-sentinel.py');

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixtures() {
  return {
    input: {
      nowMs: 100,
      campaignId: 'executor-integration',
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
    },
    policy: {
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
    },
  };
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline)
        return reject(new Error('timed out waiting for integration state'));
      setTimeout(check, 10);
    };
    check();
  });
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.once('exit', resolve));
}

describe('sentinel and executor cross-process boundary', () => {
  it('observes a fake executor crash after the adapter refreshes input', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sentinel-executor-'));
    dirs.push(dir);
    const { input, policy } = fixtures();
    const inputFile = path.join(dir, 'input.json');
    const policyFile = path.join(dir, 'policy.json');
    const outputFile = path.join(dir, 'health.json');
    const eventsFile = path.join(dir, 'events.jsonl');
    writeJson(inputFile, input);
    writeJson(policyFile, policy);

    const executor = spawn('python3', ['-c', 'import time; time.sleep(0.15)'], {
      stdio: 'ignore',
    });
    const sentinelProcess = spawn(
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
        '--interval-seconds',
        '0.02',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    await waitFor(() => fs.existsSync(outputFile));
    expect(JSON.parse(fs.readFileSync(outputFile, 'utf8')).state).toBe('healthy');

    await waitForExit(executor);
    writeJson(inputFile, {
      ...input,
      executor: { processAlive: false, identityMatches: false },
    });
    await waitFor(() => JSON.parse(fs.readFileSync(outputFile, 'utf8')).state === 'failed');
    sentinelProcess.kill('SIGTERM');
    expect(await waitForExit(sentinelProcess)).toBe(0);
    const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n');
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[1]!).state).toBe('failed');
  }, 10_000);

  it('does not report completed until terminal gates are all true', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sentinel-terminal-'));
    dirs.push(dir);
    const { input, policy } = fixtures();
    const inputFile = path.join(dir, 'input.json');
    const policyFile = path.join(dir, 'policy.json');
    const outputFile = path.join(dir, 'health.json');
    const eventsFile = path.join(dir, 'events.jsonl');
    writeJson(inputFile, { ...input, terminal: { contractVerified: true } });
    writeJson(policyFile, policy);
    const partial = spawn(
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
      ],
      { encoding: 'utf8' }
    );
    expect(await waitForExit(partial)).toBe(0);
    expect(JSON.parse(fs.readFileSync(outputFile, 'utf8')).state).toBe('healthy');

    writeJson(inputFile, {
      ...input,
      terminal: {
        contractVerified: true,
        artifactsVerified: true,
        reconcileVerified: true,
        allRanksExited: true,
      },
    });
    const complete = spawn(
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
      ],
      { encoding: 'utf8' }
    );
    expect(await waitForExit(complete)).toBe(0);
    expect(JSON.parse(fs.readFileSync(outputFile, 'utf8')).state).toBe('completed');
  });
});
