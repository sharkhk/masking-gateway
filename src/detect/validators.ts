/**
 * B4 — validators. Every deterministic pattern is paired with a validator; regex alone
 * produces unusable false-positive rates. These are pure, dependency-free, and unit-tested
 * against SYNTHETIC values (real values never enter the repo — see the policy carve-out).
 */

/** Luhn (mod-10) — payment cards and the Emirates ID check digit. */
export function luhnValid(digits: string): boolean {
  const s = digits.replace(/\D/g, '');
  if (s.length < 2) return false;
  let sum = 0;
  let alt = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = s.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Card BIN sanity: known major-scheme prefixes + plausible length. Not exhaustive; a
 *  guard against Luhn-valid-but-not-a-card 16-digit numbers. */
export function looksLikeCardBIN(digits: string): boolean {
  const s = digits.replace(/\D/g, '');
  if (s.length < 12 || s.length > 19) return false;
  return (
    /^4/.test(s) ||                     // Visa
    /^(5[1-5]|2[2-7])/.test(s) ||       // Mastercard
    /^3[47]/.test(s) ||                 // Amex (15)
    /^(6011|65|64[4-9])/.test(s) ||     // Discover
    /^3(0[0-5]|[689])/.test(s) ||       // Diners
    /^35/.test(s)                       // JCB
  );
}

/** IBAN mod-97 (ISO 13616): move the first 4 chars to the end, letters→numbers, mod 97 == 1. */
export function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch >= 'A' && ch <= 'Z' ? (ch.charCodeAt(0) - 55).toString() : ch;
    for (const d of code) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/** UAE Emirates ID: 15 digits, prefix 784, Luhn-valid (the 15th digit is the check digit). */
export function emiratesIdValid(raw: string): boolean {
  const s = raw.replace(/\D/g, '');
  if (s.length !== 15 || !s.startsWith('784')) return false;
  return luhnValid(s);
}

/** E.164 phone: '+' then country digit 1-9 then up to 14 more digits. */
export function e164Valid(raw: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(raw.replace(/[\s()-]/g, ''));
}

/** Structural JWT: three base64url segments; header decodes to JSON with typ/alg. */
export function jwtValid(raw: string): boolean {
  const parts = raw.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return false;
  if (!parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return false;
  try {
    const json = Buffer.from(parts[0]!, 'base64url').toString('utf8');
    const header = JSON.parse(json) as Record<string, unknown>;
    return typeof header['alg'] === 'string';
  } catch {
    return false;
  }
}

/** Shannon entropy (bits/char) — flags high-entropy strings likely to be secrets. */
export function shannonEntropy(s: string): number {
  if (!s.length) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}
