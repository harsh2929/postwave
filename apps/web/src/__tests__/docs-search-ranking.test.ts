// SPDX-License-Identifier: AGPL-3.0-only
//
// The docs search index is assembled from three sources — 25 hand-written
// STATIC_DOCS, every OpenAPI operation, and every MCP skill — and nothing tied
// the hand-written half to the routes it points at. A stale url there is worse
// than a missing page: the reader searches, gets a confident hit, clicks, and
// lands on a 404 that looks like the docs are broken.
//
// It also pins the ranking property the scorer depends on. searchIndex unions
// posting lists rather than intersecting them, so a doc matching one query
// token still appears; what keeps that useful is that the builder stores each
// doc at most once per term, making the score count distinct tokens matched
// rather than term frequency. Drop the dedupe and a page that merely repeats a
// common word outranks the page the reader asked for.
import { describe, expect, it } from "vitest";

import { searchIndex } from "@/lib/docs/search";
import { getSearchIndex, indexSizeBytes } from "@/lib/docs/search.server";
import { docsRouteExists, docsRouteStats } from "./helpers/docs-routes";

describe("docs search index integrity", () => {
  const index = getSearchIndex();

  it("is built from all three sources", () => {
    // Guard the guard: a loader returning nothing would make every sweep here
    // pass over a near-empty corpus.
    expect(index.docs.length).toBeGreaterThan(500);
    expect(index.docs.some((d) => d.section === "Get Started")).toBe(true);
    expect(index.docs.some((d) => d.section.startsWith("API ·"))).toBe(true);
    expect(index.docs.some((d) => d.section.startsWith("Skills ·"))).toBe(true);
    expect(docsRouteStats().params).toBeGreaterThan(500);
  });

  it("points every result at a route that exists", () => {
    const dead = index.docs
      .filter((d) => !docsRouteExists(d.url))
      .map((d) => `${d.title} → ${d.url}`);
    expect([...new Set(dead)].sort()).toEqual([]);
  });

  it("never lists the same page twice", () => {
    // Two entries for one URL is two identical-looking rows in the ⌘K panel,
    // each consuming one of the twelve result slots.
    const byUrl = new Map<string, number>();
    for (const d of index.docs) byUrl.set(d.url, (byUrl.get(d.url) ?? 0) + 1);
    const dupes = [...byUrl.entries()]
      .filter(([, n]) => n > 1)
      .map(([url, n]) => `${url} ×${n}`);
    expect(dupes.sort()).toEqual([]);
  });

  it("stores each doc at most once per term", () => {
    const repeated = Object.entries(index.postings)
      .filter(([, ids]) => new Set(ids).size !== ids.length)
      .map(([term]) => term);
    expect(repeated.slice(0, 5)).toEqual([]);
  });

  it("puts a page first when you type its own title", () => {
    // Measured before the fix, on real data: the exact-title page ranked
    // 5th for "mailchimp migration" (below three unrelated API endpoints),
    // 3rd for "custom domains", and 2nd for "quickstart" — beaten by
    // "Getting started", which only mentions the word.
    //
    // Two causes, both scoring bugs. A doc collected +2 for "migration" and
    // another +1 for "migrations", so the generic /docs/migrations index won
    // on plural forms; and title and body were tokenized into one bag, so a
    // page's own name counted no more than an incidental mention.
    const EXPECTED: [string, string][] = [
      ["mailchimp migration", "/docs/migrations/mailchimp"],
      ["substack migration", "/docs/migrations/substack"],
      ["quickstart", "/docs/quickstart"],
      ["inbound webhooks", "/docs/integrations/inbound-webhooks"],
      ["custom domains", "/docs/integrations/custom-domains"],
    ];
    const wrong = EXPECTED.filter(([query, url]) => {
      const hits = searchIndex(index, query, 10);
      return hits[0]?.doc.url !== url;
    }).map(
      ([query, url]) =>
        `${query} → ${searchIndex(index, query, 1)[0]?.doc.url ?? "(none)"}, expected ${url}`,
    );
    expect(wrong).toEqual([]);
  });

  it("scores each query token once per doc", () => {
    // A doc containing "migration", "migrations" and "migrations_id" must not
    // bank three separate bonuses for one query token. With a single token the
    // ceiling is one exact hit plus a title hit.
    const hits = searchIndex(index, "migration", 25);
    expect(hits.length).toBeGreaterThan(3);
    for (const hit of hits) expect(hit.score).toBeLessThanOrEqual(2 + 3);
  });

  it("returns nothing rather than everything for an unusable query", () => {
    // All-stopword and punctuation-only queries tokenize to nothing. Returning
    // the whole corpus there would be the worst possible failure mode.
    for (const query of ["the of and", "!!!", "  ", "a"]) {
      expect(searchIndex(index, query, 10)).toEqual([]);
    }
  });

  it("stays small enough to hold in server memory", () => {
    // indexSizeBytes existed with no caller. This is the check it was for:
    // the corpus grows with every endpoint and skill, and a body field that
    // accidentally embedded a full schema would show up here first.
    const bytes = indexSizeBytes(index);
    expect(bytes).toBeGreaterThan(50_000);
    expect(bytes).toBeLessThan(8_000_000);
  });
});
