/**
 * B15 — evaluation harness. Measures RECALL per entity class (the safety metric, reported
 * separately, never hidden in an F1 average) and precision on negatives. The CI gate
 * (test/eval.test.ts) fails the build on a recall regression — nothing ships on a recall drop.
 */
import type { EntityType } from '../detect/types';
import { detectText } from '../detect/deterministic';
import { CORPUS, NEGATIVES, type Sample } from './corpus';

export interface ClassRecall {
  expected: number;
  found: number;
  recall: number;
}

export interface EvalReport {
  perClass: Partial<Record<EntityType, ClassRecall>>;
  overallRecall: number;
  /** false-positive findings across all NEGATIVE samples (should be 0) */
  falsePositivesOnNegatives: number;
  falsePositiveDetail: Array<{ id: string; types: EntityType[] }>;
}

export function evaluate(
  corpus: Sample[] = CORPUS,
  negatives: Sample[] = NEGATIVES,
  detect: (t: string) => Array<{ type: EntityType }> = (t) => detectText(t),
): EvalReport {
  const perClass: Partial<Record<EntityType, ClassRecall>> = {};
  let totalExpected = 0;
  let totalFound = 0;

  for (const s of corpus) {
    const foundTypes = new Set(detect(s.text).map((f) => f.type));
    for (const type of s.expect) {
      const c = (perClass[type] ??= { expected: 0, found: 0, recall: 0 });
      c.expected += 1;
      totalExpected += 1;
      if (foundTypes.has(type)) {
        c.found += 1;
        totalFound += 1;
      }
    }
  }
  for (const c of Object.values(perClass)) c.recall = c.expected ? c.found / c.expected : 1;

  let fp = 0;
  const falsePositiveDetail: Array<{ id: string; types: EntityType[] }> = [];
  for (const s of negatives) {
    const types = detect(s.text).map((f) => f.type);
    if (types.length) {
      fp += types.length;
      falsePositiveDetail.push({ id: s.id, types });
    }
  }

  return {
    perClass,
    overallRecall: totalExpected ? totalFound / totalExpected : 1,
    falsePositivesOnNegatives: fp,
    falsePositiveDetail,
  };
}

/** Human-readable one-liner per class + overall (used by the eval script). */
export function formatReport(r: EvalReport): string {
  const lines = Object.entries(r.perClass)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, c]) => `  ${type.padEnd(14)} recall ${(c!.recall * 100).toFixed(0)}%  (${c!.found}/${c!.expected})`);
  lines.push(`  OVERALL        recall ${(r.overallRecall * 100).toFixed(1)}%`);
  lines.push(`  false positives on negatives: ${r.falsePositivesOnNegatives}`);
  return lines.join('\n');
}
