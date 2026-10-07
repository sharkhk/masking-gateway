import { describe, it, expect } from 'vitest';
import { PolicyEngine, type TenantPolicy } from '../src/index';
import type { Finding } from '../src/detect/types';

const f = (type: Finding['type'], confidence = 0.99): Finding => ({
  type, value: 'x', start: 0, end: 1, confidence, source: 'deterministic',
});

const TENANT: TenantPolicy = {
  tenantId: 't1',
  default: {
    allowed: true,
    reidThreshold: 10,
    classes: {
      PRIVATE_KEY: { action: 'block' },
      AWS_KEY: { action: 'block' },
      // a public-ish class allowed through only above confidence
      ORG: { action: 'allow', minConfidence: 0.9 },
    },
  },
  providers: {
    // an explicitly forbidden provider (e.g. a non-approved region)
    untrusted: { allowed: false },
  },
};

describe('B13 — policy engine (fail-closed)', () => {
  const eng = new PolicyEngine([TENANT]);

  it('unknown tenant is fully fail-closed (provider not allowed, everything masked)', () => {
    const r = eng.resolve('ghost', 'openai');
    expect(r.providerAllowed).toBe(false);
    expect(r.actionFor('EMAIL')).toBe('mask');
  });

  it('a class with no rule defaults to MASK, never allow', () => {
    const r = eng.resolve('t1', 'openai');
    expect(r.actionFor('EMAIL')).toBe('mask');
    expect(r.actionFor('PHONE')).toBe('mask');
  });

  it('secret classes resolve to BLOCK and prevent the send', () => {
    const d = eng.decide('t1', 'openai', [f('EMAIL'), f('AWS_KEY'), f('PRIVATE_KEY')]);
    expect(d.blocked.map((x) => x.type).sort()).toEqual(['AWS_KEY', 'PRIVATE_KEY']);
    expect(d.toMask.map((x) => x.type)).toEqual(['EMAIL']);
    expect(d.allow).toBe(false);
  });

  it('an explicitly forbidden provider blocks the send even with no findings', () => {
    const d = eng.decide('t1', 'untrusted', []);
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toMatch(/not permitted/);
  });

  it('allow-listed class passes through only above minConfidence; below → masked', () => {
    expect(eng.resolve('t1', 'openai').actionFor('ORG', 0.95)).toBe('allow');
    expect(eng.resolve('t1', 'openai').actionFor('ORG', 0.5)).toBe('mask');
  });

  it('a clean allowed request with only maskable findings is allowed', () => {
    const d = eng.decide('t1', 'openai', [f('EMAIL'), f('PHONE')]);
    expect(d.allow).toBe(true);
    expect(d.blocked).toHaveLength(0);
    expect(d.toMask).toHaveLength(2);
  });

  it('provider override inherits default classes unless replaced', () => {
    // 'openai' has no explicit provider block → uses default (allowed:true, block secrets)
    const r = eng.resolve('t1', 'openai');
    expect(r.providerAllowed).toBe(true);
    expect(r.actionFor('AWS_KEY')).toBe('block');
  });
});
