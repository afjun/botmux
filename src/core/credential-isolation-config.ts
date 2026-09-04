import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const CREDENTIAL_BOOTSTRAP_DEFAULT_TIMEOUT_SECONDS = 600;
export const CREDENTIAL_BOOTSTRAP_MIN_TIMEOUT_SECONDS = 30;
export const CREDENTIAL_BOOTSTRAP_MAX_TIMEOUT_SECONDS = 1_800;

export type CredentialIsolationPresetId = 'bytedcli' | 'bytecloud' | 'devflow' | 'playwright';
export type CredentialMountKind = 'directory' | 'file';

export interface CredentialCommandConfig {
  command: string;
  args: string[];
}

export interface CredentialBootstrapConfig extends CredentialCommandConfig {
  /** Paths relative to `~/.botmux/owners/<owner>/` that must exist after login. */
  successPaths: string[];
  checkCommand?: CredentialCommandConfig;
  timeoutSeconds: number;
}

/** A fully normalized, active mount. Safe to persist as a Session snapshot. */
export interface CredentialMountConfig {
  id: string;
  kind: CredentialMountKind;
  /** Canonical HOME-relative target, always rendered as `~/...`. */
  target: string;
  /** Relative path below `~/.botmux/owners/<owner>/`. */
  ownerSubdir: string;
  bootstrap?: CredentialBootstrapConfig;
}

export interface CredentialIsolationConfig {
  enabled: boolean;
  /** Effective preset switches. Missing input means all built-ins are enabled. */
  presets: Record<CredentialIsolationPresetId, boolean>;
  /** Effective active mounts after preset expansion and custom id overrides. */
  mounts: CredentialMountConfig[];
}

const ALL_PRESETS: CredentialIsolationPresetId[] = [
  'bytedcli',
  'bytecloud',
  'devflow',
  'playwright',
];

/**
 * Core credential locations. DevFlow deliberately mounts only authentication
 * data and its token cache; mounting all of ~/.devflow-cli would hide its
 * executable, dependencies and skills.
 */
export const BUILTIN_CREDENTIAL_MOUNTS: Readonly<Record<CredentialIsolationPresetId, readonly CredentialMountConfig[]>> = {
  bytedcli: [{
    id: 'bytedcli',
    kind: 'directory',
    target: '~/.local/share/bytedcli',
    ownerSubdir: 'bytedcli',
    bootstrap: {
      command: 'bytedcli',
      args: ['auth', 'login'],
      successPaths: ['bytedcli/data/userinfo.json'],
      checkCommand: { command: 'bytedcli', args: ['--json', 'auth', 'status'] },
      timeoutSeconds: CREDENTIAL_BOOTSTRAP_DEFAULT_TIMEOUT_SECONDS,
    },
  }],
  bytecloud: [{
    id: 'bytecloud',
    kind: 'directory',
    target: '~/.config/bytecloud-cli',
    ownerSubdir: 'bytecloud-cli',
    bootstrap: {
      command: 'bytecloud-cli',
      args: ['auth', 'init', '--timeout', '10m'],
      successPaths: ['bytecloud-cli/auth/cn'],
      checkCommand: { command: 'bytecloud-cli', args: ['auth', 'status'] },
      timeoutSeconds: CREDENTIAL_BOOTSTRAP_DEFAULT_TIMEOUT_SECONDS,
    },
  }],
  devflow: [{
    id: 'devflow-conf',
    kind: 'directory',
    target: '~/.devflow-cli/conf',
    ownerSubdir: 'devflow/conf',
  }, {
    id: 'devflow-auth',
    kind: 'directory',
    target: '~/.devflow-cli/localcache',
    ownerSubdir: 'devflow/localcache',
    bootstrap: {
      command: 'devflow-cli',
      args: ['auth', 'update'],
      successPaths: ['devflow/localcache/cloud_jwt_token.txt'],
      timeoutSeconds: CREDENTIAL_BOOTSTRAP_DEFAULT_TIMEOUT_SECONDS,
    },
  }],
  playwright: [{
    id: 'playwright',
    kind: 'directory',
    target: '~/.cache/ms-playwright-mcp',
    ownerSubdir: 'playwright',
  }],
};

interface NormalizeCredentialIsolationOptions {
  homeDir?: string;
  workingDirs?: string[];
  /** Disable host filesystem checks only in tests for synthetic HOME paths. */
  checkFilesystem?: boolean;
  configPath?: string;
}

type MutableMount = {
  id?: unknown;
  enabled?: unknown;
  kind?: unknown;
  target?: unknown;
  ownerSubdir?: unknown;
  bootstrap?: unknown;
};

function invalid(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownKeys(raw: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) invalid(`${path}.${key}`, 'is not supported');
  }
}

export function cloneCredentialMount(mount: CredentialMountConfig): CredentialMountConfig {
  return {
    ...mount,
    bootstrap: mount.bootstrap ? {
      ...mount.bootstrap,
      args: [...mount.bootstrap.args],
      successPaths: [...mount.bootstrap.successPaths],
      checkCommand: mount.bootstrap.checkCommand
        ? { ...mount.bootstrap.checkCommand, args: [...mount.bootstrap.checkCommand.args] }
        : undefined,
    } : undefined,
  };
}

