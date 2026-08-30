import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPtyLeaseState, requestPtyLease, startPtyLeaseDaemon } from '../pty-lease.js';

const dirs: string[] = [];
const describePosix = process.platform === 'win32' ? describe.skip : describe;

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

describePosix('independent PTY connection lease daemon', () => {
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
      allowedProbePrefixes: ['printf'],
    });
    await waitFor(() => fs.existsSync(state));
    expect((await requestPtyLease(socket, { action: 'status' })).state.status).toBe('starting');
    expect((await requestPtyLease(socket, { action: 'ready' })).state.status).toBe('active');
    const first = await requestPtyLease(socket, { action: 'probe', command: 'printf FIRST' });
    const second = await requestPtyLease(socket, { action: 'probe', command: 'printf SECOND' });
    expect(first.ok).toBe(true);
    expect(first.output).toContain('FIRST');
    expect(second.ok).toBe(true);
    expect(second.output).toContain('SECOND');
    expect(first.state.leaseId).toBe(second.state.leaseId);
    expect(first.state.pid).toBe(second.state.pid);
    expect(first.state.readyDeadlineAtMs).toBeNull();
    expect(fs.statSync(socket).mode & 0o777).toBe(0o600);
    expect(fs.statSync(state).mode & 0o777).toBe(0o600);
    expect(readPtyLeaseState(state)?.leaseId).toBe(first.state.leaseId);
    const exited = new Promise<number | null>((resolve) => daemon.once('exit', resolve));
    const stopped = await requestPtyLease(socket, { action: 'stop' });
    expect(stopped.ok).toBe(true);
    expect(stopped.state.status).toBe('stopped');
    expect(stopped.state.pid).toBeNull();
    expect(await exited).toBe(0);
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
      allowedProbePrefixes: ['printf'],
    });
    await waitFor(() => fs.existsSync(state));
    expect((await requestPtyLease(socket, { action: 'ready' })).state.status).toBe('active');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const expired = await requestPtyLease(socket, { action: 'status' });
    expect(expired.ok).toBe(true);
    expect(expired.state.status).toBe('reauth-required');
    expect(expired.state.readyDeadlineAtMs).toBeNull();
    const refused = await requestPtyLease(socket, { action: 'probe', command: 'printf BAD' });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('reauthentication required');
    const exited = new Promise<number | null>((resolve) => daemon.once('exit', resolve));
    expect((await requestPtyLease(socket, { action: 'stop' })).state.status).toBe('stopped');
    expect(await exited).toBe(0);
  }, 10_000);

  it('fails a bootstrap that never becomes ready instead of leaving starting stuck', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pty-lease-'));
    dirs.push(dir);
    const socket = path.join(dir, 'lease.sock');
    const state = path.join(dir, 'lease.json');
    const daemon = startPtyLeaseDaemon({
      socket,
      state,
      command: ['bash', '--noprofile', '--norc', '-i'],
      ttlSeconds: 5,
      startupTimeoutSeconds: 0.08,
      probeTimeoutSeconds: 1,
      allowedProbePrefixes: ['printf'],
    });
    await waitFor(() => fs.existsSync(state));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const expired = await requestPtyLease(socket, { action: 'status' });
    expect(expired.state.status).toBe('reauth-required');
    expect(expired.state.error).toContain('readiness timed out');
    expect(expired.state.pid).toBeNull();
    expect(expired.state.readyDeadlineAtMs).toBeNull();
    const exited = new Promise<number | null>((resolve) => daemon.once('exit', resolve));
    expect((await requestPtyLease(socket, { action: 'stop' })).state.status).toBe('stopped');
    expect(await exited).toBe(0);
  }, 10_000);

  it('forwards a starting bootstrap through an ephemeral attach and keeps the lease reusable', async () => {
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
      allowedProbePrefixes: ['printf'],
    });
    await waitFor(() => fs.existsSync(state));
    await new Promise<void>((resolve, reject) => {
      const client = net.createConnection(socket);
      let buffer = '';
      let acknowledged = false;
      const timer = setTimeout(() => {
        client.destroy();
        reject(new Error('timed out waiting for attach output'));
      }, 3_000);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        client.destroy();
        if (error) reject(error);
        else resolve();
      };
      client.on('connect', () => client.write('{"action":"attach"}\n'));
      client.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (!acknowledged) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) return;
          const response = JSON.parse(buffer.slice(0, newline)) as { ok: boolean; attached?: boolean };
          expect(response.ok).toBe(true);
          expect(response.attached).toBe(true);
          acknowledged = true;
          buffer = buffer.slice(newline + 1);
          client.write('printf ATTACHED\\n');
        }
        if (buffer.includes('ATTACHED')) finish();
      });
      client.on('error', finish);
    });
    expect((await requestPtyLease(socket, { action: 'ready' })).state.status).toBe('active');
    expect(
      (await requestPtyLease(socket, { action: 'probe', command: 'printf AFTER-ATTACH' })).output
    ).toContain('AFTER-ATTACH');
    const refused = await requestPtyLease(socket, { action: 'attach' });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('only allowed while bootstrap is starting');
    const exited = new Promise<number | null>((resolve) => daemon.once('exit', resolve));
    expect((await requestPtyLease(socket, { action: 'stop' })).state.status).toBe('stopped');
    expect(await exited).toBe(0);
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
      allowedProbePrefixes: ['printf'],
    });
    await waitFor(() => fs.existsSync(state));
    await waitFor(() => JSON.parse(fs.readFileSync(state, 'utf8')).status === 'reauth-required');
    const response = await requestPtyLease(socket, { action: 'status' });
    expect(response.state.status).toBe('reauth-required');
    expect(response.state.pid).toBeNull();
    expect(response.state.readyDeadlineAtMs).toBeNull();
    expect(response.state.error).toContain('PTY exited');
    const exited = new Promise<number | null>((resolve) => daemon.once('exit', resolve));
    expect((await requestPtyLease(socket, { action: 'stop' })).state.status).toBe('stopped');
    expect(await exited).toBe(0);
  }, 10_000);

  it('requires explicit reauth after expiry and resumes with a new lease', async () => {
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
      allowedProbePrefixes: ['printf'],
    });
    await waitFor(() => fs.existsSync(state));
    const before = await requestPtyLease(socket, { action: 'status' });
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    expect((await requestPtyLease(socket, { action: 'status' })).state.status).toBe(
      'reauth-required'
    );

    const reauthed = await requestPtyLease(socket, { action: 'reauth' });
    expect(reauthed.ok).toBe(true);
    expect(reauthed.state.status).toBe('starting');
    expect(reauthed.state.leaseId).not.toBe(before.state.leaseId);
    const ready = await requestPtyLease(socket, { action: 'ready' });
    expect(ready.state.status).toBe('active');
    const probe = await requestPtyLease(socket, { action: 'probe', command: 'printf RECOVERED' });
    expect(probe.ok).toBe(true);
    expect(probe.output).toContain('RECOVERED');
    const exited = new Promise<number | null>((resolve) => daemon.once('exit', resolve));
    expect((await requestPtyLease(socket, { action: 'stop' })).state.status).toBe('stopped');
    expect(await exited).toBe(0);
  }, 10_000);

  it('rejects reauth while the current lease is active', async () => {
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
      allowedProbePrefixes: ['printf'],
    });
    await waitFor(() => fs.existsSync(state));
    expect((await requestPtyLease(socket, { action: 'ready' })).state.status).toBe('active');
    const refused = await requestPtyLease(socket, { action: 'reauth' });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('only allowed');
    expect(refused.state.status).toBe('active');
    const exited = new Promise<number | null>((resolve) => daemon.once('exit', resolve));
    expect((await requestPtyLease(socket, { action: 'stop' })).state.status).toBe('stopped');
    expect(await exited).toBe(0);
  }, 10_000);

  it('expires an unfinished reauth instead of leaving the lease stuck in starting', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pty-lease-'));
    dirs.push(dir);
    const socket = path.join(dir, 'lease.sock');
    const state = path.join(dir, 'lease.json');
    const daemon = startPtyLeaseDaemon({
      socket,
      state,
      command: ['bash', '--noprofile', '--norc', '-i'],
      ttlSeconds: 0.15,
      probeTimeoutSeconds: 1,
      allowedProbePrefixes: ['printf'],
    });
    await waitFor(() => fs.existsSync(state));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await requestPtyLease(socket, { action: 'status' })).state.status).toBe(
      'reauth-required'
    );
    const reauthed = await requestPtyLease(socket, { action: 'reauth' });
    expect(reauthed.state.status).toBe('starting');
    await new Promise((resolve) => setTimeout(resolve, 250));
    const expired = await requestPtyLease(socket, { action: 'status' });
    expect(expired.state.status).toBe('reauth-required');
    const ready = await requestPtyLease(socket, { action: 'ready' });
    expect(ready.ok).toBe(false);
    expect(ready.error).toContain('waiting for bootstrap readiness');
    const exited = new Promise<number | null>((resolve) => daemon.once('exit', resolve));
    expect((await requestPtyLease(socket, { action: 'stop' })).state.status).toBe('stopped');
    expect(await exited).toBe(0);
  }, 10_000);

  it('keeps a multi-hop-style bootstrap alive until relay EOF and never auto-restarts it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pty-lease-'));
    dirs.push(dir);
    const socket = path.join(dir, 'lease.sock');
    const state = path.join(dir, 'lease.json');
    const count = path.join(dir, 'bootstrap-count');
    const bootstrap = path.join(dir, 'bootstrap.py');
    fs.writeFileSync(
      bootstrap,
      [
        'import os, pathlib, sys',
        'p = pathlib.Path(sys.argv[1])',
        'p.write_text(str(int(p.read_text()) + 1) if p.exists() else "1")',
        'os.execvp("bash", ["bash", "--noprofile", "--norc", "-i"])',
        '',
      ].join('\n')
    );
    const daemon = startPtyLeaseDaemon({
      socket,
      state,
      command: ['python3', bootstrap, count],
      ttlSeconds: 5,
      probeTimeoutSeconds: 1,
      allowedProbePrefixes: ['printf'],
    });
    await waitFor(() => fs.existsSync(state));
    const initial = await requestPtyLease(socket, { action: 'status' });
    await waitFor(() => fs.existsSync(count));
    expect(fs.readFileSync(count, 'utf8')).toBe('1');
    expect((await requestPtyLease(socket, { action: 'ready' })).state.status).toBe('active');
    expect(
      (await requestPtyLease(socket, { action: 'probe', command: 'printf HOP' })).output
    ).toContain('HOP');
    process.kill(initial.state.pid!, 'SIGKILL');
    await waitFor(() => JSON.parse(fs.readFileSync(state, 'utf8')).status === 'reauth-required');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fs.readFileSync(count, 'utf8')).toBe('1');
    const reauthed = await requestPtyLease(socket, { action: 'reauth' });
    await waitFor(() => fs.readFileSync(count, 'utf8') === '2');
    expect(reauthed.state.status).toBe('starting');
    expect((await requestPtyLease(socket, { action: 'ready' })).state.status).toBe('active');
    expect(
      (await requestPtyLease(socket, { action: 'probe', command: 'printf REAUTH-HOP' })).output
    ).toContain('REAUTH-HOP');
    const exited = new Promise<number | null>((resolve) => daemon.once('exit', resolve));
    expect((await requestPtyLease(socket, { action: 'stop' })).state.status).toBe('stopped');
    expect(await exited).toBe(0);
  }, 10_000);

  it('rejects arbitrary commands when no declared probe prefix matches', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pty-lease-'));
    dirs.push(dir);
    const socket = path.join(dir, 'lease.sock');
    const state = path.join(dir, 'lease.json');
    const daemon = startPtyLeaseDaemon({
      socket,
      state,
      command: ['bash', '--noprofile', '--norc', '-i'],
      ttlSeconds: 5,
      allowedProbePrefixes: ['printf'],
    });
    await waitFor(() => fs.existsSync(state));
    expect((await requestPtyLease(socket, { action: 'ready' })).state.status).toBe('active');
    const refused = await requestPtyLease(socket, { action: 'probe', command: 'rm -rf /' });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('outside the declared allowlist');
    const injected = await requestPtyLease(socket, {
      action: 'probe',
      command: 'printf SAFE; rm -rf /',
    });
    expect(injected.ok).toBe(false);
    expect(injected.error).toContain('shell metacharacters');
    const newlineInjected = await requestPtyLease(socket, {
      action: 'probe',
      command: 'printf SAFE\nrm -rf /',
    });
    expect(newlineInjected.ok).toBe(false);
    expect(newlineInjected.error).toContain('control characters');
    const oversizedTimeout = await requestPtyLease(socket, {
      action: 'probe',
      command: 'printf SAFE',
      timeoutMs: 60_000,
    });
    expect(oversizedTimeout.ok).toBe(false);
    expect(oversizedTimeout.error).toContain('within the daemon limit');
    const exited = new Promise<number | null>((resolve) => daemon.once('exit', resolve));
    expect((await requestPtyLease(socket, { action: 'stop' })).state.status).toBe('stopped');
    expect(await exited).toBe(0);
  }, 10_000);
});
