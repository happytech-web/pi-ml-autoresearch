import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpNotificationAdapter } from '../http-notification.js';
import type { MinimalNotification } from '../monitoring.js';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

const event: MinimalNotification = {
  schemaVersion: 1,
  eventId: 'sha256:event',
  campaignId: 'campaign-http',
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

describe('HTTP notification adapter', () => {
  it('sends only the minimal event and reads auth from an environment variable', async () => {
    process.env.PI_TEST_NOTIFY_TOKEN = 'secret-token';
    let body = '';
    let authorization = '';
    const { port } = await listen((request, response) => {
      authorization = String(request.headers.authorization ?? '');
      request.setEncoding('utf8');
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        response.statusCode = 202;
        response.end();
      });
    });
    await createHttpNotificationAdapter({
      endpoint: `http://127.0.0.1:${port}/notify`,
      tokenEnv: 'PI_TEST_NOTIFY_TOKEN',
    }).send(event);
    expect(authorization).toBe('Bearer secret-token');
    expect(JSON.parse(body)).toEqual(event);
    expect(body).not.toContain('secret-token');
    delete process.env.PI_TEST_NOTIFY_TOKEN;
  });

  it('reports non-2xx delivery and times out a hung endpoint', async () => {
    const failing = await listen((_request, response) => {
      response.statusCode = 503;
      response.end();
    });
    await expect(
      createHttpNotificationAdapter({ endpoint: `http://127.0.0.1:${failing.port}` }).send(event)
    ).rejects.toThrow('HTTP 503');

    const hung = await listen(() => undefined);
    await expect(
      createHttpNotificationAdapter({
        endpoint: `http://127.0.0.1:${hung.port}`,
        timeoutMs: 10,
      }).send(event)
    ).rejects.toThrow('timed out');
  });

  it('rejects invalid endpoint and secret configuration', () => {
    expect(() => createHttpNotificationAdapter({ endpoint: 'file:///tmp/notify' })).toThrow(
      'http or https'
    );
    expect(() =>
      createHttpNotificationAdapter({ endpoint: 'http://localhost', token: 'x', tokenEnv: 'Y' })
    ).toThrow('mutually exclusive');
  });
});