function normalizeId(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    invalid(path, 'must be 1-64 characters containing only letters, digits, dot, underscore or dash');
  }
  return value;
}

function normalizeRelativePath(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || isAbsolute(value)) {
    invalid(path, 'must be a non-empty portable relative path');
  }
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    invalid(path, 'must not contain empty, dot or parent segments');
  }
  return segments.join('/');
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function normalizeTarget(value: unknown, kind: CredentialMountKind, path: string, options: NormalizeCredentialIsolationOptions): string {
  if (typeof value !== 'string' || value.includes('\0')) {
    invalid(path, 'must be a path below $HOME');
  }
  const homeDir = resolve(options.homeDir ?? homedir());
  let suffix: string;
  if (value.startsWith('~/')) suffix = value.slice(2);
  else if (value.startsWith('$HOME/')) suffix = value.slice(6);
  else invalid(path, 'must start with ~/ or $HOME/');

  const target = resolve(homeDir, suffix!);
  if (target === homeDir || !isWithin(homeDir, target)) invalid(path, 'must resolve strictly below $HOME');
  const botmuxDir = resolve(homeDir, '.botmux');
  if (isWithin(botmuxDir, target)) invalid(path, 'must not target ~/.botmux');

  for (const workingDir of options.workingDirs ?? []) {
    const absoluteWorkingDir = workingDir === '~'
      ? homeDir
      : workingDir.startsWith('~/')
        ? resolve(homeDir, workingDir.slice(2))
        : resolve(workingDir);
    if (isWithin(target, absoluteWorkingDir)) {
      invalid(path, 'must not target a working directory or one of its ancestors');
    }
  }

  if (options.checkFilesystem !== false) {
    let cursor = target;
    while (cursor !== homeDir && !existsSync(cursor)) cursor = dirname(cursor);
    if (existsSync(cursor)) {
      const resolvedCursor = realpathSync(cursor);
      const resolvedHome = realpathSync(homeDir);
      if (!isWithin(resolvedHome, resolvedCursor)) invalid(path, 'must not escape $HOME through a symbolic link');
    }
    if (existsSync(target)) {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) invalid(path, 'must not be a symbolic link');
      if (kind === 'directory' && !stat.isDirectory()) invalid(path, 'must refer to a directory');
      if (kind === 'file' && !stat.isFile()) invalid(path, 'must refer to a regular file');
    }
  }

  const homeRelative = relative(homeDir, target).split(sep).join('/');
  return `~/${homeRelative}`;
}

function normalizeStringArray(value: unknown, path: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) invalid(path, 'must be a non-empty string array');
  return value.map((item, index) => {
    if (typeof item !== 'string' || !item) invalid(`${path}[${index}]`, 'must be a non-empty string');
    return item;
  });
}

function normalizeCommand(raw: unknown, path: string): CredentialCommandConfig {
  if (!isObject(raw)) invalid(path, 'must be an object');
  rejectUnknownKeys(raw, ['command', 'args'], path);
  if (typeof raw.command !== 'string' || !raw.command.trim()) invalid(`${path}.command`, 'must be a non-empty string');
  return {
    command: raw.command.trim(),
    args: raw.args === undefined ? [] : normalizeStringArray(raw.args, `${path}.args`, true),
  };
}

function normalizeBootstrap(raw: unknown, path: string): CredentialBootstrapConfig {
  if (!isObject(raw)) invalid(path, 'must be an object');
  rejectUnknownKeys(raw, ['command', 'args', 'successPaths', 'checkCommand', 'timeoutSeconds'], path);
  const command = normalizeCommand({ command: raw.command, args: raw.args }, path);
  const object = raw as Record<string, unknown>;
  const timeout = object.timeoutSeconds ?? CREDENTIAL_BOOTSTRAP_DEFAULT_TIMEOUT_SECONDS;
  if (typeof timeout !== 'number' || !Number.isInteger(timeout)
    || timeout < CREDENTIAL_BOOTSTRAP_MIN_TIMEOUT_SECONDS
    || timeout > CREDENTIAL_BOOTSTRAP_MAX_TIMEOUT_SECONDS) {
    invalid(`${path}.timeoutSeconds`, `must be an integer from ${CREDENTIAL_BOOTSTRAP_MIN_TIMEOUT_SECONDS} to ${CREDENTIAL_BOOTSTRAP_MAX_TIMEOUT_SECONDS}`);
  }
  const successPaths = normalizeStringArray(object.successPaths, `${path}.successPaths`, false)
    .map((item, index) => normalizeRelativePath(item, `${path}.successPaths[${index}]`));
  return {
    ...command,
    successPaths,
    checkCommand: object.checkCommand === undefined
      ? undefined
      : normalizeCommand(object.checkCommand, `${path}.checkCommand`),
    timeoutSeconds: timeout,
  };
}

