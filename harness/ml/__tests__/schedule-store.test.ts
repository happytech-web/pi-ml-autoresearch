import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMonitorSchedule,
  readMonitorSchedule,
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
});
