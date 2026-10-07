/**
 * Anthropic (Messages API) provider adapter (B11). Like the OpenAI adapter, `send()` accepts
 * ONLY `Masked<CanonicalRequest>` — the outward edge of the choke point.
 *
 * The Messages API differs from OpenAI in shape, which is exactly why masking lives in the
 * canonical model and NEVER per-provider:
 *   - `system` is a TOP-LEVEL parameter (string or typed text blocks), not a message role.
 *   - message roles are only 'user' | 'assistant'; tool results are a `tool_result` content
 *     block inside a user message; system/developer messages are hoisted into `system`.
 *   - `max_tokens` is REQUIRED; stop sequences are `stop_sequences`; user id is `metadata.user_id`.
 *
 * Stage 1/10 proves TRANSPARENCY only: build the exact provider body from canonical. The live
 * fetch + streaming + rehydration are layered in later, and the type contract here won't change.
 *
 * NOTE (B11): verify the live Anthropic API contract (paths, headers `anthropic-version`,
 * params, model ids) against current docs before the network call is enabled — do not rely on
 * training-data assumptions.
 */
import type { Masked } from '../brand';
import { Sensitive } from '../brand';
import type { CanonicalRequest, CanonicalMessage } from '../canonical';
import type { ProviderResponse } from './openai';

/** Anthropic requires max_tokens; when canonical omits it we supply a conservative default and
 *  flag it in the built body so callers see the substitution rather than a silent value. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface AnthropicBody {
  model: string;
  max_tokens: number;
  system?: string | Array<{ type: 'text'; text: string }>;
  messages: Array<{ role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }>;
  tools?: Array<{ name: string; description?: string; input_schema: unknown }>;
  temperature?: number;
  stop_sequences?: string[];
  stream?: boolean;
  metadata?: { user_id?: string };
}

/** Build the Anthropic Messages body from a canonical request. Pure + typed. */
export function toAnthropicBody(req: CanonicalRequest): AnthropicBody {
  // Collect system/developer text into the top-level `system` param (canonical.system first).
  const systemParts: string[] = [];
  if (req.system) systemParts.push(req.system);

  const messages: AnthropicBody['messages'] = [];
  for (const m of req.messages) {
    if (m.role === 'system' || m.role === 'developer') {
      systemParts.push(m.content);
      continue;
    }
    messages.push(canonicalToAnthropicMessage(m));
  }

  const body: AnthropicBody = {
    model: req.model,
    max_tokens: req.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages,
  };
  if (systemParts.length) body.system = systemParts.join('\n\n');
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters ?? { type: 'object', properties: {} },
    }));
  }
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.stop?.length) body.stop_sequences = req.stop;
  if (req.stream !== undefined) body.stream = req.stream;
  if (req.metadata?.user) body.metadata = { user_id: req.metadata.user };
  return body;
}

function canonicalToAnthropicMessage(m: CanonicalMessage): AnthropicBody['messages'][number] {
  if (m.role === 'tool') {
    // Anthropic represents a tool result as a user message carrying a tool_result block.
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content }],
    };
  }
  // Only 'user' and 'assistant' remain here (system/developer hoisted by the caller).
  const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
  return { role, content: m.content };
}

export class AnthropicProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: Sensitive<string>,
  ) {}

  /**
   * Send a request. The parameter type is `Masked<CanonicalRequest>` — obtainable only via
   * `pipeline.mask()`, so unmasked data cannot reach here by construction.
   */
  async send(req: Masked<CanonicalRequest>): Promise<ProviderResponse> {
    const body = toAnthropicBody(req);
    // STAGE 10: transparency-only — body fully built and ready to POST /v1/messages. Live fetch
    // (x-api-key + anthropic-version headers) and streaming are enabled once the API contract is
    // verified live, matching the OpenAI adapter's staged approach.
    void this.baseUrl;
    void this.apiKey;
    return { text: '', raw: { built: body, note: 'stage10: transport not yet enabled' } };
  }
}
