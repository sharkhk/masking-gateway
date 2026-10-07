/**
 * B4 — gazetteer detector. Exact-match dictionaries of the tenant's OWN proprietary entities
 * (employee roster, customer names, project codenames, account numbers) that patterns and NER
 * structurally cannot catch. Aho-Corasick, not iterated regex, so thousands of terms scan in
 * one linear pass.
 *
 * Sovereign: each tenant supplies its own lists; nothing ships with the gateway. Terms are the
 * tenant's data — carry them only in memory, never log them (they are PII themselves).
 *
 * Matching is case-insensitive and word-boundary aware (so "Sam" does not fire inside
 * "Samsung"). Longer terms win at overlap-resolution time (handled by the caller).
 */
import type { EntityType, Finding } from './types';

export interface GazetteerEntry {
  term: string;
  type: EntityType; // e.g. PERSON, ORG, PROJECT, ACCOUNT
}

interface Node {
  next: Map<number, number>; // charCode → node id
  fail: number;
  outputs: Array<{ length: number; type: EntityType }>;
}

const isWordChar = (code: number): boolean =>
  (code >= 48 && code <= 57) || // 0-9
  (code >= 65 && code <= 90) || // A-Z
  (code >= 97 && code <= 122) || // a-z
  code === 95 || // _
  code >= 128; // treat non-ASCII (e.g. Arabic script) as word chars

export class Gazetteer {
  private readonly nodes: Node[] = [{ next: new Map(), fail: 0, outputs: [] }];

  private constructor() {}

  /** Build an automaton from entries (deduped; case-folded for matching). */
  static build(entries: GazetteerEntry[]): Gazetteer {
    const g = new Gazetteer();
    for (const e of entries) {
      const term = e.term.trim();
      if (!term) continue;
      g.insert(term.toLowerCase(), term.length, e.type);
    }
    g.buildFailureLinks();
    return g;
  }

  private insert(lower: string, origLen: number, type: EntityType): void {
    let cur = 0;
    for (let i = 0; i < lower.length; i++) {
      const c = lower.charCodeAt(i);
      const node = this.nodes[cur]!;
      let nxt = node.next.get(c);
      if (nxt === undefined) {
        nxt = this.nodes.length;
        this.nodes.push({ next: new Map(), fail: 0, outputs: [] });
        node.next.set(c, nxt);
      }
      cur = nxt;
    }
    this.nodes[cur]!.outputs.push({ length: origLen, type });
  }

  private buildFailureLinks(): void {
    const queue: number[] = [];
    for (const child of this.nodes[0]!.next.values()) {
      this.nodes[child]!.fail = 0;
      queue.push(child);
    }
    while (queue.length) {
      const cur = queue.shift()!;
      const node = this.nodes[cur]!;
      for (const [c, child] of node.next) {
        let f = node.fail;
        while (f !== 0 && !this.nodes[f]!.next.has(c)) f = this.nodes[f]!.fail;
        const fail = this.nodes[f]!.next.get(c);
        this.nodes[child]!.fail = fail !== undefined && fail !== child ? fail : 0;
        this.nodes[child]!.outputs.push(...this.nodes[this.nodes[child]!.fail]!.outputs);
        queue.push(child);
      }
    }
  }

  /** Scan text; emit word-boundary-aligned findings for every dictionary hit. */
  scan(text: string): Finding[] {
    const findings: Finding[] = [];
    const lower = text.toLowerCase();
    let cur = 0;
    for (let i = 0; i < lower.length; i++) {
      const c = lower.charCodeAt(i);
      while (cur !== 0 && !this.nodes[cur]!.next.has(c)) cur = this.nodes[cur]!.fail;
      cur = this.nodes[cur]!.next.get(c) ?? 0;
      if (cur === 0) continue;
      for (const out of this.nodes[cur]!.outputs) {
        const start = i - out.length + 1;
        const end = i + 1;
        const before = start - 1 >= 0 ? text.charCodeAt(start - 1) : -1;
        const after = end < text.length ? text.charCodeAt(end) : -1;
        if (isWordChar(before) || isWordChar(after)) continue; // enforce whole-word match
        findings.push({ type: out.type, value: text.slice(start, end), start, end, confidence: 1, source: 'gazetteer' });
      }
    }
    return findings;
  }
}
