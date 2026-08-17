#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { initCampaign, reconcileCampaign, snapshot, trialContractHash } from './ml/campaign.js';
import { cancelLocalTrial, pollLocalTrial, submitLocalTrial } from './ml/local-runner.js';
import { readJson } from './ml/io.js';
import type { MlSearchConfig, MlTrialSpec } from './ml/types.js';

function flag(args: string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function usage(): string {
  return `pi-ml-autoresearch — bounded ML trial harness

Usage:
  pi-ml-autoresearch init --campaign <dir> --config <search.json>
  pi-ml-autoresearch hash-trial --trial <trial.json>
  pi-ml-autoresearch submit --campaign <dir> --trial <trial.json>
  pi-ml-autoresearch poll --campaign <dir> --trial-id <id>
  pi-ml-autoresearch cancel --campaign <dir> --trial-id <id>
  pi-ml-autoresearch status --campaign <dir>
  pi-ml-autoresearch reconcile --campaign <dir>
`;
}

function output(value: unknown): void {
  process.stdout.write(
    `${JSON.stringify(value, (_key, item) => (item instanceof Map ? Object.fromEntries(item) : item), 2)}\n`
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const action = args.shift();
  if (!action || action === '--help' || action === '-h') {
    process.stdout.write(usage());
    return;
  }
  if (action === 'hash-trial') {
    const trial = readJson<MlTrialSpec>(path.resolve(flag(args, 'trial')));
    output({ trialId: trial.trialId, contractHash: trialContractHash(trial) });
    return;
  }
  const campaignDir = path.resolve(flag(args, 'campaign'));
  switch (action) {
    case 'init':
      output(
        initCampaign(campaignDir, readJson<MlSearchConfig>(path.resolve(flag(args, 'config'))))
      );
      break;
    case 'submit':
      output(
        submitLocalTrial(campaignDir, readJson<MlTrialSpec>(path.resolve(flag(args, 'trial'))))
      );
      break;
    case 'poll':
      output(pollLocalTrial(campaignDir, flag(args, 'trial-id')));
      break;
    case 'cancel':
      output(cancelLocalTrial(campaignDir, flag(args, 'trial-id')));
      break;
    case 'status':
      output(snapshot(campaignDir));
      break;
    case 'reconcile': {
      const result = reconcileCampaign(campaignDir);
      output(result);
      if (!result.ok) process.exitCode = 2;
      break;
    }
    default:
      throw new Error(`Unknown action: ${action}\n${usage()}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
