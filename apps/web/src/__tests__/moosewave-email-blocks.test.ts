// SPDX-License-Identifier: AGPL-3.0-only

import mjml2html from "mjml";
import { describe, expect, it } from "vitest";

import {
  BRANDED_BLOCKS,
  DEFAULT_MJML,
  initialBlockMjml,
  workspaceBrandBlocks,
} from "@/components/editor/moosewave-email-blocks";
import { runTemplatePreflight } from "@/lib/template-merge-tags";

describe("Moosewave email design blocks", () => {
  it("starts a visual design for both missing and empty MJML", () => {
    expect(initialBlockMjml()).toBe(DEFAULT_MJML);
    expect(initialBlockMjml("")).toBe(DEFAULT_MJML);
    expect(initialBlockMjml("  ")).toBe(DEFAULT_MJML);
    expect(initialBlockMjml("<mjml>Saved</mjml>")).toBe("<mjml>Saved</mjml>");
    expect(
      initialBlockMjml('<mj-image src="https://example.test/photo.png" /><mj-divider border-width="1px" /><mj-text>Next block</mj-text>'),
    ).toBe(
      '<mj-image src="https://example.test/photo.png"></mj-image><mj-divider border-width="1px"></mj-divider><mj-text>Next block</mj-text>',
    );
  });

  it("keeps the starter valid under the installed strict MJML compiler", async () => {
    const output = await mjml2html(DEFAULT_MJML, { validationLevel: "strict" });
    expect(output.errors).toEqual([]);
    expect(output.html).toContain("#ffdf38");
    expect(
      runTemplatePreflight(DEFAULT_MJML).find(
        (check) => check.id === "unsubscribe",
      )?.status,
    ).toBe("pass");
    expect(
      runTemplatePreflight(DEFAULT_MJML).find(
        (check) => check.id === "placeholder-links",
      )?.status,
    ).toBe("warn");
  });

  it.each(BRANDED_BLOCKS)(
    "compiles the $id insert on its own",
    async (block) => {
      const source = `<mjml><mj-body>${block.content}</mj-body></mjml>`;
      const output = await mjml2html(source, { validationLevel: "strict" });
      expect(output.errors).toEqual([]);
    },
  );

  it("uses the workspace brand safely and produces compilable copied blocks", async () => {
    const blocks = workspaceBrandBlocks({
      tenant_id: "tenant-1",
      timezone: "UTC",
      date_format: "YYYY-MM-DD",
      display_name: 'Acme & <Co> "Today"',
      brand_color: "#112233",
      logo_url: 'https://assets.example.com/logo.svg?q="bad"&a=1',
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0].source).toContain('background-color="#112233"');
    expect(blocks[0].source).toContain("&amp;");
    expect(blocks[0].source).not.toContain("<Co>");
    expect(blocks[1].source).toContain('color="#ffffff"');
    for (const block of blocks) {
      const result = await mjml2html(`<mjml><mj-body>${block.source}</mj-body></mjml>`, { validationLevel: "strict" });
      expect(result.errors).toEqual([]);
    }
  });

  it("omits unsafe workspace logos and falls back from invalid colors", () => {
    const blocks = workspaceBrandBlocks({
      tenant_id: "tenant-1",
      timezone: "UTC",
      date_format: "YYYY-MM-DD",
      brand_color: "red\" onload=evil",
      logo_url: "javascript:alert(1)",
    });
    expect(blocks[0].source).toContain("Your workspace");
    expect(blocks[0].source).not.toContain("mj-image");
    expect(blocks[0].source).toContain('background-color="#ffdf38"');
  });
});
