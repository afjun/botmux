import type { ConnectorDefinition, ConnectorTopicMessageExtractor } from './connector-store.js';
import { getJsonPathValue } from './webhook-lifecycle-extractors.js';

const TEMPLATE_TOKEN = /{{\s*(?:(mention)\s+)?([A-Za-z][A-Za-z0-9_.-]{0,63})\s*}}/g;
const MAX_TOPIC_MESSAGE_CODEPOINTS = 200;
const MAX_MENTION_VALUES = 20;
const VALID_OPEN_ID = /^ou_[A-Za-z0-9_-]+$/;

export type ResolveConnectorMentionIdentities = (
  botId: string,
  identities: string[],
) => Promise<Map<string, string>>;

interface MentionCandidate {
  identity: string;
  name: string;
}

interface RenderChunk {
  text: string;
  kind: 'static' | 'flexible' | 'mention';
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** Neutralize Lark-native tags originating in webhook data. Full-width
 *  punctuation keeps the visible information while making `<at>` inert. */
export function escapeConnectorTopicText(value: string): string {
  return value.replaceAll('&', '＆').replaceAll('<', '＜').replaceAll('>', '＞');
}

function mentionCandidates(
  value: unknown,
  extractor: ConnectorTopicMessageExtractor,
  limit: number,
): MentionCandidate[] {
  const values = Array.isArray(value) ? value : [value];
  const candidates: MentionCandidate[] = [];
  for (const item of values) {
    if (candidates.length >= limit) break;
    const identityValue = extractor.identityPath
      ? getJsonPathValue(item, extractor.identityPath)
      : item;
    const identity = scalarText(identityValue);
    if (!identity || Array.from(identity).length > 320 || /[<>\r\n]/.test(identity)) continue;
    const extractedName = extractor.namePath
      ? scalarText(getJsonPathValue(item, extractor.namePath))
      : undefined;
    candidates.push({ identity, name: extractedName ?? identity });
  }
  return candidates;
}

function limitedTopicMessage(chunks: RenderChunk[]): string {
  const length = (value: string): number => Array.from(value).length;
  const mentionLength = chunks
    .filter(chunk => chunk.kind === 'mention')
    .reduce((total, chunk) => total + length(chunk.text), 0);
  const staticLength = chunks
    .filter(chunk => chunk.kind === 'static')
    .reduce((total, chunk) => total + length(chunk.text), 0);
  let staticBudget = Math.min(staticLength, Math.max(0, MAX_TOPIC_MESSAGE_CODEPOINTS - mentionLength));
  let flexibleBudget = Math.max(0, MAX_TOPIC_MESSAGE_CODEPOINTS - mentionLength - staticBudget);
  const output: string[] = [];
  let remaining = MAX_TOPIC_MESSAGE_CODEPOINTS;
  for (const chunk of chunks) {
    const codepoints = Array.from(chunk.text);
    if (chunk.kind === 'mention') {
      if (codepoints.length <= remaining) {
        output.push(chunk.text);
        remaining -= codepoints.length;
      }
      continue;
    }
    const budget = chunk.kind === 'static' ? staticBudget : flexibleBudget;
    const take = Math.min(remaining, budget, codepoints.length);
    if (take > 0) output.push(codepoints.slice(0, take).join(''));
    remaining -= take;
    if (chunk.kind === 'static') staticBudget -= take;
    else flexibleBudget -= take;
  }
  return output.join('').trim();
}

export async function renderConnectorTopicTemplate(
  connector: ConnectorDefinition,
  payload: unknown,
  resolveIdentities: ResolveConnectorMentionIdentities,
): Promise<string | undefined> {
  const topicMessage = connector.topicMessage;
  if (topicMessage?.mode !== 'template' || !topicMessage.text || !topicMessage.extractors) return undefined;

  const mentionValues = new Map<string, MentionCandidate[]>();
  const identities: string[] = [];
  let mentionCount = 0;
  for (const [alias, extractor] of Object.entries(topicMessage.extractors)) {
    if (extractor.kind !== 'mention') continue;
    const candidates = mentionCandidates(
      getJsonPathValue(payload, extractor.path),
      extractor,
      Math.max(0, MAX_MENTION_VALUES - mentionCount),
    );
    mentionValues.set(alias, candidates);
    mentionCount += candidates.length;
    for (const candidate of candidates) {
      if (!identities.includes(candidate.identity)) identities.push(candidate.identity);
    }
  }

  let resolved = new Map<string, string>();
  if (identities.length > 0) {
    try {
      resolved = await resolveIdentities(connector.target.botId, identities);
    } catch {
      // Identity lookup is best-effort. A contact outage must not discard the
      // whole authenticated webhook; unresolved entries fall back to safe text.
    }
  }

  const source = connector.promptEnvelope.sourceName || connector.name;
  const chunks: RenderChunk[] = [];
  let cursor = 0;
  for (const match of topicMessage.text.matchAll(TEMPLATE_TOKEN)) {
    const index = match.index ?? 0;
    if (index > cursor) chunks.push({ text: topicMessage.text.slice(cursor, index), kind: 'static' });
    const mention = match[1];
    const alias = match[2];
    if (alias === 'source') {
      chunks.push({ text: escapeConnectorTopicText(source), kind: 'flexible' });
      cursor = index + match[0].length;
      continue;
    }
    const extractor = topicMessage.extractors?.[alias];
    if (!extractor) {
      cursor = index + match[0].length;
      continue;
    }
    if (!mention) {
      const value = scalarText(getJsonPathValue(payload, extractor.path));
      if (value) chunks.push({ text: escapeConnectorTopicText(value), kind: 'flexible' });
      cursor = index + match[0].length;
      continue;
    }
    const renderedMentions = (mentionValues.get(alias) ?? []).map(candidate => {
      const openId = resolved.get(candidate.identity);
      const name = escapeConnectorTopicText(candidate.name);
      return openId && VALID_OPEN_ID.test(openId)
        ? `<at user_id="${openId}">${name}</at>`
        : name;
    });
    renderedMentions.forEach((value, position) => {
      if (position > 0) chunks.push({ text: ' ', kind: 'static' });
      chunks.push({ text: value, kind: value.startsWith('<at user_id="') ? 'mention' : 'static' });
    });
    cursor = index + match[0].length;
  }
  if (cursor < topicMessage.text.length) {
    chunks.push({ text: topicMessage.text.slice(cursor), kind: 'static' });
  }
  return limitedTopicMessage(chunks) || undefined;
}
