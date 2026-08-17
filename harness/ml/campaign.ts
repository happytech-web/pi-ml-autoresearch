import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { appendMarkdownEvent, ensureTrialsMarkdown, reconcileLedger } from './ledger.js';
import { appendLine, ensureDir, readJson, resolveInside, writeJsonAtomic } from './io.js';
import type {
  CampaignSnapshot,
  LedgerReconciliation,
  MlEvent,
  MlSearchConfig,
  MlTrialSpec,
  TrialStatus,
} from './types.js';

const CONFIG_FILE = 'search.json';
const EVENTS_FILE = 'events.jsonl';
const WRITE_LOCK = '.campaign-write.lock';

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function trialContractHash(trial: MlTrialSpec): string {
  return digest({
    schemaVersion: trial.schemaVersion,
    trialId: trial.trialId,
    searchRevision: trial.searchRevision,
    phase: trial.phase,
    seed: trial.seed,
    configHash: trial.configHash,
    gitSha: trial.gitSha,
    workdir: path.resolve(trial.workdir),
    command: trial.command,
    guardCommand: trial.guardCommand,
    metricRelativePath: path.relative(
      path.resolve(trial.outputDir),
      path.resolve(trial.metricFile)
    ),
    checkpoint: trial.checkpoint,
    dataset: trial.dataset,
    split: trial.split,
    budget: trial.budget,
  });
}

function withWriteLock<T>(campaignDir: string, operation: () => T): T {
  const lock = path.join(campaignDir, WRITE_LOCK);
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Campaign is busy or requires lock recovery: ${lock}`);
    }
    throw error;
  }
  try {
    return operation();
  } finally {
    fs.rmdirSync(lock);
  }
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
}

function assertPositiveInteger(name: string, value: number): void {
  assertPositive(name, value);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a positive integer`);
}

