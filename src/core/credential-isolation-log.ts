export interface CredentialTraceFields {
  sessionId?: string;
  botId?: string;
  connectorId?: string;
  taskId?: string;
  ownerId?: string;
  openId?: string;
  mountId?: string;
  ownerSubdir?: string;
  target?: string;
  backend?: string;
  source?: string;
  scope?: string;
  result?: string;
  reason?: string;
  count?: number;
  timeoutSeconds?: number;
  durationMs?: number;
  exitCode?: number;
  signal?: string;
  sandbox?: boolean;
  hasCheck?: boolean;
  fresh?: boolean;
  attempt?: number;
  pid?: number;
}

const FIELD_ORDER: ReadonlyArray<keyof CredentialTraceFields> = [
  'sessionId',
  'botId',
  'connectorId',
  'taskId',
  'ownerId',
  'openId',
  'mountId',
  'ownerSubdir',
  'target',
  'backend',
  'source',
  'scope',
  'result',
  'reason',
  'count',
  'timeoutSeconds',
  'durationMs',
  'exitCode',
  'signal',
  'sandbox',
  'hasCheck',
  'fresh',
  'attempt',
  'pid',
];

const FIELD_NAMES: Record<keyof CredentialTraceFields, string> = {
  sessionId: 'session',
  botId: 'bot',
  connectorId: 'connector',
  taskId: 'task',
  ownerId: 'owner',
  openId: 'open_id',
  mountId: 'mount',
  ownerSubdir: 'owner_subdir',
  target: 'target',
  backend: 'backend',
  source: 'source',
  scope: 'scope',
  result: 'result',
  reason: 'reason',
  count: 'count',
  timeoutSeconds: 'timeout_s',
  durationMs: 'duration_ms',
  exitCode: 'exit_code',
  signal: 'signal',
  sandbox: 'sandbox',
  hasCheck: 'has_check',
  fresh: 'fresh',
  attempt: 'attempt',
  pid: 'pid',
};

/** Keep enough identity for correlation while avoiding full Open IDs in logs. */
export function maskCredentialIdentity(value: string | undefined): string | undefined {
  if (!value || value.length <= 10) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function sanitizeReason(value: string): string {
  return value
    .replace(/https?:\/\/[^\s<>'"]+/gi, '<redacted-url>')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, '$1<redacted>')
    .replace(/((?:access[_-]?token|refresh[_-]?token|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, '$1<redacted>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function renderValue(key: keyof CredentialTraceFields, value: string | number | boolean): string {
  let rendered = String(value);
  if (key === 'sessionId' || key === 'connectorId' || key === 'taskId') rendered = rendered.slice(0, 12);
  if (key === 'openId') rendered = maskCredentialIdentity(rendered) ?? '';
  if (key === 'reason') rendered = sanitizeReason(rendered);
  return /^[A-Za-z0-9._~:/@+…-]+$/.test(rendered) ? rendered : JSON.stringify(rendered);
}

/** Stable, grep-friendly trace shared by daemon and worker logs. Callers pass
 * only non-secret metadata; reason receives a final defensive redaction pass. */
export function formatCredentialTrace(event: string, fields: CredentialTraceFields = {}): string {
  const parts = [`[owner-credential] event=${event}`];
  for (const key of FIELD_ORDER) {
    const value = fields[key];
    if (value === undefined) continue;
    parts.push(`${FIELD_NAMES[key]}=${renderValue(key, value)}`);
  }
  return parts.join(' ');
}
