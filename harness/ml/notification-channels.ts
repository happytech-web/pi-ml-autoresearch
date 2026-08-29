import type { MinimalNotification, NotificationAdapter } from './monitoring.js';
import { createHttpNotificationAdapter } from './http-notification.js';

export interface ChannelOptions {
  endpoint: string;
  tokenEnv: string;
  timeoutMs?: number;
}

function message(event: MinimalNotification): string {
  const reasons = event.reasonCodes.length > 0 ? ` (${event.reasonCodes.join(', ')})` : '';
  return `${event.state} ${event.campaignId}/${event.runId}${reasons}`;
}

export function createNtfyNotificationAdapter(
  options: ChannelOptions & { title?: string; priority?: number }
): NotificationAdapter {
  return createHttpNotificationAdapter({
    endpoint: options.endpoint,
    tokenEnv: options.tokenEnv,
    timeoutMs: options.timeoutMs,
    body: (event) => ({
      title: options.title ?? 'ML monitor',
      priority: options.priority ?? (event.severity === 'critical' ? 5 : 3),
      message: message(event),
    }),
  });
}

export function createGotifyNotificationAdapter(
  options: ChannelOptions & { title?: string; priority?: number }
): NotificationAdapter {
  return createHttpNotificationAdapter({
    endpoint: options.endpoint,
    tokenEnv: options.tokenEnv,
    tokenHeader: 'X-Gotify-Key',
    tokenPrefix: '',
    timeoutMs: options.timeoutMs,
    body: (event) => ({
      title: options.title ?? 'ML monitor',
      priority: options.priority ?? (event.severity === 'critical' ? 8 : 5),
      message: message(event),
    }),
  });
}
