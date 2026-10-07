/**
 * B3 — the structural choke point.
 *
 * `Masked<T>` and `Unmasked<T>` are nominally-branded versions of `T`. Provider clients
 * accept ONLY `Masked<T>`. The single place allowed to produce a `Masked<T>` is the masking
 * pipeline (`pipeline.ts`), which owns the brand cast. Any other code path that tries to
 * hand raw data to a provider is a COMPILE error, not a review catch.
 *
 * There is intentionally no public `unwrap`/`unmask`-to-raw and no exported `Masked`
 * constructor. Reading fields is fine — `Masked<T>`/`Unmasked<T>` are structurally `T` — but
 * you cannot pass an `Unmasked<T>` (or a plain `T`) where `Masked<T>` is required.
 */

declare const MASKED: unique symbol;
declare const UNMASKED: unique symbol;

export type Masked<T> = T & { readonly [MASKED]: true };
export type Unmasked<T> = T & { readonly [UNMASKED]: true };

/**
 * The ONE entry point for raw client data. Everything ingested from a client is branded
 * `Unmasked` immediately, so the type system tracks it from the edge inward.
 */
export function asUnmasked<T>(value: T): Unmasked<T> {
  return value as Unmasked<T>;
}

/**
 * INTERNAL brand cast — the ONLY sanctioned way to mint a `Masked<T>`. It lives here so the
 * cast exists in exactly one auditable spot, but it must be called ONLY from `pipeline.ts`
 * after the value has traversed detection + masking. Do not import this anywhere else; it is
 * deliberately NOT re-exported from `index.ts`. A lint rule enforces the single caller.
 */
export function __unsafeBrandMasked<T>(value: T): Masked<T> {
  return value as Masked<T>;
}

/**
 * B3 — logging discipline. Wrap any value that could contain PII/secrets in `Sensitive<T>`.
 * Its string/JSON/inspect forms redact, so a value cannot reach a log line, trace, metric,
 * or exception payload by accident. Reading the real value requires an explicit `.reveal()`,
 * which is greppable and reviewable.
 */
export class Sensitive<T> {
  constructor(private readonly value: T) {}

  /** Explicit, auditable reveal — the only way to read the wrapped value. */
  reveal(): T {
    return this.value;
  }

  toString(): string {
    return '[REDACTED]';
  }

  toJSON(): string {
    return '[REDACTED]';
  }

  // Node's console.log / util.inspect hook.
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return 'Sensitive([REDACTED])';
  }
}
