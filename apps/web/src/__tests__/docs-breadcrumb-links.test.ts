// SPDX-License-Identifier: AGPL-3.0-only
//
// Docs breadcrumbs are a navigation control, and Breadcrumbs renders a crumb
// without an href as plain text. On /docs/api/<endpoint> the tag crumb had no
// href, so there was no one-click way back to the group the endpoint belongs
// to — while the sibling /docs/skills/<skill> page links its category crumb to
// exactly that kind of anchor.
//
// The tag anchor also has to come from operationsByTag rather than a local
// toLowerCase: the spec carries "SMS" and "Sms" as distinct primary tags, and
// only the shared slug disambiguates them. A crumb built by re-deriving the
// slug would send 33 endpoints to the wrong section.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { listOperations, operationsByTag } from "@/lib/docs/loadOpenAPI";

const SRC = resolve(process.cwd(), "src");
const ENDPOINT_PAGE = readFileSync(
  join(SRC, "app/(docs)/docs/api/[endpoint]/page.tsx"),
  "utf8",
);
const SKILL_PAGE = readFileSync(
  join(SRC, "app/(docs)/docs/skills/[skill]/page.tsx"),
  "utf8",
);

describe("docs detail-page breadcrumbs", () => {
  it("links the tag crumb on an endpoint page", () => {
    expect(ENDPOINT_PAGE).toMatch(/href: `\/docs\/api#\$\{tagAnchor\}`/);
  });

  it("takes that anchor from the shared slug, not a local transform", () => {
    // Re-deriving it would reintroduce the SMS/Sms collision.
    expect(ENDPOINT_PAGE).toMatch(/operationsByTag\(\)\.find/);
    expect(ENDPOINT_PAGE).not.toMatch(/primaryTag\.toLowerCase\(\)/);
  });

  it("resolves a tag anchor for every operation", () => {
    // The lookup is by exact tag string; a mismatch would silently drop the
    // href and put the crumb back to inert text for that endpoint.
    const slugs = new Map(operationsByTag().map((g) => [g.tag, g.slug]));
    const ops = listOperations();
    expect(ops.length).toBeGreaterThan(500); // guard the guard
    const unresolved = ops
      .filter((op) => !slugs.has(op.primaryTag))
      .map((op) => op.primaryTag);
    expect([...new Set(unresolved)].sort()).toEqual([]);
  });

  it("points every tag anchor at a section /docs/api renders", () => {
    // The index renders id={g.slug} for each group, so the crumb's target
    // exists exactly when the slug came from the same place.
    const index = readFileSync(
      join(SRC, "app/(docs)/docs/api/page.tsx"),
      "utf8",
    );
    expect(index).toContain("id={g.slug}");
  });

  it("keeps the sibling skills page linking its category crumb too", () => {
    // The inconsistency between these two pages is what surfaced the gap;
    // this fails if the working one regresses instead.
    expect(SKILL_PAGE).toMatch(/href: `\/docs\/skills#\$\{s\.category\}`/);
  });
});
