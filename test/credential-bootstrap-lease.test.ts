import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireCredentialBootstrapLease,
  currentCredentialBootstrapLease,
  releaseCredentialBootstrapLease,
} from '../src/core/credential-bootstrap-lease.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'credential-bootstrap-lease-'));

describe('owner credential bootstrap lease', () => {
  it('makes the newest durable session authoritative regardless of acquisition order', () => {
    const directory = tmp();
    const newer = acquireCredentialBootstrapLease(directory, {
      sessionId: 'session-new',
      sessionCreatedAt: '2026-09-06T11:25:00.000Z',
    });
    const restoredOlder = acquireCredentialBootstrapLease(directory, {
      sessionId: 'session-old',
      sessionCreatedAt: '2026-09-06T11:20:00.000Z',
    });

    expect(currentCredentialBootstrapLease(directory)?.leaseId).toBe(newer.record.leaseId);
    expect(restoredOlder.isCurrent()).toBe(false);
    expect(newer.isCurrent()).toBe(true);

    releaseCredentialBootstrapLease(restoredOlder);
    releaseCredentialBootstrapLease(newer);
  });

  it('removes a stale crashed-runner candidate', () => {
    const directory = tmp();
    const crashed = acquireCredentialBootstrapLease(directory, {
      sessionId: 'session-crashed',
      sessionCreatedAt: '2026-09-06T11:20:00.000Z',
    });
    const stale = new Date(Date.now() - 60_000);
    utimesSync(crashed.path, stale, stale);

    expect(currentCredentialBootstrapLease(directory)).toBeUndefined();
    expect(existsSync(crashed.path)).toBe(false);
  });
});
