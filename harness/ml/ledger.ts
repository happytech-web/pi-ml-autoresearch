import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendLine, ensureDir } from './io.js';
import type { LedgerReconciliation, MlEvent } from './types.js';

const HEADER = [
  '# ML Trial Ledger',
  '',
  '> Append-only project evidence. Runner JSONL is an operational event cache.',
  '',
  '| event_id | updated | search_revision | trial_id | run_id | retry_of_run | phase | event | status | git_sha | config_hash | dataset | split | seed | budget | output_dir | primary_metric | secondary_metrics | gpu_hours | checkpoint | failure_reason | decision | detail |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---:|---|---|---:|---|---:|---|---|---|---|',
].join('\n');

function escapeCell(value: unknown): string {
  return String(value ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('\n', '<br>');
}

export function eventToMarkdownRow(event: MlEvent): string {
  const trial = event.trial;
  const failureReason = ['failed', 'invalid', 'abandoned'].includes(event.status ?? '')
    ? event.detail
    : undefined;
  return `| ${[
    event.eventId,
    event.timestamp,
    event.searchRevision,
    event.trialId,
    event.runId,
    trial?.retryOfRunId,
    trial?.phase,
    event.type,
    event.status,
    trial?.gitSha,
    trial?.configHash,
    trial?.dataset,
    trial?.split,
    trial?.seed,
    trial?.budget ? JSON.stringify(trial.budget) : undefined,
    trial?.outputDir,
    event.metric,
    event.secondaryMetrics ? JSON.stringify(event.secondaryMetrics) : undefined,
    event.gpuHours,
    trial?.checkpoint,
    failureReason,
    event.status,
    event.detail,
  ]
    .map(escapeCell)
    .join(' | ')} |`;
}

export function ensureTrialsMarkdown(file: string): void {
  ensureDir(path.dirname(file));
  if (!fs.existsSync(file)) fs.writeFileSync(file, `${HEADER}\n`, 'utf8');
}

export function appendMarkdownEvent(file: string, event: MlEvent): void {
  ensureTrialsMarkdown(file);
  appendLine(file, eventToMarkdownRow(event));
}

export function readMarkdownEventRows(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('| evt-'));
}

export function reconcileLedger(events: MlEvent[], markdownFile: string): LedgerReconciliation {
  const expected = events.map(eventToMarkdownRow);
  const actual = readMarkdownEventRows(markdownFile);
  const missingEventIds = expected
    .filter((row, index) => actual[index] !== row)
    .map((row) => row.split('|')[1]?.trim())
    .filter((id): id is string => Boolean(id));
  const extraEventIds = actual
    .filter((row, index) => expected[index] !== row)
    .map((row) => row.split('|')[1]?.trim())
    .filter((id): id is string => Boolean(id));
  return {
    ok: missingEventIds.length === 0 && extraEventIds.length === 0,
    missingEventIds,
    extraEventIds,
  };
}
