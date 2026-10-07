import { describe, it, expect } from 'vitest';
import {
  asUnmasked, Sensitive, mask, toOpenAIBody, OpenAIProvider,
  type CanonicalRequest,
} from '../src/index';

const sampleReq = (): CanonicalRequest => ({
  model: 'gpt-4o-mini',
  system: 'You are helpful.',
  messages: [{ role: 'user', content: 'Hello there' }],
  tools: [{ name: 'lookup', description: 'look something up', parameters: { type: 'object' } }],
  metadata: { user: 'client-123' },
  maxTokens: 256,
  temperature: 0.2,
  stop: ['\n\n'],
});

describe('B3 — Sensitive logging guard', () => {
  it('redacts in String / JSON / template, reveals only explicitly', () => {
    const s = new Sensitive('sk-super-secret-key');
    expect(String(s)).toBe('[REDACTED]');
    expect(`${s}`).toBe('[REDACTED]');
    expect(JSON.stringify({ apiKey: s })).toBe('{"apiKey":"[REDACTED]"}');
    expect(JSON.stringify(s)).toBe('"[REDACTED]"');
    expect(s.reveal()).toBe('sk-super-secret-key'); // explicit + greppable
  });
});

describe('B3 — the choke point', () => {
  it('mask() is the only producer of Masked, and its result is accepted by a provider', async () => {
    const { masked, entityCount } = await mask(asUnmasked(sampleReq()));
    expect(entityCount).toBe(0); // stage 1: no detectors yet
    const provider = new OpenAIProvider('https://api.openai.com/v1', new Sensitive('sk-test'));
    const res = await provider.send(masked); // compiles: masked is Masked<CanonicalRequest>
    expect(res).toBeTruthy();
  });

  it('COMPILE-TIME: raw/Unmasked data cannot reach a provider', async () => {
    const provider = new OpenAIProvider('https://api.openai.com/v1', new Sensitive('sk-test'));
    const raw = sampleReq();
    // @ts-expect-error — a plain CanonicalRequest is not Masked<CanonicalRequest>
    await provider.send(raw);
    // @ts-expect-error — an Unmasked<CanonicalRequest> is not Masked<CanonicalRequest>
    await provider.send(asUnmasked(sampleReq()));
    expect(true).toBe(true);
  });
});

describe('Stage 1 — transparency (provider-compatible re-encode)', () => {
  it('builds an OpenAI body that faithfully mirrors the canonical request', () => {
    const body = toOpenAIBody(sampleReq());
    expect(body.model).toBe('gpt-4o-mini');
    // system is prepended as the first message
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Hello there' });
    expect(body.tools?.[0]).toEqual({
      type: 'function',
      function: { name: 'lookup', description: 'look something up', parameters: { type: 'object' } },
    });
    expect(body.max_tokens).toBe(256);
    expect(body.temperature).toBe(0.2);
    expect(body.stop).toEqual(['\n\n']);
    expect(body.user).toBe('client-123'); // metadata.user → OpenAI `user`
  });

  it("maps the 'developer' role to 'system' for classic chat", () => {
    const body = toOpenAIBody({ model: 'm', messages: [{ role: 'developer', content: 'rules' }] });
    expect(body.messages[0]?.role).toBe('system');
  });
});
