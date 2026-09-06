import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { readProcessStartIdentity } from '../utils/process-identity.js';

export const CREDENTIAL_BOOTSTRAP_LEASE_TARGET = '/run/botmux-owner-bootstrap';
export const CREDENTIAL_BOOTSTRAP_LEASE_STALE_MS = 30_000;

function hostNamespaceId(field: 'NSpid' | 'NSpgid', fallback: number): number {
  try {
    const match = readFileSync('/proc/self/status', 'utf8').match(new RegExp(`^${field}:\\s+([0-9]+)`, 'm'));
    const id = Number(match?.[1]);
    if (Number.isSafeInteger(id) && id > 0) return id;
  } catch { /* non-Linux or proc unavailable */ }
  return fallback;
}

export interface CredentialBootstrapLeaseRecord {
  version: 1;
  leaseId: string;
  sessionId: string;
  sessionCreatedAt: string;
  runnerStartedAt: number;
  runnerPid: number;
  runnerPgid: number;
  runnerProcStart?: string;
}

export interface CredentialBootstrapLease {
  directory: string;
  path: string;
  record: CredentialBootstrapLeaseRecord;
  isCurrent: () => boolean;
  heartbeat: () => void;
}

function parseLease(raw: string): CredentialBootstrapLeaseRecord | undefined {
  try {
    const value = JSON.parse(raw) as Partial<CredentialBootstrapLeaseRecord>;
    if (value.version !== 1
      || typeof value.leaseId !== 'string' || !value.leaseId
      || typeof value.sessionId !== 'string' || !value.sessionId
      || typeof value.sessionCreatedAt !== 'string' || !Number.isFinite(Date.parse(value.sessionCreatedAt))
      || !Number.isSafeInteger(value.runnerStartedAt) || (value.runnerStartedAt ?? 0) <= 0
      || !Number.isSafeInteger(value.runnerPid) || (value.runnerPid ?? 0) <= 0
      || !Number.isSafeInteger(value.runnerPgid) || (value.runnerPgid ?? 0) <= 0) return undefined;
    return value as CredentialBootstrapLeaseRecord;
  } catch {
    return undefined;
  }
}

function compareLease(left: CredentialBootstrapLeaseRecord, right: CredentialBootstrapLeaseRecord): number {
  const created = Date.parse(left.sessionCreatedAt) - Date.parse(right.sessionCreatedAt);
  if (created) return created;
  const session = left.sessionId.localeCompare(right.sessionId);
  if (session) return session;
  const started = left.runnerStartedAt - right.runnerStartedAt;
  return started || left.leaseId.localeCompare(right.leaseId);
}

function sameInode(left: Pick<import('node:fs').Stats, 'dev' | 'ino'>, right: Pick<import('node:fs').Stats, 'dev' | 'ino'>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function unlinkPinnedLease(path: string, expectedLeaseId: string | undefined, staleBefore?: number): boolean {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return false; }
  try {
    const before = fstatSync(fd);
    const lease = parseLease(readFileSync(fd, 'utf8'));
    const after = fstatSync(fd);
    const current = lstatSync(path);
    if (!before.isFile() || !sameInode(before, after) || !sameInode(after, current)
      || before.mtimeMs !== after.mtimeMs || after.mtimeMs !== current.mtimeMs
      || (expectedLeaseId !== undefined && lease?.leaseId !== expectedLeaseId)
      || (staleBefore !== undefined && current.mtimeMs >= staleBefore)) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

export function activeCredentialBootstrapLeases(
  directory: string,
  now = Date.now(),
): CredentialBootstrapLeaseRecord[] {
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  const leases: CredentialBootstrapLeaseRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.lease.json')) continue;
    try {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (now - stat.mtimeMs > CREDENTIAL_BOOTSTRAP_LEASE_STALE_MS) {
        unlinkPinnedLease(path, undefined, now - CREDENTIAL_BOOTSTRAP_LEASE_STALE_MS);
        continue;
      }
      const lease = parseLease(readFileSync(path, 'utf8'));
      if (lease) leases.push(lease);
    } catch { /* contender changed while scanning */ }
  }
  return leases;
}

export function currentCredentialBootstrapLease(
  directory: string,
  now = Date.now(),
): CredentialBootstrapLeaseRecord | undefined {
  return activeCredentialBootstrapLeases(directory, now)
    .sort(compareLease)
    .at(-1);
}

export function acquireCredentialBootstrapLease(
  directory: string,
  identity: Pick<CredentialBootstrapLeaseRecord, 'sessionId' | 'sessionCreatedAt'>,
): CredentialBootstrapLease {
  if (!/^[A-Za-z0-9_-]+$/.test(identity.sessionId)
    || !Number.isFinite(Date.parse(identity.sessionCreatedAt))) {
    throw new Error('invalid credential bootstrap lease identity');
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const leaseId = randomUUID();
  const runnerProcStart = readProcessStartIdentity(process.pid);
  const record: CredentialBootstrapLeaseRecord = {
    version: 1,
    leaseId,
    sessionId: identity.sessionId,
    sessionCreatedAt: identity.sessionCreatedAt,
    runnerStartedAt: Date.now(),
    runnerPid: hostNamespaceId('NSpid', process.pid),
    runnerPgid: hostNamespaceId('NSpgid', process.pid),
    ...(runnerProcStart ? { runnerProcStart } : {}),
  };
  const path = join(directory, `${identity.sessionId}.${leaseId}.lease.json`);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
  return {
    directory,
    path,
    record,
    isCurrent: () => currentCredentialBootstrapLease(directory)?.leaseId === leaseId,
    heartbeat: () => { try { utimesSync(path, new Date(), new Date()); } catch { /* released */ } },
  };
}

export function releaseCredentialBootstrapLease(lease: CredentialBootstrapLease): void {
  unlinkPinnedLease(lease.path, lease.record.leaseId);
}

export function removeCredentialBootstrapLease(
  directory: string,
  record: CredentialBootstrapLeaseRecord,
): boolean {
  return unlinkPinnedLease(join(directory, `${record.sessionId}.${record.leaseId}.lease.json`), record.leaseId);
}

export function credentialBootstrapLeaseProcessAlive(record: CredentialBootstrapLeaseRecord): boolean {
  if (!record.runnerProcStart) return true;
  return readProcessStartIdentity(record.runnerPid) === record.runnerProcStart;
}

export function signalCredentialBootstrapLeaseProcess(
  record: CredentialBootstrapLeaseRecord,
  signal: NodeJS.Signals,
): boolean {
  if (!record.runnerProcStart || readProcessStartIdentity(record.runnerPid) !== record.runnerProcStart) return false;
  try {
    const raw = readFileSync(`/proc/${record.runnerPid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/);
    if (Number(fields[2]) !== record.runnerPgid) return false;
    process.kill(-record.runnerPgid, signal);
    return true;
  } catch {
    return false;
  }
}
