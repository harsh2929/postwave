// SPDX-License-Identifier: AGPL-3.0-only
//
// Two pages describe the same last-touch attribution rule. /commerce said the
// conversion joins to the subscriber's most recent email *click*; /analytics
// said the most recent campaign they *opened*. Only one can be right, and
// attribution.go settles it — the lookup filters `event_type = 'clicked'` and
// rides a partial index built on that value (migration 0397).
//
// The difference is not cosmetic: opens fire from image proxies and privacy
// preloads, so attributing on opens would credit campaigns nobody engaged
// with, and the two pages would report different revenue for the same send.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");
const ATTRIBUTION = readFileSync(
  join(REPO, "apps/api/internal/conversions/attribution.go"),
  "utf8",
);

const page = (rel: string): string =>
  readFileSync(join(SRC, `app/(marketing)/${rel}/page.tsx`), "utf8");

describe("last-touch attribution claims", () => {
  it("reads the attribution query", () => {
    // Guard the guard: a moved file would otherwise let the sweep pass on an
    // empty string and prove nothing about the signal we key on.
    expect(ATTRIBUTION).toMatch(/event_type/);
  });

  it("keys on the same engagement event the code does", () => {
    const keysOnClick = /event_type = 'clicked'/.test(ATTRIBUTION);
    const keysOnOpen = /event_type = 'opened'/.test(ATTRIBUTION);
    expect({ keysOnClick, keysOnOpen }).toEqual({
      keysOnClick: true,
      keysOnOpen: false,
    });

    // No public page may describe last-touch as keying on opens.
    const offenders: string[] = [];
    for (const rel of ["commerce", "analytics"]) {
      const text = page(rel).replace(/\s+/g, " ");
      if (/most recent[^.]{0,60}\bopened\b/i.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("quotes the same look-back window the code enforces", () => {
    const days = /lastTouchAttributionWindow\s*=\s*(\d+) \* 24 \* time\.Hour/.exec(
      ATTRIBUTION,
    );
    expect(days).not.toBeNull();
    for (const rel of ["commerce", "analytics"]) {
      expect(page(rel)).toContain(`${days![1]}-day`);
    }
  });
});