function normalizeMount(raw: MutableMount, base: CredentialMountConfig | undefined, path: string, options: NormalizeCredentialIsolationOptions): CredentialMountConfig {
  const id = normalizeId(raw.id, `${path}.id`);
  const kind = raw.kind ?? base?.kind;
  if (kind !== 'directory' && kind !== 'file') invalid(`${path}.kind`, 'must be "directory" or "file"');
  const ownerSubdir = normalizeRelativePath(raw.ownerSubdir ?? base?.ownerSubdir, `${path}.ownerSubdir`);
  const bootstrap = raw.bootstrap === undefined
    ? base?.bootstrap && cloneCredentialMount(base).bootstrap
    : raw.bootstrap === null
      ? undefined
      : normalizeBootstrap(raw.bootstrap, `${path}.bootstrap`);
  if (kind === 'file' && bootstrap) {
    invalid(`${path}.bootstrap`, 'is supported only for directory mounts');
  }
  return {
    id,
    kind,
    target: normalizeTarget(raw.target ?? base?.target, kind, `${path}.target`, options),
    ownerSubdir,
    bootstrap,
  };
}

/** Strictly normalize the bots.json credentialIsolation block. */
export function normalizeCredentialIsolationConfig(
  raw: unknown,
  options: NormalizeCredentialIsolationOptions = {},
): CredentialIsolationConfig | undefined {
  if (raw === undefined) return undefined;
  const configPath = options.configPath ?? 'credentialIsolation';
  if (!isObject(raw)) invalid(configPath, 'must be an object');
  if (typeof raw.enabled !== 'boolean') invalid(`${configPath}.enabled`, 'must be a boolean');

  const presets = Object.fromEntries(ALL_PRESETS.map(id => [id, true])) as Record<CredentialIsolationPresetId, boolean>;
  // Disabled Bots intentionally retain the legacy host-credential behavior;
  // dormant isolation details must not affect their ability to start.
  if (!raw.enabled) return { enabled: false, presets, mounts: [] };

  rejectUnknownKeys(raw, ['enabled', 'presets', 'mounts'], configPath);
  const mountOptions = options;
  if (raw.presets !== undefined) {
    if (!isObject(raw.presets)) invalid(`${configPath}.presets`, 'must be an object');
    for (const key of Object.keys(raw.presets)) {
      if (!ALL_PRESETS.includes(key as CredentialIsolationPresetId)) invalid(`${configPath}.presets.${key}`, 'is not a supported preset');
      if (typeof raw.presets[key] !== 'boolean') invalid(`${configPath}.presets.${key}`, 'must be a boolean');
      presets[key as CredentialIsolationPresetId] = raw.presets[key];
    }
  }

  const mounts = new Map<string, CredentialMountConfig>();
  for (const preset of ALL_PRESETS) {
    if (!presets[preset]) continue;
    for (const mount of BUILTIN_CREDENTIAL_MOUNTS[preset]) {
      mounts.set(mount.id, normalizeMount(mount, undefined, `${configPath}.presets.${preset}`, mountOptions));
    }
  }

  if (raw.mounts !== undefined) {
    if (!Array.isArray(raw.mounts)) invalid(`${configPath}.mounts`, 'must be an array');
    const seen = new Set<string>();
    raw.mounts.forEach((item, index) => {
      const itemPath = `${configPath}.mounts[${index}]`;
      if (!isObject(item)) invalid(itemPath, 'must be an object');
      rejectUnknownKeys(item, ['id', 'enabled', 'kind', 'target', 'ownerSubdir', 'bootstrap'], itemPath);
      const id = normalizeId(item.id, `${itemPath}.id`);
      if (seen.has(id)) invalid(`${itemPath}.id`, 'must be unique');
      seen.add(id);
      if (item.enabled !== undefined && typeof item.enabled !== 'boolean') invalid(`${itemPath}.enabled`, 'must be a boolean');
      const builtin = ALL_PRESETS.flatMap(preset => BUILTIN_CREDENTIAL_MOUNTS[preset]).find(mount => mount.id === id);
      if (item.enabled === false) {
        if (!mounts.has(id) && !builtin) invalid(`${itemPath}.id`, 'cannot disable an unknown mount');
        mounts.delete(id);
        return;
      }
      mounts.set(id, normalizeMount(item, mounts.get(id) ?? builtin, itemPath, mountOptions));
    });
  }

  const activeMounts = [...mounts.values()];
  const overlaps = (left: string, right: string): boolean => left === right
    || left.startsWith(`${right}/`)
    || right.startsWith(`${left}/`);
  for (let i = 0; i < activeMounts.length; i++) {
    for (let j = i + 1; j < activeMounts.length; j++) {
      if (overlaps(activeMounts[i].target, activeMounts[j].target)) {
        invalid(configPath, `overlapping mount targets: ${activeMounts[i].target}, ${activeMounts[j].target}`);
      }
      if (overlaps(activeMounts[i].ownerSubdir, activeMounts[j].ownerSubdir)) {
        invalid(configPath, `overlapping ownerSubdir paths: ${activeMounts[i].ownerSubdir}, ${activeMounts[j].ownerSubdir}`);
      }
    }
  }

  return { enabled: raw.enabled, presets, mounts: raw.enabled ? activeMounts : [] };
}
