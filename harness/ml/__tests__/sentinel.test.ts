import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
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
      campaignId: 'remote-mock',
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

function runSentinel(dir: string, input: object, policy: object) {
  const inputFile = path.join(dir, 'input.json');
  const policyFile = path.join(dir, 'policy.json');
  const outputFile = path.join(dir, 'health.json');
  const eventsFile = path.join(dir, 'health-events.jsonl');
  fs.writeFileSync(inputFile, `${JSON.stringify(input)}\n`);
  fs.writeFileSync(policyFile, `${JSON.stringify(policy)}\n`);
  return spawnSync(
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
}

describe('remote health sentinel mock', () => {
  it('writes health atomically and deduplicates unchanged observations', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sentinel-'));
    dirs.push(dir);
    const { input, policy } = fixtures();
    expect(runSentinel(dir, input, policy).status).toBe(0);
    expect(runSentinel(dir, input, policy).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'health.json'), 'utf8')).state).toBe(
      'healthy'
    );
    expect(
      fs.readFileSync(path.join(dir, 'health-events.jsonl'), 'utf8').trim().split('\n')
    ).toHaveLength(1);
    expect(fs.statSync(path.join(dir, 'health.json')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, 'health-events.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('records a new event for a fatal executor observation without touching other files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sentinel-'));
    dirs.push(dir);
    const { input, policy } = fixtures();
    expect(runSentinel(dir, input, policy).status).toBe(0);
    const failed = {
      ...input,
      nowMs: 101,
      executor: { processAlive: false, identityMatches: false },
    };
    expect(runSentinel(dir, failed, policy).status).toBe(0);
    const health = JSON.parse(fs.readFileSync(path.join(dir, 'health.json'), 'utf8'));
    expect(health.state).toBe('failed');
    expect(
      fs.readFileSync(path.join(dir, 'health-events.jsonl'), 'utf8').trim().split('\n')
    ).toHaveLength(2);
    expect(fs.existsSync(path.join(dir, 'input.json'))).toBe(true);
  });

  it('fails closed on an incomplete policy without writing health state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sentinel-'));
    dirs.push(dir);
    const { input, policy } = fixtures();
    const result = runSentinel(dir, input, { ...policy, disk: undefined });
    expect(result.status).toBe(2);
    expect(fs.existsSync(path.join(dir, 'health.json'))).toBe(false);
  });
});
