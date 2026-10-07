import { describe, it, expect } from 'vitest';
import {
  scoreReId, resolveReId, extractQuasiIdentifiers, defaultPopulation,
  type QuasiIdentifier,
} from '../src/index';

describe('B9 — quasi-identifier / re-identification scoring', () => {
  it("flags the spec's canonical example as re-identifiable with every NAME removed", () => {
    // "The 34-year-old female Emirati radiologist who joined the Dubai branch in March"
    const qis: QuasiIdentifier[] = [
      { type: 'AGE', value: '34' },
      { type: 'GENDER', value: 'female' },
      { type: 'NATIONALITY', value: 'Emirati', selectivity: 0.11 },
      { type: 'ROLE', value: 'radiologist', selectivity: 0.0002 }, // rare title = the trap
      { type: 'CITY', value: 'Dubai', granularity: 'emirate' },
      { type: 'DATE', value: 'March', granularity: 'month' },
    ];
    const a = scoreReId(qis, defaultPopulation, 10);
    expect(a.belowThreshold).toBe(true);
    expect(a.k).toBeLessThan(10);
    // rarest contributor surfaced first
    expect(a.contributors[0]!.type).toBe('ROLE');
  });

  it('generalizes the rarest attributes until k >= threshold (or blocks)', () => {
    const qis: QuasiIdentifier[] = [
      { type: 'AGE', value: '34' },
      { type: 'GENDER', value: 'female' },
      { type: 'NATIONALITY', value: 'Emirati', selectivity: 0.11 },
      { type: 'ROLE', value: 'radiologist', selectivity: 0.0002 },
      { type: 'CITY', value: 'Dubai', granularity: 'emirate' },
      { type: 'DATE', value: 'March', granularity: 'month' },
    ];
    const r = resolveReId(qis, defaultPopulation, 10);
    expect(['generalized', 'block']).toContain(r.action);
    expect(r.steps.length).toBeGreaterThan(0);
    if (r.action === 'generalized') expect(r.assessment.k).toBeGreaterThanOrEqual(10);
  });

  it('a single common attribute is NOT flagged (large anonymity set)', () => {
    const a = scoreReId([{ type: 'GENDER', value: 'female' }], defaultPopulation, 10);
    expect(a.belowThreshold).toBe(false);
    expect(a.k).toBeGreaterThan(1000);
  });

  it('extracts age + gender + dictionary QIs from free text', () => {
    const qis = extractQuasiIdentifiers(
      'a 34-year-old female Emirati radiologist at the Dubai branch',
      { nationalities: ['Emirati'], roles: ['radiologist'], cities: [{ name: 'Dubai', granularity: 'emirate' }] },
    );
    const types = qis.map((q) => q.type).sort();
    expect(types).toContain('AGE');
    expect(types).toContain('GENDER');
    expect(types).toContain('NATIONALITY');
    expect(types).toContain('ROLE');
    expect(types).toContain('CITY');
    expect(qis.find((q) => q.type === 'AGE')!.value).toBe('34');
  });
});
