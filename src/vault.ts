/**
 * B4/B10/B12 — reversible surrogates + the vault.
 *
 * A `MaskSession` holds the bidirectional original↔surrogate map for one conversation. It is
 * the highest-value object in the system, so:
 *   • MEMORY-ONLY by default, conversation-scoped, with a TTL (B12 sovereign default — zero
 *     PII at rest; envelope encryption / per-tenant KMS is an infra option for persisted mode).
 *   • Surrogates carry an UNGUESSABLE per-session salt and are only reversed via MAP MEMBERSHIP
 *     — never by pattern — so an attacker cannot forge a surrogate to exfiltrate a value the
 *     gateway never minted (B10).
 *   • The session NEVER renders its contents to a log/trace/inspect — toString/JSON/inspect
 *     redact (B3/B12).
 *
 * Runtime `crypto`/`Date.now()` are fine here (this is normal Node, not a workflow sandbox).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { EntityType } from './detect/types';

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h conversation scope

export class MaskSession {
  readonly id: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  private readonly salt: string; // per-session, unguessable — baked into every surrogate
  private readonly fwd = new Map<string, string>(); // original → surrogate (referential integrity)
  private readonly rev = new Map<string, string>(); // surrogate → original (membership = trust)
  private readonly counters = new Map<EntityType, number>();

  /** `salt` is injectable for deterministic tests; defaults to unguessable random. */
  constructor(ttlMs: number = DEFAULT_TTL_MS, salt?: string) {
    this.id = randomUUID();
    this.salt = salt ?? randomBytes(4).toString('hex'); // 8 hex chars
    this.createdAt = Date.now();
    this.expiresAt = this.createdAt + ttlMs;
  }

  /** Mint (or reuse) a reversible surrogate for one original value. Referential integrity:
   *  the same original always yields the same surrogate within the session. */
  surrogateFor(type: EntityType, original: string): string {
    const existing = this.fwd.get(original);
    if (existing) return existing;
    const n = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, n);
    const surrogate = `[${type}_${n}_${this.salt}]`;
    this.fwd.set(original, surrogate);
    this.rev.set(surrogate.toUpperCase(), original); // rev keyed by canonical (upper) form
    return surrogate;
  }

  /** Restore an original ONLY if THIS session minted the surrogate. Case-tolerant (models
   *  case-shift tokens), but still MAP-VERIFIED — forged/foreign tokens return undefined and
   *  are left untouched by the caller (B10). */
  originalFor(surrogate: string): string | undefined {
    return this.rev.get(surrogate.toUpperCase());
  }

  get size(): number {
    return this.fwd.size;
  }
  get expired(): boolean {
    return Date.now() > this.expiresAt;
  }

  /** Wipe every mapping from memory (GDPR Art.17 / PDPL erasure at the session level). */
  destroy(): void {
    this.fwd.clear();
    this.rev.clear();
    this.counters.clear();
  }

  // PII must never reach a log via the session object.
  toString(): string {
    return `MaskSession(${this.id} · ${this.fwd.size} entities · [REDACTED])`;
  }
  toJSON(): string {
    return this.toString();
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString();
  }
}

/** In-memory, TTL'd session store — the sovereign default (no PII at rest). */
export class Vault {
  private readonly sessions = new Map<string, MaskSession>();
  constructor(private readonly defaultTtlMs: number = DEFAULT_TTL_MS) {}

  create(ttlMs: number = this.defaultTtlMs, salt?: string): MaskSession {
    const s = new MaskSession(ttlMs, salt);
    this.sessions.set(s.id, s);
    return s;
  }

  get(id: string): MaskSession | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (s.expired) {
      this.destroy(id);
      return undefined;
    }
    return s;
  }

  destroy(id: string): void {
    this.sessions.get(id)?.destroy();
    this.sessions.delete(id);
  }

  /** Evict + wipe expired sessions; returns how many were reaped. Call on a timer in prod. */
  sweep(): number {
    let reaped = 0;
    for (const [id, s] of this.sessions) {
      if (s.expired) {
        s.destroy();
        this.sessions.delete(id);
        reaped += 1;
      }
    }
    return reaped;
  }
}
