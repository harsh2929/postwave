// SPDX-License-Identifier: AGPL-3.0-only
//
// /features and /voice publish the voice pipeline's operating numbers. Each
// has one source of truth in services/voice or apps/api, and none of them had
// anything holding the copy to it.
//
// The one that was wrong: "up to five source types", published in five places
// across the two pages — and every one of them then listed all SIX that
// ingest.SourceType declares (newsletter_archive, twitter, blog_rss,
// podcast_transcript, linkedin_export, paste_in). The enumeration beside the
// count was its own disproof; whoever added linkedin_export extended the prose
// list and left the number two words earlier alone.
//
// Not re-tested here: the 50-template / 13-category figures
// (voice-template-claims) and the seedlist size (seedlist-claims).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");

const PAGES = ["features", "voice"].map((name) => ({
  name,
  text: readFileSync(
    join(SRC, `app/(marketing)/${name}/page.tsx`),
    "utf8",
  ).replace(/\s+/g, " "),
}));

const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];

function voice(rel: string): string {
  return readFileSync(join(REPO, "services/voice/internal", rel), "utf8");
}

describe("voice pipeline claims match the service", () => {
  it("counts the source types the ingest package declares", () => {
    const src = voice("ingest/source.go");
    const block = /const \(([\s\S]*?)\)/.exec(src)?.[1] ?? "";
    const types = [...block.matchAll(/Source\w+\s+SourceType\s*=\s*"([^"]+)"/g)].map(
      (m) => m[1]!,
    );
    expect(types.length).toBeGreaterThan(3); // guard the guard
    expect(types).toContain("linkedin_export");

    const word = WORDS[types.length];
    expect(word, `no word for ${types.length}`).toBeDefined();
    for (const page of PAGES) {
      const claims = [...page.text.matchAll(/(\w+) source types/g)].map(
        (m) => m[1]!,
      );
      expect(claims.length, `${page.name} makes no source-type claim`)
        .toBeGreaterThan(0);
      for (const claimed of claims) {
        expect(claimed, `${page.name} says "${claimed} source types"`).toBe(word);
      }
    }
  });

  it("states the score below which the engine regenerates", () => {
    // types.go: "<60 is the auto-regenerate threshold". The same 60 is also
    // DriftWarnThreshold in the pre-send UI — same number, different
    // mechanism — so this reads the generation engine, not the drift banner.
    const types = voice("generation/types.go");
    const m = /<(\d+) is the auto-regenerate threshold/.exec(types);
    expect(m, "auto-regenerate threshold comment not found").not.toBeNull();
    const engine = voice("generation/engine.go");
    expect(engine).toContain(`If score < ${m![1]}, regenerate`);
    for (const page of PAGES) {
      expect(page.text, page.name).toMatch(
        new RegExp(`(under|below) ${m![1]}\\b`),
      );
    }
  });

  it("states the subject-line variant default and ceiling", () => {
    const src = readFileSync(
      join(REPO, "apps/api/internal/ai_subject_lines/ai_subject_lines.go"),
      "utf8",
    );
    const bounds = /variant_count\?: int \(default (\d+), bounded \[(\d+),(\d+)\]\)/.exec(
      src,
    );
    expect(bounds, "variant_count contract not found").not.toBeNull();
    // The doc comment and the constant must agree before either is published.
    expect(src).toContain(`defaultVariantCount = ${bounds![1]}`);
    const voicePage = PAGES.find((p) => p.name === "voice")!;
    expect(voicePage.text).toContain(
      `default ${bounds![1]}, up to ${bounds![3]}`,
    );
  });

  it("states the top-performers window the endpoint defaults to", () => {
    const src = readFileSync(
      join(REPO, "apps/api/internal/ai_subject_lines/ai_subject_lines.go"),
      "utf8",
    );
    const m = /\?days=(\d+) \(default \d+, bounded/.exec(src);
    expect(m, "days contract not found").not.toBeNull();
    for (const page of PAGES) {
      if (!/top-performers/.test(page.text)) continue;
      expect(page.text, page.name).toContain(`${m![1]}-day top-performers`);
    }
  });

  it("states the generation quota the pricing tier grants", () => {
    // "Studio Lifetime includes 50 generations per month" — the tier list is
    // the source of truth, and it carries a different number on another tier.
    const pricing = readFileSync(join(SRC, "lib/pricing.ts"), "utf8");
    const m = /(\d+) voice generations \/ month/.exec(pricing);
    expect(m, "voice generation quota not found in pricing").not.toBeNull();
    const features = PAGES.find((p) => p.name === "features")!;
    expect(features.text).toContain(`${m![1]} generations per month`);
  });

  it("does not present optimizer previews as persisted send-worker input", () => {
    const voicePage = PAGES.find((page) => page.name === "voice")!;
    expect(voicePage.text).toContain("preview-only content optimizer");
    expect(voicePage.text).toContain(
      "Optimizer previews are not persisted or applied by send workers",
    );
    expect(voicePage.text).not.toContain("persist as a run for send workers");
  });
});
