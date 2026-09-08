#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatCredentialTrace, type CredentialTraceFields } from './credential-isolation-log.js';
import {
  acquireCredentialBootstrapLease,
  activeCredentialBootstrapLeases,
  releaseCredentialBootstrapLease,
  type CredentialBootstrapLease,
} from './credential-bootstrap-lease.js';

export interface CredentialBootstrapRunnerSpec {
  id: string;
  displayName?: string;
  executableName: string;
  command: string;
  args: string[];
  successPaths: string[];
  checkCommand?: { command: string; args: string[] };
  timeoutSeconds: number;
}

export interface CredentialBootstrapLeaseSpec {
  directory: string;
  sessionId: string;
  sessionCreatedAt: string;
}

export type CredentialBootstrapRunResult = 'ready' | 'failed' | 'superseded';

let activeChildPid: number | undefined;
let activeLease: CredentialBootstrapLease | undefined;
let leaseHeartbeat: ReturnType<typeof setInterval> | undefined;
let shuttingDown = false;
const LEASE_HEARTBEAT_MS = 500;

function trace(event: string, fields: CredentialTraceFields = {}): void {
  process.stdout.write(`\n${formatCredentialTrace(event, {
    sessionId: process.env.BOTMUX_SESSION_ID,
    botId: process.env.BOTMUX_LARK_APP_ID,
    ...fields,
  })}\n`);
}

function terminateProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch { /* already gone */ }
}

function cleanupOwnedLease(): void {
  if (leaseHeartbeat) clearInterval(leaseHeartbeat);
  leaseHeartbeat = undefined;
  if (!activeLease) return;
  releaseCredentialBootstrapLease(activeLease);
  trace('bootstrap.lease_released', { result: 'released', leaseId: activeLease.record.leaseId });
  activeLease = undefined;
}

function installSignalCleanup(): void {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as NodeJS.Signals[]) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      trace('bootstrap.signal_received', { result: 'stopping', reason: signal });
      terminateProcessGroup(activeChildPid, signal);
      // Keep the lease until the login child exits so a newer session cannot
      // write the same credential tree concurrently. The normal command path
      // releases it; this timer handles a child that ignores the first signal.
      setTimeout(() => {
        terminateProcessGroup(activeChildPid, 'SIGKILL');
        cleanupOwnedLease();
        process.exit(128);
      }, 2_000);
    });
  }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function bootstrapSuccessPathsReady(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every(path => existsSync(path));
}

interface CredentialCommandResult {
  ok: boolean;
  outcome: 'success' | 'spawn_error' | 'timeout' | 'exit_nonzero' | 'signal';
  durationMs: number;
  exitCode?: number;
  signal?: NodeJS.Signals;
  errorCode?: string;
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  stdio: 'inherit' | 'ignore' = 'inherit',
): Promise<CredentialCommandResult> {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const child = spawn(command, args, { stdio, detached: true });
    activeChildPid = child.pid;
    let settled = false;
    const finish = (result: Omit<CredentialCommandResult, 'durationMs'>) => {
      if (settled) return;
      settled = true;
      if (activeChildPid === child.pid) activeChildPid = undefined;
      clearTimeout(timer);
      resolve({ ...result, durationMs: Date.now() - startedAt });
    };
    const timer = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => {
        try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }, 2_000).unref();
      finish({ ok: false, outcome: 'timeout' });
    }, timeoutMs);
    child.once('error', error => finish({
      ok: false,
      outcome: 'spawn_error',
      errorCode: (error as NodeJS.ErrnoException).code ?? 'unknown',
    }));
    child.once('exit', (code, signal) => finish(signal
      ? { ok: false, outcome: 'signal', signal }
      : code === 0
        ? { ok: true, outcome: 'success', exitCode: 0 }
        : { ok: false, outcome: 'exit_nonzero', exitCode: code ?? undefined }));
  });
}

async function acquireLatestLease(spec: CredentialBootstrapLeaseSpec): Promise<CredentialBootstrapLease | undefined> {
  const lease = acquireCredentialBootstrapLease(spec.directory, spec);
  activeLease = lease;
  trace('bootstrap.lease_published', { result: 'published', leaseId: lease.record.leaseId });
  if (!lease.isCurrent()) return undefined;

  let supersededLogged = false;
  const stopIfSuperseded = () => {
    lease.heartbeat();
    if (lease.isCurrent()) return;
    if (supersededLogged) return;
    supersededLogged = true;
    trace('bootstrap.superseded', { result: 'superseded', leaseId: lease.record.leaseId });
    terminateProcessGroup(activeChildPid, 'SIGTERM');
    setTimeout(() => terminateProcessGroup(activeChildPid, 'SIGKILL'), 2_000).unref();
  };
  leaseHeartbeat = setInterval(stopIfSuperseded, LEASE_HEARTBEAT_MS);
  leaseHeartbeat.unref();

  // Give an older runner one heartbeat to stop its login child before this
  // session starts writing the same owner credential tree.
  while (activeCredentialBootstrapLeases(spec.directory).length > 1) {
    if (!lease.isCurrent()) return undefined;
    await wait(100);
  }
  return lease.isCurrent() ? lease : undefined;
}

async function bootstrapReady(spec: CredentialBootstrapRunnerSpec): Promise<boolean> {
  if (!bootstrapSuccessPathsReady(spec.successPaths)) return false;
  return spec.checkCommand
    ? (await runCommand(spec.checkCommand.command, spec.checkCommand.args, 30_000, 'ignore')).ok
    : true;
}

