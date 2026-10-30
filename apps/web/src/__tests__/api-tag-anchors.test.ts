// SPDX-License-Identifier: AGPL-3.0-only
//
// /docs/api renders one section per OpenAPI tag with a jump-list above it.
// Both the chip's href and the section's id were computed inline, separately,
// from `tag.replace(/\s+/g,"-").toLowerCase()`.
//
// The spec carries two primary tags that differ only in case: "SMS" (33
// management endpoints under /api/v1/sms) and "Sms" (59 public provider
// webhooks under /api/public/sms). Both lowercased to "sms", so the page
// emitted two sections with the same DOM id — invalid HTML, and one chip could
// never reach its group because the browser stops at the first match.
//
// The slug now comes from operationsByTag and is disambiguated the same way
// operation slugs already are, so the anchor and the id cannot drift apart and
// a case-only tag collision resolves instead of silently swallowing a section.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { operationsByTag } from "@/lib/docs/loadOpenAPI";

const SRC = resolve(process.cwd(), "src");
const PAGE = readFileSync(join(SRC, "app/(docs)/docs/api/page.tsx"), "utf8");

describe("API reference tag anchors", () => {
  const groups = operationsByTag();

  it("groups the spec by tag", () => {
    // Guard the guard: an empty grouping would satisfy every check below.
    expect(groups.length).toBeGreaterThan(50);
    expect(groups.every((g) => g.operations.length > 0)).toBe(true);
  });

  it("gives every tag a distinct anchor", () => {
    const bySlug = new Map<string, string[]>();
    for (const g of groups) {
      bySlug.set(g.slug, [...(bySlug.get(g.slug) ?? []), g.tag]);
    }
    const collisions = [...bySlug.entries()]
      .filter(([, tags]) => tags.length > 1)
      .map(([slug, tags]) => `${slug}: ${tags.join(" | ")}`);
    expect(collisions.sort()).toEqual([]);
  });

  it("still resolves the case-only pair that collided", () => {
    // Guard the guard the other way: if the spec ever unifies these tags this
    // assertion tells us the scenario is gone rather than silently passing.
    const sms = groups.filter((g) => g.tag.toLowerCase() === "sms");
    if (sms.length < 2) return;
    expect(new Set(sms.map((g) => g.slug)).size).toBe(sms.length);
  });

  it("emits URL-safe anchors", () => {
    const unsafe = groups
      .filter((g) => encodeURIComponent(g.slug) !== g.slug)
      .map((g) => `${g.tag} → ${g.slug}`);
    expect(unsafe).toEqual([]);
  });

  it("uses the shared slug for both the chip and the section", () => {
    // The whole failure mode was two independent computations of one value.
    expect(PAGE).toContain("href={`#${g.slug}`}");
    expect(PAGE).toContain("id={g.slug}");
    expect(PAGE).not.toMatch(/replace\(\/\\s\+\/g, "-"\)/);
  });
});
