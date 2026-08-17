import * as path from 'node:path';
import type { MlSearchConfig } from '../../harness/ml/types.js';

export interface GoalRunStateEvent {
  type: 'state';
  runId: string;
  goalId: string;
  status: string;
  summary?: string;
  reason?: string;
}

export interface GoalRunErrorEvent {
  type: 'error';
  runId: string;
  operation: 'start' | 'cancel';
  error: { code: string; message: string };
}

export type GoalRunEvent = GoalRunStateEvent | GoalRunErrorEvent;

export function goalEventChannel(runId: string): string {
  return `pi-goal:event:${runId}`;
}

export function buildGoalRunId(config: MlSearchConfig): string {
  const prefix = `ml-${config.experimentId}-${config.searchRevision}`
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  return `${prefix || 'ml-search'}-${Date.now()}`;
}

export function buildGoalObjective(campaignDir: string, config: MlSearchConfig): string {
  return [
    `Execute approved ML search ${config.experimentId} revision ${config.searchRevision}.`,
    `Campaign directory: ${path.resolve(campaignDir)}.`,
    `Use pi-ml-autoresearch and the campaign artifacts as the execution interface.`,
    `Agent level: ${config.agentLevel}. Do not expand candidates, axes, resources, code, data, evaluation, seeds, or budgets beyond search.json.`,
    `Hard ceilings: ${config.budget.maxTrials} trials, ${config.budget.maxParallel} parallel, ${config.budget.maxGpuHours} GPU-hours, ${config.budget.maxWallClockMinutes} minutes per trial, ${config.budget.maxFailures} failures, ${config.budget.maxRetriesPerTrial} retries per trial.`,
    `Primary metric: ${config.primaryMetric.name} (${config.primaryMetric.direction}).`,
    `Stop at promotion, contract change, budget/stopping condition, or evidence mismatch. Do not enter longer confirmation without user approval.`,
    `Before completion, reconcile events.jsonl with TRIALS.md and update RESULTS.md, the experiment index, reviewer findings, and handoff.`,
  ].join('\n');
}

export function isGoalRunEvent(value: unknown): value is GoalRunEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return (
    (event.type === 'state' || event.type === 'error') &&
    typeof event.runId === 'string' &&
    event.runId.length > 0
  );
}

export function isTerminalGoalEvent(event: GoalRunEvent): boolean {
  return event.type === 'error' || event.status !== 'active';
}
