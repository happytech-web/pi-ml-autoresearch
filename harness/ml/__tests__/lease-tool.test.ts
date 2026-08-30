import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import mlAutoresearch from '../../../extensions/pi-ml-autoresearch/index.js';
import { requestPtyLease, startPtyLeaseDaemon } from '../pty-lease.js';

const dirs: string[] = [];
const itPosix = process.platform === 'win32' ? it.skip : it;

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Pi ML connection lease tool', () => {
  itPosix(
    'routes status, ready, and probe through the shared lease client',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lease-tool-'));
      dirs.push(dir);
      const socket = path.join(dir, 'lease.sock');
      const state = path.join(dir, 'lease.json');
      const daemon = startPtyLeaseDaemon({
        socket,
        state,
        command: ['bash', '--noprofile', '--norc', '-i'],
        ttlSeconds: 5,
        probeTimeoutSeconds: 1,
        allowedProbePrefixes: ['printf'],
      });
      const registered: { execute: (...args: any[]) => Promise<any> }[] = [];
      const pi = {
        on: () => {},
        registerCommand: () => {},
        registerTool: (tool: { execute: (...args: any[]) => Promise<any> }) =>
          registered.push(tool),
      };
      mlAutoresearch(pi as any);
      const tool = registered.find((entry: any) => entry.name === 'ml_connection_lease')! as any;
      const ctx = { hasUI: true, ui: { confirm: async () => false } };
      try {
        const deadline = Date.now() + 3_000;
        while (!fs.existsSync(state)) {
          if (Date.now() >= deadline) throw new Error('timed out waiting for lease state');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const status = await tool.execute(
          'status',
          { action: 'status', socketPath: socket },
          undefined,
          undefined,
          ctx
        );
        expect(status.details.ok).toBe(true);
        expect(status.details.state.status).toBe('starting');
        const ready = await tool.execute(
          'ready',
          { action: 'ready', socketPath: socket },
          undefined,
          undefined,
          ctx
        );
        expect(ready.details.state.status).toBe('active');
        const probe = await tool.execute(
          'probe',
          { action: 'probe', socketPath: socket, command: 'printf PI-TOOL-REUSED' },
          undefined,
          undefined,
          ctx
        );
        expect(probe.details.ok).toBe(true);
        expect(probe.details.output).toContain('PI-TOOL-REUSED');
      } finally {
        await requestPtyLease(socket, { action: 'stop' });
        await new Promise((resolve) => daemon.once('exit', resolve));
      }
    },
    10_000
  );
});
