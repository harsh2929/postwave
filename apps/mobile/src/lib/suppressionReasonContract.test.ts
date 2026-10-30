import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FILTER_REASON_ALIASES as DESKTOP_ALIASES,
  type SuppressionFilter as DesktopFilter,
} from "../../../desktop/src/components/suppressions/suppression-search";
import {
  FILTER_REASON_ALIASES,
  SUPPRESSION_FILTERS,
  reasonMatchesFilter,
  type SuppressionFilter,
} from "./suppressionSearch";

/**
 * THE SUPPRESSION-REASON CONTRACT (DELIVERABILITY#41).
 *
 * Two clients each carried their own copy of "what a suppression reason
 * MEANS": `apps/mobile/src/lib/suppressionSearch.ts` and
 * `apps/desktop/src/components/suppressions/suppression-search.ts`. Neither is
 * the authority — the SERVER is. `reason` is written through
 * `suppressions.NormalizeReason` (apps/api/internal/suppressions/channel.go)
 * and constrained on the way into Postgres by the CHECK that
 * `suppressions.ValidReasons` (store.go) mirrors. Every value a client can
 * ever see in that field is in that map.
 *
 * A shared npm package was the obvious fix and is the wrong one here: mobile
 * resolves workspace packages through `apps/mobile/package.json` plus a Metro
 * `watchFolders` entry, and a resolver change that type-checks but does not
 * BUNDLE is a red-screen regression that none of this repo's runnable gates
 * would catch. So instead of moving the vocabulary to a third copy, this test
 * anchors both existing copies to the Go source that defines it:
 *
 *   R1 EVERY canonical reason lands in exactly ONE chip. A reason in no chip
 *      is a row that only "All" can ever show — which is how `spam_trap` went
 *      missing on mobile in the first place. A reason in two chips is a row
 *      that appears under two mutually-exclusive filters.
 *   R2 THE TWO CLIENTS AGREE, reason by reason. This is the drift the finding
 *      names, and it had already happened: mobile's `hard_bounce` bucket
 *      accepted three spellings, desktop's accepted one.
 *   R3 NEITHER CLIENT INVENTS A REASON the server cannot produce (beyond an
 *      explicitly-listed set of legacy free-form values).
 *
 * Adding a reason to the Go enum now fails this test until both clients learn
 * it. That is the property a shared module would have bought, obtained without
 * a bundler change nothing here can verify.
 */

const apiRoot = join(process.cwd(), "..", "..", "apps", "api");
const suppressionsGo = join(apiRoot, "internal", "suppressions");

function readGo(file: string): string {
  return readFileSync(join(suppressionsGo, file), "utf8");
}

/** `ReasonHardBounce Reason = "hard_bounce"` → constant name → wire value. */
function reasonConstants(): Map<string, string> {
  const out = new Map<string, string>();
  const pattern = /\b(Reason[A-Za-z]+)\s+Reason\s*=\s*"([a-z0-9_]+)"/gu;
  for (const source of [readGo("store.go"), readGo("channel.go")]) {
    for (const match of source.matchAll(pattern)) {
      const [, name, value] = match;
      if (name && value) out.set(name, value);
    }
  }
  return out;
}

/** The CHECK-mirroring map: every reason a row may legally carry. */
function canonicalReasons(): string[] {
  const source = readGo("store.go");
  const block = /var ValidReasons = map\[Reason\]bool\{([\s\S]*?)\n\}/u.exec(
    source,
  );
  if (!block?.[1]) throw new Error("ValidReasons block not found in store.go");
  const constants = reasonConstants();
  const values: string[] = [];
  for (const match of block[1].matchAll(/\b(Reason[A-Za-z]+)\s*:\s*true/gu)) {
    const name = match[1];
    if (!name) continue;
    const value = constants.get(name);
    if (!value) throw new Error(`no string literal for Go constant ${name}`);
    values.push(value);
  }
  return values;
}

/**
 * Legacy free-form values the pre-X1 `email_suppressions` table stores. The
 * converger serves those rows through the unified view, so a client that only
 * knew the enum would bucket them nowhere. They are listed rather than
 * pattern-matched so that adding one is a deliberate act.
 */
const LEGACY_WIRE_REASONS = [
  "bounce",
  "hardbounce",
  "manual",
  "unsubscribe",
  "unsubscribed",
  "admin",
  "blocklisted",
  "spam_trap",
];

