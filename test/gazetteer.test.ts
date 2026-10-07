import { describe, it, expect } from 'vitest';
import {
  Gazetteer, detectText, mask, rehydrate, asUnmasked, MaskSession,
  type GazetteerEntry, type CanonicalRequest,
} from '../src/index';

const roster: GazetteerEntry[] = [
  { term: 'Ahmed Al-Rashid', type: 'PERSON' },
  { term: 'Falcon Industries', type: 'ORG' },
  { term: 'Project Zephyr', type: 'PROJECT' },
  { term: 'ACC-99812', type: 'ACCOUNT' },
  { term: 'محمد', type: 'PERSON' }, // Arabic-script name
];

describe('B4 — gazetteer (Aho-Corasick, tenant proprietary entities)', () => {
  const gaz = Gazetteer.build(roster);

  it('detects names, orgs, project codenames, accounts (case-insensitive, whole-word)', () => {
    const text = 'ahmed al-rashid leads Project Zephyr at FALCON INDUSTRIES, acct ACC-99812';
    const types = detectText(text, { gazetteer: gaz }).filter((f) => f.source === 'gazetteer').map((f) => f.type).sort();
    expect(types).toEqual(['ACCOUNT', 'ORG', 'PERSON', 'PROJECT']);
  });

  it('enforces whole-word matching (no substring hits)', () => {
    // "Samsung" must not fire a "Sam" entry; and a longer name inside another word is ignored
    const g = Gazetteer.build([{ term: 'Sam', type: 'PERSON' }]);
    expect(detectText('Samsung released a phone', { gazetteer: g }).some((f) => f.source === 'gazetteer')).toBe(false);
    expect(detectText('Sam released a phone', { gazetteer: g }).some((f) => f.source === 'gazetteer')).toBe(true);
  });

  it('matches Arabic-script terms', () => {
    expect(detectText('اسمه محمد', { gazetteer: gaz }).some((f) => f.type === 'PERSON')).toBe(true);
  });

  it('masks + round-trips gazetteer entities through the pipeline', async () => {
    const req = (): CanonicalRequest => ({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Ahmed Al-Rashid approved Project Zephyr for Falcon Industries' }],
    });
    const session = new MaskSession(60_000, 'ab12cd34');
    const { masked, entityCount } = await mask(asUnmasked(req()), session, { gazetteer: gaz });
    const body = JSON.stringify(masked);
    expect(body).not.toContain('Ahmed Al-Rashid');
    expect(body).not.toContain('Project Zephyr');
    expect(body).not.toContain('Falcon Industries');
    expect(entityCount).toBe(3);
    const restored = await rehydrate(masked.messages[0]!.content, session);
    expect(restored).toBe('Ahmed Al-Rashid approved Project Zephyr for Falcon Industries');
  });
});
