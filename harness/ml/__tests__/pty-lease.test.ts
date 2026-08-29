import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { requestPtyLease, startPtyLeaseDaemon } from '../pty-lease.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for PTY lease daemon');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('independent PTY connection lease daemon', () => {
  it('reuses one authenticated PTY across independent client requests', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pty-lease-'));
    dirs.push(dir);
    const socket = path.join(dir, 'lease.sock');
    const state = path.join(dir, 'lease.json');
    const daemon = startPtyLeaseDaemon({
      socket,
      state,
      command: ['bash', '--noprofile', '--norc', '-i'],
      ttlSeconds: 5,
      probeTimeoutSeconds: 1,
    });
    await waitFor(() => fs.existsSync(state));
    const first = await requestPtyLease(socket, { action: 'probe', command: 'printf FIRST' });
    const second = await requestPtyLease(socket, { action: 'probe', command: 'printf SECOND' });
    expect(first.ok).toBe(true);
    expect(first.output).toContain('FIRST');
    expect(second.ok).toBe(true);
    expect(second.output).toContain('SECOND');
    expect(first.state.leaseId).toBe(second.state.leaseId);
    expect(first.state.pid).toBe(second.state.pid);
    expect(fs.statSync(socket).mode & 0o777).toBe(0o600);
    expect(fs.statSync(state).mode & 0o777).toBe(0o600);
    const stopped = await requestPtyLease(socket, { action: 'stop' });
    expect(stopped.ok).toBe(true);
    expect(stopped.state.status).toBe('stopped');
    expect(await new Promise<number | null>((resolve) => daemon.once('exit', resolve))).toBe(0);
  }, 10_000);

  it('transitions to reauth-required at TTL expiry without restarting authentication', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pty-lease-'));
    dirs.push(dir);
    const socket = path.join(dir, 'lease.sock');
    const state = path.join(dir, 'lease.json');
    const daemon = startPtyLeaseDaemon({
      socket,
      state,
      command: ['bash', '--noprofile', '--norc', '-i'],
      ttlSeconds: 0.08,
      probeTimeoutSeconds: 1,
    });
    await waitFor(() => fs.existsSync(state));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const expired = await requestPtyLease(socket, { action: 'status' });
    expect(expired.ok).toBe(true);
    expect(expired.state.status).toBe('reauth-required');
    const refused = await requestPtyLease(socket, { action: 'probe', command: 'printf BAD' });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('reauthentication required');
    expect((await requestPtyLease(socket, { action: 'stop' })).state.status).toBe('stopped');
    expect(await new Promise<number | null>((resolve) => daemon.once('exit', resolve))).toBe(0);
  }, 10_000);

  it('marks a relay/bootstrap EOF as reauth-required and never auto-restarts it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pty-lease-'));
    dirs.push(dir);
    const socket = path.join(dir, 'lease.sock');
    const state = path.join(dir, 'lease.json');
    const daemon = startPtyLeaseDaemon({
      socket,
      state,
      command: ['bash', '-lc', 'exit 0'],
      ttlSeconds: 5,
    });
    await waitFor(() => fs.existsSync(state));
    await waitFor(() => JSON.parse(fs.readFileSync(state, 'utf8')).status === 'reauth-required');
    const response = await requestPtyLease(socket, { action: 'status' });
    expect(response.state.status).toBe('reauth-required');
    expect(response.state.error).toContain('PTY exited');
    expect((await requestPtyLease(socket, { action: 'stop' })).state.status).toBe('stopped');
    expect(await new Promise<number | null>((resolve) => daemon.once('exit', resolve))).toBe(0);
  }, 10_000);
});
