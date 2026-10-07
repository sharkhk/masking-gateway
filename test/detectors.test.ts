import { describe, it, expect } from 'vitest';
import {
  detectText, mask, asUnmasked, toOpenAIBody, validators,
  type CanonicalRequest, type EntityType,
} from '../src/index';

// A synthetic Emirates ID: 784 + year + sequence + a Luhn check digit (generated, not real).
const emiratesId = (() => {
  const base = '78419901234567';
  for (let c = 0; c <= 9; c++) if (validators.emiratesIdValid(base + c)) return base + c;
  throw new Error('no check digit');
})();

describe('B4 validators (synthetic values only)', () => {
  it('Luhn accepts a valid test card, rejects a near-miss', () => {
    expect(validators.luhnValid('4242424242424242')).toBe(true);
    expect(validators.luhnValid('4242424242424241')).toBe(false);
  });
  it('IBAN mod-97 accepts a valid test IBAN, rejects a mutated one', () => {
    expect(validators.ibanValid('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(validators.ibanValid('GB82 WEST 1234 5698 7654 33')).toBe(false);
  });
  it('Emirates ID requires 784 prefix + Luhn check digit', () => {
    expect(validators.emiratesIdValid(emiratesId)).toBe(true);
    expect(validators.emiratesIdValid('784' + '0'.repeat(12))).toBe(false); // wrong check digit
    expect(validators.emiratesIdValid('123' + emiratesId.slice(3))).toBe(false); // wrong prefix
  });
  it('E.164 phone', () => {
    expect(validators.e164Valid('+971501234567')).toBe(true);
    expect(validators.e164Valid('0501234567')).toBe(false);
  });
  it('entropy: high for random tokens, low for repetitive strings', () => {
    expect(validators.shannonEntropy('aG7kQ9zR2mX5wL8pV3nB6tY1')).toBeGreaterThan(3.5);
    expect(validators.shannonEntropy('aaaaaaaaaaaaaaaaaaaaaaaa')).toBeLessThan(1);
  });
  it('the SECRET rule does not fire on ordinary prose', () => {
    expect(detectText('the quick brown fox jumps over the lazy dog today').some((f) => f.type === 'SECRET')).toBe(false);
  });
});

describe('B4 detectText — finds validated entities, resolves overlaps', () => {
  it('detects a spread of entity types in a blob', () => {
    const blob = [
      'card 4242 4242 4242 4242',
      'iban GB82 WEST 1234 5698 7654 32',
      `eid ${emiratesId}`,
      'email jane.doe@example.com',
      'phone +971501234567',
      'aws AKIAIOSFODNN7EXAMPLE',
      'gh ghp_' + 'a'.repeat(36),
    ].join('\n');
    const types = new Set(detectText(blob).map((f) => f.type));
    for (const t of ['CREDIT_CARD', 'IBAN', 'EMIRATES_ID', 'EMAIL', 'PHONE', 'AWS_KEY', 'GITHUB_TOKEN'] as EntityType[]) {
      expect(types.has(t)).toBe(true);
    }
  });
  it('rejects a Luhn-invalid 16-digit number (no false-positive card)', () => {
    expect(detectText('order number 1234567812345670 ships today').some((f) => f.type === 'CREDIT_CARD')).toBe(false);
  });
  it('does NOT over-mask public hex hashes (commit SHA / sha256) — a quality guard', () => {
    expect(detectText('commit a94a8fe5ccb19ba61c4c0873d391e987982fbbd3 shipped').some((f) => f.type === 'SECRET')).toBe(false);
    expect(detectText('sha256 ' + 'a'.repeat(0) + 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855').some((f) => f.type === 'SECRET')).toBe(false);
  });
  it('still catches a real mixed-case high-entropy token', () => {
    expect(detectText('token AbCd1234EfGh5678IjKl90MnOpQr').some((f) => f.type === 'SECRET')).toBe(true);
  });
});

describe('Stage 3 — pipeline masks every channel with referential integrity', () => {
  const req = (): CanonicalRequest => ({
    model: 'gpt-4o-mini',
    system: 'Support agent. Escalate to jane.doe@example.com.',
    messages: [
      { role: 'user', content: 'My card is 4242 4242 4242 4242, email jane.doe@example.com' },
      { role: 'assistant', content: 'Noted your card.' },
    ],
    tools: [{ name: 'notify', description: 'emails jane.doe@example.com', parameters: { example: 'call +971501234567' } }],
    metadata: { user: 'jane.doe@example.com' },
    stop: ['AKIAIOSFODNN7EXAMPLE'],
  });

  it('removes all originals and reuses one token per entity', async () => {
    const { masked, entityCount } = await mask(asUnmasked(req()));
    const body = JSON.stringify(toOpenAIBody(masked));
    for (const secret of ['4242 4242 4242 4242', 'jane.doe@example.com', '+971501234567', 'AKIAIOSFODNN7EXAMPLE']) {
      expect(body).not.toContain(secret);
    }
    // referential integrity: the email (system + 2 messages/tool + metadata) → ONE surrogate
    const emailToken = (masked.metadata?.user) as string;
    expect(emailToken).toMatch(/^\[EMAIL_\d+_[0-9a-f]{8}\]$/);
    expect(masked.system).toContain(emailToken);
    // entityCount counts DISTINCT entities (email, card, phone, aws key) = 4
    expect(entityCount).toBe(4);
  });
});
