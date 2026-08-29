import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { HealthInput, HealthPolicy } from '../health.js';

const dirs: string[] = [];
const cli = fileURLToPath(new URL('../../ml-cli.ts', import.meta.url));
const sentinel = path.resolve('harness/ml-health-sentinel.py');

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const policy: HealthPolicy = {
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

function input(overrides: Partial<HealthInput> = {}): HealthInput {
  return {
    nowMs: 100,
    campaignId: 'parity-campaign',
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
    ...overrides,
  };
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function runTs(inputFile: string, policyFile: string): Record<string, unknown> {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', cli, 'health', '--input', inputFile, '--policy', policyFile],
    { encoding: 'utf8' }
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function runPython(dir: string): Record<string, unknown> {
  const result = spawnSync(
    'python3',
    [
      sentinel,
      '--input',
      path.join(dir, 'input.json'),
      '--policy',
      path.join(dir, 'policy.json'),
      '--output',
      path.join(dir, 'health.json'),
      '--events',
      path.join(dir, 'events.jsonl'),
    ],
    { encoding: 'utf8' }
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(fs.readFileSync(path.join(dir, 'health.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

function comparable(observation: Record<string, unknown>) {
  return {
    schemaVersion: observation.schemaVersion,
    campaignId: observation.campaignId,
    runId: observation.runId,
    attemptId: observation.attemptId,
    observedAtMs: observation.observedAtMs,
    state: observation.state,
    evidence: observation.evidence,
    fingerprint: observation.fingerprint,
  };
}

describe('TypeScript/Python health implementation parity', () => {
  it.each([
    ['healthy', input()],
    [
      'failed with fatal and disk evidence',
      input({
        executor: { processAlive: false, identityMatches: false },
        fatalSignatures: ['CUDA out of memory'],
        disk: { availableBytes: 10, availablePercent: 1, availableInodes: 10 },
      }),
    ],
  ])('produces the same observation for %s', (_name, healthInput) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-health-parity-'));
    dirs.push(dir);
    const inputFile = path.join(dir, 'input.json');
    const policyFile = path.join(dir, 'policy.json');
    writeJson(inputFile, healthInput);
    writeJson(policyFile, policy);
    const tsObservation = runTs(inputFile, policyFile);
    const pythonObservation = runPython(dir);
    expect(comparable(pythonObservation)).toEqual(comparable(tsObservation));
  });
});
