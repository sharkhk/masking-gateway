/**
 * B13 — policy engine. Decides, per (tenant, provider, entity class), what happens to each
 * detected entity before a request may leave for an external LLM: MASK (reversible surrogate),
 * BLOCK (refuse to send), or ALLOW (pass through verbatim — used sparingly, e.g. a public model
 * name). Also carries the re-identification threshold (B9) per provider.
 *
 * FAIL CLOSED is the whole design (Section E):
 *   - unknown tenant            → provider not allowed, everything masked
 *   - provider not listed        → not allowed
 *   - entity class with no rule   → MASK (never ALLOW by omission)
 *   - a finding below minConfidence is still MASKED, never allowed through
 * Relaxing any default (allow-by-omission, lower reid threshold, allow a secret class) is a
 * Tier-2 change and must be explicit in the tenant config, never inferred. Zero deps.
 */
import type { EntityType, Finding } from './detect/types';

export type PolicyAction = 'mask' | 'block' | 'allow';

export interface ClassPolicy {
  action: PolicyAction;
  /** findings below this confidence are still masked (never allowed) but flagged low-confidence */
  minConfidence?: number;
}

export interface ProviderPolicy {
  /** whether ANY external send to this provider is permitted for the tenant */
  allowed: boolean;
  /** per-entity-class overrides; omitted classes fall back to MASK */
  classes?: Partial<Record<EntityType, ClassPolicy>>;
  /** k-anonymity threshold; below it the request is generalized or blocked (see reidFallback) */
  reidThreshold?: number;
  reidFallback?: 'block' | 'generalize';
}

export interface TenantPolicy {
  tenantId: string;
  /** applies to every provider unless overridden in `providers` */
  default: ProviderPolicy;
  providers?: Record<string, ProviderPolicy>;
}

/** Global fail-closed defaults, used whenever a level of config is absent. */
export const DEFAULT_CLASS_ACTION: PolicyAction = 'mask';
export const DEFAULT_REID_THRESHOLD = 10;
export const DEFAULT_REID_FALLBACK: 'block' | 'generalize' = 'generalize';

export interface ResolvedPolicy {
  tenantId: string;
  provider: string;
  providerAllowed: boolean;
  reidThreshold: number;
  reidFallback: 'block' | 'generalize';
  /** effective action for an entity class + optional detection confidence */
  actionFor: (type: EntityType, confidence?: number) => PolicyAction;
}

export interface SendDecision {
  /** whether the request may be sent at all (false if provider blocked or any BLOCK finding) */
  allow: boolean;
  /** findings whose class resolves to BLOCK — these prevent the send */
  blocked: Finding[];
  /** findings to mask (reversible surrogate) before sending */
  toMask: Finding[];
  /** findings explicitly allowed through verbatim */
  passthrough: Finding[];
  reasons: string[];
}

export class PolicyEngine {
  private readonly tenants: Map<string, TenantPolicy>;

  constructor(tenants: TenantPolicy[] | Map<string, TenantPolicy> = []) {
    this.tenants = tenants instanceof Map ? tenants : new Map(tenants.map((t) => [t.tenantId, t]));
  }

  upsert(policy: TenantPolicy): void {
    this.tenants.set(policy.tenantId, policy);
  }

  /** Resolve the effective policy for a (tenant, provider) pair. Always returns a policy —
   *  an unknown tenant/provider yields a fully fail-closed one (not allowed, mask everything). */
  resolve(tenantId: string, provider: string): ResolvedPolicy {
    const tenant = this.tenants.get(tenantId);
    const prov = tenant?.providers?.[provider] ?? tenant?.default;

    const providerAllowed = prov?.allowed === true; // fail closed: undefined/false → not allowed
    const reidThreshold = prov?.reidThreshold ?? DEFAULT_REID_THRESHOLD;
    const reidFallback = prov?.reidFallback ?? DEFAULT_REID_FALLBACK;
    const classes = prov?.classes;

    const actionFor = (type: EntityType, confidence?: number): PolicyAction => {
      const rule = classes?.[type];
      if (!rule) return DEFAULT_CLASS_ACTION; // omitted class → MASK
      // Below-confidence findings are never ALLOWED through; downgrade allow→mask, keep block.
      if (rule.action === 'allow' && rule.minConfidence !== undefined && confidence !== undefined && confidence < rule.minConfidence) {
        return 'mask';
      }
      return rule.action;
    };

    return { tenantId, provider, providerAllowed, reidThreshold, reidFallback, actionFor };
  }

  /** Classify a set of findings against the resolved policy into a send decision. */
  decide(tenantId: string, provider: string, findings: Finding[]): SendDecision {
    const resolved = this.resolve(tenantId, provider);
    const blocked: Finding[] = [];
    const toMask: Finding[] = [];
    const passthrough: Finding[] = [];
    const reasons: string[] = [];

    if (!resolved.providerAllowed) {
      reasons.push(`provider "${provider}" not permitted for tenant "${tenantId}" (fail-closed)`);
    }

    for (const f of findings) {
      const action = resolved.actionFor(f.type, f.confidence);
      if (action === 'block') {
        blocked.push(f);
      } else if (action === 'allow') {
        passthrough.push(f);
      } else {
        toMask.push(f);
      }
    }
    if (blocked.length) reasons.push(`${blocked.length} finding(s) in a BLOCK class`);

    return {
      allow: resolved.providerAllowed && blocked.length === 0,
      blocked,
      toMask,
      passthrough,
      reasons,
    };
  }
}
