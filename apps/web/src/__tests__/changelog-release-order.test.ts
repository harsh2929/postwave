// SPDX-License-Identifier: AGPL-3.0-only
//
// Two things about the changelog were never checked.
//
// 1. Five entries carried `planned: true` — v0.2.0, v0.1.0-beta, v0.0.3,
//    v0.0.2, v0.0.1 — while v0.0.4 (2026-04-30), v0.2.1 (2026-05-11), v0.3.0,
//    v0.3.1 and v0.4.0 were listed as shipped. The page therefore told readers
//    that the predecessors of shipped releases had not happened yet, and it
//    contradicted the rest of the site: v0.2.0 is where the MCP server and CLI
//    landed, and /mcp publishes `npm i -g @postwave/cli` as a copy-paste
//    install. A release cannot be pending once a later one has shipped.
//
// 2. /changelog.xml is a second, hand-maintained copy of the same releases in
//    a separate route file, with nothing tying it to the page. Add a release
//    to one and the feed silently stops matching the site.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const PAGE = readFileSync(
  join(SRC, "app/(marketing)/changelog/page.tsx"),
  "utf8",
);
const FEED = readFileSync(join(SRC, "app/changelog.xml/route.ts"), "utf8");

interface Release {
  version: string;
  date: string | null;
  planned: boolean;
}

function releases(): Release[] {
  const block = /const ENTRIES: Entry\[\] = \[([\s\S]*?)\n\];/.exec(PAGE);
  if (!block) return [];
  return block[1]!
    .split(/\n  \{/)
    .filter((chunk) => /version:/.test(chunk))
    .map((chunk) => ({
      version: /version:\s*"([^"]+)"/.exec(chunk)![1]!,
      date: /date:\s*"([^"]+)"/.exec(chunk)?.[1] ?? null,
      planned: /planned:\s*true/.test(chunk),
    }));
}

/** "v0.1.0-beta" sorts below "v0.1.0"; a pre-release precedes its release. */
function order(version: string): number[] {
  const [core, pre] = version.replace(/^v/, "").split("-");
  const parts = core!.split(".").map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, pre ? 0 : 1];
}

function isAfter(a: string, b: string): boolean {
  const [x, y] = [order(a), order(b)];
  for (let i = 0; i < x.length; i++) {
    if (x[i]! !== y[i]!) return x[i]! > y[i]!;
  }
  return false;
}

describe("changelog release status", () => {
  const all = releases();

  it("parses the entries", () => {
    // Guard the guard: a restructured ENTRIES array must fail loudly rather
    // than leave every sweep below iterating nothing.
    expect(all.length).toBeGreaterThan(8);
    expect(all.filter((r) => r.date).length).toBeGreaterThan(3);
    expect(isAfter("v0.2.1", "v0.2.0")).toBe(true);
    expect(isAfter("v0.1.0-beta", "v0.1.0")).toBe(false);
    expect(isAfter("v0.1.0", "v0.1.0-beta")).toBe(true);
  });

  it("never marks a release planned once a later one has shipped", () => {
    const shipped = all.filter((r) => !r.planned && r.date);
    const impossible = all
      .filter((r) => r.planned)
      .flatMap((pending) =>
        shipped
          .filter((s) => isAfter(s.version, pending.version))
          .map(
            (s) =>
              `${pending.version} is planned but ${s.version} shipped ${s.date}`,
          ),
      );
    expect(impossible.sort()).toEqual([]);
  });

  it("dates every release it calls shipped, or says the date is unknown", () => {
    // An undated entry may render, but not as "Roadmap" while wearing a
    // Shipped badge — the list component picks its fallback off `planned`.
    const list = readFileSync(
      join(SRC, "components/marketing/changelog-list.tsx"),
      "utf8",
    );
    expect(list).toMatch(/entry\.date \?\? \(entry\.planned \?/);
  });

  it("does not promise in the header what the entries do not deliver", () => {
    // The page led with "Shipped releases are dated. Future work is marked as
    // roadmap." That was true when five entries still carried planned:true.
    // Clearing those bogus flags was correct — a release cannot be pending
    // once its successor shipped — but it left half the list dated, half not,
    // and nothing marked roadmap, so the header described a partition the page
    // no longer has. A reader hitting an undated entry can only conclude it
    // has not shipped.
    const page = readFileSync(
      join(SRC, "app/(marketing)/changelog/page.tsx"),
      "utf8",
    ).replace(/\s+/g, " ");
    const undated = all.filter((r) => !r.date);
    if (undated.length > 0) {
      expect(
        page,
        `${undated.length} undated entries, but the header still claims shipped releases are dated`,
      ).not.toMatch(/Shipped releases are dated/);
      // It has to say something about why they are bare instead.
      expect(page).toMatch(
        /Entries record dated or versioned source milestones/,
      );
      expect(page).toMatch(/Artifact identities are stated where/);
    }
    // `planned` is no longer set on any entry; a header promising a roadmap
    // marking would be describing a badge nothing can render.
    expect(all.filter((r) => r.planned)).toEqual([]);
    expect(page).not.toMatch(/marked as roadmap/);
  });

  it("keeps the Atom feed in step with the dated releases", () => {
    const feedIds = [...FEED.matchAll(/^\s*id:\s*"([^"]+)",/gm)].map(
      (m) => m[1]!,
    );
    const feedDates = new Map(
      [...FEED.matchAll(/id:\s*"([^"]+)",[\s\S]*?updated:\s*"(\d{4}-\d{2}-\d{2})/g)].map(
        (m) => [m[1]!, m[2]!],
      ),
    );
    expect(feedIds.length).toBeGreaterThan(3); // guard the guard

    const dated = all.filter((r) => r.date && !r.planned);
    expect([...feedIds].sort()).toEqual(dated.map((r) => r.version).sort());

    const drift = dated
      .filter((r) => feedDates.get(r.version) !== r.date)
      .map((r) => `${r.version}: page ${r.date}, feed ${feedDates.get(r.version)}`);
    expect(drift.sort()).toEqual([]);
  });
});
