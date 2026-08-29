import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createGotifyNotificationAdapter,
  createNtfyNotificationAdapter,
} from '../notification-channels.js';
import type { MinimalNotification } from '../monitoring.js';

const servers: http.Server[] = [];
const event: MinimalNotification = {
  schemaVersion: 1,
  eventId: 'sha256:event',
  campaignId: 'campaign-channel',
  runId: 'run-1',
  attemptId: 'attempt-1',
  state: 'failed',
  severity: 'critical',
  reasonCodes: ['executor-not-running'],
  observedAtMs: 100,
};

function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('server did not bind');
      resolve({ server, port: address.port });
    });
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  delete process.env.PI_CHANNEL_TOKEN;
});

describe('notification channel adapters', () => {
  it('formats ntfy payloads and keeps bearer secrets out of the body', async () => {
    process.env.PI_CHANNEL_TOKEN = 'ntfy-secret';
    let body = '';
    let authorization = '';
    const { port } = await listen((request, response) => {
      authorization = String(request.headers.authorization ?? '');
      request.setEncoding('utf8');
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => response.end());
    });
    await createNtfyNotificationAdapter({
      endpoint: `http://127.0.0.1:${port}/topic`,
      tokenEnv: 'PI_CHANNEL_TOKEN',
    }).send(event);
    expect(authorization).toBe('Bearer ntfy-secret');
    expect(JSON.parse(body)).toEqual({
      title: 'ML monitor',
      priority: 5,
      message: 'failed campaign-channel/run-1 (executor-not-running)',
    });
    expect(body).not.toContain('ntfy-secret');
  });

  it('formats Gotify payloads with its dedicated key header', async () => {
    process.env.PI_CHANNEL_TOKEN = 'gotify-secret';
    let body = '';
    let key = '';
    const { port } = await listen((request, response) => {
      key = String(request.headers['x-gotify-key'] ?? '');
      request.setEncoding('utf8');
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => response.end());
    });
    await createGotifyNotificationAdapter({
      endpoint: `http://127.0.0.1:${port}/message`,
      tokenEnv: 'PI_CHANNEL_TOKEN',
    }).send(event);
    expect(key).toBe('gotify-secret');
    expect(JSON.parse(body)).toEqual({
      title: 'ML monitor',
      priority: 8,
      message: 'failed campaign-channel/run-1 (executor-not-running)',
    });
    expect(body).not.toContain('gotify-secret');
  });
});
