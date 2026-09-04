import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCredentialBootstraps } from '../src/core/credential-bootstrap-runner.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'credential-bootstrap-'));

describe('credential bootstrap runner', () => {
  it('skips login only when success paths and the optional status check are valid', async () => {
    const dir = tmp();
    const ready = join(dir, 'ready');
    const lock = join(dir, 'lock');
    writeFileSync(ready, 'ok');

    await expect(runCredentialBootstraps([{
      id: 'valid',
      command: '/bin/false',
      args: [],
      successPaths: [ready],
      checkCommand: { command: '/bin/true', args: [] },
      timeoutSeconds: 30,
      lockPath: lock,
    }])).resolves.toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it('does not trust a stale success path when the status check fails', async () => {
    const dir = tmp();
    const ready = join(dir, 'stale');
    const lock = join(dir, 'lock');
    writeFileSync(ready, 'stale');

    await expect(runCredentialBootstraps([{
      id: 'stale',
      command: '/bin/true',
      args: [],
      successPaths: [ready],
      checkCommand: { command: '/bin/false', args: [] },
      timeoutSeconds: 30,
      lockPath: lock,
    }])).resolves.toBe(false);
    expect(existsSync(lock)).toBe(false);
  });
});
