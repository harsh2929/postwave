// SPDX-License-Identifier: AGPL-3.0-only
//
// /deliverability is the most technically specific marketing page we publish:
// an exact DNS record name, an exact cache TTL, an exact hour-of-week range.
// Every one of them checked out against the Go source when read — which is
// precisely why they are worth pinning. Specific numbers age badly, and these
// are the ones a reader would act on: publishing the wrong TXT record name
// leaves a domain unverifiable, and a wrong cache window makes a stale
// diagnosis look like a bug in the product.
//
// Seedlist composition is deliberately not asserted here. ActiveSeedCount is
// runtime deployment state; the separate seedlist-claims guard prohibits a
// fixed public fleet size or provider split.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");
const PAGE = readFileSync(
  join(SRC, "app/(marketing)/deliverability/page.tsx"),
  "utf8",
);

function go(rel: string): string {
  return readFileSync(join(REPO, rel), "utf8");
}

describe("deliverability page claims", () => {
  it("reads the page", () => {
    // Guard the guard: a restructured page would make every check vacuous.
    expect(PAGE.length).toBeGreaterThan(5_000);
    expect(PAGE).toMatch(/Diagnostician/);
  });

  it("keeps custom-host activation held instead of giving publishable DNS instructions", () => {
    expect(PAGE).toContain("custom-host registry is currently read-only");
    expect(PAGE).toContain(
      "registration, DNS re-check, removal, automated TLS, and production routing are release-held",
    );
    expect(PAGE).toContain(
      "retain expected CNAME and TXT verification evidence for review",
    );
    expect(PAGE).toContain(
      "does not provision a form, redirect, archive, or tracking hostname",
    );
  });

  it("quotes the diagnosis cache window the service uses", () => {
    // A stale diagnosis served past the advertised window reads as a bug in
    // the Diagnostician rather than a cache hit.
    const source = go(
      "services/deliverability/internal/diagnostician/diagnostician.go",
    );
    const ttl = /TTL:\s+(\d+)\s+\*\s+time\.Hour/.exec(source);
    expect(ttl).not.toBeNull();
    expect(PAGE).toContain(`cached for ${ttl![1]} hours`);
  });

  it("describes the cache key the service actually uses", () => {
    // "by fingerprint" — Diagnose keys on fingerprint(sig, contentFingerprint).
    const source = go(
      "services/deliverability/internal/diagnostician/diagnostician.go",
    );
    expect(source).toMatch(/key := fingerprint\(sig, contentFingerprint\)/);
    expect(PAGE).toMatch(/by fingerprint/);
  });

  it("states the hour-of-week range send-time optimisation computes", () => {
    // per_recipient_tz.go rejects anything outside 0..167.
    const source = go("apps/api/internal/send_time_opt/per_recipient_tz.go");
    const bound = /target < 0 \|\| target > (\d+)/.exec(source);
    expect(bound).not.toBeNull();
    expect(PAGE).toContain(`0–${bound![1]}`);
  });

  it("promises one retry, matching the validator's single re-ask", () => {
    const source = go(
      "services/deliverability/internal/diagnostician/diagnostician.go",
    );
    expect(source).toMatch(/retries once/);
    expect(PAGE).toMatch(/a single targeted retry/);
  });
});
