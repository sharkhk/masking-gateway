import { describe, it, expect } from 'vitest';
import {
  maskOutbound, rehydrateResponse, makeStreamRehydrator, soucToCanonical,
  rehydrateToolArgs, maskToolResult,
  PolicyEngine, MaskSession, type TenantPolicy, type SoucChatInput,
} from '../src/index';

const CARD = '4242 4242 4242 4242';
const EMAIL = 'jane.doe@example.com';

const input = (): SoucChatInput => ({
  systemPrompt: `You help ${EMAIL}.`,
  messages: [
    { role: 'user', content: `Charge my card ${CARD} and email a receipt to ${EMAIL}.` },
    { role: 'assistant', content: 'Sure.' },
  ],
  model: 'gpt-4o-mini',
});

describe('SOUC integration seam', () => {
  it('masks every channel so no original PII survives in the outbound prompt', async () => {
    const r = await maskOutbound(input());
    expect(r.blocked).toBe(false);
    const blob = JSON.stringify({ s: r.systemPrompt, m: r.messages });
    expect(blob).not.toContain('4242');
    expect(blob).not.toContain(EMAIL);
    expect(r.entityCount).toBeGreaterThanOrEqual(2);
    // structure preserved
    expect(r.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('round-trips: rehydrating the masked prompt restores the originals (referential integrity)', async () => {
    const r = await maskOutbound(input());
    const restoredUser = rehydrateResponse(r.messages[0]!.content, r.session);
    expect(restoredUser).toContain('4242 4242 4242 4242');
    expect(restoredUser).toContain(EMAIL);
    // the same email in the system prompt got the SAME surrogate
    const restoredSys = rehydrateResponse(r.systemPrompt!, r.session);
    expect(restoredSys).toContain(EMAIL);
  });

  it('rehydrates a provider reply that echoes a surrogate', async () => {
    const r = await maskOutbound(input());
    // the email surrogate, which the model might echo back
    const surrogate = r.messages[0]!.content.match(/\[EMAIL_\d+_[0-9a-f]{8}\]/)![0];
    const reply = `I emailed the receipt to ${surrogate}.`;
    expect(rehydrateResponse(reply, r.session)).toContain(EMAIL);
  });

  it('streaming rehydrator restores a surrogate split across chunks', async () => {
    const r = await maskOutbound(input());
    const surrogate = r.systemPrompt!.match(/\[[A-Z_]+_\d+_[0-9a-f]{8}\]/)![0];
    const stream = makeStreamRehydrator(r.session);
    const mid = Math.floor(surrogate.length / 2);
    let out = stream.push('Contact ' + surrogate.slice(0, mid));
    out += stream.push(surrogate.slice(mid) + ' now.');
    out += stream.flush();
    expect(out).toContain(EMAIL);
    expect(out).not.toContain(surrogate); // fully rehydrated, no partial token leaked
  });

  it('policy BLOCK stops the send and returns no masked payload (fail-closed)', async () => {
    const tenant: TenantPolicy = {
      tenantId: 't1',
      default: { allowed: true, classes: { CREDIT_CARD: { action: 'block' } } },
    };
    const policy = new PolicyEngine([tenant]);
    const r = await maskOutbound(input(), { policy, tenantId: 't1', provider: 'openai' });
    expect(r.blocked).toBe(true);
    expect(r.messages).toHaveLength(0);
    expect(r.systemPrompt).toBeUndefined();
    expect(r.reasons.join(' ')).toMatch(/BLOCK/);
  });

  it('a forbidden provider blocks even a clean request', async () => {
    const tenant: TenantPolicy = { tenantId: 't1', default: { allowed: false } };
    const policy = new PolicyEngine([tenant]);
    const r = await maskOutbound({ messages: [{ role: 'user', content: 'hello' }] }, { policy, tenantId: 't1', provider: 'openai' });
    expect(r.blocked).toBe(true);
  });

  it('reuses a supplied session across turns for cross-turn referential integrity', async () => {
    const session = new MaskSession();
    const r1 = await maskOutbound({ messages: [{ role: 'user', content: `email ${EMAIL}` }] }, { session });
    const r2 = await maskOutbound({ messages: [{ role: 'user', content: `again ${EMAIL}` }] }, { session });
    const s1 = r1.messages[0]!.content.match(/\[EMAIL_\d+_[0-9a-f]{8}\]/)![0];
    const s2 = r2.messages[0]!.content.match(/\[EMAIL_\d+_[0-9a-f]{8}\]/)![0];
    expect(s1).toBe(s2); // same value → same surrogate across turns
  });

  it('closes the tool loop: rehydrate args → run → re-mask result (with the same session)', async () => {
    // mask a prompt containing an IP the model would pass to a tool
    const session = new MaskSession();
    const r = await maskOutbound({ messages: [{ role: 'user', content: 'scan 203.0.113.42 please' }] }, { session });
    const surrogate = r.messages[0]!.content.match(/\[IPV4_\d+_[0-9a-f]{8}\]/)![0];

    // 1) the model emits a tool call with the SURROGATE as the arg → rehydrate before running
    const modelArgs = { target: surrogate };
    const realArgs = rehydrateToolArgs(modelArgs, session) as { target: string };
    expect(realArgs.target).toBe('203.0.113.42'); // tool receives the REAL value

    // 2) the tool returns fresh PII (a new email) → re-mask before it re-enters the conversation
    const toolResult = { owner: 'admin@corp.example', ip: '203.0.113.42' };
    const masked = maskToolResult(toolResult, session) as { owner: string; ip: string };
    expect(masked.owner).not.toContain('admin@corp.example');
    expect(masked.ip).toBe(surrogate); // same IP → same surrogate (referential integrity)
    // and it rehydrates back
    expect(rehydrateResponse(masked.owner, session)).toContain('admin@corp.example');
  });

  it('reports byClass audit counts (counts only, no values)', async () => {
    const r = await maskOutbound(input());
    expect(r.byClass.CREDIT_CARD).toBe(1);
    expect(r.byClass.EMAIL).toBe(2); // system prompt + user message
    // audit object must not contain any raw value
    expect(JSON.stringify(r.byClass)).not.toContain('4242');
    expect(JSON.stringify(r.byClass)).not.toContain(EMAIL);
  });

  it('soucToCanonical coerces unknown roles to user and stringifies content', () => {
    const c = soucToCanonical({ messages: [{ role: 'weird', content: 'x' }] });
    expect(c.messages[0]!.role).toBe('user');
  });
});
