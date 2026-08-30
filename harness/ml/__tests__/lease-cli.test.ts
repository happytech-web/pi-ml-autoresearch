import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { requestPtyLease, startPtyLeaseDaemon } from '../pty-lease.js';

const dirs: string[] = [];
const cli = path.resolve('harness/ml-lease-cli.mjs');
const itPosix = process.platform === 'win32' ? it.skip : it;

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function run(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

async function waitForState(file: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for lease state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('agent-facing lease CLI', () => {
  itPosix(
    'uses one daemon/socket for status, readiness and bounded probe',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lease-cli-'));
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
      try {
        await waitForState(state);
        const status = run(['status', '--socket', socket]);
        expect(status.status, status.stderr).toBe(0);
        expect(JSON.parse(status.stdout).state.status).toBe('starting');

        const ready = run(['ready', '--socket', socket]);
        expect(ready.status, ready.stderr).toBe(0);
        expect(JSON.parse(ready.stdout).state.status).toBe('active');

        const probe = run(['probe', '--socket', socket, '--command', 'printf CLI-REUSED']);
        expect(probe.status, probe.stderr).toBe(0);
        const response = JSON.parse(probe.stdout);
        expect(response.ok).toBe(true);
        expect(response.output).toContain('CLI-REUSED');
      } finally {
        await requestPtyLease(socket, { action: 'stop' });
        await new Promise((resolve) => daemon.once('exit', resolve));
      }
    },
    10_000
  );

  it('returns a non-zero result without attempting reauthentication when the lease is unavailable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lease-cli-'));
    dirs.push(dir);
    const result = run([
      'probe',
      '--socket',
      path.join(dir, 'missing.sock'),
      '--command',
      'printf NOPE',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ENOENT');
  });
});
