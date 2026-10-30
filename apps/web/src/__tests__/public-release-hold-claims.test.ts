// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");

function page(relativePath: string): string {
  const source = readFileSync(resolve(SRC, relativePath), "utf8");
  expect(source.length).toBeGreaterThan(1_000);
  return source;
}

const deliverability = page("app/(marketing)/deliverability/page.tsx");
const automations = page("app/(marketing)/automations/page.tsx");
const features = page("app/(marketing)/features/page.tsx");
const audiences = page("app/(marketing)/audiences/page.tsx");
const home = page("app/(marketing)/page.tsx");
const migrations = page("app/(marketing)/migrations/[from]/page.tsx");
const comparisons = [
  "substack",
  "convertkit",
  "mailchimp",
  "mailerlite",
  "sendy",
].map((slug) => page(`app/(marketing)/vs/${slug}/page.tsx`));

describe("public release-hold claims", () => {
  it("separates deliverability evidence and recommendations from held operations", () => {
    expect(deliverability).toContain(
      "Campaign scheduling and every per-recipient or timezone-based dispatch strategy remain release-held",
    );
    expect(deliverability).toContain(
      "Continuous RUA IMAP ingestion is release-held",
    );
    expect(deliverability).toContain(
      "Customer-host registration, on-demand DNS re-check, verification-state mutation, removal, automated TLS, and production routing are unavailable",
    );
    expect(deliverability).toContain(
      "does not claim universal enforcement across every channel, message type, or dispatch path",
    );

    for (const unavailableClaim of [
      "each subscriber fires at their own best hour",
      "IMAP poller ingests RUA reports",
      "Verification rechecks DNS on demand",
      "run-now endpoint when you can't wait",
      "limit how often anyone gets mailed",
    ]) {
      expect(deliverability).not.toContain(unavailableClaim);
    }
  });

  it("keeps automation, tag, archive-comment, and dedicated-IP operations held", () => {
    expect(automations).toContain(
      "timezone-by-timezone release and recipient delivery are unavailable",
    );
    expect(audiences).toContain(
      "Account-wide tag rename and merge mutations are release-held",
    );
    expect(features).toContain(
      "managed provisioning and assignment are release-held",
    );
    expect(features).toContain(
      "Reader comments and an LLM-backed remix service are not available",
    );

    expect(audiences).not.toContain("merge and rename across every subscriber");
    expect(features).not.toContain("Dedicated IP option on Pro Sending");
    expect(features).not.toContain("with reader comments");
    expect(comparisons[0]).not.toContain("dedicated IP ($40/month)");
  });

  it("presents paid relationships as history or provider-bound evidence", () => {
    expect(home).toContain("paid-subscription history");
    expect(home).toContain(
      "Checkout, billing mutation, and subscription management are unavailable",
    );
    expect(migrations).toContain(
      "provider-bound paid-relationship evidence for review",
    );
    expect(migrations).toContain(
      "Plan and verify billing continuity separately",
    );

    const paidComparisons = comparisons.slice(1).join("\n");
    expect(paidComparisons).toContain(
      "subscription creation or management are unavailable",
    );
    for (const unavailableClaim of [
      "migrate paid subscriptions intact",
      "paid relationships intact",
      "routes paid subscriptions through",
      "runs paid subs through",
      "supports paid subs natively",
      "Paid relationships migrate via Stripe Connect",
      "Paid subscriptions mapped to your Stripe customer records",
    ]) {
      expect(`${paidComparisons}\n${migrations}`).not.toContain(
        unavailableClaim,
      );
    }
  });

  it("does not call held Sendy comparison flows an execution runtime", () => {
    const sendy = comparisons.at(-1) ?? "";
    expect(sendy).toMatch(
      /activation, enrollment, scheduling, execution, and\s+delivery are release-held/u,
    );
    expect(sendy).not.toContain("typed AST + runtime");
    expect(sendy).not.toContain("real lifecycle automations");
  });
});
