export type MetricDirection = 'lower' | 'higher';
export type AgentLevel = 1 | 2;

export type TrialStatus =
  | 'planned'
  | 'preflight'
  | 'running'
  | 'pilot-complete'
  | 'promoted'
  | 'confirmation'
  | 'completed'
  | 'failed'
  | 'invalid'
  | 'abandoned';

export interface MlSearchConfig {
  schemaVersion: 1;
  experimentId: string;
  searchRevision: string;
  approval: 'approved';
  agentLevel: AgentLevel;
  primaryMetric: {
    name: string;
    direction: MetricDirection;
    minimumMeaningfulImprovement?: number;
    target?: number;
  };
  budget: {
    maxTrials: number;
    maxParallel: number;
    maxGpuHours: number;
    maxWallClockMinutes: number;
    maxFailures: number;
    maxRetriesPerTrial: number;
    maxLevel2Cycles?: number;
  };
  approvedTrials: Array<{
    trialId: string;
    contractHash: string;
  }>;
  paths: {
    trialsMarkdown: string;
    outputRoot: string;
  };
}

export interface CommandSpec {
  executable: string;
  args?: string[];
}

export interface MlTrialSpec {
  schemaVersion: 1;
  trialId: string;
  runId: string;
  searchRevision: string;
  phase: 'pilot' | 'confirmation';
  seed: number;
  configHash: string;
  gitSha: string;
  workdir: string;
  outputDir: string;
  command: CommandSpec;
  guardCommand?: CommandSpec;
  metricFile: string;
  checkpoint?: string;
  dataset: string;
  split: string;
  retryOfRunId?: string;
  budget: {
    stepLimit: number;
    wallClockMinutes: number;
    gpuCount: number;
    gpuHours: number;
  };
}

export type MlEventType =
  | 'campaign-initialized'
  | 'trial-preflight'
  | 'trial-started'
  | 'trial-finished'
  | 'trial-cancelled';

export interface MlEvent {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  timestamp: string;
  type: MlEventType;
  experimentId: string;
  searchRevision: string;
  trialId?: string;
  runId?: string;
  status?: TrialStatus;
  metric?: number;
  secondaryMetrics?: Record<string, number>;
  gpuHours?: number;
  detail?: string;
  trial?: MlTrialSpec;
  configDigest?: string;
}

export interface CampaignSnapshot {
  config: MlSearchConfig;
  events: MlEvent[];
  latestByTrial: Map<string, MlEvent>;
  activeRuns: MlEvent[];
  totalGpuHours: number;
  failures: number;
}

export interface LedgerReconciliation {
  ok: boolean;
  missingEventIds: string[];
  extraEventIds: string[];
}
