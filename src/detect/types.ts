/** B4/B9 — detection types. */

export type EntityType =
  | 'CREDIT_CARD'
  | 'IBAN'
  | 'EMIRATES_ID'
  | 'EMAIL'
  | 'PHONE'
  | 'JWT'
  | 'UUID'
  | 'IPV4'
  | 'MAC'
  | 'AWS_KEY'
  | 'GITHUB_TOKEN'
  | 'SLACK_TOKEN'
  | 'PRIVATE_KEY'
  | 'SECRET' // generic high-entropy credential
  // contextual / gazetteer / NER classes (B4 gazetteer, B6 NER)
  | 'PERSON'
  | 'ORG'
  | 'LOCATION'
  | 'PROJECT'
  | 'ACCOUNT';

export interface Finding {
  type: EntityType;
  /** matched substring (the raw value — carry it only inside the pipeline, never to a log) */
  value: string;
  start: number;
  end: number; // exclusive
  confidence: number; // 0..1
  source: 'deterministic' | 'gazetteer' | 'ner';
}
