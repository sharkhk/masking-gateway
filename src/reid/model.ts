/**
 * B9 — re-identification / quasi-identifier scoring. Masking identifiers is necessary and
 * nowhere near sufficient: individually-harmless attributes combine into unique identification.
 * "The 34-year-old female Emirati radiologist who joined the Dubai branch in March" identifies
 * exactly one person with every NAME removed.
 *
 * We estimate the anonymity set k = populationSize × Π(selectivity of each surviving attribute),
 * and if k falls below a threshold we GENERALIZE the rarest attributes (widen age→range,
 * date→month→year, district→emirate, title→department) or, if that isn't enough, recommend
 * BLOCK. Rare values are the trap, so per-value selectivity can be supplied.
 *
 * The population model is rough and CONFIGURABLE — it is a risk signal, not a census. Zero deps.
 */

export type QIType =
  | 'ROLE' | 'EMPLOYER' | 'DEPARTMENT' | 'CITY' | 'AGE' | 'AGE_RANGE'
  | 'GENDER' | 'NATIONALITY' | 'DATE' | 'CONDITION' | 'SALARY_BAND' | 'TENURE';

export interface QuasiIdentifier {
  type: QIType;
  value: string;
  /** fraction of the population with this value (0..1). Omit to use the model default. */
  selectivity?: number;
  /** granularity for generalizable types, e.g. DATE: 'day'|'month'|'year'; CITY: 'district'|'emirate'|'country' */
  granularity?: string;
}

export interface PopulationModel {
  size: number;
  /** default selectivity per type when a QI doesn't carry its own */
  defaults: Record<QIType, number>;
}

/** Rough UAE-scaled priors. Override per deployment; these exist to make the engine usable. */
export const defaultPopulation: PopulationModel = {
  size: 10_000_000,
  defaults: {
    GENDER: 0.5,
    AGE: 1 / 80,
    AGE_RANGE: 1 / 8,
    NATIONALITY: 0.05,
    CITY: 0.15,
    DEPARTMENT: 0.05,
    ROLE: 0.02,
    EMPLOYER: 0.001,
    DATE: 1 / 365,
    CONDITION: 0.0005,
    SALARY_BAND: 0.1,
    TENURE: 0.1,
  },
};

const selectivityOf = (qi: QuasiIdentifier, model: PopulationModel): number => {
  if (typeof qi.selectivity === 'number') return Math.min(1, Math.max(1e-9, qi.selectivity));
  if (qi.type === 'DATE') {
    if (qi.granularity === 'year') return 0.05;
    if (qi.granularity === 'month') return 1 / 12;
  }
  if (qi.type === 'CITY') {
    if (qi.granularity === 'country') return 1;
    if (qi.granularity === 'emirate') return 0.2;
    if (qi.granularity === 'district') return 0.01;
  }
  return model.defaults[qi.type];
};

export interface ReIdAssessment {
  /** estimated anonymity set size (how many people match the surviving attributes) */
  k: number;
  belowThreshold: boolean;
  threshold: number;
  /** attributes sorted by how much they narrow identity (rarest first) */
  contributors: Array<{ type: QIType; value: string; selectivity: number }>;
}

/** Estimate k for a set of quasi-identifiers. */
export function scoreReId(
  qis: QuasiIdentifier[],
  model: PopulationModel = defaultPopulation,
  threshold = 10,
): ReIdAssessment {
  let product = 1;
  const contributors = qis.map((qi) => {
    const s = selectivityOf(qi, model);
    product *= s;
    return { type: qi.type, value: qi.value, selectivity: s };
  });
  contributors.sort((a, b) => a.selectivity - b.selectivity); // rarest first
  const k = qis.length ? Math.max(1, Math.round(model.size * product)) : model.size;
  return { k, belowThreshold: k < threshold, threshold, contributors };
}

/** Widen one quasi-identifier by one step. Returns the coarser QI, or null if it can't widen
 *  further (the caller then drops it). */
export function generalizeQI(qi: QuasiIdentifier): QuasiIdentifier | null {
  switch (qi.type) {
    case 'AGE':
      return { type: 'AGE_RANGE', value: ageToRange(qi.value) };
    case 'DATE': {
      const g = qi.granularity ?? 'day';
      if (g === 'day') return { ...qi, granularity: 'month' };
      if (g === 'month') return { ...qi, granularity: 'year' };
      return null;
    }
    case 'CITY': {
      const g = qi.granularity ?? 'district';
      if (g === 'district') return { ...qi, granularity: 'emirate' };
      if (g === 'emirate') return { ...qi, granularity: 'country' };
      return null;
    }
    case 'ROLE':
      return { type: 'DEPARTMENT', value: qi.value };
    default:
      return null; // not generalizable → drop it
  }
}

function ageToRange(age: string): string {
  const n = parseInt(age, 10);
  if (Number.isNaN(n)) return age;
  const lo = Math.floor(n / 10) * 10;
  return `${lo}-${lo + 9}`;
}

export interface ReIdResolution {
  assessment: ReIdAssessment;
  generalized: QuasiIdentifier[];
  /** what to do: 'ok' (already >= k), 'generalized' (widened to reach k), or 'block' */
  action: 'ok' | 'generalized' | 'block';
  steps: string[];
}

/**
 * Assess, then iteratively generalize the rarest attribute until k >= threshold, or BLOCK if
 * generalization is exhausted and it still identifies.
 */
export function resolveReId(
  qis: QuasiIdentifier[],
  model: PopulationModel = defaultPopulation,
  threshold = 10,
): ReIdResolution {
  const working = qis.map((q) => ({ ...q }));
  const steps: string[] = [];
  let assessment = scoreReId(working, model, threshold);
  if (!assessment.belowThreshold) return { assessment, generalized: working, action: 'ok', steps };

  for (let guard = 0; guard < 50 && assessment.belowThreshold; guard++) {
    // generalize the rarest (most-identifying) attribute
    const rarest = assessment.contributors[0];
    if (!rarest) break;
    const idx = working.findIndex((q) => q.type === rarest.type && q.value === rarest.value);
    if (idx === -1) break;
    const widened = generalizeQI(working[idx]!);
    if (widened) {
      steps.push(`generalize ${working[idx]!.type}("${working[idx]!.value}") → ${widened.type}${widened.granularity ? `/${widened.granularity}` : ''}("${widened.value}")`);
      working[idx] = widened;
    } else {
      steps.push(`drop ${working[idx]!.type}("${working[idx]!.value}")`);
      working.splice(idx, 1);
    }
    assessment = scoreReId(working, model, threshold);
  }

  return {
    assessment,
    generalized: working,
    action: assessment.belowThreshold ? 'block' : 'generalized',
    steps,
  };
}
