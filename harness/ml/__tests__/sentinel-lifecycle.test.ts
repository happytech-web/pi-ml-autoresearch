import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
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
      campaignId: 'lifecycle-campaign',
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

function writeFixtures(dir: string) {
  const { input, policy } = fixtures();
  fs.writeFileSync(path.join(dir, 'input.json'), `${JSON.stringify(input)}\n`);
  fs.writeFileSync(path.join(dir, 'policy.json'), `${JSON.stringify(policy)}\n`);
}

function args(dir: string, intervalSeconds?: number): string[] {
  const result = [
    sentinel,
    '--input',
    path.join(dir, 'input.json'),
    '--policy',
    path.join(dir, 'policy.json'),
    '--output',
    path.join(dir, 'health.json'),
    '--events',
    path.join(dir, 'health-events.jsonl'),
  ];
  if (intervalSeconds !== undefined) result.push('--interval-seconds', String(intervalSeconds));
  return result;
}

function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('timed out waiting for sentinel state'));
      setTimeout(check, 10);
    };
    check();
  });
}

function waitForExit(child: ChildProcess): Promise<{ status: number | null; stderr: string }> {
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  return new Promise((resolve) => {
    child.once('exit', (status) => resolve({ status, stderr }));
  });
}

describe('remote health sentinel lifecycle', () => {
  it('runs interval probes and exits cleanly on SIGTERM', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sentinel-life-'));
    dirs.push(dir);
    writeFixtures(dir);
    const child = spawn('python3', args(dir, 0.02), { stdio: ['ignore', 'ignore', 'pipe'] });
    await waitFor(() => fs.existsSync(path.join(dir, 'health.json')));
    child.kill('SIGTERM');
    const result = await waitForExit(child);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'health.json'), 'utf8')).state).toBe(
      'healthy'
    );
  }, 10_000);

  it('serializes concurrent probes and never exposes a partial JSON output', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sentinel-concurrent-'));
    dirs.push(dir);
    writeFixtures(dir);
    const first = spawn('python3', args(dir), { stdio: ['ignore', 'ignore', 'pipe'] });
    const second = spawn('python3', args(dir), { stdio: ['ignore', 'ignore', 'pipe'] });
    const [firstResult, secondResult] = await Promise.all([waitForExit(first), waitForExit(second)]);
    expect(firstResult.status, firstResult.stderr).toBe(0);
    expect(secondResult.status, secondResult.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'health.json'), 'utf8')).state).toBe(
      'healthy'
    );
    expect(fs.readFileSync(path.join(dir, 'health-events.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('fails closed when a prior health file is corrupt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sentinel-corrupt-'));
    dirs.push(dir);
    writeFixtures(dir);
    const output = path.join(dir, 'health.json');
    fs.writeFileSync(output, '{"state":');
    const result = spawnSync('python3', args(dir), { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(fs.readFileSync(output, 'utf8')).toBe('{"state":');
    expect(fs.existsSync(path.join(dir, 'health-events.jsonl'))).toBe(false);
  });

  it('keeps readers safe while interval probes replace the output atomically', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sentinel-reader-'));
    dirs.push(dir);
    writeFixtures(dir);
    const child = spawn('python3', args(dir, 0.005), { stdio: ['ignore', 'ignore', 'pipe'] });
    await waitFor(() => fs.existsSync(path.join(dir, 'health.json')));
    const parseErrors: string[] = [];
    const deadline = Date.now() + 150;
    while (Date.now() < deadline) {
      try {
        JSON.parse(fs.readFileSync(path.join(dir, 'health.json'), 'utf8'));
      } catch (error) {
        parseErrors.push(String(error));
      }
    }
    child.kill('SIGTERM');
    const result = await waitForExit(child);
    expect(result.status, result.stderr).toBe(0);
    expect(parseErrors).toEqual([]);
  }, 10_000);
});
