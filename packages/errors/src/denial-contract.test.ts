// The denial vocabulary is written down twice and nothing checked the copies
// agree.
//
//   1. apps/api/internal/entitlement/denial.go — `Reason`, the closed set the
//      server may put on the wire, plus the two named remedy constants and the
//      reason→status mapping.
//   2. this package — `DENIAL_REASONS`, `REMEDY_*`, and `denialRetryable`,
//      which every client (web, desktop, mobile) reads to choose an affordance.
//
// Drift here is SILENT and one-directional. `parseDenial` drops a reason
// outside the closed set on purpose, so adding `ReasonRegion` to the Go
// constant block would leave all three clients seeing `denial: undefined` and
// falling back to bare-status handling — the exact "flattened into one
// sentence" failure the vocabulary exists to prevent. Nothing goes red; users
// just quietly stop being told why. The same is true of the remedy strings:
// `denialGuidance` branches on their literal values, so a rename on the Go side
// turns actionable guidance back into unexplained prose.
//
// Read from the Go source rather than a hand-kept list, because a hand-kept
// list is the thing that drifts.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DENIAL_REASONS,
  REMEDY_CONTACT_WORKSPACE_ADMIN,
  REMEDY_UPGRADE_PLAN,
  denialRetryable,
  type DenialReason,
} from "./index.js";

const REPO = resolve(process.cwd(), "../..");
const DENIAL_GO = readFileSync(
  join(REPO, "apps/api/internal/entitlement/denial.go"),
  "utf8",
);

/**
 * The reason values from the `const (…)` block that declares them.
 *
 * Throws on an empty read rather than returning `[]`. A guard that reads
 * nothing and compares nothing passes, which is the one outcome worse than the
 * drift it exists to catch — and this reader got that wrong on its first run.
 */
function goReasons(): string[] {
  const block = /const \(\n([\s\S]*?)\n\)/.exec(DENIAL_GO);
  if (!block?.[1]) throw new Error("Reason const block not found in denial.go");
  const found = [
    ...block[1].matchAll(/\bReason[A-Za-z]+\s+Reason\s*=\s*"([a-z_]+)"/g),
  ].map((m) => m[1]!);
  if (found.length === 0) {
    throw new Error("no Reason constants parsed out of denial.go");
  }
  return found;
}

/** A named remedy constant's value, e.g. `RemedyUpgradePlan`. */
function goRemedy(name: string): string {
  const m = new RegExp(`const ${name} = "([a-z_]+)"`).exec(DENIAL_GO);
  if (!m?.[1]) throw new Error(`${name} not found in denial.go`);
  return m[1];
}

/**
 * The reason→status arms of `httpStatus()`, as `{reason: statusConst}`.
 *
 * The `default` arm (role, flag and policy → 403) is deliberately not modelled:
 * it is an else, and asserting a mapping this file did not read would be
 * inventing the contract rather than checking it.
 */
function goExplicitStatuses(): Record<string, string> {
  const body = /func \(r Reason\) httpStatus\(\) int \{([\s\S]*?)\n\}/.exec(
    DENIAL_GO,
  );
  if (!body?.[1]) throw new Error("httpStatus() not found in denial.go");
  const out: Record<string, string> = {};
  for (const m of body[1].matchAll(
    /case Reason([A-Za-z]+):\s*\n\s*return (http\.Status[A-Za-z]+)/g,
  )) {
    out[m[1]!.toLowerCase()] = m[2]!;
  }
  return out;
}

describe("denial vocabulary matches apps/api/internal/entitlement", () => {
  it("mirrors the server's closed reason set exactly", () => {
    // Sorted, because declaration order is not part of the contract but
    // membership is. An extra value on either side is a client that cannot
    // classify a refusal the server is already sending.
    expect([...DENIAL_REASONS].sort()).toEqual(goReasons().sort());
  });

  it("mirrors the remedy strings denialGuidance branches on", () => {
    expect(REMEDY_UPGRADE_PLAN).toBe(goRemedy("RemedyUpgradePlan"));
    expect(REMEDY_CONTACT_WORKSPACE_ADMIN).toBe(
      goRemedy("RemedyContactWorkspaceAdmin"),
    );
  });

  it("agrees with the server about which refusals may work later", () => {
    // `denialRetryable` claims to be derived from the server's status mapping,
    // so it is checked against that mapping instead of a second opinion:
    // 429/503 are retry-later statuses, 402 is not, and the unlisted reasons
    // fall to the 403 default which is not either.
    const RETRY_LATER = new Set([
      "http.StatusTooManyRequests",
      "http.StatusServiceUnavailable",
    ]);
    const statuses = goExplicitStatuses();
    expect(Object.keys(statuses).length).toBeGreaterThan(0);
    for (const reason of DENIAL_REASONS) {
      const status = statuses[reason];
      const serverSaysLater = status !== undefined && RETRY_LATER.has(status);
      expect({ reason, retryable: denialRetryable({ reason }) }).toEqual({
        reason,
        retryable: serverSaysLater,
      });
    }
  });

  it("keeps the TS type in step with the parsed values", () => {
    // A compile-time assertion that every string the Go file declares is
    // assignable to DenialReason — the runtime check above cannot catch a type
    // that has widened to `string`.
    const reasons = goReasons();
    expect(reasons.length).toBe(DENIAL_REASONS.length);
    for (const reason of reasons) {
      const typed: DenialReason = reason as DenialReason;
      expect(DENIAL_REASONS).toContain(typed);
    }
  });
});