export async function runCredentialBootstraps(
  specs: readonly CredentialBootstrapRunnerSpec[],
  leaseSpec: CredentialBootstrapLeaseSpec,
): Promise<CredentialBootstrapRunResult> {
  trace('bootstrap.batch_started', { result: 'started', count: specs.length });
  const initiallyReady: boolean[] = [];
  for (const spec of specs) initiallyReady.push(await bootstrapReady(spec));
  if (initiallyReady.every(Boolean) && activeCredentialBootstrapLeases(leaseSpec.directory).length === 0) {
    for (const spec of specs) {
      trace('bootstrap.skipped', {
        mountId: spec.id, result: 'already_ready', count: spec.successPaths.length,
        hasCheck: !!spec.checkCommand, fresh: false,
      });
    }
    trace('bootstrap.batch_completed', { result: 'ready', count: specs.length, fresh: false });
    return 'ready';
  }
  const lease = await acquireLatestLease(leaseSpec);
  if (!lease) {
    cleanupOwnedLease();
    trace('bootstrap.batch_superseded', { result: 'superseded', count: specs.length });
    return 'superseded';
  }
  let fresh = false;
  try {
    for (const spec of specs) {
      const displayName = spec.displayName ?? spec.id;
      if (await bootstrapReady(spec)) {
        trace('bootstrap.skipped', {
          mountId: spec.id,
          result: 'already_ready',
          count: spec.successPaths.length,
          hasCheck: !!spec.checkCommand,
          fresh: false,
        });
        continue;
      }
      trace('bootstrap.required', {
        mountId: spec.id,
        result: 'login_required',
        count: spec.successPaths.length,
        timeoutSeconds: spec.timeoutSeconds,
        hasCheck: !!spec.checkCommand,
      });
      if (!lease.isCurrent()) return 'superseded';
      process.stdout.write(`\n[botmux] 正在初始化 ${displayName} 登录。登录链接、设备码或二维码会显示在此终端。\n`);
      trace('bootstrap.command_started', {
        mountId: spec.id,
        result: 'started',
        timeoutSeconds: spec.timeoutSeconds,
      });
      const commandResult = await runCommand(spec.command, spec.args, spec.timeoutSeconds * 1_000);
      if (!lease.isCurrent()) return 'superseded';
      const pathsOk = bootstrapSuccessPathsReady(spec.successPaths);
      const checkResult = commandResult.ok && pathsOk && spec.checkCommand
        ? await runCommand(spec.checkCommand.command, spec.checkCommand.args, 30_000, 'ignore')
        : undefined;
      if (!lease.isCurrent()) return 'superseded';
      const checkOk = commandResult.ok && pathsOk && (checkResult?.ok ?? true);
      const failedCommand = !commandResult.ok ? commandResult : checkResult && !checkResult.ok ? checkResult : undefined;
      trace('bootstrap.validation_finished', {
        mountId: spec.id,
        result: checkOk ? 'ready' : 'failed',
        reason: checkOk
          ? undefined
          : !commandResult.ok ? `login_${commandResult.outcome}`
            : !pathsOk ? 'success_path_missing'
              : `check_${checkResult?.outcome ?? 'failed'}`,
        count: spec.successPaths.length,
        hasCheck: !!spec.checkCommand,
        fresh: true,
        durationMs: commandResult.durationMs + (checkResult?.durationMs ?? 0),
        exitCode: failedCommand?.exitCode,
        errorCode: failedCommand?.errorCode,
        signal: failedCommand?.signal,
      });
      if (!checkOk) {
        process.stdout.write(`\n[botmux] ${displayName} 登录未完成或校验失败。请使用 /restart 重试。\n`);
        return 'failed';
      }
      fresh = true;
      trace('bootstrap.step_completed', {
        mountId: spec.id,
        result: 'ready',
        fresh: true,
      });
      process.stdout.write(`\n[botmux] ${displayName} 登录完成。\n`);
    }
    if (!lease.isCurrent()) return 'superseded';
    trace('bootstrap.batch_completed', { result: 'ready', count: specs.length, fresh });
    return 'ready';
  } finally {
    cleanupOwnedLease();
  }
}

async function main(): Promise<void> {
  const specArg = process.argv[2];
  const cliBin = process.argv[3];
  if (!specArg || !cliBin) throw new Error('credential bootstrap runner requires spec and CLI binary');
  const specJson = specArg.startsWith('@')
    ? readFileSync(specArg.slice(1), 'utf8')
    : Buffer.from(specArg, 'base64url').toString('utf8');
  const payload = JSON.parse(specJson) as {
    bootstraps: CredentialBootstrapRunnerSpec[];
    lease: CredentialBootstrapLeaseSpec;
  };
  installSignalCleanup();
  // The worker registers PTY listeners immediately after spawn. Leave a small
  // handshake window so a fast login command cannot print its URL before the
  // terminal observer is attached.
  await wait(750);
  const result = await runCredentialBootstraps(payload.bootstraps, payload.lease);
  if (result === 'superseded') process.exit(79);
  if (result === 'failed') process.exit(78);
  process.stdout.write('\n[botmux] 凭证初始化全部完成，正在启动 CLI。\n');

  const cli = spawn(cliBin, process.argv.slice(4), { stdio: 'inherit', detached: true });
  activeChildPid = cli.pid;
  cli.once('error', error => {
    process.stderr.write(`[botmux] failed to start CLI: ${error.message}\n`);
    process.exit(127);
  });
  cli.once('exit', (code, signal) => {
    if (signal) process.exit(128);
    else process.exit(code ?? 1);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch(error => {
    process.stderr.write(`[botmux] credential bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(78);
  });
}
