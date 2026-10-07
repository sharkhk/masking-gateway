/**
 * B1 — the single canonical request model. Every provider request is normalized into this
 * one shape; policy is applied once here; adapters re-encode outward per provider. Masking
 * logic is NEVER written per-provider (that guarantees drift and gaps).
 *
 * Stage 1 covers the core fields. Later stages extend coverage to the full B2 map (tool
 * results, structured-output schemas, attachments, image parts, metadata channels, etc.);
 * every added channel must be a typed field here so it cannot be silently forgotten.
 */

export type Role = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export interface CanonicalMessage {
  role: Role;
  content: string;
  /** author/name label (some providers use this for tool/function attribution) */
  name?: string;
  /** links a tool result back to the tool call that produced it */
  toolCallId?: string;
}

/** Tool/function DEFINITION — descriptions, param names, enums and examples routinely carry
 *  real customer data (B2), so they are first-class canonical fields, not opaque blobs. */
export interface CanonicalToolDef {
  name: string;
  description?: string;
  /** JSON-schema parameters; walked structurally by detectors in later stages */
  parameters?: unknown;
}

export interface CanonicalRequest {
  model: string;
  /** system / developer instruction, normalized to one place regardless of provider shape */
  system?: string;
  messages: CanonicalMessage[];
  tools?: CanonicalToolDef[];
  /** request metadata channel: user id, session id, custom fields (a B2 leak vector) */
  metadata?: Record<string, string>;
  maxTokens?: number;
  temperature?: number;
  /** stop sequences can themselves contain sensitive strings (B2) */
  stop?: string[];
  stream?: boolean;
}
