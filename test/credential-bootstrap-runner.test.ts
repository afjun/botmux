import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCredentialBootstraps } from '../src/core/credential-bootstrap-runner.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'credential-bootstrap-'));

describe('credential bootstrap runner', () => {
  it('skips login only when success paths and the optional status check are valid', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write');
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
    expect(writeSpy.mock.calls.flat().join('')).toContain(
      '[owner-credential] event=bootstrap.skipped mount=valid result=already_ready',
    );
    writeSpy.mockRestore();
  });

  it('does not trust a stale success path when the status check fails', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write');
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
    expect(writeSpy.mock.calls.flat().join('')).toContain(
      '[owner-credential] event=bootstrap.validation_finished mount=stale result=failed',
    );
    expect(writeSpy.mock.calls.flat().join('')).toContain('reason=check_exit_nonzero');
    expect(writeSpy.mock.calls.flat().join('')).toContain('exit_code=1');
    writeSpy.mockRestore();
  });

  it('distinguishes a command spawn failure without logging the command', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write');
    const dir = tmp();
    const output = writeSpy.mock.calls;

    await expect(runCredentialBootstraps([{
      id: 'missing-tool',
      command: '/definitely-missing-credential-login-tool',
      args: ['--secret', 'must-not-appear'],
      successPaths: [join(dir, 'ready')],
      timeoutSeconds: 1,
      lockPath: join(dir, 'lock'),
    }])).resolves.toBe(false);

    const trace = output.flat().join('');
    expect(trace).toContain('reason=login_spawn_error');
    expect(trace).not.toContain('definitely-missing-credential-login-tool');
    expect(trace).not.toContain('must-not-appear');
    writeSpy.mockRestore();
  });
});
