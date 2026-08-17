import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSearchConfig, validateTrialSpec } from './campaign.js';
import { ensureDir, readJson, writeJsonAtomic } from './io.js';
import type { MlRemoteQueue, MlSearchConfig, MlTrialSpec } from './types.js';

function validateQueue(config: MlSearchConfig, queue: MlRemoteQueue): void {
  if (queue.schemaVersion !== 1) throw new Error('Unsupported remote queue schemaVersion');
  if (queue.searchRevision !== config.searchRevision) {
    throw new Error('Remote queue searchRevision does not match search.json');
  }
  if (!Array.isArray(queue.trials) || queue.trials.length === 0) {
    throw new Error('Remote queue must contain at least one trial');
  }
  const maximumRuns = config.budget.maxTrials * (1 + config.budget.maxRetriesPerTrial);
  if (queue.trials.length > maximumRuns) {
    throw new Error('Remote queue exceeds the approved trial and retry ceiling');
  }

  const runs = new Map<string, MlTrialSpec>();
  const retries = new Map<string, number>();
  const uniqueTrials = new Set<string>();
  for (const trial of queue.trials) {
    validateTrialSpec(config, trial);
    for (const [name, value] of [
      ['workdir', trial.workdir],
      ['outputDir', trial.outputDir],
      ['metricFile', trial.metricFile],
    ]) {
      if (!path.isAbsolute(value)) {
        throw new Error(`${name} must be absolute on the final training host`);
      }
    }
    if (path.resolve(trial.metricFile) === path.resolve(trial.outputDir)) {
      throw new Error('metricFile must name a file below outputDir');
    }
    const commandKeys = Object.keys(trial.command).filter(
      (key) => key !== 'executable' && key !== 'args'
    );
    if (commandKeys.length > 0) {
      throw new Error(`command contains unsupported fields: ${commandKeys.sort().join(', ')}`);
    }
    const guardKeys = Object.keys(trial.guardCommand ?? {}).filter(
      (key) => key !== 'executable' && key !== 'args'
    );
    if (guardKeys.length > 0) {
      throw new Error(`guardCommand contains unsupported fields: ${guardKeys.sort().join(', ')}`);
    }
    const budgetKeys = Object.keys(trial.budget).filter(
      (key) => !['stepLimit', 'wallClockMinutes', 'gpuCount', 'gpuHours'].includes(key)
    );
    if (budgetKeys.length > 0) {
      throw new Error(`budget contains unsupported fields: ${budgetKeys.sort().join(', ')}`);
    }
    if (runs.has(trial.runId)) throw new Error(`Duplicate runId in remote queue: ${trial.runId}`);
    uniqueTrials.add(trial.trialId);
    if (trial.retryOfRunId) {
      const prior = runs.get(trial.retryOfRunId);
      if (!prior || prior.trialId !== trial.trialId) {
        throw new Error('Remote retry must reference an earlier run for the same trial');
      }
      const count = (retries.get(trial.trialId) ?? 0) + 1;
      if (count > config.budget.maxRetriesPerTrial) {
        throw new Error(`Remote queue retry ceiling exceeded: ${trial.trialId}`);
      }
      retries.set(trial.trialId, count);
    } else if ([...runs.values()].some((prior) => prior.trialId === trial.trialId)) {
      throw new Error('Repeated remote trial must declare retryOfRunId');
    }
    runs.set(trial.runId, trial);
  }
  if (uniqueTrials.size > config.budget.maxTrials) {
    throw new Error('Remote queue exceeds the approved unique trial ceiling');
  }
}

export function packRemoteBundle(
  configFile: string,
  trialFiles: string[],
  outputDir: string
): MlRemoteQueue {
  const config = readJson<MlSearchConfig>(configFile);
  validateSearchConfig(config);
  const queue: MlRemoteQueue = {
    schemaVersion: 1,
    searchRevision: config.searchRevision,
    trials: trialFiles.map((file) => readJson<MlTrialSpec>(file)),
  };
  validateQueue(config, queue);

  if (fs.existsSync(outputDir) && fs.readdirSync(outputDir).length > 0) {
    throw new Error(`Remote bundle output is not empty: ${outputDir}`);
  }
  ensureDir(outputDir);
  writeJsonAtomic(path.join(outputDir, 'search.json'), config);
  writeJsonAtomic(path.join(outputDir, 'queue.json'), queue);
  const executor = fileURLToPath(new URL('../ml-remote-executor.py', import.meta.url));
  const bundledExecutor = path.join(outputDir, 'remote-executor.py');
  fs.copyFileSync(executor, bundledExecutor);
  fs.chmodSync(bundledExecutor, 0o755);
  return queue;
}
