/**
 * SOUC integration adapter — the seam between SOUC's `llmGateway.js` and the masking pipeline.
 *
 * SOUC's gateway speaks `{ systemPrompt, messages:[{role,content,...}] }`. This module maps that
 * shape to the canonical request (B1), runs the choke-point `mask()` (B3), applies the policy
 * engine (B13 — BLOCK a send when a class/provider policy forbids it), and hands back the masked
 * prompt in SOUC's own shape plus the `MaskSession` needed to rehydrate the reply.
 *
 * FAIL CLOSED (Section E): if masking or policy would let sensitive data through unmasked, or the
 * pipeline throws, the caller must BLOCK the request — never egress the original. `maskOutbound`
 * surfaces `{ blocked, reasons }` for exactly that decision; it never returns partial/unmasked
 * text alongside `blocked:true`.
 *
 * This runs ONLY on SOUC's external-provider (BYOK) egress path. On-box / sovereign tiers keep
 * data in the boundary already, so masking there would add surrogate noise for no privacy gain.
 * Zero runtime deps.
 */
import type { CanonicalRequest, CanonicalMessage, Role } from '../canonical';
import { mask, maskValue, rehydrateSync, rehydrateValue, createRehydrator } from '../pipeline';
import { asUnmasked } from '../brand';
import { MaskSession } from '../vault';
import { detectText, type DetectOptions } from '../detect/deterministic';
import { detectTextAsync, type NerRecognizer, type NerOptions } from '../detect/ner';
import type { Gazetteer } from '../detect/gazetteer';
import type { EntityType } from '../detect/types';
import { PolicyEngine, type SendDecision } from '../policy';

