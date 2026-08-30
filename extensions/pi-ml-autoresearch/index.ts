import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from '@sinclair/typebox';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../../harness/ml/campaign.js';
import { requestPtyLease } from '../../harness/ml/pty-lease.js';
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

  pi.registerTool({
    name: 'ml_connection_lease',
    label: 'ML connection lease',
    description:
      'Inspect or use an existing ML interactive connection lease. Probes are restricted by the allowlist declared when the lease daemon was started; this tool never starts blogin or retries TouchID.',
    promptSnippet: 'Inspect or use an existing authenticated ML connection lease',
    promptGuidelines: [
      'Use ml_connection_lease for declared remote status/health probes when a lease socket is available.',
      'Use ml_connection_lease status before any probe and treat reauth-required as unknown until the user explicitly reauthenticates.',
      'Use ml_connection_lease reauth only after the user has confirmed that a new TouchID/bootstrap is intended; never poll reauth in a loop.',
      'Do not use ml_connection_lease probe for training submission, arbitrary shell, file transfer, or configuration mutation.',
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('status'),
        Type.Literal('probe'),
        Type.Literal('ready'),
        Type.Literal('reauth'),
        Type.Literal('stop'),
      ]),
      socketPath: Type.String({ description: 'Absolute path to the 0600 lease Unix socket.' }),
      command: Type.Optional(
        Type.String({
          description: 'One bounded command matching the daemon allowlist (probe only).',
        })
      ),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!path.isAbsolute(params.socketPath) || params.socketPath.includes('\0')) {
        return {
          content: [
            { type: 'text', text: 'socketPath must be an absolute local Unix socket path' },
          ],
          details: { ok: false },
        };
      }
      if (params.action === 'probe' && !params.command?.trim()) {
        return {
          content: [{ type: 'text', text: 'command is required for probe' }],
          details: { ok: false },
        };
      }
      if (params.action === 'reauth') {
        if (!ctx.hasUI) {
          return {
            content: [
              {
                type: 'text',
                text: 'reauth requires an interactive user confirmation and TouchID',
              },
            ],
            details: { ok: false, code: 'interactive-confirmation-required' },
          };
        }
        const confirmed = await ctx.ui.confirm(
          'Re-authenticate ML connection?',
          'This starts the declared bootstrap and may request TouchID. Continue once?'
        );
        if (!confirmed) {
          return {
            content: [{ type: 'text', text: 'Re-authentication was declined by the user' }],
            details: { ok: false, code: 'user-declined' },
          };
        }
      }
      try {
        const request: Record<string, unknown> = { action: params.action };
        if (params.command !== undefined) request.command = params.command;
        if (params.timeoutMs !== undefined) request.timeoutMs = params.timeoutMs;
        const response = await requestPtyLease(params.socketPath, request);
        const output = response.output ? `\n${response.output}` : '';
        return {
          content: [{ type: 'text', text: `${JSON.stringify(response.state)}${output}` }],
          details: response,
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Lease request failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          details: { ok: false, error: error instanceof Error ? error.message : String(error) },
        };
      }
    },
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
