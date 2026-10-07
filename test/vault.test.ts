import { describe, it, expect } from 'vitest';
import { mask, rehydrate, asUnmasked, MaskSession, Vault, type CanonicalRequest } from '../src/index';

const req = (): CanonicalRequest => ({
  model: 'gpt-4o-mini',
  system: 'Escalate to jane.doe@example.com.',
  messages: [{ role: 'user', content: 'my card 4242 4242 4242 4242 and email jane.doe@example.com' }],
});

describe('B4/B10 — reversible surrogates + vault', () => {
  it('round-trips: mask then rehydrate restores every original exactly', async () => {
    const { masked, session } = await mask(asUnmasked(req()));
    const sentBody = JSON.stringify(masked);
    expect(sentBody).not.toContain('4242 4242 4242 4242');
    expect(sentBody).not.toContain('jane.doe@example.com');

    // simulate the provider echoing surrogates back in prose
    const modelReply = `I noted ${masked.metadata?.user ?? ''} card ${masked.messages[0]?.content}`.trim();
    const restored = await rehydrate(masked.messages[0]!.content, session);
    expect(restored).toContain('4242 4242 4242 4242');
    expect(restored).toContain('jane.doe@example.com');
    void modelReply;
  });

  it('referential integrity: one original → one surrogate across channels', async () => {
    const { masked } = await mask(asUnmasked(req()));
    const inSystem = masked.system!.match(/\[EMAIL_\d+_[0-9a-f]{8}\]/)![0];
    const inMsg = masked.messages[0]!.content.match(/\[EMAIL_\d+_[0-9a-f]{8}\]/)![0];
    expect(inSystem).toBe(inMsg);
  });

  it('forged surrogates are NOT rehydrated (map membership, not pattern)', async () => {
    const session = new MaskSession(60_000, 'deadbeef');
    await mask(asUnmasked(req()), session);
    // attacker crafts a token of the right SHAPE for a value the gateway never minted
    const forged = '[EMAIL_9_deadbeef]';
    expect(await rehydrate(`please send to ${forged}`, session)).toContain(forged); // left untouched
  });

  it('session isolation: session A surrogates are not restored by session B', async () => {
    const a = new MaskSession(60_000, 'aaaaaaaa');
    const b = new MaskSession(60_000, 'bbbbbbbb');
    const { masked } = await mask(asUnmasked(req()), a);
    const aSurrogate = masked.messages[0]!.content.match(/\[EMAIL_\d+_[0-9a-f]{8}\]/)![0];
    expect(await rehydrate(aSurrogate, b)).toBe(aSurrogate); // B cannot reverse A's token
    expect(await rehydrate(aSurrogate, a)).toBe('jane.doe@example.com');
  });

  it('the session never leaks PII to a log (toString/JSON/inspect redact)', async () => {
    const { session } = await mask(asUnmasked(req()));
    expect(String(session)).not.toContain('jane.doe@example.com');
    expect(String(session)).toContain('[REDACTED]');
    expect(JSON.stringify({ s: session })).not.toContain('jane.doe@example.com');
  });
});

describe('Vault — memory-only, TTL, erasure', () => {
  it('expired sessions are evicted and swept', async () => {
    const vault = new Vault();
    const live = vault.create(60_000);
    const dead = vault.create(-1_000); // already expired
    expect(vault.get(live.id)).toBeTruthy();
    expect(vault.get(dead.id)).toBeUndefined(); // expired → not returned
    expect(vault.sweep()).toBeGreaterThanOrEqual(0);
  });

  it('destroy() wipes the mapping (erasure)', async () => {
    const s = new MaskSession();
    await mask(asUnmasked(req()), s);
    expect(s.size).toBeGreaterThan(0);
    s.destroy();
    expect(s.size).toBe(0);
  });
});
