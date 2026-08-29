import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const bridge = path.resolve('harness/ml-monitor-bridge.mjs');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function run(args: string[]) {
  return spawnSync(process.execPath, [bridge, ...args], { encoding: 'utf8' });
}

describe('health-gated monitor bridge', () => {
  it('does not launch a monitor command for healthy health input', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-monitor-bridge-'));
    dirs.push(dir);
    const health = path.join(dir, 'health.json');
    fs.writeFileSync(health, JSON.stringify({ state: 'healthy' }));
    const result = run(['--campaign', dir, '--health', health]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      invoked: false,
      state: 'healthy',
      reason: 'normal-health',
    });
  });

  it('launches a fresh monitor for unknown health and passes bounded context via env', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-monitor-bridge-'));
    dirs.push(dir);
    const health = path.join(dir, 'health.json');
    const marker = path.join(dir, 'monitor.json');
    fs.writeFileSync(health, '{malformed');
    const monitor = `require('node:fs').writeFileSync(process.env.MARKER, JSON.stringify({campaign:process.env.PI_ML_MONITOR_CAMPAIGN,health:process.env.PI_ML_MONITOR_HEALTH,state:process.env.PI_ML_MONITOR_STATE,reason:process.env.PI_ML_MONITOR_REASON}))`;
    const result = spawnSync(
      process.execPath,
      [
        bridge,
        '--campaign',
        dir,
        '--health',
        health,
        '--monitor-command',
        process.execPath,
        '-e',
        monitor,
      ],
      { encoding: 'utf8', env: { ...process.env, MARKER: marker } }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      invoked: true,
      state: 'unknown',
      reason: 'health-input-unavailable',
    });
    expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toEqual({
      campaign: dir,
      health,
      state: 'unknown',
      reason: 'health-input-unavailable',
    });
  });

  it('fails clearly when abnormal health has no monitor command', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-monitor-bridge-'));
    dirs.push(dir);
    const health = path.join(dir, 'health.json');
    fs.writeFileSync(health, JSON.stringify({ state: 'failed' }));
    const result = run(['--campaign', dir, '--health', health]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing --monitor-command');
  });
});
