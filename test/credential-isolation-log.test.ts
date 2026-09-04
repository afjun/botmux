import { describe, expect, it } from 'vitest';
import {
  formatCredentialTrace,
  maskCredentialIdentity,
} from '../src/core/credential-isolation-log.js';

describe('owner credential trace logging', () => {
  it('emits a stable grep-friendly chain record', () => {
    expect(formatCredentialTrace('bootstrap.plan_ready', {
      sessionId: '12345678-aaaa-bbbb-cccc-1234567890ab',
      botId: 'cli_demo_bot',
      ownerId: 'alice',
      openId: 'ou_80723f8f6f88a86b3028c9cc988fe22f',
      mountId: 'bytedcli',
      backend: 'pty',
      count: 1,
      result: 'ready',
      durationMs: 42,
      exitCode: 0,
    })).toBe(
      '[owner-credential] event=bootstrap.plan_ready session=12345678-aaa '
      + 'bot=cli_demo_bot owner=alice open_id=ou_8…e22f mount=bytedcli '
      + 'backend=pty result=ready count=1 duration_ms=42 exit_code=0',
    );
  });

  it('redacts URLs, bearer values, token assignments, and line breaks in reasons', () => {
    const line = formatCredentialTrace('bootstrap.failed', {
      reason: 'open https://login.example/path?token=secret\nAuthorization: Bearer abcdef',
    });
    expect(line).toContain('reason="open <redacted-url> Authorization: Bearer <redacted>"');
    expect(line).not.toContain('login.example');
    expect(line).not.toContain('abcdef');
    expect(line).not.toContain('\n');
  });

  it('masks identity-like values without making short diagnostics useless', () => {
    expect(maskCredentialIdentity('ou_1234567890abcdef')).toBe('ou_1…cdef');
    expect(maskCredentialIdentity('short')).toBe('short');
    expect(maskCredentialIdentity(undefined)).toBeUndefined();
  });
});
