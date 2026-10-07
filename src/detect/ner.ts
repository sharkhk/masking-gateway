/**
 * B6 — transformer NER, wired as a PLUGGABLE layer (additive; zero mandatory deps).
 *
 * The deterministic detectors (B4) catch structured PII. NER catches UNSTRUCTURED identifiers —
 * a person's name, an employer, a place — in English or Arabic. We do NOT hard-depend on any ML
 * runtime here: the model is injected as a `NerRecognizer`. That keeps the core dependency-free
 * and testable, keeps the ML runtime + model out of the default build, and lets an operator wire
 * a real recognizer (see providers/transformersNer.ts) only where NER is wanted (e.g. the
 * Sovereign Runtime).
 *
 * NER is a RISK SIGNAL added to findings with `source:'ner'`; deterministic + gazetteer remain
 * authoritative for structured PII (they carry higher confidence, so they win overlaps).
 */
import type { EntityType, Finding } from './types';
import { detectText, resolveOverlaps, type DetectOptions } from './deterministic';

/** A model-produced entity span. `type` is the raw model label (mapped below). */
export interface NerSpan {
  type: string; // model label, e.g. 'PER' | 'PERSON' | 'ORG' | 'LOC' | 'LOCATION' | 'MISC'
  start: number;
  end: number;
  score: number; // 0..1
}

/** The pluggable model boundary. An adapter (ONNX/Transformers.js/remote) implements this. */
export interface NerRecognizer {
  recognize(text: string): Promise<NerSpan[]> | NerSpan[];
}

export interface NerOptions {
  /** drop spans below this model score (default 0.85 — precision guard) */
  minConfidence?: number;
}

/** Map raw model labels → gateway entity classes. `MISC` (and unknowns) are dropped: too noisy
 *  to mask blindly. Structured PII is handled by the deterministic layer, not here. */
function mapNerType(label: string): EntityType | null {
  const l = label.toUpperCase().replace(/^[BI]-/, ''); // strip BIO prefixes (B-PER / I-LOC)
  if (l === 'PER' || l === 'PERSON') return 'PERSON';
  if (l === 'ORG' || l === 'ORGANIZATION') return 'ORG';
  if (l === 'LOC' || l === 'LOCATION' || l === 'GPE') return 'LOCATION';
  return null;
}

/** Turn recognizer spans into validated Findings (mapped, thresholded, bounds-checked). */
export function spansToFindings(text: string, spans: NerSpan[], opts: NerOptions = {}): Finding[] {
  const min = opts.minConfidence ?? 0.85;
  const out: Finding[] = [];
  for (const s of spans) {
    if (s.score < min) continue;
    const type = mapNerType(s.type);
    if (!type) continue;
    if (!(s.start >= 0 && s.end > s.start && s.end <= text.length)) continue; // bounds-safe
    const value = text.slice(s.start, s.end);
    if (!value.trim()) continue;
    out.push({ type, value, start: s.start, end: s.end, confidence: Math.min(0.94, s.score), source: 'ner' });
  }
  return out;
}

/**
 * Async detection = deterministic + gazetteer (sync) + NER (async), overlaps resolved together.
 * Deterministic/gazetteer findings win overlaps (higher confidence), so NER only fills the gaps
 * they leave (free-text names/orgs/places). Falls back to the sync result if no recognizer.
 */
export async function detectTextAsync(
  text: string,
  opts: DetectOptions & { ner?: NerRecognizer; nerOptions?: NerOptions } = {},
): Promise<Finding[]> {
  const base = detectText(text, opts);
  if (!opts.ner || !text) return base;
  let spans: NerSpan[] = [];
  try {
    spans = await opts.ner.recognize(text);
  } catch {
    // NER is an ADDITIVE layer — a recognizer failure must not drop the deterministic findings.
    // (Whether a missing/erroring recognizer should BLOCK the send is a policy decision made by
    // the caller via NER_REQUIRED, not silently here.)
    return base;
  }
  const nerFindings = spansToFindings(text, spans, opts.nerOptions);
  if (!nerFindings.length) return base;
  return resolveOverlaps([...base, ...nerFindings]);
}
