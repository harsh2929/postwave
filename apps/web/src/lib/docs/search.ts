// Moosewave docs - tiny inverted-index search.
//
// This module is split for client-safety:
//
//   - This file: client-safe. Defines the `SearchIndex` shape and the pure
//     `searchIndex(...)` lookup function. Safe to import from a "use client"
//     component because it has zero Node.js builtins.
//   - search.server.ts: server-only. Builds the index from the OpenAPI loader
//     and the MCP skill loader (both of which use node:fs). The public search
//     route returns only compact ranked results to the client.

export interface SearchDoc {
  id: number;
  title: string;
  url: string;
  section: string;
  body: string;
}

export interface SearchIndex {
  docs: SearchDoc[];
  postings: Record<string, number[]>;
}

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "to",
  "and",
  "or",
  "is",
  "in",
  "on",
  "for",
  "with",
  "this",
  "that",
  "by",
  "from",
  "be",
  "are",
  "as",
  "at",
  "it",
  "if",
  "but",
  "not",
  "you",
  "your",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/g, " ")
    .split(/[\s_-]+/)
    .filter((t) => t.length >= 2 && t.length <= 30 && !STOPWORDS.has(t));
}

/**
 * Lookup against the prebuilt index. Tokenizes the query, then *unions* the
 * posting lists — a doc matching one query token still ranks, it just ranks
 * below one matching several. (This said "intersects", which describes AND
 * semantics this has never had; someone acting on that description would
 * "restore" an intersection and silently drop most results.)
 *
 * Scoring: +2 per exact token, +1 per prefix token. The index stores each doc
 * at most once per term (search.server.ts dedupes while building), so the
 * score counts *distinct query tokens matched* rather than term frequency —
 * which is what keeps a doc matching every token above a doc that happens to
 * repeat one of them.
 *
 * Pure, so it behaves identically server-side and in tests.
 */
const EXACT_TOKEN = 2;
const PREFIX_TOKEN = 1;
const TITLE_TOKEN = 3;

export function searchIndex(
  index: SearchIndex,
  query: string,
  limit = 10,
): { doc: SearchDoc; score: number }[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const byId = new Map<number, SearchDoc>();
  for (const d of index.docs) byId.set(d.id, d);

  const scores = new Map<number, number>();
  for (const t of tokens) {
    // One score per doc per query token, best match wins. Summing every
    // matching variant meant a doc containing both "migration" and
    // "migrations" collected 2 + 1 for what is one concept, and the generic
    // /docs/migrations index outranked the specific guide the reader asked
    // for on plural forms alone.
    const counted = new Set<number>();
    for (const id of index.postings[t] ?? []) {
      counted.add(id);
      scores.set(id, (scores.get(id) ?? 0) + EXACT_TOKEN);
    }
    for (const k of Object.keys(index.postings)) {
      if (k === t || !k.startsWith(t)) continue;
      for (const id of index.postings[k]!) {
        if (counted.has(id)) continue;
        counted.add(id);
        scores.set(id, (scores.get(id) ?? 0) + PREFIX_TOKEN);
      }
    }
  }

  // Title hits outrank body mentions. The builder tokenizes title and body
  // into one bag, so without this an incidental mention counted the same as
  // the page's own name — typing "quickstart" ranked Getting Started above
  // Quickstart, and "mailchimp migration" put the Mailchimp guide fifth.
  for (const [id, score] of scores) {
    const doc = byId.get(id);
    if (!doc) continue;
    const inTitle = new Set(tokenize(doc.title));
    const hits = tokens.filter((t) => inTitle.has(t)).length;
    if (hits > 0) scores.set(id, score + hits * TITLE_TOKEN);
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, score]) => {
      const doc = byId.get(id);
      return doc ? { doc, score } : null;
    })
    .filter((x): x is { doc: SearchDoc; score: number } => Boolean(x));
}
