import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMonitorSchedule,
  readMonitorSchedule,
  runDueMonitorSchedule,
  updateMonitorSchedule,
} from '../schedule-store.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function schedule() {
  return {
    campaignId: 'schedule-campaign',
    everyMs: 30_000,
    nextDueAtMs: 100,
  };
}

describe('durable monitor schedule bridge', () => {
  it('persists schedule state atomically and reloads it after a fresh process', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-schedule-'));
    dirs.push(dir);
    const file = path.join(dir, 'monitor.json');
    const created = createMonitorSchedule(file, schedule());
    expect(created.revision).toBe(0);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readMonitorSchedule(file)).toEqual(created);

    const updated = updateMonitorSchedule(file, 0, (current) => ({
      ...current,
      status: 'paused',
      schedule: { ...current.schedule, nextDueAtMs: 200 },
    }));
    expect(updated.revision).toBe(1);
    expect(readMonitorSchedule(file)?.status).toBe('paused');
    expect(readMonitorSchedule(file)?.schedule.nextDueAtMs).toBe(200);
  });

  it('rejects duplicate creation and stale writers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-schedule-'));
    dirs.push(dir);
    const file = path.join(dir, 'monitor.json');
    createMonitorSchedule(file, schedule());
    expect(() => createMonitorSchedule(file, schedule())).toThrow('already exists');
    updateMonitorSchedule(file, 0, (current) => current);
    expect(() => updateMonitorSchedule(file, 0, (current) => current)).toThrow('revision conflict');
  });

  it('fails closed on malformed persisted state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-schedule-'));
    dirs.push(dir);
    const file = path.join(dir, 'monitor.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, revision: 0, status: 'active' }));
    expect(() => readMonitorSchedule(file)).toThrow('Invalid persisted monitor schedule');
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        revision: 0,
        status: 'active',
        schedule: { ...schedule(), everyMs: 0 },
      })
    );
    expect(() => readMonitorSchedule(file)).toThrow('everyMs must be positive');
  });

  it('runs one due tick, records runner failure, and advances catch-up time', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-schedule-'));
    dirs.push(dir);
    const file = path.join(dir, 'monitor.json');
    createMonitorSchedule(file, schedule());
    const result = await runDueMonitorSchedule(file, 100, async () => {
      throw new Error('monitor child crashed');
    });
    expect(result).toEqual({
      ran: true,
      reason: 'due',
      revision: 2,
      runnerError: 'monitor child crashed',
    });
    expect(readMonitorSchedule(file)?.schedule.nextDueAtMs).toBe(30_100);
    expect(readMonitorSchedule(file)?.schedule.activeUntilMs).toBeUndefined();
  });

  it('serializes overlapping ticks so only one runner starts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-schedule-'));
    dirs.push(dir);
    const file = path.join(dir, 'monitor.json');
    createMonitorSchedule(file, schedule());
    let calls = 0;
    const runner = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
    };
    const results = await Promise.all([
      runDueMonitorSchedule(file, 100, runner),
      runDueMonitorSchedule(file, 100, runner),
    ]);
    expect(calls).toBe(1);
    expect(results.filter((result) => result.ran)).toHaveLength(1);
    expect(results.filter((result) => !result.ran)).toHaveLength(1);
    expect(results.find((result) => !result.ran)?.reason).toBe('not-due');
  });

  it('does not launch paused or completed schedules', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-schedule-'));
    dirs.push(dir);
    const file = path.join(dir, 'monitor.json');
    createMonitorSchedule(file, schedule());
    updateMonitorSchedule(file, 0, (current) => ({ ...current, status: 'paused' }));
    const paused = await runDueMonitorSchedule(file, 100, async () => {
      throw new Error('must not run');
    });
    expect(paused).toEqual({ ran: false, reason: 'paused' });
    updateMonitorSchedule(file, 1, (current) => ({ ...current, status: 'completed' }));
    const completed = await runDueMonitorSchedule(file, 100, async () => {
      throw new Error('must not run');
    });
    expect(completed).toEqual({ ran: false, reason: 'completed' });
  });
});
