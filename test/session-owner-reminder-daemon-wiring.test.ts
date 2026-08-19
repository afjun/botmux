import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');

describe('session owner reminder daemon wiring', () => {
  it('registers the reset-capable controller before dashboard IPC accepts writes', () => {
    const createAt = source.indexOf('new SessionOwnerReminderController');
    const registerAt = source.indexOf('setSessionOwnerReminderResetHandler(() => sessionOwnerReminder.reset())');
    const ipcAt = source.indexOf('await startIpcServer');

    expect(createAt).toBeGreaterThan(-1);
    expect(registerAt).toBeGreaterThan(createAt);
    expect(ipcAt).toBeGreaterThan(registerAt);
    expect(source).toContain('timeZone: scheduleTimeZone');
  });

  it('unregisters the reset handler during shutdown and process exit', () => {
    expect(source.match(/setSessionOwnerReminderResetHandler\(null\)/g)).toHaveLength(2);
  });
});
