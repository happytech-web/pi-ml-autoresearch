import * as fs from 'node:fs';
import * as net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';

export interface PtyLeaseState {
  schemaVersion: 1;
  leaseId: string;
  transport: 'background-pty';
  status: 'starting' | 'active' | 'reauth-required' | 'stopped';
  pid: number | null;
  createdAtMs: number;
  expiresAtMs: number;
  updatedAtMs: number;
  error: string | null;
}

export interface PtyLeaseResponse {
  ok: boolean;
  state: PtyLeaseState;
  output?: string;
  error?: string;
}

export function startPtyLeaseDaemon(options: {
  script?: string;
  socket: string;
  state: string;
  command: string[];
  ttlSeconds?: number;
  probeTimeoutSeconds?: number;
  allowedProbePrefixes: string[];
}): ChildProcess {
  const script = options.script ?? new URL('../ml-pty-lease.py', import.meta.url).pathname;
  const args = [script, '--socket', options.socket, '--state', options.state];
  if (options.ttlSeconds !== undefined) args.push('--ttl-seconds', String(options.ttlSeconds));
  if (options.probeTimeoutSeconds !== undefined) {
    args.push('--probe-timeout-seconds', String(options.probeTimeoutSeconds));
  }
  for (const prefix of options.allowedProbePrefixes) {
    args.push('--allowed-probe-prefix', prefix);
  }
  args.push('--command', ...options.command);
  return spawn('python3', args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

export async function requestPtyLease(
  socketPath: string,
  request: Record<string, unknown>,
  timeoutMs = 35_000
): Promise<PtyLeaseResponse> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('PTY lease request timed out'));
    }, timeoutMs);
    let body = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      body += chunk;
      const line = body.split('\n', 1)[0];
      if (!line) return;
      clearTimeout(timer);
      socket.destroy();
      try {
        resolve(JSON.parse(line) as PtyLeaseResponse);
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function readPtyLeaseState(file: string): PtyLeaseState | null {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as PtyLeaseState;
}
