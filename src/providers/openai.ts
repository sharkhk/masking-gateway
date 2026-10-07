/**
 * OpenAI-compatible provider adapter (B11). Its `send()` accepts ONLY `Masked<CanonicalRequest>`
 * — passing raw/`Unmasked` data is a compile error. This is the outward edge of the choke point.
 *
 * Stage 1 proves TRANSPARENCY: build the exact provider body from the canonical request so a
 * client can migrate by changing a base URL. The real network call + streaming + rehydration
 * are layered in later stages; the type contract here does not change.
 *
 * NOTE (B11): verify the live OpenAI API contract against current docs before the network call
 * is enabled — do not rely on training-data assumptions for paths/params/model ids.
 */
import type { Masked } from '../brand';
import { Sensitive } from '../brand';
import type { CanonicalRequest, CanonicalMessage } from '../canonical';

export interface OpenAIBody {
  model: string;
  messages: Array<{ role: string; content: string; name?: string; tool_call_id?: string }>;
  tools?: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: unknown } }>;
  max_tokens?: number;
  temperature?: number;
  stop?: string[];
  stream?: boolean;
  user?: string;
}

/** Build the OpenAI-compatible request body from a canonical request. Pure + typed. */
export function toOpenAIBody(req: CanonicalRequest): OpenAIBody {
  const messages: OpenAIBody['messages'] = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  for (const m of req.messages) messages.push(canonicalToOpenAIMessage(m));

  const body: OpenAIBody = { model: req.model, messages };
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.stop?.length) body.stop = req.stop;
  if (req.stream !== undefined) body.stream = req.stream;
  if (req.metadata?.user) body.user = req.metadata.user;
  return body;
}

function canonicalToOpenAIMessage(m: CanonicalMessage): OpenAIBody['messages'][number] {
  // 'developer' role maps to 'system' on classic OpenAI chat; kept explicit for clarity.
  const role = m.role === 'developer' ? 'system' : m.role;
  const out: OpenAIBody['messages'][number] = { role, content: m.content };
  if (m.name) out.name = m.name;
  if (m.toolCallId) out.tool_call_id = m.toolCallId;
  return out;
}

export interface ProviderResponse {
  text: string;
  raw: unknown;
}

export class OpenAIProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: Sensitive<string>,
  ) {}

  /**
   * Send a request. The parameter type is `Masked<CanonicalRequest>` — the ONLY way a caller
   * can obtain one is `pipeline.mask()`, so unmasked data cannot reach this method by
   * construction. Reading fields off the masked value is fine (it is structurally canonical).
   */
  async send(req: Masked<CanonicalRequest>): Promise<ProviderResponse> {
    const body = toOpenAIBody(req);
    // STAGE 1: transparency-only — the body is fully built and ready to POST. The live fetch
    // (with SigV4/api-version/etc. per provider) and streaming buffer are enabled in a later
    // stage, once the choke point + tests are locked and the API contract is verified live.
    void this.baseUrl;
    void this.apiKey;
    return { text: '', raw: { built: body, note: 'stage1: transport not yet enabled' } };
  }
}
