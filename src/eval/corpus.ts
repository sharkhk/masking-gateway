/**
 * B15 — labeled evaluation corpus. SYNTHETIC values only (fake cards passing Luhn, generated
 * Emirates IDs passing the check digit, example credentials) — required for the harness and
 * explicitly allowed; real values never enter the repo. Each sample embeds known entities so
 * the harness can measure RECALL (the safety metric) per class, plus negatives for precision.
 */
import type { EntityType } from '../detect/types';
import { emiratesIdValid } from '../detect/validators';

export interface Sample {
  id: string;
  text: string;
  expect: EntityType[]; // entity types that MUST be detected
}

// Generate a synthetic Emirates ID with a valid check digit (784 + year + seq + Luhn digit).
function synthEmiratesId(): string {
  const base = '78419901234567';
  for (let c = 0; c <= 9; c++) if (emiratesIdValid(base + c)) return base + c;
  throw new Error('unreachable');
}
const EID = synthEmiratesId();

export const CORPUS: Sample[] = [
  { id: 'email-1', text: 'Please email jane.doe@example.com about the invoice.', expect: ['EMAIL'] },
  { id: 'email-ar', text: 'راسل العميل على الإيميل omar.k@example.ae لمتابعة الطلب.', expect: ['EMAIL'] },
  { id: 'phone-1', text: 'Call me on +971501234567 tomorrow.', expect: ['PHONE'] },
  { id: 'card-visa', text: 'My Visa is 4242 4242 4242 4242 exp 05/29.', expect: ['CREDIT_CARD'] },
  { id: 'card-mc', text: 'charge 5555555555554444 for the order', expect: ['CREDIT_CARD'] },
  { id: 'iban-1', text: 'Wire to GB82 WEST 1234 5698 7654 32 by Friday.', expect: ['IBAN'] },
  { id: 'eid-1', text: `The applicant's Emirates ID is ${EID}.`, expect: ['EMIRATES_ID'] },
  { id: 'aws-1', text: 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE', expect: ['AWS_KEY'] },
  { id: 'gh-1', text: 'token ghp_' + 'a'.repeat(36) + ' committed by mistake', expect: ['GITHUB_TOKEN'] },
  { id: 'jwt-1', text: 'Authorization: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.abcDEF123_-', expect: ['JWT'] },
  { id: 'ipv4-1', text: 'client connected from 203.0.113.42 at noon', expect: ['IPV4'] },
  { id: 'uuid-1', text: 'trace id 550e8400-e29b-41d4-a716-446655440000', expect: ['UUID'] },
  { id: 'pem-1', text: 'key:\n-----BEGIN PRIVATE KEY-----\nMIIBVwIBADANBgkq\n-----END PRIVATE KEY-----', expect: ['PRIVATE_KEY'] },
  { id: 'multi-1', text: `Contact jane.doe@example.com or +971501234567; card 4242424242424242.`, expect: ['EMAIL', 'PHONE', 'CREDIT_CARD'] },
];

// Negatives — no PII; must produce ZERO findings (precision guard).
export const NEGATIVES: Sample[] = [
  { id: 'neg-model', text: 'Use model gpt-4o-mini with temperature 0.2 and reasoning enabled.', expect: [] },
  { id: 'neg-hash', text: 'Deployed commit a94a8fe5ccb19ba61c4c0873d391e987982fbbd3 to staging.', expect: [] },
  { id: 'neg-prose', text: 'The quick brown fox jumps over the lazy dog near the river bank.', expect: [] },
  { id: 'neg-order', text: 'Order number 1234567812345670 will ship on the third of the month.', expect: [] },
];
