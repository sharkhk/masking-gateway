import { describe, it, expect } from 'vitest';
import {
  mask, asUnmasked, rehydrateSync, rehydrateValue, createRehydrator, MaskSession,
  type CanonicalRequest,
} from '../src/index';

const reqWithEmail = (): CanonicalRequest => ({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'contact jane.doe@example.com please' }],
});

async function maskedEmail() {
  const session = new MaskSession(60_000, 'ab12cd34');
  const { masked } = await mask(asUnmasked(reqWithEmail()), session);
  const surrogate = masked.messages[0]!.content.match(/\[EMAIL_\d+_[0-9a-f]{8}\]/i)![0];
  return { session, surrogate };
}

describe('B10 — rehydration regression: entity types with digits (IPV4)', () => {
  it('rehydrates an IPV4 surrogate (type segment contains a digit)', async () => {
    const session = new MaskSession(60_000, 'ab12cd34');
    const req: CanonicalRequest = { model: 'm', messages: [{ role: 'user', content: 'from 203.0.113.42 now' }] };
    const { masked } = await mask(asUnmasked(req), session);
    const surrogate = masked.messages[0]!.content.match(/\[IPV4_\d+_[0-9a-f]{8}\]/i)![0];
    expect(rehydrateSync(`host ${surrogate}`, session)).toBe('host 203.0.113.42');
  });
});

describe('B10 — streaming rehydration', () => {
  it('restores a surrogate split across SSE chunk boundaries', async () => {
    const { session, surrogate } = await maskedEmail();
    const full = `email: ${surrogate}!`;
    const r = createRehydrator(session);
    // split the stream in the MIDDLE of the surrogate token
    const mid = full.indexOf(surrogate) + 5;
    let out = r.push(full.slice(0, mid));
    out += r.push(full.slice(mid));
    out += r.flush();
    expect(out).toBe('email: jane.doe@example.com!');
    expect(out).not.toContain('[EMAIL');
  });

  it('char-by-char streaming still restores exactly (never emits a partial token)', async () => {
    const { session, surrogate } = await maskedEmail();
    const full = `A ${surrogate} B`;
    const r = createRehydrator(session);
    let out = '';
    for (const ch of full) {
      out += r.push(ch);
      expect(out).not.toMatch(/\[EMAIL_\d+_[0-9a-f]{0,7}$/i); // never a dangling partial surrogate
    }
    out += r.flush();
    expect(out).toBe('A jane.doe@example.com B');
  });

  it('flush() emits rehydrated remainder on early disconnect, never the raw buffer', async () => {
    const { session, surrogate } = await maskedEmail();
    const r = createRehydrator(session);
    r.push(`start ${surrogate.slice(0, 6)}`); // partial token buffered, nothing unsafe emitted
    const tail = r.push(surrogate.slice(6)) + r.flush();
    expect((`start `) + tail).toContain('jane.doe@example.com') // reconstructed across the boundary
  });
});

describe('B10 — tolerant matching + tool args + forgery', () => {
  it('restores a case-shifted surrogate', async () => {
    const { session, surrogate } = await maskedEmail();
    expect(rehydrateSync(surrogate.toLowerCase(), session)).toBe('jane.doe@example.com');
  });

  it('rehydrates surrogates inside tool-call arguments (nested)', async () => {
    const { session, surrogate } = await maskedEmail();
    const args = { to: surrogate, cc: [surrogate], meta: { note: `send ${surrogate}` } };
    const restored = rehydrateValue(args, session) as typeof args;
    expect(restored.to).toBe('jane.doe@example.com');
    expect(restored.cc[0]).toBe('jane.doe@example.com');
    expect(restored.meta.note).toBe('send jane.doe@example.com');
  });

  it('does NOT restore a forged surrogate even mid-stream', async () => {
    const { session } = await maskedEmail();
    const forged = '[EMAIL_9_deadbeef]';
    const r = createRehydrator(session);
    const out = r.push(`hi ${forged}`) + r.flush();
    expect(out).toContain(forged); // left untouched — not in the session map
  });
});
