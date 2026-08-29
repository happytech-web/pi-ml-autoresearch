import { createHash } from 'node:crypto';

export type HealthState = 'healthy' | 'degraded' | 'failed' | 'unknown' | 'recovered' | 'completed';

export type HealthSeverity = 'info' | 'warning' | 'critical';

export type HealthReasonCode =
  | 'executor-not-running'
  | 'executor-identity-mismatch'
  | 'fatal-signature'
  | 'nan-or-inf'
  | 'progress-stale'
  | 'disk-headroom-low'
  | 'disk-headroom-critical'
  | 'inode-headroom-low'
  | 'inode-headroom-critical'
  | 'sentinel-heartbeat-stale'
  | 'observation-unavailable'
  | 'terminal-verified'
  | 'progress-restored';

export interface ProgressSignal {
  runId: string;
  attemptId: string;
  phase: string;
  step?: number;
  epoch?: number;
  sequence: number;
  timestampMs: number;
  finiteMetrics?: boolean;
}

export interface DiskObservation {
  availableBytes: number;
  availablePercent: number;
  availableInodes: number;
}

export interface HealthPolicy {
  stale: {
    warningMs: number;
    confirmationMs: number;
  };
  disk: {
    warningBytes: number;
    criticalBytes: number;
    warningPercent: number;
    criticalPercent: number;
    warningInodes: number;
    criticalInodes: number;
  };
  sentinelHeartbeatMaxAgeMs: number;
}

export interface HealthInput {
  nowMs: number;
  campaignId: string;
  runId: string;
  attemptId: string;
  sentinelHeartbeatAtMs?: number;
  executor: {
    processAlive: boolean;
    identityMatches: boolean;
  };
  progress?: ProgressSignal;
  disk?: DiskObservation;
  fatalSignatures?: string[];
  terminal?: {
    contractVerified: boolean;
    artifactsVerified: boolean;
    reconcileVerified: boolean;
    allRanksExited: boolean;
  };
  staleProbeCount?: number;
}

export interface HealthEvidence {
  detector: string;
  reasonCode: HealthReasonCode;
  severity: HealthSeverity;
  confidence: number;
  detail: string;
}

