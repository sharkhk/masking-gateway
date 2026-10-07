/**
 * SOUC Masking Gateway — public surface.
 *
 * NOTE: `__unsafeBrandMasked` is deliberately NOT exported here. The only way for consumer
 * code to obtain a `Masked<T>` is to call `mask()`, which routes through the full pipeline.
 * That is the whole point of the choke point (B3).
 */
export { asUnmasked, Sensitive } from './brand';
export type { Masked, Unmasked } from './brand';
export type { CanonicalRequest, CanonicalMessage, CanonicalToolDef, Role } from './canonical';
export { mask, maskValue, rehydrate, rehydrateSync, rehydrateValue, createRehydrator } from './pipeline';
export type { MaskResult } from './pipeline';
export { MaskSession, Vault } from './vault';
export { OpenAIProvider, toOpenAIBody } from './providers/openai';
export type { ProviderResponse, OpenAIBody } from './providers/openai';
export { AnthropicProvider, toAnthropicBody, ANTHROPIC_DEFAULT_MAX_TOKENS } from './providers/anthropic';
export type { AnthropicBody, AnthropicContentBlock } from './providers/anthropic';
export { detectText, resolveOverlaps } from './detect/deterministic';
export type { DetectOptions } from './detect/deterministic';
// B6 — pluggable transformer NER (recognizer injected; ML runtime/model optional, never bundled)
export { detectTextAsync, spansToFindings } from './detect/ner';
export type { NerRecognizer, NerSpan, NerOptions } from './detect/ner';
export { Gazetteer } from './detect/gazetteer';
export type { GazetteerEntry } from './detect/gazetteer';
export type { EntityType, Finding } from './detect/types';
export type { MaskOptions } from './pipeline';
export * as validators from './detect/validators';
// B9 — re-identification / quasi-identifier scoring
export { scoreReId, resolveReId, generalizeQI, defaultPopulation } from './reid/model';
export type { QuasiIdentifier, QIType, PopulationModel, ReIdAssessment, ReIdResolution } from './reid/model';
export { extractQuasiIdentifiers } from './reid/extract';
export type { ExtractQIOptions } from './reid/extract';
// SOUC integration seam — maps SOUC's chat shape ↔ canonical, masks outbound, rehydrates reply
export { soucToCanonical, maskOutbound, rehydrateResponse, rehydrateToolArgs, maskToolResult, makeStreamRehydrator } from './integration/souc';
export type { SoucMessage, SoucChatInput, MaskOutboundOptions, MaskOutboundResult } from './integration/souc';
// B13 — policy engine (per tenant/provider/class; fail-closed)
export { PolicyEngine, DEFAULT_CLASS_ACTION, DEFAULT_REID_THRESHOLD, DEFAULT_REID_FALLBACK } from './policy';
export type { PolicyAction, ClassPolicy, ProviderPolicy, TenantPolicy, ResolvedPolicy, SendDecision } from './policy';
// B15 — evaluation harness (recall is the safety metric; CI gate lives in test/eval.test.ts)
export { evaluate, formatReport } from './eval/harness';
export type { EvalReport, ClassRecall } from './eval/harness';
export { CORPUS, NEGATIVES } from './eval/corpus';
export type { Sample } from './eval/corpus';
