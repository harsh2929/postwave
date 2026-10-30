// SPDX-License-Identifier: AGPL-3.0-only
//
// Two published pages make a data-residency commitment about PostHog:
//
//   /legal/sub-processors   region: "EU (eu.posthog.com). Moosewave deployment"
//   /legal/cookies          "We use PostHog (EU-hosted, eu.posthog.com)"
//
// The first is not marketing copy. Terms §8 says "The sub-processor list is
// part of the DPA", so that row is a contractual statement about where a
// named category of personal data is processed.
//
// Every default in the repo said app.posthog.com — US Cloud. Browser
// (lib/telemetry.ts), server (POSTHOG_API_HOST), and desktop
// (VITE_POSTHOG_HOST) all fell back to it, so an unset env var routed EU
// visitors' analytics to the US while both pages promised otherwise. A
// fallback is a decision, not an absence of one.
//
// What this pins is the agreement, not the value. If Moosewave genuinely moves
// to US Cloud, this test fails until the two legal pages are amended — which
// is the point: the residency claim and the code that honours it have to move
// together.
//
// Deliberately NOT covered: internal/analytics_integrations/posthog.go. That
// is the customer's own PostHog, pulled with per-tenant credentials through
// AnalyticsPullerSecretResolver. Its region is the customer's choice and has
// nothing to do with our sub-processor register — the two files look nearly
// identical and mean opposite things.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { SUBPROCESSORS } from "@/lib/legal/infrastructure";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");

/** The host the legal pages commit to, read from the sub-processor register. */
function documentedHost(): string {
  const page = readFileSync(
    join(SRC, "app/(marketing)/legal/sub-processors/page.tsx"),
    "utf8",
  );
  expect(page).toContain("SUBPROCESSORS.map");
  const row = SUBPROCESSORS.find((entry) => entry.name === "PostHog");
  expect(
    row,
    "PostHog row missing from the sub-processor register",
  ).not.toBeNull();
  const host = /\b([a-z0-9-]+\.posthog\.com)\b/.exec(row!.region);
  expect(
    host,
    `no posthog host in region string ${JSON.stringify(row!.region)}`,
  ).not.toBeNull();
  return host![1]!;
}

describe("PostHog host matches the published residency claim", () => {
  const documented = documentedHost();

  it("reads a concrete host out of the register", () => {
    // Guard the guard: a reworded region string must fail loudly rather than
    // leave every assertion below comparing against undefined.
    expect(documented).toMatch(/^[a-z0-9-]+\.posthog\.com$/);
  });

  it("says the same host on the cookie policy", () => {
    // Visitors read the cookie policy, not the DPA. The two must agree or the
    // consent we collect is against a different set of facts.
    const cookies = readFileSync(
      join(SRC, "app/(marketing)/legal/cookies/page.tsx"),
      "utf8",
    );
    const hosts = [...cookies.matchAll(/\b([a-z0-9-]+\.posthog\.com)\b/g)].map(
      (m) => m[1]!,
    );
    expect(hosts.length).toBeGreaterThan(0);
    expect([...new Set(hosts)]).toEqual([documented]);
  });

  it("names every first-party PostHog host in the repo, and they all agree", () => {
    // This assertion used to enumerate the files it checked: the browser
    // client, the Go tracker, and two env examples. Enumeration is why the
    // violation survived here. The header above lists desktop's
    // VITE_POSTHOG_HOST as one of the surfaces that fell back to US Cloud, but
    // no assertion ever read that file — and mobile did not exist in this
    // test's world at all. Four surfaces kept a US default while a test named
    // "host matches policy" passed.
    //
    // So it scans instead. A fifth client added next year is covered the day
    // it lands, which a curated list can never promise.
    const found = firstPartyHosts();

    // Guard the guard: a broken walk finds nothing and reports perfect
    // compliance. Name the surfaces that must always be in the sweep.
    const covered = found.map((f) => f.file);
    for (const required of [
      "apps/web/src/lib/telemetry.ts",
      "apps/desktop/src/lib/telemetry.ts",
      "apps/mobile/src/lib/telemetry.ts",
      "apps/api/internal/telemetry/posthog.go",
      "apps/web/.env.example",
      "apps/mobile/.env.example",
      "apps/api/.env.example",
    ]) {
      expect(
        covered,
        `${required} carries a PostHog host and must be in the sweep`,
      ).toContain(required);
    }

    const wrong = found.filter((f) => f.host !== documented);
    expect(
      wrong.map((f) => `${f.file}: ${f.host} (documented: ${documented})`),
      "a first-party PostHog host disagrees with the sub-processor register",
    ).toEqual([]);
    // A whole-source scan; a slower CI host needs more than vitest's 5 s default.
  }, 60_000);
});