export interface HealthObservation {
  schemaVersion: 1;
  campaignId: string;
  runId: string;
  attemptId: string;
  observedAtMs: number;
  state: HealthState;
  evidence: HealthEvidence[];
  fingerprint: string;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(
  input: Pick<HealthObservation, 'campaignId' | 'runId' | 'attemptId' | 'state' | 'evidence'>
): string {
  const normalized = input.evidence
    .map(({ detector, reasonCode, severity, confidence }) => ({
      detector,
      reasonCode,
      severity,
      confidence,
    }))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  return `sha256:${createHash('sha256')
    .update(
      stableJson({
        campaignId: input.campaignId,
        runId: input.runId,
        attemptId: input.attemptId,
        state: input.state,
        evidence: normalized,
      })
    )
    .digest('hex')}`;
}

function evidence(
  detector: string,
  reasonCode: HealthReasonCode,
  severity: HealthSeverity,
  confidence: number,
  detail: string
): HealthEvidence {
  return { detector, reasonCode, severity, confidence, detail };
}

function isTerminalVerified(input: HealthInput): boolean {
  const terminal = input.terminal;
  return Boolean(
    terminal?.contractVerified &&
    terminal.artifactsVerified &&
    terminal.reconcileVerified &&
    terminal.allRanksExited
  );
}

export function observeHealth(
  policy: HealthPolicy,
  input: HealthInput,
  previousState?: HealthState
): HealthObservation {
  const evidence: HealthEvidence[] = [];
  const heartbeatAge =
    input.sentinelHeartbeatAtMs === undefined
      ? undefined
      : Math.max(0, input.nowMs - input.sentinelHeartbeatAtMs);
  if (heartbeatAge === undefined || heartbeatAge > policy.sentinelHeartbeatMaxAgeMs) {
    evidence.push(
      evidenceFn(
        'sentinel-heartbeat',
        'sentinel-heartbeat-stale',
        'warning',
        0.9,
        heartbeatAge === undefined
          ? 'sentinel heartbeat unavailable'
          : `heartbeat age ${heartbeatAge}ms`
      )
    );
  }

  if (!input.executor.processAlive) {
    evidence.push(
      evidenceFn(
        'executor',
        'executor-not-running',
        'critical',
        0.99,
        'executor process is not alive'
      )
    );
  } else if (!input.executor.identityMatches) {
    evidence.push(
      evidenceFn(
        'executor',
        'executor-identity-mismatch',
        'critical',
        0.99,
        'executor identity does not match campaign'
      )
    );
  }

  for (const signature of input.fatalSignatures ?? []) {
    evidence.push(evidenceFn('log-signature', 'fatal-signature', 'critical', 0.95, signature));
  }

  if (
    input.progress &&
    (input.progress.runId !== input.runId || input.progress.attemptId !== input.attemptId)
  ) {
    evidence.push(
      evidenceFn(
        'progress-contract',
        'observation-unavailable',
        'critical',
        0.99,
        'progress identity does not match run'
      )
    );
  }
  if (input.progress?.finiteMetrics === false) {
    evidence.push(
      evidenceFn(
        'progress-contract',
        'nan-or-inf',
        'critical',
        0.99,
        'progress metric contains NaN or Inf'
      )
    );
  }

  if (input.disk) {
    const { availableBytes, availablePercent, availableInodes } = input.disk;
    if (
      availableBytes <= policy.disk.criticalBytes ||
      availablePercent <= policy.disk.criticalPercent
    ) {
      evidence.push(
        evidenceFn(
          'disk',
          'disk-headroom-critical',
          'critical',
          0.99,
          `bytes=${availableBytes}, percent=${availablePercent}`
        )
      );
    } else if (
      availableBytes <= policy.disk.warningBytes ||
      availablePercent <= policy.disk.warningPercent
    ) {
      evidence.push(
        evidenceFn(
          'disk',
          'disk-headroom-low',
          'warning',
          0.95,
          `bytes=${availableBytes}, percent=${availablePercent}`
        )
      );
    }
    if (availableInodes <= policy.disk.criticalInodes) {
      evidence.push(
        evidenceFn(
          'inode',
          'inode-headroom-critical',
          'critical',
          0.99,
          `inodes=${availableInodes}`
        )
      );
    } else if (availableInodes <= policy.disk.warningInodes) {
      evidence.push(
        evidenceFn('inode', 'inode-headroom-low', 'warning', 0.95, `inodes=${availableInodes}`)
      );
    }
  } else {
    evidence.push(
      evidenceFn('disk', 'observation-unavailable', 'warning', 0.8, 'disk observation unavailable')
    );
  }

  if (input.progress) {
    const age = Math.max(0, input.nowMs - input.progress.timestampMs);
    if (age >= policy.stale.confirmationMs && (input.staleProbeCount ?? 0) >= 2) {
      evidence.push(
        evidenceFn('progress-stale', 'progress-stale', 'critical', 0.9, `progress age ${age}ms`)
      );
    } else if (age >= policy.stale.warningMs) {
      evidence.push(
        evidenceFn('progress-stale', 'progress-stale', 'warning', 0.85, `progress age ${age}ms`)
      );
    }
  } else {
    evidence.push(
      evidenceFn(
        'progress-contract',
        'observation-unavailable',
        'warning',
        0.8,
        'progress signal unavailable'
      )
    );
  }

  const hasCritical = evidence.some((item) => item.severity === 'critical');
  const hasWarning = evidence.some((item) => item.severity === 'warning');
  const hasUnknown = evidence.some(
    (item) =>
      item.reasonCode === 'observation-unavailable' ||
      item.reasonCode === 'sentinel-heartbeat-stale'
  );
  const state: HealthState =
    isTerminalVerified(input) && !hasCritical && !hasUnknown
      ? 'completed'
      : hasCritical
        ? 'failed'
        : hasUnknown
          ? 'unknown'
          : hasWarning
            ? 'degraded'
            : previousState === 'degraded' || previousState === 'unknown'
              ? 'recovered'
              : 'healthy';

  if (state === 'recovered') {
    evidence.push(
      evidenceFn(
        'state-machine',
        'progress-restored',
        'info',
        0.9,
        'health returned to a valid observable state'
      )
    );
  }
  const observation: HealthObservation = {
    schemaVersion: 1,
    campaignId: input.campaignId,
    runId: input.runId,
    attemptId: input.attemptId,
    observedAtMs: input.nowMs,
    state,
    evidence,
    fingerprint: '',
  };
  observation.fingerprint = fingerprint(observation);
  return observation;
}

const evidenceFn = evidence;
