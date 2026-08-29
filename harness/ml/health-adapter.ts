import type { HealthInput } from './health.js';

export interface HealthInputReader {
  read(): HealthInput | unknown | Promise<HealthInput | unknown>;
}

export interface HealthInputIdentity {
  campaignId: string;
  runId: string;
  attemptId: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return finiteNumber(value) && Number.isInteger(value) && value >= 0;
}

export function validateHealthInputPayload(value: unknown): asserts value is HealthInput {
  if (!record(value)) throw new Error('health input must be a JSON object');
  for (const key of ['campaignId', 'runId', 'attemptId']) {
    if (typeof value[key] !== 'string' || !value[key].trim()) {
      throw new Error(`health input ${key} is required`);
    }
  }
  if (!record(value.executor)) {
    throw new Error('health input executor is required');
  }
  if (
    typeof value.executor.processAlive !== 'boolean' ||
    typeof value.executor.identityMatches !== 'boolean'
  ) {
    throw new Error('health input executor booleans are required');
  }
  if (value.sentinelHeartbeatAtMs !== undefined && !finiteNumber(value.sentinelHeartbeatAtMs)) {
    throw new Error('health input sentinelHeartbeatAtMs must be finite');
  }
  if (value.progress !== undefined) {
    if (!record(value.progress)) throw new Error('health input progress must be an object');
    if (typeof value.progress.runId !== 'string' || typeof value.progress.attemptId !== 'string') {
      throw new Error('health input progress identity is required');
    }
    if (typeof value.progress.phase !== 'string' || !nonNegativeInteger(value.progress.sequence)) {
      throw new Error('health input progress phase and sequence are required');
    }
    if (!finiteNumber(value.progress.timestampMs)) {
      throw new Error('health input progress timestampMs must be finite');
    }
    if (
      value.progress.finiteMetrics !== undefined &&
      typeof value.progress.finiteMetrics !== 'boolean'
    ) {
      throw new Error('health input progress finiteMetrics must be boolean');
    }
  }
  if (value.disk !== undefined) {
    if (!record(value.disk)) throw new Error('health input disk must be an object');
    for (const key of ['availableBytes', 'availablePercent', 'availableInodes']) {
      if (!finiteNumber(value.disk[key]) || value.disk[key] < 0) {
        throw new Error(`health input disk ${key} must be non-negative and finite`);
      }
    }
  }
  if (value.fatalSignatures !== undefined) {
    if (
      !Array.isArray(value.fatalSignatures) ||
      value.fatalSignatures.some((item) => typeof item !== 'string')
    ) {
      throw new Error('health input fatalSignatures must be an array of strings');
    }
  }
  if (value.staleProbeCount !== undefined && !nonNegativeInteger(value.staleProbeCount)) {
    throw new Error('health input staleProbeCount must be a non-negative integer');
  }
  if (value.terminal !== undefined) {
    const terminal = value.terminal;
    if (!record(terminal)) {
      throw new Error('health input terminal gates must be booleans');
    }
    if (
      ['contractVerified', 'artifactsVerified', 'reconcileVerified', 'allRanksExited'].some(
        (key) => typeof terminal[key] !== 'boolean'
      )
    ) {
      throw new Error('health input terminal gates must be booleans');
    }
  }
}

export async function readHealthInput(
  reader: HealthInputReader,
  identity: HealthInputIdentity,
  nowMs: () => number = () => Date.now()
): Promise<HealthInput> {
  const observed = await reader.read();
  validateHealthInputPayload(observed);
  if (
    observed.campaignId !== identity.campaignId ||
    observed.runId !== identity.runId ||
    observed.attemptId !== identity.attemptId
  ) {
    throw new Error('health input identity does not match the active campaign run');
  }
  const current = nowMs();
  if (!finiteNumber(current)) throw new Error('health adapter clock must return a finite number');
  return { ...observed, nowMs: current };
}