/** A SOUC chat message as it appears in `llmGateway.js`. */
export interface SoucMessage {
  role: string;
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface SoucChatInput {
  systemPrompt?: string;
  messages: SoucMessage[];
  model?: string;
}

export interface MaskOutboundOptions {
  /** tenant proprietary-entity dictionary (roster/customers/projects) */
  gazetteer?: Gazetteer;
  /** reuse across turns for cross-turn referential integrity (one value → one surrogate) */
  session?: MaskSession;
  /** policy engine + identity to enforce per tenant/provider/class BLOCK/ALLOW decisions */
  policy?: PolicyEngine;
  tenantId?: string;
  provider?: string;
  /** optional transformer NER recognizer (B6) — catches unstructured names/orgs/places (EN/AR) */
  ner?: NerRecognizer;
  nerOptions?: NerOptions;
}

export interface MaskOutboundResult {
  /** true → the caller MUST NOT send; the request violates policy (fail-closed) */
  blocked: boolean;
  reasons: string[];
  /** masked prompt in SOUC's shape — present only when !blocked */
  systemPrompt?: string;
  messages: SoucMessage[];
  /** hand to `rehydrateResponse` / `makeStreamRehydrator` to restore the reply */
  session: MaskSession;
  /** distinct new entities masked in this call */
  entityCount: number;
  /** detections by entity class — COUNTS ONLY, never values (B14 audit/observability) */
  byClass: Partial<Record<EntityType, number>>;
  /** policy decision, when a policy was supplied */
  decision?: SendDecision;
}

const CANONICAL_ROLES: ReadonlySet<string> = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
function toRole(role: string): Role {
  return (CANONICAL_ROLES.has(role) ? role : 'user') as Role;
}

/** Map a SOUC chat input into the canonical request model. */
export function soucToCanonical(input: SoucChatInput): CanonicalRequest {
  const messages: CanonicalMessage[] = input.messages.map((m) => {
    const cm: CanonicalMessage = { role: toRole(m.role), content: String(m.content ?? '') };
    if (m.name !== undefined) cm.name = m.name;
    if (m.toolCallId !== undefined) cm.toolCallId = m.toolCallId;
    return cm;
  });
  const req: CanonicalRequest = { model: input.model ?? 'unknown', messages };
  if (input.systemPrompt !== undefined) req.system = input.systemPrompt;
  return req;
}

/** Extract SOUC's `{ systemPrompt, messages }` back out of a (masked) canonical request. Reading
 *  fields off a `Masked<T>` is safe by design — it is structurally the canonical object. */
function canonicalToSouc(req: CanonicalRequest): { systemPrompt?: string; messages: SoucMessage[] } {
  const messages: SoucMessage[] = req.messages.map((m) => {
    const sm: SoucMessage = { role: m.role, content: m.content };
    if (m.name !== undefined) sm.name = m.name;
    if (m.toolCallId !== undefined) sm.toolCallId = m.toolCallId;
    return sm;
  });
  return req.system !== undefined ? { systemPrompt: req.system, messages } : { messages };
}

/**
 * Mask a SOUC chat request before it egresses to an external provider. Returns the masked prompt
 * in SOUC's shape + the session for rehydration, OR a fail-closed BLOCK decision.
 */
export async function maskOutbound(
  input: SoucChatInput,
  opts: MaskOutboundOptions = {},
): Promise<MaskOutboundResult> {
  const canonical = soucToCanonical(input);
  const session = opts.session ?? new MaskSession();
  const detectOpts: DetectOptions & { ner?: NerRecognizer; nerOptions?: NerOptions } = {};
  if (opts.gazetteer) detectOpts.gazetteer = opts.gazetteer;
  if (opts.ner) { detectOpts.ner = opts.ner; if (opts.nerOptions) detectOpts.nerOptions = opts.nerOptions; }

  // One detect pass over the outbound text — drives both the policy gate and the audit counts.
  // NER (when configured) runs async; deterministic + gazetteer stay synchronous.
  const texts = [canonical.system, ...canonical.messages.map((m) => m.content)].filter((t): t is string => !!t);
  const findings = opts.ner
    ? (await Promise.all(texts.map((t) => detectTextAsync(t, detectOpts)))).flat()
    : texts.flatMap((t) => detectText(t, detectOpts));
  const byClass: Partial<Record<EntityType, number>> = {};
  for (const f of findings) byClass[f.type] = (byClass[f.type] ?? 0) + 1;

  // Policy gate FIRST — a BLOCK class or a forbidden provider stops the send before any masked
  // payload is produced (fail-closed).
  let decision: SendDecision | undefined;
  if (opts.policy && opts.tenantId && opts.provider) {
    decision = opts.policy.decide(opts.tenantId, opts.provider, findings);
    if (!decision.allow) {
      return { blocked: true, reasons: decision.reasons, messages: [], session, entityCount: 0, byClass, decision };
    }
  }

  const { masked, entityCount } = await mask(asUnmasked(canonical), session, detectOpts);
  const { systemPrompt, messages } = canonicalToSouc(masked as unknown as CanonicalRequest);
  return { blocked: false, reasons: [], systemPrompt, messages, session, entityCount, byClass, decision };
}

/** Restore originals in a complete (non-streamed) provider reply. */
export function rehydrateResponse(text: string, session: MaskSession): string {
  return rehydrateSync(text, session);
}

/** Restore originals inside model-emitted tool-call arguments before SOUC executes the tool. */
export function rehydrateToolArgs(args: unknown, session: MaskSession): unknown {
  return rehydrateValue(args, session);
}

/**
 * Mask a TOOL RESULT before it re-enters the provider-bound conversation. A tool's output can
 * carry fresh PII (WHOIS emails, breach records, scan hostnames); inside a multi-hop tool loop
 * that result is appended and re-sent to the provider, so it must be masked with the SAME session
 * for referential integrity + rehydration. Pairs with `rehydrateToolArgs` to close the tool loop:
 * rehydrate the model's args → run the real tool → mask its result.
 */
export function maskToolResult(result: unknown, session: MaskSession, opts?: { gazetteer?: Gazetteer }): unknown {
  return maskValue(result, session, opts?.gazetteer ? { gazetteer: opts.gazetteer } : {});
}

/** Build a streaming rehydrator for SSE token deltas (holds back partial surrogates). */
export function makeStreamRehydrator(session: MaskSession): { push(chunk: string): string; flush(): string } {
  return createRehydrator(session);
}
