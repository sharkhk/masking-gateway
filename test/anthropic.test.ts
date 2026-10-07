import { describe, it, expect } from 'vitest';
import { toAnthropicBody, ANTHROPIC_DEFAULT_MAX_TOKENS } from '../src/index';
import type { CanonicalRequest } from '../src/index';

describe('B11 — Anthropic Messages adapter (transparency)', () => {
  it('hoists system + system/developer messages to the top-level system param', () => {
    const req: CanonicalRequest = {
      model: 'claude-sonnet-5',
      system: 'You are helpful.',
      messages: [
        { role: 'developer', content: 'Be terse.' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
      ],
    };
    const body = toAnthropicBody(req);
    expect(body.system).toBe('You are helpful.\n\nBe terse.');
    // only user/assistant survive in messages
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('requires max_tokens — supplies the default when canonical omits it', () => {
    const body = toAnthropicBody({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] });
    expect(body.max_tokens).toBe(ANTHROPIC_DEFAULT_MAX_TOKENS);
    const body2 = toAnthropicBody({ model: 'claude-sonnet-5', maxTokens: 256, messages: [{ role: 'user', content: 'hi' }] });
    expect(body2.max_tokens).toBe(256);
  });

  it('maps a tool message to a tool_result content block inside a user message', () => {
    const body = toAnthropicBody({
      model: 'claude-sonnet-5',
      messages: [{ role: 'tool', content: '{"ok":true}', toolCallId: 'call_1' }],
    });
    expect(body.messages[0]!.role).toBe('user');
    expect(body.messages[0]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'call_1', content: '{"ok":true}' },
    ]);
  });

  it('renames stop → stop_sequences and metadata.user → metadata.user_id; maps tools to input_schema', () => {
    const body = toAnthropicBody({
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'hi' }],
      stop: ['END'],
      metadata: { user: 'u-123' },
      tools: [{ name: 'lookup', description: 'd', parameters: { type: 'object', properties: { q: { type: 'string' } } } }],
    });
    expect(body.stop_sequences).toEqual(['END']);
    expect(body.metadata).toEqual({ user_id: 'u-123' });
    expect(body.tools![0]!.input_schema).toEqual({ type: 'object', properties: { q: { type: 'string' } } });
  });
});
