// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const WEB_ROOT = existsSync(resolve(process.cwd(), "src"))
  ? process.cwd()
  : resolve(process.cwd(), "apps/web");
const REPO_ROOT = resolve(WEB_ROOT, "../..");

const SURFACES = [
  "docs-site/pages/migration/beehiiv.mdx",
  "docs/integrations/beehiiv-migration.md",
  "docs/integrations/beehiiv.md",
  "apps/web/src/app/(docs)/docs/migrations/[source]/page.tsx",
  "apps/web/src/app/(marketing)/migrations/[from]/page.tsx",
  "apps/web/src/app/(marketing)/vs/beehiiv/page.tsx",
  "apps/web/src/app/(marketing)/migrate-anywhere/page.tsx",
  "apps/web/src/app/(marketing)/vs/page.tsx",
  "apps/web/src/app/(marketing)/page.tsx",
  "apps/web/src/lib/docs/search.server.ts",
  "apps/web/src/components/tour/tours/marketing.ts",
  "apps/web/locales/en.json",
] as const;

function readSurface(path: (typeof SURFACES)[number]): string {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

describe("Beehiiv migration copy contract", () => {
  it("removes automatic publication, automation, consent, and Stripe continuity claims", () => {
    const copy = SURFACES.map(readSurface).join("\n");

    for (const staleClaim of [
      'most "complete" of the API-based migrations',
      "you'll see a chooser",
      "Moosewave Paid Subs schema",
      "creates equivalent Stripe Products and Prices",
      "triggers a Stripe Customer migration",
      "paid subscriptions intact",
      "API import: subs, posts, automations, paid subs",
      "segments translated to Postgres DSL",
      "automations translated to a canonical AST",
      "every Beehiiv journey we’ve seen migrates intact",
      "Each maps 1:1",
      "No charge interruption",
      "Yes via Stripe Connect with 0% Moosewave take",
      "Beehiiv migration: publication subscribers tiers paid subscriptions",
      "Beehiiv, ConvertKit, ActiveCampaign, and CSV paths bring subscribers, tags, and paid Stripe subs where available",
      "Stripe Connect integration mirrors paid subs from Substack/ConvertKit/Beehiiv",
    ]) {
      expect(copy).not.toContain(staleClaim);
    }
  });

  it("keeps the dashboard wizard honest before and after the initial import", () => {
    const wizard = readFileSync(
      resolve(
        REPO_ROOT,
        "apps/web/src/app/(dashboard)/app/migrations/new/[source]/page.tsx",
      ),
      "utf8",
    );
    const preview = readFileSync(
      resolve(
        REPO_ROOT,
        "apps/web/src/app/(dashboard)/app/migrations/_dry-run-preview.tsx",
      ),
      "utf8",
    );
    const copy = `${wizard}\n${preview}`;

    for (const claim of [
      "Premium memberships (metadata)",
      "Automation rebuild inventory",
      "Stripe billing objects and continuity are not imported",
      "Initial import complete",
      "ready for cutover review",
      "Final delta, shadow check, rebuild evidence",
      "Stripe billing is not part of this import",
    ]) {
      expect(copy).toContain(claim);
    }
  });

  it("states the bounded, rebuild-first Beehiiv contract", () => {
    const copy = SURFACES.map(readSurface).join("\n").toLowerCase();

    for (const requiredClaim of [
      "workspace",
      "multiple publications",
      "no chooser",
      "cursor-paginated",
      "newsletter-list",
      "completion manifest",
      "unknown consent",
      "frozen",
      "rebuild_review",
      "never activated",
      "draft",
      "scheduled",
      "web-only",
      "stripe customers",
      "no live webhook bridge",
      "final full delta",
      "post-delta evidence",
      "missing",
      "referral",
      "poll",
      "post-template",
      "boosts",
      "recommendations",
      "ad-network",
      "live certification",
    ]) {
      expect(copy).toContain(requiredClaim);
    }
  });
});
