import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createMonitorSchedule, readMonitorSchedule } from '../schedule-store.js';

const dirs: string[] = [];
const tick = path.resolve('harness/ml-monitor-tick.mjs');

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('launchd-compatible monitor tick entrypoint', () => {
  it('runs a due argv bridge and persists the next due time', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-monitor-tick-'));
    dirs.push(dir);
    const scheduleFile = path.join(dir, 'schedule.json');
    const marker = path.join(dir, 'ran');
    createMonitorSchedule(scheduleFile, {
      campaignId: 'tick-campaign',
      everyMs: 60_000,
      nextDueAtMs: Date.now() - 1,
    });
    const result = spawnSync(
      process.execPath,
      [
        tick,
        '--schedule',
        scheduleFile,
        '--command',
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ok')`,
      ],
      { encoding: 'utf8' }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ran: true, reason: 'due' });
    expect(fs.readFileSync(marker, 'utf8')).toBe('ok');
    expect(readMonitorSchedule(scheduleFile)?.schedule.nextDueAtMs).toBeGreaterThan(
      Date.now() - 1000
    );
  });

  it('returns a non-zero result for runner failure while retaining durable schedule state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-monitor-tick-'));
    dirs.push(dir);
    const scheduleFile = path.join(dir, 'schedule.json');
    createMonitorSchedule(scheduleFile, {
      campaignId: 'tick-campaign',
      everyMs: 60_000,
      nextDueAtMs: Date.now() - 1,
    });
    const result = spawnSync(
      process.execPath,
      [tick, '--schedule', scheduleFile, '--command', process.execPath, '-e', 'process.exit(7)'],
      { encoding: 'utf8' }
    );
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ran: true,
      reason: 'due',
      runnerError: 'monitor runner exited with code 7',
    });
    expect(readMonitorSchedule(scheduleFile)?.schedule.activeUntilMs).toBeUndefined();
  });

  it('times out a stuck monitor command and releases the active window', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-monitor-tick-'));
    dirs.push(dir);
    const scheduleFile = path.join(dir, 'schedule.json');
    const marker = path.join(dir, 'leaked-child');
    createMonitorSchedule(scheduleFile, {
      campaignId: 'tick-campaign',
      everyMs: 60_000,
      nextDueAtMs: Date.now() - 1,
    });
    const result = spawnSync(
      process.execPath,
      [
        tick,
        '--schedule',
        scheduleFile,
        '--command-timeout-ms',
        '50',
        '--command',
        process.execPath,
        '-e',
        `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'), 300)`)}], { stdio: 'ignore' }); setTimeout(() => {}, 10_000)`,
      ],
      { encoding: 'utf8', timeout: 5_000 }
    );
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ran: true,
      reason: 'due',
      runnerError: 'monitor runner timed out after 50ms',
    });
    expect(readMonitorSchedule(scheduleFile)?.schedule.activeUntilMs).toBeUndefined();
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && !fs.existsSync(marker)) {
      // Give a child that escaped the process group enough time to surface.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('rejects a non-positive monitor command timeout', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-monitor-tick-'));
    dirs.push(dir);
    const scheduleFile = path.join(dir, 'schedule.json');
    createMonitorSchedule(scheduleFile, {
      campaignId: 'tick-campaign',
      everyMs: 60_000,
      nextDueAtMs: Date.now() - 1,
    });
    const result = spawnSync(
      process.execPath,
      [
        tick,
        '--schedule',
        scheduleFile,
        '--command-timeout-ms',
        '0',
        '--command',
        process.execPath,
      ],
      { encoding: 'utf8' }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid --command-timeout-ms');
  });

  it('does not invoke the runner for a not-due schedule', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-monitor-tick-'));
    dirs.push(dir);
    const scheduleFile = path.join(dir, 'schedule.json');
    const marker = path.join(dir, 'ran');
    createMonitorSchedule(scheduleFile, {
      campaignId: 'tick-campaign',
      everyMs: 60_000,
      nextDueAtMs: Date.now() + 60_000,
    });
    const result = spawnSync(
      process.execPath,
      [
        tick,
        '--schedule',
        scheduleFile,
        '--command',
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`,
      ],
      { encoding: 'utf8' }
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ran: false, reason: 'not-due' });
    expect(fs.existsSync(marker)).toBe(false);
  });
});
