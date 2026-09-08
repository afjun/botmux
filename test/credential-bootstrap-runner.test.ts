import { describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCredentialBootstraps } from '../src/core/credential-bootstrap-runner.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'credential-bootstrap-'));
const lease = (dir: string, sessionId = 'session-test', sessionCreatedAt = '2026-09-06T11:25:00.000Z') => ({
  directory: join(dir, '.bootstrap'), sessionId, sessionCreatedAt,
});
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('credential bootstrap runner', () => {
  it('keeps status-check output out of the interactive terminal', () => {
    const dir = tmp();
    const ready = join(dir, 'ready');
    const spec = Buffer.from(JSON.stringify({ bootstraps: [{
      id: 'silent-check',
      executableName: 'tool',
      command: '/usr/bin/touch',
      args: [ready],
      successPaths: [ready],
      checkCommand: {
        command: '/bin/sh',
        args: ['-c', 'printf "https://console.example.com should-stay-private"'],
      },
      timeoutSeconds: 30,
    }], lease: lease(dir) })).toString('base64url');

    const result = spawnSync(process.execPath, [
      '--import', 'tsx', join(process.cwd(), 'src/core/credential-bootstrap-runner.ts'),
      spec, '/bin/true',
    ], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('console.example.com');
  });

  it('fails silently when the status check fails', () => {
    const dir = tmp();
    const ready = join(dir, 'ready');
    const spec = Buffer.from(JSON.stringify({ bootstraps: [{
      id: 'failed-check',
      executableName: 'tool',
      command: '/usr/bin/touch',
      args: [ready],
      successPaths: [ready],
      checkCommand: {
        command: '/bin/sh',
        args: ['-c', 'printf "https://console.example.com should-stay-private"; exit 7'],
      },
      timeoutSeconds: 30,
    }], lease: lease(dir) })).toString('base64url');

    const result = spawnSync(process.execPath, [
      '--import', 'tsx', join(process.cwd(), 'src/core/credential-bootstrap-runner.ts'),
      spec, '/bin/true',
    ], { encoding: 'utf8' });

    expect(result.status).toBe(78);
    expect(result.stdout).not.toContain('console.example.com');
  });

  it('skips login only when success paths and the optional status check are valid', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write');
    const dir = tmp();
    const ready = join(dir, 'ready');
    writeFileSync(ready, 'ok');

    await expect(runCredentialBootstraps([{
      id: 'valid',
      executableName: 'valid',
      command: '/bin/false',
      args: [],
      successPaths: [ready],
      checkCommand: { command: '/bin/true', args: [] },
      timeoutSeconds: 30,
    }], lease(dir))).resolves.toBe('ready');
    expect(writeSpy.mock.calls.flat().join('')).toContain(
      '[owner-credential] event=bootstrap.skipped mount=valid result=already_ready',
    );
    writeSpy.mockRestore();
  });

  it('does not trust a stale success path when the status check fails', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write');
    const dir = tmp();
    const ready = join(dir, 'stale');
    writeFileSync(ready, 'stale');

    await expect(runCredentialBootstraps([{
      id: 'stale',
      executableName: 'stale',
      command: '/bin/true',
      args: [],
      successPaths: [ready],
      checkCommand: { command: '/bin/false', args: [] },
      timeoutSeconds: 30,
    }], lease(dir))).resolves.toBe('failed');
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
    }], lease(dir))).resolves.toBe('ready');

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
      successPaths: [firstReady], timeoutSeconds: 30,
    }, {
      id: 'bytedcli~meego', displayName: 'meego', executableName: 'bytedcli',
      command: '/usr/bin/touch', args: [secondReady],
      successPaths: [secondReady], timeoutSeconds: 30,
    }], lease(dir))).resolves.toBe('ready');

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
    }], lease(dir))).resolves.toBe('failed');

    const trace = output.flat().join('');
    expect(trace).toContain('reason=login_spawn_error');
    expect(trace).not.toContain('definitely-missing-credential-login-tool');
    expect(trace).not.toContain('must-not-appear');
    writeSpy.mockRestore();
  });

  it('keeps coordination stable when a tool recreates its credential directory', async () => {
    const dir = tmp();
    const credentials = join(dir, 'credentials');
    const ready = join(credentials, 'ready');
    mkdirSync(credentials);

    await expect(runCredentialBootstraps([{
      id: 'recreated-directory',
      executableName: 'sh',
      command: '/bin/sh',
      args: ['-c', `rm -rf "${credentials}" && mkdir "${credentials}" && touch "${ready}"`],
      successPaths: [ready],
      timeoutSeconds: 1,
    }], lease(dir))).resolves.toBe('ready');
    expect(readdirSync(lease(dir).directory)).toEqual([]);
  });

  it('supersedes an older login runner with the newest durable session', async () => {
    const dir = tmp();
    const ready = join(dir, 'ready');
    const runner = join(process.cwd(), 'src/core/credential-bootstrap-runner.ts');
    const start = (sessionId: string, sessionCreatedAt: string, command: string, args: string[]) => {
      const payload = Buffer.from(JSON.stringify({
        bootstraps: [{
          id: 'shared', executableName: command, command, args,
          successPaths: [ready], timeoutSeconds: 15,
        }],
        lease: lease(dir, sessionId, sessionCreatedAt),
      })).toString('base64url');
      const child = spawn(process.execPath, ['--import', 'tsx', runner, payload, '/bin/true'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return {
        child,
        exited: new Promise<number | null>(resolve => child.once('exit', code => resolve(code))),
      };
    };

    const older = start('session-old', '2026-09-06T11:20:00.000Z', '/bin/sh', ['-c', 'sleep 10']);
    for (let attempt = 0; attempt < 30 && !existsSync(lease(dir).directory); attempt++) await delay(50);
    for (let attempt = 0; attempt < 30 && readdirSync(lease(dir).directory).length === 0; attempt++) await delay(50);
    const newer = start('session-new', '2026-09-06T11:25:00.000Z', '/usr/bin/touch', [ready]);

    await expect(newer.exited).resolves.toBe(0);
    await expect(older.exited).resolves.toBe(79);
  }, 10_000);
});
