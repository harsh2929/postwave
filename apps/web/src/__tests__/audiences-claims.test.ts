// SPDX-License-Identifier: AGPL-3.0-only
//
// /audiences told readers they could attach an alias of kind "email" or
// "phone". The UpsertSubscriberAliasInput schema excludes both, and its own
// description says why:
//
//   "Email and phone are intentionally absent: those destinations require
//    their verified contact-method workflows so alias management cannot
//    bypass consent."
//
// So the page did not just name two types that get rejected — it advertised
// alias management as a way to attach a sending destination, which is exactly
// the bypass the API is built to refuse. That is the kind of copy that reads
// as a feature and lands as a compliance incident.
//
// Active referral mutation, link, widget, attribution, reward, and payout
// surfaces are compile-time held. Published copy must not turn dormant
// constants into an operational promise.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");
const PAGE = readFileSync(
  join(SRC, "app/(marketing)/audiences/page.tsx"),
  "utf8",
);

function go(rel: string): string {
  return readFileSync(join(REPO, rel), "utf8");
}

interface Spec {
  components: {
    schemas: Record<string, { properties?: Record<string, { enum?: string[] }> }>;
  };
}

function aliasKinds(): string[] {
  const spec = JSON.parse(
    readFileSync(join(REPO, "packages/openapi/openapi.json"), "utf8"),
  ) as Spec;
  return (
    spec.components.schemas.UpsertSubscriberAliasInput?.properties?.alias_type
      ?.enum ?? []
  );
}

describe("/audiences claims", () => {
  it("reads the page and the schema", () => {
    // Guard the guard: an empty enum would make the exclusion check vacuous.
    expect(PAGE.length).toBeGreaterThan(5_000);
    expect(aliasKinds().length).toBeGreaterThan(3);
  });

  it("names only alias types the API accepts", () => {
    const accepted = new Set(aliasKinds());
    const sentence = /You attach[^"]*?custom kind\./.exec(PAGE)?.[0] ?? "";
    expect(sentence).not.toBe("");
    const named = [...sentence.matchAll(/\b([a-z]+_[a-z]+|custom)\b/g)].map(
      (m) => m[1]!,
    );
    expect(named.length).toBeGreaterThan(2);
    expect(named.filter((k) => !accepted.has(k)).sort()).toEqual([]);
  });

  it("does not offer email or phone as alias types", () => {
    // The specific bypass. Asserted separately from the enum check so the
    // reason survives even if the schema gains a kind later.
    const accepted = new Set(aliasKinds());
    expect(accepted.has("email")).toBe(false);
    expect(accepted.has("phone")).toBe(false);
    const sentence = /You attach[^"]*?custom kind\./.exec(PAGE)?.[0] ?? "";
    expect(sentence).not.toMatch(/\bemail,|\bphone,/);
  });

  it("quotes the real audience-sync limits", () => {
    const runner = go(
      "apps/api/internal/audience_destinations/sync_runner.go",
    );
    const maxRows = /SyncMaxRows = ([\d_]+)/.exec(runner)![1]!.replace(/_/g, "");
    const batch = /SyncBatchSize = (\d+)/.exec(runner)![1]!;
    expect(PAGE).toContain(`${Number(maxRows).toLocaleString("en-US")} members`);
    expect(PAGE).toContain(`batches of ${batch}`);
  });

  it("presents referral data as historical while operations are held", () => {
    const referrals = go("apps/api/internal/referrals/referrals.go");
    expect(referrals).toContain("const OperationalRuntimeAvailable = false");
    expect(PAGE).toContain("historical program, conversion-summary, and leaderboard reads");
    expect(PAGE).toContain("Referral attribution and rewards remain release-held");
    for (const unavailableClaim of [
      "Every subscriber is auto-minted",
      "personal share URL",
      "milestones they've unlocked",
      "The loop runs",
      "Click-through attribution is held in a 30-day cookie",
      "run a referral program",
    ]) {
      expect(PAGE).not.toContain(unavailableClaim);
    }
  });

  it("quotes the real batch-upsert cap", () => {
    const batch = go("apps/api/internal/mcp/batch_tools.go");
    const cap = /maxBatchItems = (\d+)/.exec(batch)![1]!;
    expect(PAGE).toContain(`up to ${cap} aliases`);
  });
});