/**
 * Every first-party PostHog host literal in the repo.
 *
 * "First-party" is the whole difficulty. Two files in apps/api look nearly
 * identical and mean opposite things: internal/telemetry sends OUR product
 * analytics and is bound by the register, while internal/analytics_integrations
 * pulls from the CUSTOMER's own PostHog with per-tenant credentials, where the
 * region is their choice. Excluding by path is deliberate and narrow — an
 * exclusion by pattern would eventually swallow a real violation.
 */
function firstPartyHosts(): Array<{ file: string; host: string }> {
  const EXCLUDE_DIRS = new Set([
    "node_modules",
    "dist",
    "build",
    ".turbo",
    "target",
    "vendor",
    "coverage",
    ".git",
    "ios",
    "android",
  ]);
  // Build output carries the bundled posthog-js library, whose OWN defaults are
  // app/us/i.posthog.com. Those are the vendor's constants, not our
  // configuration, and a stale build dir would otherwise fail this forever.
  const isBuildDir = (name: string) => name.startsWith(".next");
  // Customer-owned PostHog, not ours. See above.
  const EXCLUDE_FILES = new Set([
    "apps/api/internal/analytics_integrations/posthog.go",
  ]);

  const out: Array<{ file: string; host: string }> = [];

  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!EXCLUDE_DIRS.has(entry.name) && !isBuildDir(entry.name)) {
          walk(abs, relPath);
        }
        continue;
      }
      // Tests legitimately stub other hosts, and the audit-replay tests use a
      // customer's PostHog project URL as fixture data.
      if (/\.(test|spec)\.[cm]?[tj]sx?$/.test(entry.name)) continue;
      if (entry.name.endsWith("_test.go")) continue;
      if (EXCLUDE_FILES.has(relPath)) continue;
      // Only the committed EXAMPLES are ours to assert on. A developer's real
      // .env is their machine's business, and rewriting it from a test suite
      // would be a surprising side effect.
      if (entry.name.startsWith(".env") && !entry.name.endsWith(".example")) {
        continue;
      }
      if (
        !/\.(ts|tsx|js|mjs|go|example|md)$/.test(entry.name) &&
        !entry.name.startsWith(".env")
      ) {
        continue;
      }

      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      // Skip this file itself — it quotes both hosts while explaining them.
      if (text.includes("names every first-party PostHog host in the repo")) {
        continue;
      }
      for (const m of text.matchAll(/\b([a-z0-9-]+\.posthog\.com)\b/g)) {
        out.push({ file: relPath, host: m[1]! });
      }
    }
  };

  for (const root of ["apps", "packages", "services"]) {
    walk(join(REPO, root), root);
  }
  for (const envFile of [".env.local.example", ".env.example"]) {
    try {
      const text = readFileSync(join(REPO, envFile), "utf8");
      for (const m of text.matchAll(/\b([a-z0-9-]+\.posthog\.com)\b/g)) {
        out.push({ file: envFile, host: m[1]! });
      }
    } catch {
      /* not every checkout carries both */
    }
  }
  return out;
}
