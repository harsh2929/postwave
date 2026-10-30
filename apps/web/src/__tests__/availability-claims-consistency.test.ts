// SPDX-License-Identifier: AGPL-3.0-only
//
// Terms section 9 publishes three per-tier availability targets with service
// credits: Studio 99.5% best-effort, Cloud Sending 99.5% with a 10% credit
// below 99.0%, Pro Sending 99.9% with 25%/50% credits. Those are binding once
// an order incorporates the Terms.
//
// Meanwhile /security said Moosewave "does not currently publish a generally
// applicable uptime SLA", and /roadmap listed "availability targets" among the
// things that "will appear publicly only after" audit evidence exists. A
// prospective customer reading either page would conclude no SLA exists, then
// find three in the contract they are asked to sign.
//
// The resolution taken was the conservative one: the two prose pages now point
// at what Terms already publishes, and keep their real caveat — no measured
// uptime history in a qualified environment. No commitment was added or
// removed; only the denial of an existing one.
//
// This guards the direction that matters. If Terms ever gains, loses, or
// changes a target, the pages that describe the SLA landscape have to move
// with it.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");

function page(rel: string): string {
  return readFileSync(join(SRC, `app/(marketing)/${rel}/page.tsx`), "utf8");
}

const TERMS = page("legal/terms");
const SECURITY = page("security");
const ROADMAP = page("roadmap");

/** Availability percentages Terms commits to, e.g. "99.5", "99.9". */
function publishedTargets(): string[] {
  const section = /9\. Service availability and SLA([\s\S]*?)<h2>/.exec(TERMS);
  expect(section).not.toBeNull();
  return [
    ...new Set(
      // \d+ after the dot, not exactly one: a 99.99% tier would otherwise be
      // invisible to this parser, and the pages could silently omit it.
      [
        ...section![1]!.matchAll(/(\d{2}(?:\.\d+)?)%\s+monthly availability/g),
      ].map((m) => m[1]!),
    ),
  ].sort();
}

describe("availability claims are consistent across pages", () => {
  const targets = publishedTargets();

  it("finds the targets Terms publishes", () => {
    // Guard the guard: an empty parse would make the contradiction check
    // vacuous, which is exactly how this went unnoticed.
    expect(targets.length).toBeGreaterThan(1);
    expect(targets).toContain("99.5");
  });

  it("does not let /security deny a published SLA", () => {
    expect(SECURITY).not.toMatch(
      /does not currently publish a generally applicable uptime SLA/,
    );
    // …and it names the real ones.
    for (const target of targets) expect(SECURITY).toContain(`${target}%`);
  });

  it("does not let /roadmap defer targets that already exist", () => {
    // The original listed "availability targets" among things that appear
    // only after audit evidence. They appear today, in the Terms.
    const deferred =
      /will appear publicly only after([\s\S]{0,200}?)exist\./.exec(
        ROADMAP,
      )?.[0] ?? "";
    expect(deferred).not.toBe("");
    expect(deferred).not.toMatch(/availability targets/);
  });

  it("keeps the caveat that actually still holds", () => {
    // The honest part of the original claim: targets exist, measured uptime
    // history against them does not.
    for (const text of [SECURITY, ROADMAP]) {
      expect(text).toMatch(/qualified environment/);
    }
    expect(SECURITY).toMatch(/no uptime history has been measured/);
  });

  it("still publishes no recovery objective", () => {
    // Unchanged and still true — Terms commits to availability, not RPO/RTO.
    expect(SECURITY).toMatch(/no recovery point objective/);
    expect(TERMS).not.toMatch(/recovery point objective/i);
  });
});
