import { describe, it, expect } from 'vitest';
import { evaluate, formatReport } from '../src/eval/harness';

/**
 * B15 — CI RECALL GATE. Recall is the safety metric: a masking miss = a leak. This test fails
 * the build if per-class recall on the synthetic corpus regresses below its floor, or if a
 * false positive appears on a clean negative. Floors are deliberately strict — the deterministic
 * detectors are validated (Luhn / mod-97 / check-digit / entropy), so well-formed synthetic
 * values MUST be caught. Loosening a floor is a Tier-2 change (confirm first).
 */

// Minimum acceptable recall per class. Deterministic validated classes → 1.0 (no misses allowed).
const RECALL_FLOOR: Record<string, number> = {
  EMAIL: 1,
  PHONE: 1,
  CREDIT_CARD: 1,
  IBAN: 1,
  EMIRATES_ID: 1,
  AWS_KEY: 1,
  GITHUB_TOKEN: 1,
  JWT: 1,
  IPV4: 1,
  UUID: 1,
  PRIVATE_KEY: 1,
};

describe('B15 — recall gate on the synthetic corpus', () => {
  const report = evaluate();
  // Surface the numbers in test output — measured, never fabricated.
  // eslint-disable-next-line no-console
  console.log('\n[masking-gateway recall report]\n' + formatReport(report) + '\n');

  for (const [type, floor] of Object.entries(RECALL_FLOOR)) {
    it(`${type} recall >= ${floor * 100}%`, () => {
      const c = report.perClass[type as keyof typeof report.perClass];
      expect(c, `${type} missing from corpus`).toBeDefined();
      expect(c!.recall).toBeGreaterThanOrEqual(floor);
    });
  }

  it('overall recall stays at 100% on well-formed synthetic values', () => {
    expect(report.overallRecall).toBe(1);
  });

  it('produces ZERO false positives on clean negatives', () => {
    expect(report.falsePositivesOnNegatives, JSON.stringify(report.falsePositiveDetail)).toBe(0);
  });
});
