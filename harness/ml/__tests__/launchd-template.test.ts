import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('launchd lease owner template', () => {
  it('starts once and does not configure automatic restart/authentication', () => {
    const template = fs.readFileSync(
      path.resolve('examples/launchd/com.pi.ml-pty-lease.plist'),
      'utf8'
    );
    expect(template).toContain('<key>RunAtLoad</key>');
    expect(template).not.toContain('<key>KeepAlive</key>');
    expect(template).toContain('<string>--socket</string>');
    expect(template).toContain('<string>--state</string>');
    expect(template).toContain('<string>--command</string>');
    expect(template).toContain('<string>--allowed-probe-prefix</string>');
  });
});
