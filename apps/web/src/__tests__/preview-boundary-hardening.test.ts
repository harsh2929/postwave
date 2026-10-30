// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

function openingTags(input: string, element: string): string[] {
  return input.match(new RegExp(`<${element}\\b[\\s\\S]*?>`, "gu")) ?? [];
}

describe("authored-content preview boundaries", () => {
  it("suppresses referrers from every audited srcDoc iframe", () => {
    for (const relativePath of [
      "src/components/campaigns/email-preview.tsx",
      "src/app/(dashboard)/app/landing-pages/[id]/preview-tab.tsx",
    ]) {
      const srcDocFrames = openingTags(source(relativePath), "iframe").filter(
        (tag) => tag.includes("srcDoc="),
      );
      expect(srcDocFrames.length).toBeGreaterThan(0);
      for (const frame of srcDocFrames) {
        expect(frame).toContain('sandbox=""');
        expect(frame).toContain('referrerPolicy="no-referrer"');
      }
    }
  });

  it("explains that the landing-page preview form is intentionally inert", () => {
    const previewBuilder = source("src/lib/landing-page-content.ts");
    expect(previewBuilder).toMatch(/<input\b[^>]*\bdisabled\b/u);
    expect(previewBuilder).toMatch(/<button\b[^>]*\bdisabled\b/u);

    const editor = source(
      "src/app/(dashboard)/app/landing-pages/[id]/preview-tab.tsx",
    );
    expect(editor.replace(/\s+/gu, " ")).toContain(
      "The signup form is inactive in preview and will not submit.",
    );
  });

  it("hardens flow-editor links that open a new browsing context", () => {
    const links = openingTags(
      source("src/app/(dashboard)/app/flows/_components/node-config-panel.tsx"),
      "Link",
    ).filter((tag) => tag.includes('target="_blank"'));

    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toContain('rel="noopener noreferrer"');
    }
  });
});
