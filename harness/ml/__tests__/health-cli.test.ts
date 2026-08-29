import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { HealthInput, HealthPolicy } from '../health.js';

const dirs: string[] = [];
const cli = fileURLToPath(new URL('../../ml-cli.ts', import.meta.url));

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixtures(): { input: HealthInput; policy: HealthPolicy } {
  return {
    input: {
      nowMs: 100,
      campaignId: 'campaign-cli',
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

describe('health CLI boundary', () => {
  it('runs a read-only healthy probe in a child process', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-health-cli-'));
    dirs.push(dir);
    const { input, policy } = fixtures();
    const inputFile = path.join(dir, 'input.json');
    const policyFile = path.join(dir, 'policy.json');
    fs.writeFileSync(inputFile, `${JSON.stringify(input)}\n`);
    fs.writeFileSync(policyFile, `${JSON.stringify(policy)}\n`);
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', cli, 'health', '--input', inputFile, '--policy', policyFile],
      { encoding: 'utf8' }
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).state).toBe('healthy');
    expect(fs.readdirSync(dir)).toEqual(['input.json', 'policy.json']);
  });

  it('returns unknown for a stale sentinel lease without mutating input', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-health-cli-'));
    dirs.push(dir);
    const { input, policy } = fixtures();
    input.sentinelHeartbeatAtMs = 0;
    const inputFile = path.join(dir, 'input.json');
    const policyFile = path.join(dir, 'policy.json');
    const original = JSON.stringify(input);
    fs.writeFileSync(inputFile, `${original}\n`);
    fs.writeFileSync(policyFile, `${JSON.stringify(policy)}\n`);
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', cli, 'health', '--input', inputFile, '--policy', policyFile],
      { encoding: 'utf8' }
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).state).toBe('unknown');
    expect(fs.readFileSync(inputFile, 'utf8')).toBe(`${original}\n`);
  });
});
