import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import type { MinimalNotification, NotificationAdapter } from './monitoring.js';

export interface HttpNotificationOptions {
  endpoint: string;
  token?: string;
  tokenEnv?: string;
  tokenHeader?: string;
  tokenPrefix?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  body?: (event: MinimalNotification) => unknown;
}

function resolveToken(options: HttpNotificationOptions): string | undefined {
  if (options.token !== undefined && options.tokenEnv !== undefined) {
    throw new Error('notification token and tokenEnv are mutually exclusive');
  }
  return options.token ?? (options.tokenEnv ? process.env[options.tokenEnv] : undefined);
}

export function createHttpNotificationAdapter(
  options: HttpNotificationOptions
): NotificationAdapter {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error('notification endpoint must use http or https');
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('notification timeoutMs must be positive');
  }
  const token = resolveToken(options);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...options.headers,
  };
  if (token) {
    headers[options.tokenHeader ?? 'authorization'] = `${options.tokenPrefix ?? 'Bearer '}${token}`;
  }
  return {
    send: (event: MinimalNotification) =>
      new Promise<void>((resolve, reject) => {
        const transport = endpoint.protocol === 'https:' ? https : http;
        const request = transport.request(
          endpoint,
          { method: 'POST', headers, timeout: timeoutMs },
          (response) => {
            response.resume();
            response.once('end', () => {
              const status = response.statusCode ?? 0;
              if (status >= 200 && status < 300) resolve();
              else reject(new Error(`notification endpoint returned HTTP ${status}`));
            });
          }
        );
        request.once('timeout', () =>
          request.destroy(new Error('notification delivery timed out'))
        );
        request.once('error', reject);
        request.end(JSON.stringify(options.body ? options.body(event) : event));
      }),
  };
}
