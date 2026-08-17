import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../../harness/ml/campaign.js';
import { writeJsonAtomic } from '../../harness/ml/io.js';
import {
  buildGoalObjective,
  buildGoalRunId,
  goalEventChannel,
  isGoalRunEvent,
  isTerminalGoalEvent,
} from './goal-bridge.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function installShellAlias(): void {
  try {
    const binDir = path.join(getAgentDir(), 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const cli = path.join(__dirname, '..', '..', 'harness', 'pi-ml-autoresearch.mjs');
    const link = path.join(binDir, 'pi-ml-autoresearch');
    const content = `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`;
    if (!fs.existsSync(link) || fs.readFileSync(link, 'utf8') !== content) {
      fs.writeFileSync(link, content, { mode: 0o755 });
    }
  } catch {}
}

export default function mlAutoresearch(pi: ExtensionAPI): void {
  const activeSubscriptions = new Map<string, () => void>();

  pi.on('session_start', () => installShellAlias());
  pi.on('session_shutdown', () => {
    for (const unsubscribe of activeSubscriptions.values()) unsubscribe();
    activeSubscriptions.clear();
  });

  pi.registerCommand('ml-search-goal', {
    description: 'Start an optional pi-goal managed run for an approved ML campaign',
    handler: async (args, ctx) => {
      const raw = (args ?? '').trim();
      if (!raw) {
        ctx.ui.notify('Usage: /ml-search-goal <campaign-dir>', 'warning');
        return;
      }
      const campaignDir = path.resolve(ctx.cwd, raw);
      let config;
      try {
        config = loadConfig(campaignDir);
      } catch (error) {
        ctx.ui.notify(
          `Cannot load approved ML campaign: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        );
        return;
      }

      const cacheFile = path.join(campaignDir, 'goal-run.json');
      if (fs.existsSync(cacheFile)) {
        try {
          const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as {
            runId?: string;
            event?: { type?: string; status?: string };
          };
          if (
            cache.runId &&
            (cache.event?.type === 'requested' ||
              (cache.event?.type === 'state' && cache.event.status === 'active'))
          ) {
            ctx.ui.notify(
              `Campaign already has an active/requested goal run: ${cache.runId}`,
              'warning'
            );
            return;
          }
        } catch (error) {
          ctx.ui.notify(
            `Cannot validate existing goal bridge cache: ${error instanceof Error ? error.message : String(error)}`,
            'error'
          );
          return;
        }
      }
      const runId = buildGoalRunId(config);
      let received = false;
      const unsubscribe = pi.events.on(goalEventChannel(runId), (value) => {
        if (!isGoalRunEvent(value) || value.runId !== runId) return;
        received = true;
        writeJsonAtomic(cacheFile, {
          runId,
          campaignDir,
          event: value,
          updatedAt: new Date().toISOString(),
        });
        if (value.type === 'error') {
          ctx.ui.notify(
            `pi-goal bridge unavailable (${value.error.code}): ${value.error.message}. Campaign remains usable without the bridge.`,
            'warning'
          );
        } else {
          ctx.ui.notify(
            `ML search goal: ${value.status}${value.reason ? ` — ${value.reason}` : ''}`,
            'info'
          );
        }
        if (isTerminalGoalEvent(value)) {
          unsubscribe();
          activeSubscriptions.delete(runId);
        }
      });
      activeSubscriptions.set(runId, unsubscribe);
      writeJsonAtomic(cacheFile, {
        runId,
        campaignDir,
        event: { type: 'requested' },
        updatedAt: new Date().toISOString(),
      });
      pi.events.emit('pi-goal:start', {
        runId,
        objective: buildGoalObjective(campaignDir, config),
      });
      setTimeout(() => {
        if (!received && activeSubscriptions.has(runId)) {
          writeJsonAtomic(cacheFile, {
            runId,
            campaignDir,
            event: { type: 'unavailable' },
            updatedAt: new Date().toISOString(),
          });
          ctx.ui.notify(
            'No pi-goal RPC response. Install/enable @narumitw/pi-goal RPC or run the campaign without the optional goal bridge.',
            'warning'
          );
        }
      }, 3_000).unref();
    },
  });

  pi.registerCommand('ml-search-goal-cancel', {
    description: 'Cancel the pi-goal managed run associated with an ML campaign',
    handler: async (args, ctx) => {
      const raw = (args ?? '').trim();
      if (!raw) {
        ctx.ui.notify('Usage: /ml-search-goal-cancel <campaign-dir>', 'warning');
        return;
      }
      const campaignDir = path.resolve(ctx.cwd, raw);
      const cacheFile = path.join(campaignDir, 'goal-run.json');
      try {
        const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { runId?: string };
        if (!cache.runId) throw new Error('goal-run.json has no runId');
        pi.events.emit('pi-goal:cancel', {
          runId: cache.runId,
          reason: 'ML campaign goal cancelled by operator',
        });
        ctx.ui.notify(
          'Goal cancellation requested. This does not stop a running trial; use pi-ml-autoresearch cancel and verify terminal status separately.',
          'warning'
        );
      } catch (error) {
        ctx.ui.notify(
          `Cannot cancel ML search goal: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        );
      }
    },
  });
}
