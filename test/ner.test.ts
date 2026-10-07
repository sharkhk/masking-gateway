import { describe, it, expect } from 'vitest';
import {
  detectTextAsync, spansToFindings, mask, asUnmasked, rehydrateSync, maskOutbound, MaskSession,
  type NerRecognizer, type CanonicalRequest,
} from '../src/index';

// A stub recognizer — stands in for the ONNX/Transformers.js model so the LAYER is tested
// without any ML dependency or fabricated recall. It "recognizes" fixed spans by substring.
function stubNer(entities: Array<{ text: string; type: string; score?: number }>): NerRecognizer {
  return {
    recognize(text: string) {
      const spans = [];
      for (const e of entities) {
        let from = 0, i;
        while ((i = text.indexOf(e.text, from)) !== -1) {
          spans.push({ type: e.type, start: i, end: i + e.text.length, score: e.score ?? 0.97 });
          from = i + e.text.length;
        }
      }
      return spans;
    },
  };
}

describe('B6 — pluggable NER layer', () => {
  it('maps PER/ORG/LOC spans to PERSON/ORG/LOCATION findings and thresholds by score', () => {
    const text = 'Dr Sarah Malik joined Acme Corp in Dubai.';
    const f = spansToFindings(text, [
      { type: 'PER', start: 3, end: 14, score: 0.99 },   // Sarah Malik
      { type: 'ORG', start: 22, end: 31, score: 0.95 },  // Acme Corp
      { type: 'LOC', start: 35, end: 40, score: 0.5 },   // Dubai — below threshold, dropped
      { type: 'MISC', start: 0, end: 2, score: 0.99 },   // dropped (MISC)
    ], { minConfidence: 0.85 });
    expect(f.map((x) => x.type).sort()).toEqual(['ORG', 'PERSON']);
    expect(f.every((x) => x.source === 'ner')).toBe(true);
  });

  it('detectTextAsync merges NER with deterministic; deterministic wins overlaps', async () => {
    const text = 'Email sarah@acme.com — analyst Sarah Malik at Acme Corp.';
    const ner = stubNer([{ text: 'Sarah Malik', type: 'PER' }, { text: 'Acme Corp', type: 'ORG' }, { text: 'sarah@acme.com', type: 'PER' }]);
    const findings = await detectTextAsync(text, { ner });
    // the email stays EMAIL (deterministic, higher confidence) even though NER also tagged it
    expect(findings.find((f) => f.value === 'sarah@acme.com')!.type).toBe('EMAIL');
    expect(findings.some((f) => f.type === 'PERSON' && f.value === 'Sarah Malik')).toBe(true);
    expect(findings.some((f) => f.type === 'ORG' && f.value === 'Acme Corp')).toBe(true);
  });

  it('mask() with a recognizer masks NER entities and rehydrates them (async path)', async () => {
    const req: CanonicalRequest = { model: 'm', messages: [{ role: 'user', content: 'analyst Sarah Malik at Acme Corp' }] };
    const ner = stubNer([{ text: 'Sarah Malik', type: 'PER' }, { text: 'Acme Corp', type: 'ORG' }]);
    const session = new MaskSession();
    const { masked } = await mask(asUnmasked(req), session, { ner });
    const out = (masked as unknown as CanonicalRequest).messages[0]!.content;
    expect(out).not.toContain('Sarah Malik');
    expect(out).not.toContain('Acme Corp');
    expect(rehydrateSync(out, session)).toBe('analyst Sarah Malik at Acme Corp');
  });

  it('a recognizer that throws does NOT drop deterministic findings (additive layer)', async () => {
    const badNer: NerRecognizer = { recognize() { throw new Error('model failed'); } };
    const findings = await detectTextAsync('card 4242 4242 4242 4242', { ner: badNer });
    expect(findings.some((f) => f.type === 'CREDIT_CARD')).toBe(true);
  });

  it('maskOutbound threads the recognizer through and reports PERSON/ORG in byClass', async () => {
    const ner = stubNer([{ text: 'Sarah Malik', type: 'PER' }, { text: 'Acme Corp', type: 'ORG' }]);
    const r = await maskOutbound(
      { messages: [{ role: 'user', content: 'Sarah Malik at Acme Corp, card 4242 4242 4242 4242' }] },
      { ner },
    );
    expect(r.blocked).toBe(false);
    expect(r.byClass.PERSON).toBe(1);
    expect(r.byClass.ORG).toBe(1);
    expect(r.byClass.CREDIT_CARD).toBe(1);
    expect(JSON.stringify(r.messages)).not.toContain('Sarah Malik');
  });

  it('no recognizer → sync path unchanged (deterministic only)', async () => {
    const findings = await detectTextAsync('card 4242 4242 4242 4242', {});
    expect(findings.some((f) => f.type === 'CREDIT_CARD')).toBe(true);
    expect(findings.some((f) => f.source === 'ner')).toBe(false);
  });
});
