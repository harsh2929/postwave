// SPDX-License-Identifier: AGPL-3.0-only
//
// The Privacy Policy publishes a retention schedule and the DPIA repeats it.
// Both said engagement events default to a 24-month window; the code default
// is 365 days (settings/privacy.go: defaultEngagementEventRetentionDays), so
// the published figure was double what the product actually does — a storage-
// limitation claim under GDPR Article 5(1)(e), stated in two legal documents.
//
// The "configurable down to 30 days" half was right: engagementEventMin = 30,
// matching the CHECK in migration 0238 (BETWEEN 30 AND 2555).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");
const SETTINGS = readFileSync(
  join(REPO, "apps/api/internal/settings/privacy.go"),
  "utf8",
);

function goConst(name: string): number {
  const m = new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(SETTINGS);
  if (!m) throw new Error(`constant ${name} not found`);
  return Number(m[1]);
}

const legal = (slug: string): string =>
  readFileSync(join(SRC, `app/(marketing)/legal/${slug}/page.tsx`), "utf8")
    .replace(/&rarr;/g, "→")
    .replace(/\s+/g, " ");

describe("published retention schedule", () => {
  const defaultDays = goConst("defaultEngagementEventRetentionDays");
  const minDays = goConst("engagementEventMin");

  it("reads the retention constants", () => {
    // Guard the guard: a renamed constant must fail loudly, not silently make
    // the month arithmetic below compare against zero.
    expect(defaultDays).toBeGreaterThan(0);
    expect(minDays).toBeGreaterThan(0);
  });

  it("states the engagement-event default in months that match the code", () => {
    const months = Math.round(defaultDays / 30.44);
    for (const slug of ["privacy", "dpia"]) {
      const text = legal(slug);
      const claims = [
        ...text.matchAll(/(\d+)[- ]month retention window/g),
        ...text.matchAll(/Default (\d+) months/g),
      ].map((m) => Number(m[1]));
      expect(claims.length).toBeGreaterThan(0);
      for (const claimed of claims) expect(claimed).toBe(months);
    }
  });

  it("states the configurable floor the code enforces", () => {
    for (const slug of ["privacy", "dpia"]) {
      expect(legal(slug)).toContain(`${minDays} days`);
    }
  });
});
