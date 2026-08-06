import { describe, expect, it, vi } from 'vitest';

import { renderConnectorTopicTemplate } from '../src/services/connector-topic-template.js';
import type { ConnectorDefinition } from '../src/services/connector-store.js';

function templateConnector(): ConnectorDefinition {
  return {
    id: 'conn_template',
    name: 'Meego development',
    enabled: true,
    verify: {
      type: 'token',
      secretRef: 'secret',
      signatureHeader: 'x-botmux-signature',
      timestampHeader: 'x-botmux-timestamp',
      nonceHeader: 'x-botmux-nonce',
      toleranceSeconds: 300,
    },
    target: { mode: 'fixed', kind: 'turn', botId: 'app1', chatId: 'oc_topic' },
    promptEnvelope: {
      sourceName: 'Meego',
      headerAllowlist: [],
      includeRawText: false,
      maxBodyBytes: 1024,
    },
    topicMessage: {
      mode: 'template',
      text: '{{mention owners}} {{mention watchers}}',
      extractors: {
        owners: { path: '$.owners', kind: 'mention' },
        watchers: { path: '$.watchers', kind: 'mention' },
      },
    },
    loggingPolicy: { storePayload: false, storeHeaders: false, retentionDays: 14 },
    lifecycleExtractors: null,
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
  };
}

describe('connector trusted topic template', () => {
  it('caps mention extraction globally across aliases', async () => {
    const resolveIdentities = vi.fn(async (_botId: string, identities: string[]) => (
      new Map(identities.map((identity, index) => [identity, `ou_${index}`]))
    ));
    const owners = Array.from({ length: 15 }, (_, index) => `owner${index}@corp.com`);
    const watchers = Array.from({ length: 15 }, (_, index) => `watcher${index}@corp.com`);

    await renderConnectorTopicTemplate(templateConnector(), { owners, watchers }, resolveIdentities);

    expect(resolveIdentities).toHaveBeenCalledWith('app1', [...owners, ...watchers.slice(0, 5)]);
  });
});