const CHIPS = SUPPRESSION_FILTERS.map((f) => f.key).filter(
  (key): key is Exclude<SuppressionFilter, "all"> => key !== "all",
);

function chipsMatching(
  aliases: Readonly<Record<string, readonly string[]>>,
  reason: string,
): string[] {
  return Object.entries(aliases)
    .filter(([, values]) => values.includes(reason))
    .map(([chip]) => chip);
}

describe("the Go source this contract is anchored to", () => {
  it("parses a plausible taxonomy — a silently-empty read would pass everything", () => {
    const reasons = canonicalReasons();
    expect(reasons.length).toBeGreaterThanOrEqual(15);
    // Spot-check both generations of the enum so a regex that matched only
    // the original six would fail loudly rather than shrink the contract.
    expect(reasons).toContain("hard_bounce");
    expect(reasons).toContain("spam_complaint");
    expect(reasons).toContain("spamtrap");
    expect(reasons).toContain("list_unsub_header");
    expect(new Set(reasons).size).toBe(reasons.length);
  });
});

describe("R1 — every canonical reason lands in exactly one chip", () => {
  it("leaves no reason reachable only through All", () => {
    const unbucketed = canonicalReasons().filter(
      (reason) => chipsMatching(FILTER_REASON_ALIASES, reason).length === 0,
    );
    expect(
      unbucketed,
      `these server reasons match no filter chip on mobile: ${unbucketed.join(", ")}`,
    ).toEqual([]);
  });

  it("never files one reason under two mutually exclusive chips", () => {
    const doubled = canonicalReasons()
      .map((reason) => ({
        reason,
        chips: chipsMatching(FILTER_REASON_ALIASES, reason),
      }))
      .filter((row) => row.chips.length > 1);
    expect(doubled, JSON.stringify(doubled)).toEqual([]);
  });

  it("buckets the legacy free-form values the converger still serves", () => {
    const unbucketed = LEGACY_WIRE_REASONS.filter(
      (reason) => chipsMatching(FILTER_REASON_ALIASES, reason).length === 0,
    );
    expect(unbucketed, unbucketed.join(", ")).toEqual([]);
  });
});

describe("R2 — mobile and desktop bucket every reason identically", () => {
  it("agrees on the chip for each canonical and legacy reason", () => {
    const disagreements: string[] = [];
    for (const reason of [...canonicalReasons(), ...LEGACY_WIRE_REASONS]) {
      const mine = chipsMatching(FILTER_REASON_ALIASES, reason).sort();
      const theirs = chipsMatching(DESKTOP_ALIASES, reason).sort();
      if (mine.join("|") !== theirs.join("|")) {
        disagreements.push(
          `${reason}: mobile=[${mine.join(",")}] desktop=[${theirs.join(",")}]`,
        );
      }
    }
    expect(disagreements, disagreements.join("\n")).toEqual([]);
  });

  it("offers the same chip vocabulary on both clients", () => {
    // A chip that exists on one client only is drift the reason-by-reason
    // comparison above cannot see (its alias list is simply never consulted).
    const mineChips = [...CHIPS].sort();
    const theirChips = (Object.keys(DESKTOP_ALIASES) as DesktopFilter[])
      .map(String)
      .sort();
    expect(mineChips).toEqual(theirChips);
  });
});

describe("R3 — neither client invents a reason the server cannot emit", () => {
  it("keeps every mobile alias inside the server's vocabulary", () => {
    const known = new Set([...canonicalReasons(), ...LEGACY_WIRE_REASONS]);
    const invented = Object.entries(FILTER_REASON_ALIASES).flatMap(
      ([chip, aliases]) =>
        aliases.filter((a) => !known.has(a)).map((a) => `${chip}:${a}`),
    );
    expect(invented, invented.join(", ")).toEqual([]);
  });

  it("still matches through the public predicate, not just the table", () => {
    // The table is the data; `reasonMatchesFilter` is what the screen calls.
    // Pinning both stops a future normalisation change (trimming, casing)
    // from making the two disagree.
    for (const reason of canonicalReasons()) {
      const chip = chipsMatching(FILTER_REASON_ALIASES, reason)[0] as
        | SuppressionFilter
        | undefined;
      expect(chip, reason).toBeDefined();
      expect(reasonMatchesFilter(reason, chip!), reason).toBe(true);
      expect(reasonMatchesFilter(reason.toUpperCase(), chip!), reason).toBe(
        true,
      );
    }
  });
});