function assertSafeId(name: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${name} must use 1-128 safe identifier characters`);
  }
}

function validateCommand(name: string, command: MlTrialSpec['command']): void {
  if (!command || typeof command.executable !== 'string' || !command.executable.trim()) {
    throw new Error(`${name}.executable is required`);
  }
  if (
    command.args !== undefined &&
    (!Array.isArray(command.args) || command.args.some((arg) => typeof arg !== 'string'))
  ) {
    throw new Error(`${name}.args must be an array of strings`);
  }
}

export function validateSearchConfig(config: MlSearchConfig): void {
  if (config.schemaVersion !== 1) throw new Error('Unsupported search schemaVersion');
  if (config.approval !== 'approved') throw new Error('Search revision is not approved');
  assertSafeId('experimentId', config.experimentId);
  assertSafeId('searchRevision', config.searchRevision);
  if (config.agentLevel !== 1 && config.agentLevel !== 2)
    throw new Error('agentLevel must be 1 or 2');
  if (config.primaryMetric.direction !== 'lower' && config.primaryMetric.direction !== 'higher') {
    throw new Error('primaryMetric.direction must be lower or higher');
  }
  if (!config.primaryMetric.name.trim()) throw new Error('primaryMetric.name is required');
  assertPositiveInteger('maxTrials', config.budget.maxTrials);
  assertPositiveInteger('maxParallel', config.budget.maxParallel);
  assertPositive('maxGpuHours', config.budget.maxGpuHours);
  assertPositive('maxWallClockMinutes', config.budget.maxWallClockMinutes);
  if (config.budget.maxParallel > config.budget.maxTrials) {
    throw new Error('maxParallel cannot exceed maxTrials');
  }
  assertPositiveInteger('maxFailures', config.budget.maxFailures);
  if (
    !Number.isSafeInteger(config.budget.maxRetriesPerTrial) ||
    config.budget.maxRetriesPerTrial < 0
  ) {
    throw new Error('maxRetriesPerTrial must be a non-negative integer');
  }
  if (config.agentLevel === 2) {
    assertPositiveInteger('maxLevel2Cycles', config.budget.maxLevel2Cycles ?? 0);
  }
  if (!Array.isArray(config.approvedTrials) || config.approvedTrials.length === 0) {
    throw new Error('approvedTrials must contain at least one approved trial contract');
  }
  if (config.approvedTrials.length > config.budget.maxTrials) {
    throw new Error('approvedTrials cannot exceed maxTrials');
  }
  const ids = new Set<string>();
  for (const approved of config.approvedTrials) {
    assertSafeId('approvedTrials.trialId', approved.trialId);
    if (!/^sha256:[0-9a-f]{64}$/.test(approved.contractHash)) {
      throw new Error('approvedTrials.contractHash must be a sha256 digest');
    }
    if (ids.has(approved.trialId)) throw new Error(`Duplicate approved trial: ${approved.trialId}`);
    ids.add(approved.trialId);
  }
  if (
    !config.paths ||
    typeof config.paths.trialsMarkdown !== 'string' ||
    !config.paths.trialsMarkdown.trim()
  ) {
    throw new Error('paths.trialsMarkdown is required');
  }
  if (typeof config.paths.outputRoot !== 'string' || !path.isAbsolute(config.paths.outputRoot)) {
    throw new Error('paths.outputRoot must be absolute');
  }
}

export function validateTrialSpec(config: MlSearchConfig, trial: MlTrialSpec): void {
  if (trial.schemaVersion !== 1) throw new Error('Unsupported trial schemaVersion');
  if (trial.searchRevision !== config.searchRevision) {
    throw new Error(
      `Trial searchRevision ${trial.searchRevision} does not match approved ${config.searchRevision}`
    );
  }
  for (const [name, value] of [
    ['trialId', trial.trialId],
    ['runId', trial.runId],
    ['configHash', trial.configHash],
    ['gitSha', trial.gitSha],
    ['workdir', trial.workdir],
    ['outputDir', trial.outputDir],
    ['metricFile', trial.metricFile],
    ['dataset', trial.dataset],
    ['split', trial.split],
  ]) {
    if (!String(value).trim()) throw new Error(`${name} is required`);
  }
  assertSafeId('trialId', trial.trialId);
  assertSafeId('runId', trial.runId);
  if (!/^sha256:[0-9a-f]{64}$/.test(trial.configHash)) {
    throw new Error('configHash must be a sha256 digest');
  }
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(trial.gitSha)) {
    throw new Error('gitSha must be a full SHA-1 or SHA-256 commit id');
  }
  if (trial.phase !== 'pilot') {
    throw new Error(
      'This runner only executes pilot trials; promotion and confirmation require a user checkpoint'
    );
  }
  if (!Number.isSafeInteger(trial.seed)) throw new Error('seed must be an integer');
  validateCommand('command', trial.command);
  if (trial.guardCommand) validateCommand('guardCommand', trial.guardCommand);
  assertPositiveInteger('stepLimit', trial.budget.stepLimit);
  assertPositive('trial wallClockMinutes', trial.budget.wallClockMinutes);
  assertPositiveInteger('gpuCount', trial.budget.gpuCount);
  assertPositive('trial gpuHours', trial.budget.gpuHours);
  if (trial.budget.wallClockMinutes > config.budget.maxWallClockMinutes) {
    throw new Error('Trial wall-clock budget exceeds approved ceiling');
  }
  if (path.resolve(trial.workdir) === path.resolve(trial.outputDir)) {
    throw new Error('outputDir must not be the workdir root');
  }
  resolveInside(config.paths.outputRoot, trial.outputDir);
  resolveInside(trial.outputDir, trial.metricFile);
  const maximumGpuHours = (trial.budget.wallClockMinutes / 60) * trial.budget.gpuCount;
  if (trial.budget.gpuHours < maximumGpuHours) {
    throw new Error('trial gpuHours must cover wallClockMinutes multiplied by gpuCount');
  }
  const approved = config.approvedTrials.find((item) => item.trialId === trial.trialId);
  if (!approved) throw new Error(`Trial is not in the approved search revision: ${trial.trialId}`);
  const actualHash = trialContractHash(trial);
  if (actualHash !== approved.contractHash) {
    throw new Error(`Trial contract does not match approved hash: ${trial.trialId}`);
  }
}

function configPath(campaignDir: string): string {
  return path.join(campaignDir, CONFIG_FILE);
}

function eventsPath(campaignDir: string): string {
  return path.join(campaignDir, EVENTS_FILE);
}

function trialsPath(campaignDir: string, config: MlSearchConfig): string {
  return path.resolve(campaignDir, config.paths.trialsMarkdown);
}

export function readEvents(campaignDir: string): MlEvent[] {
  const file = eventsPath(campaignDir);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MlEvent);
}

export function loadConfig(campaignDir: string): MlSearchConfig {
  const config = readJson<MlSearchConfig>(configPath(campaignDir));
  validateSearchConfig(config);
  return config;
}

function createEvent(
  config: MlSearchConfig,
  events: MlEvent[],
  input: Omit<
    MlEvent,
    'schemaVersion' | 'eventId' | 'sequence' | 'timestamp' | 'experimentId' | 'searchRevision'
  >
): MlEvent {
  return {
    schemaVersion: 1,
    eventId: `evt-${String(events.length + 1).padStart(6, '0')}-${randomUUID().slice(0, 8)}`,
    sequence: events.length + 1,
    timestamp: new Date().toISOString(),
    experimentId: config.experimentId,
    searchRevision: config.searchRevision,
    ...input,
  };
}

function appendEvent(campaignDir: string, config: MlSearchConfig, event: MlEvent): void {
  appendMarkdownEvent(trialsPath(campaignDir, config), event);
  appendLine(eventsPath(campaignDir), JSON.stringify(event));
}

export function initCampaign(campaignDir: string, config: MlSearchConfig): MlEvent {
  validateSearchConfig(config);
  ensureDir(campaignDir);
  if (fs.existsSync(configPath(campaignDir)) || fs.existsSync(eventsPath(campaignDir))) {
    throw new Error(`Campaign already exists: ${campaignDir}`);
  }
  const markdownFile = trialsPath(campaignDir, config);
  resolveInside(path.dirname(path.resolve(campaignDir)), markdownFile);
  if (!reconcileLedger([], markdownFile).ok) {
    throw new Error('TRIALS.md already contains runner events; use a dedicated campaign ledger');
  }
  writeJsonAtomic(configPath(campaignDir), config);
  ensureTrialsMarkdown(markdownFile);
  const event = createEvent(config, [], {
    type: 'campaign-initialized',
    status: 'planned',
    detail: `Approved search revision ${config.searchRevision}`,
    configDigest: digest(config),
  });
  appendEvent(campaignDir, config, event);
  return event;
}

export function snapshot(campaignDir: string): CampaignSnapshot {
  const config = loadConfig(campaignDir);
  const events = readEvents(campaignDir);
  const initialized = events[0];
  if (
    !initialized ||
    initialized.type !== 'campaign-initialized' ||
    initialized.configDigest !== digest(config) ||
    initialized.experimentId !== config.experimentId ||
    initialized.searchRevision !== config.searchRevision
  ) {
    throw new Error('search.json differs from the initialized immutable revision');
  }
  const latestByTrial = new Map<string, MlEvent>();
  for (const event of events) {
    if (event.trialId) latestByTrial.set(event.trialId, event);
  }
  const activeRuns = [...latestByTrial.values()].filter(
    (event) => event.status === 'preflight' || event.status === 'running'
  );
  const chargedGpuHours = events
    .filter((event) => event.type === 'trial-started')
    .reduce((sum, event) => sum + (event.gpuHours ?? 0), 0);
  const preflightGpuHours = [...latestByTrial.values()]
    .filter((event) => event.status === 'preflight')
    .reduce((sum, event) => sum + (event.gpuHours ?? 0), 0);
  const totalGpuHours = chargedGpuHours + preflightGpuHours;
  const failures = events.filter(
    (event) => event.type === 'trial-finished' && event.status === 'failed'
  ).length;
  return { config, events, latestByTrial, activeRuns, totalGpuHours, failures };
}

function assertLedgerReconciled(campaignDir: string, state: CampaignSnapshot): void {
  const result = reconcileLedger(state.events, trialsPath(campaignDir, state.config));
  if (!result.ok) throw new Error('Campaign ledger reconciliation failed; refusing state mutation');
}

export function preflightTrial(campaignDir: string, trial: MlTrialSpec): MlEvent {
  return withWriteLock(campaignDir, () => {
    const state = snapshot(campaignDir);
    assertLedgerReconciled(campaignDir, state);
    validateTrialSpec(state.config, trial);
    const startedTrials = new Set(
      state.events.filter((event) => event.type === 'trial-started').map((event) => event.trialId)
    );
    if (!startedTrials.has(trial.trialId) && startedTrials.size >= state.config.budget.maxTrials) {
      throw new Error('Approved trial ceiling reached');
    }
    if (state.activeRuns.length >= state.config.budget.maxParallel) {
      throw new Error('Approved parallelism ceiling reached');
    }
    if (state.totalGpuHours + trial.budget.gpuHours > state.config.budget.maxGpuHours) {
      throw new Error('Approved GPU-hour ceiling would be exceeded');
    }
    if (state.failures >= state.config.budget.maxFailures) {
      throw new Error('Failure ceiling reached');
    }
    const priorTrialEvent = state.latestByTrial.get(trial.trialId);
    if (priorTrialEvent?.status === 'running' || priorTrialEvent?.status === 'preflight') {
      throw new Error(`Trial already has an active run: ${trial.trialId}`);
    }
    if (priorTrialEvent && !trial.retryOfRunId) {
      throw new Error('A repeated trialId must declare retryOfRunId');
    }
    if ([...state.latestByTrial.values()].some((event) => event.runId === trial.runId)) {
      throw new Error(`runId already exists: ${trial.runId}`);
    }
    if (fs.existsSync(trial.outputDir) && fs.readdirSync(trial.outputDir).length > 0) {
      throw new Error(`outputDir is not empty: ${trial.outputDir}`);
    }
    if (trial.retryOfRunId) {
      const prior = [...state.events].reverse().find((event) => event.runId === trial.retryOfRunId);
      if (!prior || prior.status !== 'failed' || prior.trialId !== trial.trialId) {
        throw new Error('retryOfRunId must reference a failed run for the same trial');
      }
      const retries = state.events.filter(
        (event) =>
          event.type === 'trial-preflight' &&
          event.trialId === trial.trialId &&
          event.trial?.retryOfRunId
      ).length;
      if (retries >= state.config.budget.maxRetriesPerTrial) {
        throw new Error('Retry ceiling reached');
      }
    }
    const event = createEvent(state.config, state.events, {
      type: 'trial-preflight',
      trialId: trial.trialId,
      runId: trial.runId,
      status: 'preflight',
      gpuHours: trial.budget.gpuHours,
      detail: 'Preflight passed; launch is permitted for this approved revision',
      trial,
    });
    appendEvent(campaignDir, state.config, event);
    return event;
  });
}

export function markTrialStarted(campaignDir: string, trial: MlTrialSpec): MlEvent {
  return withWriteLock(campaignDir, () => {
    const state = snapshot(campaignDir);
    assertLedgerReconciled(campaignDir, state);
    const latest = state.latestByTrial.get(trial.trialId);
    if (latest?.runId !== trial.runId || latest.status !== 'preflight') {
      throw new Error('Trial must pass preflight immediately before launch');
    }
    const event = createEvent(state.config, state.events, {
      type: 'trial-started',
      trialId: trial.trialId,
      runId: trial.runId,
      status: 'running',
      gpuHours: trial.budget.gpuHours,
      detail: `Local runner started: ${trial.command.executable}`,
      trial,
    });
    appendEvent(campaignDir, state.config, event);
    return event;
  });
}

export function rejectTrialPreflight(
  campaignDir: string,
  trial: MlTrialSpec,
  detail: string
): MlEvent {
  return withWriteLock(campaignDir, () => {
    const state = snapshot(campaignDir);
    assertLedgerReconciled(campaignDir, state);
    const latest = state.latestByTrial.get(trial.trialId);
    if (latest?.runId !== trial.runId || latest.status !== 'preflight') {
      throw new Error('Only the active preflight can be rejected');
    }
    const event = createEvent(state.config, state.events, {
      type: 'trial-finished',
      trialId: trial.trialId,
      runId: trial.runId,
      status: 'invalid',
      detail,
      trial,
    });
    appendEvent(campaignDir, state.config, event);
    return event;
  });
}

const TERMINAL_STATUSES = new Set<TrialStatus>([
  'pilot-complete',
  'completed',
  'failed',
  'invalid',
  'abandoned',
]);

export function finishTrial(
  campaignDir: string,
  trialId: string,
  runId: string,
  status: TrialStatus,
  options: {
    metric?: number;
    secondaryMetrics?: Record<string, number>;
    detail?: string;
    gpuHours?: number;
  } = {}
): MlEvent {
  if (!TERMINAL_STATUSES.has(status)) throw new Error(`Not a terminal status: ${status}`);
  return withWriteLock(campaignDir, () => {
    const state = snapshot(campaignDir);
    assertLedgerReconciled(campaignDir, state);
    const latest = state.latestByTrial.get(trialId);
    if (!latest || latest.status !== 'running' || latest.runId !== runId) {
      throw new Error('Only the active run can be finished');
    }
    if (
      (status === 'pilot-complete' || status === 'completed') &&
      !Number.isFinite(options.metric)
    ) {
      throw new Error(`${status} requires a finite primary metric`);
    }
    const event = createEvent(state.config, state.events, {
      type: status === 'abandoned' ? 'trial-cancelled' : 'trial-finished',
      trialId,
      runId,
      status,
      metric: options.metric,
      secondaryMetrics: options.secondaryMetrics,
      gpuHours: options.gpuHours,
      detail: options.detail,
      trial: latest.trial,
    });
    appendEvent(campaignDir, state.config, event);
    return event;
  });
}

export function reconcileCampaign(campaignDir: string): LedgerReconciliation {
  const config = loadConfig(campaignDir);
  return reconcileLedger(readEvents(campaignDir), trialsPath(campaignDir, config));
}
