/**
 * B4 — deterministic detectors, each a (pattern + validator) pair. `detectText` runs them all
 * and resolves overlaps (longest match wins; ties → higher confidence). Validators reject the
 * common Luhn/mod-97/check-digit near-misses that make regex-only detection unusable.
 */
import type { EntityType, Finding } from './types';
import type { Gazetteer } from './gazetteer';
import {
  luhnValid, looksLikeCardBIN, ibanValid, emiratesIdValid, e164Valid, jwtValid, shannonEntropy,
} from './validators';

interface Rule {
  type: EntityType;
  pattern: RegExp; // MUST be global (g)
  confidence: number;
  validate?: (m: string) => boolean;
}

const RULES: Rule[] = [
  // High-signal credentials first (specific → generic).
  { type: 'PRIVATE_KEY', confidence: 1, pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { type: 'AWS_KEY', confidence: 0.99, pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { type: 'GITHUB_TOKEN', confidence: 0.99, pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { type: 'SLACK_TOKEN', confidence: 0.99, pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: 'JWT', confidence: 0.97, pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, validate: jwtValid },

  { type: 'EMIRATES_ID', confidence: 1, pattern: /\b784[-\s]?\d{4}[-\s]?\d{7}[-\s]?\d\b/g, validate: emiratesIdValid },
  { type: 'IBAN', confidence: 0.98, pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g, validate: ibanValid },
  { type: 'CREDIT_CARD', confidence: 0.97, pattern: /\b(?:\d[ -]?){13,19}\b/g, validate: (m) => { const d = m.replace(/\D/g, ''); return looksLikeCardBIN(d) && luhnValid(d); } },

  { type: 'EMAIL', confidence: 0.95, pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { type: 'PHONE', confidence: 0.9, pattern: /(?<![\w.])\+[1-9]\d[\d\s()-]{6,16}\d/g, validate: e164Valid },
  { type: 'IPV4', confidence: 0.85, pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  { type: 'MAC', confidence: 0.9, pattern: /\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g },
  { type: 'UUID', confidence: 0.8, pattern: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b/g },

  // Generic high-entropy credential backstop (specific creds above are higher-confidence).
  { type: 'SECRET', confidence: 0.7, pattern: /[A-Za-z0-9_\-+/]{24,}={0,2}/g, validate: isLikelySecret },
];

/**
 * Generic-secret heuristic. Real credentials are high-entropy, mixed digits+letters, and
 * token-shaped (mixed case OR a base64/url-safe symbol). We EXCLUDE classic hex hashes
 * (md5/sha1/sha256) — those are public identifiers (commit SHAs, content hashes, ETags),
 * and masking them would break legitimate reasoning without protecting anyone. Specific
 * credential formats (AWS/GitHub/Slack/JWT/PEM) are already caught by dedicated rules.
 */
function isLikelySecret(m: string): boolean {
  if (m.length < 24) return false;
  if (!/[0-9]/.test(m) || !/[A-Za-z]/.test(m)) return false;
  if (shannonEntropy(m) < 3.5) return false;
  if (/^[0-9a-f]{32}$/i.test(m) || /^[0-9a-f]{40}$/i.test(m) || /^[0-9a-f]{64}$/i.test(m)) return false; // md5/sha1/sha256
  const mixedCase = /[a-z]/.test(m) && /[A-Z]/.test(m);
  const hasSymbol = /[-_+/=]/.test(m);
  return mixedCase || hasSymbol;
}

export interface DetectOptions {
  /** tenant's proprietary-entity dictionary (names, orgs, project codenames, accounts) */
  gazetteer?: Gazetteer;
}

/** Run the detector ensemble over `text` (deterministic + validators + optional gazetteer),
 *  validated, with overlaps resolved. */
export function detectText(text: string, opts: DetectOptions = {}): Finding[] {
  const raw: Finding[] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (let m = rule.pattern.exec(text); m; m = rule.pattern.exec(text)) {
      const value = m[0];
      if (rule.validate && !rule.validate(value)) continue;
      raw.push({ type: rule.type, value, start: m.index, end: m.index + value.length, confidence: rule.confidence, source: 'deterministic' });
      if (m.index === rule.pattern.lastIndex) rule.pattern.lastIndex++; // avoid zero-width loops
    }
  }
  if (opts.gazetteer) raw.push(...opts.gazetteer.scan(text));
  return resolveOverlaps(raw);
}

/** Keep the strongest finding per span: longest match wins; ties broken by confidence.
 *  Exported so the async NER path (detect/ner.ts) can merge NER spans with the same rule. */
export function resolveOverlaps(findings: Finding[]): Finding[] {
  const sorted = [...findings].sort(
    (a, b) => b.end - b.start - (a.end - a.start) || b.confidence - a.confidence || a.start - b.start,
  );
  const kept: Finding[] = [];
  for (const f of sorted) {
    if (!kept.some((k) => f.start < k.end && k.start < f.end)) kept.push(f);
  }
  return kept.sort((a, b) => a.start - b.start);
}
