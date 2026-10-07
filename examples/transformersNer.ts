/**
 * REFERENCE NER adapter (Stage 6) — NOT compiled into the package (lives under examples/, outside
 * src/). It implements the `NerRecognizer` interface using Transformers.js + a local ONNX model,
 * fully on-box with remote fetching DISABLED (sovereign / air-gapped). Copy into your deployment
 * and install the deps there. Nothing here forces the ML runtime
 * into the default build.
 *
 * Install (in the deployment that wants NER):
 *   npm i @huggingface/transformers onnxruntime-node
 * Vendor a token-classification ONNX model locally (e.g. DistilBERT multilingual NER) at
 *   MODEL_DIR, pinned by revision hash + SHA-256 (see the proposal), then:
 *
 *   import { createTransformersNer } from './transformersNer';
 *   const ner = await createTransformersNer({ modelDir: process.env.NER_MODEL_PATH! });
 *   const { masked } = await mask(asUnmasked(req), session, { ner, nerOptions: { minConfidence: 0.85 } });
 *
 * The recognizer returns { type, start, end, score } spans; the gateway maps PER/ORG/LOC →
 * PERSON/ORG/LOCATION, thresholds, and merges them with the deterministic findings.
 */
import type { NerRecognizer, NerSpan } from '../src/detect/ner';

export interface TransformersNerOptions {
  /** local directory holding the vendored ONNX model + tokenizer (no network) */
  modelDir: string;
  /** aggregation strategy for the token-classification pipeline */
  aggregation?: 'simple' | 'first' | 'average' | 'max';
}

export async function createTransformersNer(opts: TransformersNerOptions): Promise<NerRecognizer> {
  // Dynamic import so this file has no static dependency on the ML runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tfx: any = await import('@huggingface/transformers');
  // Air-gapped / sovereign: never fetch from the Hugging Face Hub at runtime.
  tfx.env.allowRemoteModels = false;
  tfx.env.localModelPath = opts.modelDir;

  const pipe = await tfx.pipeline('token-classification', opts.modelDir, {
    aggregation_strategy: opts.aggregation ?? 'simple',
  });

  return {
    async recognize(text: string): Promise<NerSpan[]> {
      const raw = await pipe(text);
      // Transformers.js returns { entity_group|entity, start, end, score, word }
      return (Array.isArray(raw) ? raw : []).map((e: any) => ({
        type: String(e.entity_group ?? e.entity ?? ''),
        start: Number(e.start),
        end: Number(e.end),
        score: Number(e.score),
      })).filter((s: NerSpan) => Number.isFinite(s.start) && Number.isFinite(s.end));
    },
  };
}
