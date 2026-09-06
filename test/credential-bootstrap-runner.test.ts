import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
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
      executableName: 'valid',
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
      executableName: 'stale',
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

  it('marks a completed batch fresh only after an actual login', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write');
    const dir = tmp();
    const ready = join(dir, 'ready');

    await expect(runCredentialBootstraps([{
      id: 'shared-login',
      executableName: 'bytedcli',
      command: '/usr/bin/touch',
      args: [ready],
      successPaths: [ready],
      timeoutSeconds: 30,
      lockPath: join(dir, 'lock'),
    }])).resolves.toBe(true);

    expect(writeSpy.mock.calls.flat().join('')).toContain(
      '[owner-credential] event=bootstrap.batch_completed result=ready count=1 fresh=true',
    );
    writeSpy.mockRestore();
  });

  it('reports each completed login before starting the next dependency', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write');
    const dir = tmp();
    const firstReady = join(dir, 'first-ready');
    const secondReady = join(dir, 'second-ready');

    await expect(runCredentialBootstraps([{
      id: 'bytedcli', executableName: 'bytedcli', command: '/usr/bin/touch', args: [firstReady],
      successPaths: [firstReady], timeoutSeconds: 30, lockPath: join(dir, 'first-lock'),
    }, {
      id: 'bytedcli~meego', displayName: 'meego', executableName: 'bytedcli',
      command: '/usr/bin/touch', args: [secondReady],
      successPaths: [secondReady], timeoutSeconds: 30, lockPath: join(dir, 'second-lock'),
    }])).resolves.toBe(true);

    const trace = writeSpy.mock.calls.flat().join('');
    expect(trace.indexOf('event=bootstrap.step_completed mount=bytedcli'))
      .toBeLessThan(trace.indexOf('event=bootstrap.required mount=bytedcli~meego'));
    expect(trace).toContain('[botmux] 正在初始化 meego 登录');
    expect(trace).not.toContain('[botmux] 正在初始化 bytedcli~meego 登录');
    writeSpy.mockRestore();
  });

  it('distinguishes a command spawn failure without logging the command', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write');
    const dir = tmp();
    const output = writeSpy.mock.calls;

    await expect(runCredentialBootstraps([{
      id: 'missing-tool',
      executableName: 'missing-tool',
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

  it('reclaims a stale lock left by an interrupted sandbox', async () => {
    const dir = tmp();
    const lock = join(dir, 'lock');
    writeFileSync(lock, '');
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lock, stale, stale);

    await expect(runCredentialBootstraps([{
      id: 'stale-lock',
      executableName: 'true',
      command: '/bin/true',
      args: [],
      successPaths: [join(dir, 'missing')],
      timeoutSeconds: 1,
      lockPath: lock,
    }])).resolves.toBe(false);
    expect(existsSync(lock)).toBe(false);
  });
});
