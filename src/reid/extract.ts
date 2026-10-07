/**
 * B9 — light deterministic extraction of quasi-identifiers from free text. Age and gender are
 * pattern-detectable; nationality / role / city come from supplied dictionaries (the tenant's,
 * like the gazetteer). A transformer NER model (Stage 6) will augment this — but the SCORING
 * engine (model.ts) is the durable core and works on any QI set, however sourced.
 */
import type { QuasiIdentifier } from './model';

export interface ExtractQIOptions {
  nationalities?: string[];
  roles?: string[];
  cities?: Array<{ name: string; granularity?: 'district' | 'emirate' | 'country' }>;
}

const GENDER_RE = /\b(male|female|woman|women|man|men|non-?binary)\b/i;

export function extractQuasiIdentifiers(text: string, opts: ExtractQIOptions = {}): QuasiIdentifier[] {
  const out: QuasiIdentifier[] = [];
  const lower = text.toLowerCase();

  // Age: "34-year-old", "34 year old", "aged 34", "age 34"
  const age = text.match(/\b(\d{1,3})[\s-]?years?[\s-]?old\b/i) ?? text.match(/\bage[d]?\s+(\d{1,3})\b/i);
  if (age && age[1]) {
    const n = parseInt(age[1], 10);
    if (n > 0 && n < 120) out.push({ type: 'AGE', value: String(n) });
  }

  const g = text.match(GENDER_RE);
  if (g) out.push({ type: 'GENDER', value: g[1]!.toLowerCase() });

  const wholeWord = (term: string): boolean => {
    const i = lower.indexOf(term.toLowerCase());
    if (i === -1) return false;
    const before = i - 1 >= 0 ? lower[i - 1]! : ' ';
    const after = i + term.length < lower.length ? lower[i + term.length]! : ' ';
    return !/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after);
  };

  for (const nat of opts.nationalities ?? []) if (wholeWord(nat)) out.push({ type: 'NATIONALITY', value: nat });
  for (const role of opts.roles ?? []) if (wholeWord(role)) out.push({ type: 'ROLE', value: role });
  for (const c of opts.cities ?? []) if (wholeWord(c.name)) out.push({ type: 'CITY', value: c.name, granularity: c.granularity ?? 'emirate' });

  return out;
}
