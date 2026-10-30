// SPDX-License-Identifier: AGPL-3.0-only
//
// /forms described form variants as carrying "trigger (load, scroll,
// exit-intent, or time-on-page), and position (modal, inline, or slide-in)".
//
// Three problems in one clause. `slide-in` exists nowhere in the repository —
// a reader hunting for that position will never find it. Three of the other
// names were approximations of real values (`page-load`, `scroll-50`,
// `time-delay`, `popup`). And the whole clause was attached to the wrong
// feature: a Variant carries a label plus a free-form displayConfig, while
// trigger and mode are options on the *embed*, in EmbedOptions.
//
// The public hosted-render and submission paths do not call the variant picker,
// attribution counters, bandit, or promotion runtime. The marketing boundary
// therefore describes variant records as planning-only rather than turning
// dormant implementation into an availability claim.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");
const PAGE = readFileSync(join(SRC, "app/(marketing)/forms/page.tsx"), "utf8");
const HELPERS = readFileSync(join(SRC, "lib/embed-snippet-helpers.ts"), "utf8");
const PANEL = readFileSync(
  join(SRC, "components/forms/embed-snippet.tsx"),
  "utf8",
);

/**
 * Trigger identifier → the label the dashboard shows for it.
 *
 * Published copy should mirror what a user sees in the product, not the
 * internal identifier: the union member is `scroll-50` but the dropdown reads
 * "After 50% scroll", and the marketing page reasonably says "50% scroll".
 * Matching on the raw identifier would have forced the copy to name an
 * internal token.
 */
function triggerLabels(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of PANEL.matchAll(
    /<option value="([a-z0-9-]+)">([^<]+)<\/option>/g,
  )) {
    out.set(m[1]!, m[2]!);
  }
  return out;
}

/** Members of a string-union type in the helpers module. */
function union(name: string): string[] {
  const block = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(HELPERS);
  if (!block) return [];
  return [...block[1]!.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]!);
}

describe("/forms published claims", () => {
  it("reads the page and the unions", () => {
    // Guard the guard: an empty union makes every membership check vacuous.
    expect(PAGE.length).toBeGreaterThan(4_000);
    expect(union("PopupTrigger").length).toBeGreaterThan(2);
    expect(union("EmbedMode").length).toBeGreaterThan(2);
  });

  it("names only popup triggers that exist", () => {
    const declared = union("PopupTrigger");
    const sentence = /for a popup a trigger of ([^.]+)\./.exec(PAGE)?.[1] ?? "";
    expect(sentence).not.toBe("");
    // Every declared trigger is mentioned, either by identifier or by the
    // words the dashboard's own dropdown uses for it.
    const labels = triggerLabels();
    expect(labels.size).toBeGreaterThan(2); // guard the guard
    const unmentioned = declared.filter((trigger) => {
      if (sentence.includes(trigger)) return false;
      const label = labels.get(trigger);
      // No dashboard label and no identifier in the copy means the trigger is
      // simply unmentioned. Falling back to "" here made words empty, and
      // [].every() is vacuously true — so a newly added trigger passed
      // silently. Caught by mutating the union and watching nothing fail.
      if (!label) return true;
      // "After 50% scroll" -> the copy must carry its distinctive words.
      const words = label
        .toLowerCase()
        .replace(/^(after|on)\s+/, "")
        .split(/\s+/)
        .filter(Boolean);
      return !words.every((w) => sentence.toLowerCase().includes(w));
    });
    expect(unmentioned).toEqual([]);
  });

  it("names only embed modes that exist", () => {
    const declared = union("EmbedMode");
    const sentence =
      /mode ([^,]+(?:, [^,]+)*), and for a popup/.exec(PAGE)?.[1] ?? "";
    expect(sentence).not.toBe("");
    const unmentioned = declared.filter((m) => !sentence.includes(m));
    expect(unmentioned).toEqual([]);
  });

  it("invents no position or trigger the product does not have", () => {
    // The specific failure. "slide-in" and "time-on-page" were published for
    // months and exist in no union, no handler, and no embed script.
    const vocabulary = new Set([
      ...union("PopupTrigger"),
      ...union("EmbedMode"),
    ]);
    for (const invented of ["slide-in", "time-on-page"]) {
      expect(vocabulary.has(invented)).toBe(false);
      expect(PAGE).not.toContain(invented);
    }
  });

  it("does not market the release-held form-variant runtime", () => {
    for (const unavailableClaim of [
      "tracks impressions and submissions per variant",
      "epsilon-greedy split",
      "Automatic winner selection",
      "promotes the leader to 100%",
      "bandit traffic weights",
      "A/B variants are on every paid plan",
    ]) {
      expect(PAGE).not.toContain(unavailableClaim);
    }
    expect(PAGE).toContain("live form A/B testing is unavailable");
    expect(PAGE).toContain("hosted rendering serves the base form");
    expect(PAGE).toContain("no winner is selected or promoted");
  });

  it("does not present MCP source definitions as callable form tools", () => {
    const quoted = [
      ...new Set([...PAGE.matchAll(/\bform_[a-z_]+\b/g)].map((m) => m[0])),
    ];
    expect(quoted).toEqual([]);
    expect(PAGE).toContain("MCP_RELEASE_HOLD_CODE");
    expect(PAGE).toContain("source candidates only");
  });

  it("counts the snippet flavors the API actually serves", () => {
    const spec = JSON.parse(
      readFileSync(join(REPO, "packages/openapi/openapi.json"), "utf8"),
    ) as {
      paths: Record<
        string,
        {
          parameters?: { name: string; schema?: { enum?: string[] } }[];
          get?: {
            parameters?: { name: string; schema?: { enum?: string[] } }[];
          };
        }
      >;
    };
    const item = spec.paths["/api/v1/forms/{id}/embed/{flavor}"];
    const params = [
      ...(item?.parameters ?? []),
      ...(item?.get?.parameters ?? []),
    ];
    const flavors = params.find((p) => p.name === "flavor")?.schema?.enum ?? [];
    expect(flavors.length).toBeGreaterThan(3);
    const WORDS: Record<number, string> = { 4: "four", 5: "five", 6: "six" };
    expect(PAGE).toContain(`${WORDS[flavors.length]} snippet flavors`);
  });
});
