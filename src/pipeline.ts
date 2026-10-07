/**
 * The masking pipeline — the SINGLE `Unmasked<CanonicalRequest>` → `Masked<CanonicalRequest>`
 * converter and the only sanctioned caller of `__unsafeBrandMasked`.
 *
 * STAGE 3: deterministic detectors run over every canonical channel.
 * STAGE 4: detected values are replaced with REVERSIBLE surrogates minted by a `MaskSession`
 * (memory-only vault), with referential integrity (one value → one surrogate everywhere).
 * STAGE 5: `rehydrate()` restores originals on the return path — matching candidate surrogates
 * by shape but only restoring ones the session actually minted (map membership), so forged
 * surrogates in untrusted output cannot exfiltrate anything (B10).
 *
 * Fail-closed: if masking throws, `mask()` rejects and the caller BLOCKS — a partial/unmasked
 * request is never returned.
 */
import { Masked, Unmasked, __unsafeBrandMasked } from './brand';
import type { CanonicalRequest } from './canonical';
import { detectText, type DetectOptions } from './detect/deterministic';
import { detectTextAsync, type NerRecognizer, type NerOptions } from './detect/ner';
import { MaskSession } from './vault';

export interface MaskResult {
  masked: Masked<CanonicalRequest>;
  /** distinct NEW entities detected + replaced in this call */
  entityCount: number;
  /** the session holding the reversible surrogate map — pass it to rehydrate() */
  session: MaskSession;
}

/** Options for a mask() call — tenant gazetteer, optional NER recognizer (B6), etc. When a
 *  recognizer is supplied, mask() takes the async NER path; otherwise the sync path is unchanged. */
export interface MaskOptions extends DetectOptions {
  ner?: NerRecognizer;
  nerOptions?: NerOptions;
}

function maskString(text: string, session: MaskSession, det: DetectOptions): string {
  if (!text) return text;
  const findings = detectText(text, det);
  if (!findings.length) return text;
  let out = text;
  for (const f of [...findings].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, f.start) + session.surrogateFor(f.type, f.value) + out.slice(f.end);
  }
  return out;
}

function maskUnknown(v: unknown, session: MaskSession, det: DetectOptions): unknown {
  if (typeof v === 'string') return maskString(v, session, det);
  if (Array.isArray(v)) return v.map((x) => maskUnknown(x, session, det));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, maskUnknown(val, session, det)]));
  }
  return v;
}

// ── Async NER-aware variants (used only when opts.ner is set; sync path above is untouched) ──
async function maskStringAsync(text: string, session: MaskSession, opts: MaskOptions): Promise<string> {
  if (!text) return text;
  const findings = await detectTextAsync(text, opts);
  if (!findings.length) return text;
  let out = text;
  for (const f of [...findings].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, f.start) + session.surrogateFor(f.type, f.value) + out.slice(f.end);
  }
  return out;
}

async function maskUnknownAsync(v: unknown, session: MaskSession, opts: MaskOptions): Promise<unknown> {
  if (typeof v === 'string') return maskStringAsync(v, session, opts);
  if (Array.isArray(v)) return Promise.all(v.map((x) => maskUnknownAsync(x, session, opts)));
  if (v && typeof v === 'object') {
    const entries = await Promise.all(
      Object.entries(v as Record<string, unknown>).map(async ([k, val]) => [k, await maskUnknownAsync(val, session, opts)] as const),
    );
    return Object.fromEntries(entries);
  }
  return v;
}

async function maskRequestAsync(req: CanonicalRequest, session: MaskSession, opts: MaskOptions): Promise<CanonicalRequest> {
  const messages = await Promise.all(req.messages.map(async (m) => ({
    ...m,
    content: await maskStringAsync(m.content, session, opts),
    ...(m.name !== undefined ? { name: await maskStringAsync(m.name, session, opts) } : {}),
  })));
  const out: CanonicalRequest = { ...req, messages };
  if (req.system !== undefined) out.system = await maskStringAsync(req.system, session, opts);
  if (req.tools) {
    out.tools = await Promise.all(req.tools.map(async (t) => ({
      ...t,
      ...(t.description !== undefined ? { description: await maskStringAsync(t.description, session, opts) } : {}),
      ...(t.parameters !== undefined ? { parameters: await maskUnknownAsync(t.parameters, session, opts) } : {}),
    })));
  }
  if (req.metadata) {
    const entries = await Promise.all(Object.entries(req.metadata).map(async ([k, v]) => [k, await maskStringAsync(v, session, opts)] as const));
    out.metadata = Object.fromEntries(entries);
  }
  if (req.stop) out.stop = await Promise.all(req.stop.map((s) => maskStringAsync(s, session, opts)));
  return out;
}

