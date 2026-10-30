// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  mockCapability,
  mockDiscovery,
  mockVerification,
} from "../lib/migration-mocks";

const WEB_ROOT = existsSync(resolve(process.cwd(), "src"))
  ? process.cwd()
  : resolve(process.cwd(), "apps/web");
const REPO_ROOT = resolve(WEB_ROOT, "../..");

const SURFACES = [
  "docs-site/pages/migration/substack.mdx",
  "docs/integrations/substack-migration.md",
  "docs/integrations/substack.md",
  "apps/web/src/app/(docs)/docs/migrations/[source]/page.tsx",
  "apps/web/src/app/(dashboard)/app/migrations/new/[source]/connect-step.tsx",
  "apps/web/src/app/(marketing)/migrations/[from]/page.tsx",
  "apps/web/src/app/(marketing)/vs/substack/page.tsx",
  "apps/web/src/app/(marketing)/migrate-anywhere/page.tsx",
] as const;

function readSurface(path: (typeof SURFACES)[number]): string {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

describe("Substack migration contract", () => {
  it("keeps file, consent, archive, and billing claims bounded", () => {
    const copy = SURFACES.map(readSurface).join("\n");
    const lower = copy.toLowerCase();

    for (const required of [
      "official substack zip",
      "all columns",
      "unconfirmed",
      "provenance",
      "email-send evidence",
      "publication-bound",
      "apple",
      "tier metadata",
    ]) {
      expect(lower).toContain(required);
    }

    for (const staleClaim of [
      "paid subscriptions intact",
      "no charge interruption",
      "creates equivalent stripe products and prices",
      "charges keep firing on stripe, just routed through postwave",
      "signup dates are imported as consent timestamps",
    ]) {
      expect(lower).not.toContain(staleClaim);
    }
  });

  it("advertises ZIP/CSV upload and the service-aligned 200 MB limit", () => {
    const connect = readSurface(
      "apps/web/src/app/(dashboard)/app/migrations/new/[source]/connect-step.tsx",
    );
    expect(connect).toContain('accept={source === "substack" ? ".zip,.csv"');
    expect(connect).toContain("200 * 1024 * 1024");
    expect(connect).toContain(
      "live Stripe/Apple billing is a separate provider handoff",
    );
  });

  it("models membership evidence without billing runtime or inferred consent", () => {
    const capability = mockCapability("substack");
    expect(capability.supports).toMatchObject({
      subscribers: true,
      campaign_archive: true,
      reports: true,
      paid_subs: false,
      consent_timestamps: false,
    });

    const discovery = mockDiscovery("substack");
    const verification = mockVerification("substack");
    expect(discovery.paid_subs_count).toBeGreaterThan(0);
    expect(verification.paid_subs_imported).toBe(0);
    expect(verification.sample_subscribers?.[0]?.status).toBe("unconfirmed");

    const paidRuntime = discovery.resource_metadata?.find(
      (row) => row.resource === "paid_subs",
    );
    const membership = discovery.resource_metadata?.find(
      (row) => row.resource === "premium_memberships",
    );
    expect(paidRuntime).toMatchObject({ supported: false, imported: 0 });
    expect(membership).toMatchObject({
      supported: true,
      imported: discovery.paid_subs_count,
    });
  });
});
