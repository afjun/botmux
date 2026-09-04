import { dirname, join, resolve } from 'node:path';
import { existsSync, lstatSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { cloneCredentialMount, type CredentialIsolationConfig, type CredentialMountConfig } from './credential-isolation-config.js';
import type { CredentialBootstrapRunnerSpec } from './credential-bootstrap-runner.js';
import type { Session } from '../types.js';
import { logger } from '../utils/logger.js';
import { formatCredentialTrace } from './credential-isolation-log.js';

export class CredentialOwnerRequiredError extends Error {
  readonly code = 'credential_owner_required';
  constructor(message = 'credential isolation requires a verified human owner') {
    super(message);
    this.name = 'CredentialOwnerRequiredError';
  }
}

/**
 * Extract the owner username from an email address.
 * Returns the part before '@', lowercased and trimmed.
 * Returns undefined for invalid/missing emails.
 */
export function ownerFromEmail(email: string | undefined | null): string | undefined {
  if (!email || typeof email !== 'string') return undefined;
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.indexOf('@');
  if (at <= 0) return undefined; // no @ or @ at start
  const prefix = trimmed.slice(0, at);
  // The prefix becomes one filesystem segment. This is intentionally the only
  // identity validation in the demo, but it must never permit path traversal.
  return /^[a-z0-9][a-z0-9._-]*$/.test(prefix) ? prefix : undefined;
}

/**
 * Resolve the per-owner credential directory root.
 * E.g. ~/.botmux/owners/<ownerId>/
 */
export function ownerDir(botmuxHome: string, ownerId: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(ownerId)) {
    throw new CredentialOwnerRequiredError('credential owner id is invalid');
  }
  return `${botmuxHome.replace(/\/+$/, '')}/owners/${ownerId}`;
}

/** Build the security fields that must be included in createSession's first
 * durable write. Disabled configs deliberately return an empty object. */
export function freezeCredentialIsolation(
  config: CredentialIsolationConfig | undefined,
  identity: { openId?: string; email?: string } | undefined,
): Pick<Session, 'credentialPrincipal' | 'credentialIsolation' | 'sandbox'> {
  if (!config?.enabled) return {};
  const openId = identity?.openId?.trim();
  const ownerId = ownerFromEmail(identity?.email);
  if (!openId || !ownerId) {
    logger.warn(formatCredentialTrace('policy.freeze_failed', {
      openId,
      result: 'rejected',
      reason: !openId ? 'open_id_missing' : 'email_prefix_missing_or_invalid',
      count: config.mounts.length,
    }));
    throw new CredentialOwnerRequiredError();
  }
  logger.info(formatCredentialTrace('policy.freeze_ready', {
    ownerId,
    openId,
    result: 'frozen',
    count: config.mounts.length,
    sandbox: true,
  }));
  return {
    credentialPrincipal: { openId, ownerId },
    credentialIsolation: { version: 1, mounts: config.mounts.map(cloneCredentialMount) },
    // Owner mounts are implemented only by the full Linux bwrap sandbox.
    sandbox: true,
  };
}

export interface CredentialBindMount {
  id: string;
  kind: 'directory' | 'file';
  ownerSubdir: string;
  source: string;
  target: string;
  bootstrap?: CredentialMountConfig['bootstrap'];
}

/** Resolve a persisted snapshot to concrete host paths without consulting the
 * live Bot config. */
export function resolveCredentialBindMounts(
  session: Pick<Session, 'credentialPrincipal' | 'credentialIsolation'>,
  homeDir: string,
  botmuxHome: string,
): CredentialBindMount[] {
  const principal = session.credentialPrincipal;
  const snapshot = session.credentialIsolation;
  if (!principal || !snapshot) return [];
  const root = ownerDir(botmuxHome, principal.ownerId);
  return snapshot.mounts.map(mount => ({
    id: mount.id,
    kind: mount.kind,
    ownerSubdir: mount.ownerSubdir,
    source: join(root, mount.ownerSubdir),
    target: resolve(homeDir, mount.target.replace(/^~\//, '')),
    bootstrap: mount.bootstrap,
  }));
}

export type ResolvedCredentialBootstrap = CredentialBootstrapRunnerSpec;

/** Build the bootstrap plan from the frozen mount snapshot. successPaths are
 * configured relative to the owner root and translated to their in-sandbox
 * target locations; paths not backed by a configured mount fail closed. */
export function resolvePendingCredentialBootstraps(
  mounts: readonly CredentialBindMount[],
  botmuxHome: string,
  ownerId: string,
  resolveCommand: (command: string) => string | undefined,
): ResolvedCredentialBootstrap[] {
  const root = ownerDir(botmuxHome, ownerId);
  const result: ResolvedCredentialBootstrap[] = [];
  for (const mount of mounts) {
    const bootstrap = mount.bootstrap;
    if (!bootstrap) continue;
    const hostSuccessPaths = bootstrap.successPaths.map(path => join(root, path));
    const translate = (hostPath: string): string => {
      const backing = [...mounts]
        .sort((a, b) => b.source.length - a.source.length)
        .find(candidate => hostPath === candidate.source || hostPath.startsWith(`${candidate.source}/`));
      if (!backing) throw new Error(`credential bootstrap success path is outside configured mounts: ${hostPath}`);
      const suffix = hostPath.slice(backing.source.length).replace(/^\//, '');
      return suffix ? join(backing.target, suffix) : backing.target;
    };
    const command = resolveCommand(bootstrap.command);
    const checkCommand = bootstrap.checkCommand
      ? resolveCommand(bootstrap.checkCommand.command)
      : undefined;
    if (!command || (bootstrap.checkCommand && !checkCommand)) {
      throw new Error(`credential bootstrap command is not executable: ${bootstrap.command}`);
    }
    result.push({
      id: mount.id,
      command,
      args: [...bootstrap.args],
      successPaths: hostSuccessPaths.map(translate),
      checkCommand: bootstrap.checkCommand && checkCommand
        ? { command: checkCommand, args: [...bootstrap.checkCommand.args] }
        : undefined,
      timeoutSeconds: bootstrap.timeoutSeconds,
      lockPath: mount.kind === 'directory'
        ? join(mount.target, `.botmux-bootstrap-${mount.id}.lock`)
        : `${mount.target}.botmux-bootstrap-${mount.id}.lock`,
    });
  }
  return result;
}

/** Materialize persistent owner sources before fs-policy's allow existence
 * filter. Existing symlinks or shape mismatches fail closed. */
export function ensureCredentialBindSources(mounts: readonly CredentialBindMount[]): void {
  for (const mount of mounts) {
    if (!existsSync(mount.source)) {
      if (mount.kind === 'directory') mkdirSync(mount.source, { recursive: true, mode: 0o700 });
      else {
        mkdirSync(dirname(mount.source), { recursive: true, mode: 0o700 });
        closeSync(openSync(mount.source, 'wx', 0o600));
      }
    }
    const stat = lstatSync(mount.source);
    if (stat.isSymbolicLink()
      || (mount.kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`credential mount source has wrong shape: ${mount.source}`);
    }
  }
}

export function credentialPrincipalCanDrive(
  session: Pick<Session, 'credentialPrincipal'>,
  senderOpenId: string | undefined,
): boolean {
  return !session.credentialPrincipal || (!!senderOpenId && senderOpenId === session.credentialPrincipal.openId);
}