function maskRequest(req: CanonicalRequest, session: MaskSession, det: DetectOptions): CanonicalRequest {
  const out: CanonicalRequest = {
    ...req,
    messages: req.messages.map((m) => ({
      ...m,
      content: maskString(m.content, session, det),
      ...(m.name !== undefined ? { name: maskString(m.name, session, det) } : {}),
    })),
  };
  if (req.system !== undefined) out.system = maskString(req.system, session, det);
  if (req.tools) {
    out.tools = req.tools.map((t) => ({
      ...t,
      ...(t.description !== undefined ? { description: maskString(t.description, session, det) } : {}),
      ...(t.parameters !== undefined ? { parameters: maskUnknown(t.parameters, session, det) } : {}),
    }));
  }
  if (req.metadata) {
    out.metadata = Object.fromEntries(Object.entries(req.metadata).map(([k, v]) => [k, maskString(v, session, det)]));
  }
  if (req.stop) out.stop = req.stop.map((s) => maskString(s, session, det));
  return out;
}

/**
 * Mask an arbitrary structured value (string / array / object) with an existing session — used
 * to mask TOOL RESULTS before they re-enter the provider-bound conversation (a tool's output can
 * carry fresh PII, e.g. WHOIS emails). Reuses the same session so surrogates stay consistent and
 * rehydrate on the return path. Not the choke point (returns a plain value, not `Masked<T>`) —
 * the request choke point remains `mask()`.
 */
export function maskValue(value: unknown, session: MaskSession, opts: MaskOptions = {}): unknown {
  return maskUnknown(value, session, opts);
}

/**
 * Mask a request. A fresh conversation-scoped `MaskSession` is created unless one is passed
 * (so multi-turn conversations keep one consistent surrogate map — referential integrity
 * across turns). NER, gazetteer, entity resolution, and quasi-identifier scoring slot into
 * this same function in later stages without touching the choke point.
 */
export async function mask(
  req: Unmasked<CanonicalRequest>,
  session: MaskSession = new MaskSession(),
  opts: MaskOptions = {},
): Promise<MaskResult> {
  const before = session.size;
  // NER path is async (model inference); the deterministic-only path stays fully synchronous.
  const maskedReq = opts.ner ? await maskRequestAsync(req, session, opts) : maskRequest(req, session, opts);
  const masked = __unsafeBrandMasked<CanonicalRequest>(maskedReq);
  return { masked, entityCount: session.size - before, session };
}

// Matches the SHAPE of a minted surrogate: [TYPE_N_<8 hex salt>]. The TYPE segment allows
// DIGITS (entity types like IPV4 contain one) — an earlier [A-Za-z_]+ silently failed to
// rehydrate IPv4 surrogates. Case-INSENSITIVE so a model that case-shifts the token is still
// caught. Used only to FIND candidates — every one is verified against the session map before
// restoring (B10), so broadening the charclass cannot cause a forged token to be restored.
const SURROGATE_RE = /\[[A-Za-z0-9_]+_\d+_[0-9A-Fa-f]{8}\]/g;

/** Upper bound on a minted surrogate's length — governs the streaming holdback window. */
const MAX_SURROGATE_LEN = 64;

/** Synchronous core: restore only session-minted surrogates (tolerant match, map-verified). */
export function rehydrateSync(text: string, session: MaskSession): string {
  if (!text) return text;
  return text.replace(SURROGATE_RE, (candidate) => session.originalFor(candidate) ?? candidate);
}

/**
 * Restore originals from surrogates on the return path. Only surrogates THIS session minted
 * are restored (map membership) — a forged or foreign token is left untouched, so untrusted
 * model output cannot trick the gateway into revealing a value it never masked (B10). Tolerant
 * to case-shift; exact restoration of the original value.
 */
export async function rehydrate(text: string, session: MaskSession): Promise<string> {
  return rehydrateSync(text, session);
}

/**
 * Rehydrate surrogates inside a structured value — e.g. TOOL-CALL ARGUMENTS the model emits,
 * which must be restored before execution (a frequently-missed leak/bug per B10).
 */
export function rehydrateValue(v: unknown, session: MaskSession): unknown {
  if (typeof v === 'string') return rehydrateSync(v, session);
  if (Array.isArray(v)) return v.map((x) => rehydrateValue(x, session));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, rehydrateValue(val, session)]));
  }
  return v;
}

/**
 * Streaming-safe rehydrator for SSE. Chunks split surrogates mid-token, so we hold back any
 * trailing region that could be an INCOMPLETE surrogate (an unclosed `[...` within the max
 * surrogate length) and never emit a partial token. On end/timeout/disconnect, `flush()`
 * emits the rehydrated remainder — never the raw buffer.
 */
export function createRehydrator(session: MaskSession): { push(chunk: string): string; flush(): string } {
  let buf = '';
  return {
    push(chunk: string): string {
      buf += chunk;
      let cut = buf.length;
      const lastOpen = buf.lastIndexOf('[');
      // Hold back only if there's an unclosed '[' near the end that could still become a surrogate.
      if (lastOpen !== -1 && buf.indexOf(']', lastOpen) === -1 && buf.length - lastOpen < MAX_SURROGATE_LEN) {
        cut = lastOpen;
      }
      const emit = rehydrateSync(buf.slice(0, cut), session);
      buf = buf.slice(cut);
      return emit;
    },
    flush(): string {
      const out = rehydrateSync(buf, session);
      buf = '';
      return out;
    },
  };
}
