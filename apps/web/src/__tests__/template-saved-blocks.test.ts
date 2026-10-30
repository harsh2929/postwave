// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import type { SavedBlock } from "@/lib/content-library-api";
import { savedBlockSource } from "@/lib/template-saved-blocks";

const block = (bodyHtml: string, bodyJson: Record<string, unknown>): SavedBlock => ({
  id: "00000000-0000-4000-8000-000000000001",
  tenantId: "00000000-0000-4000-8000-000000000002",
  name: "Footer",
  kind: "snippet",
  bodyHtml,
  bodyJson,
  createdAt: "2026-09-24T00:00:00Z",
  updatedAt: "2026-09-24T00:00:00Z",
  version: 1,
});

describe("savedBlockSource", () => {
  it("inserts only same-format fragments and never guesses a conversion", () => {
    const html = block("<p>Saved footer</p>", {
      moosewave_template_fragment_format: "html",
      source: "<p>Saved footer</p>",
    });
    expect(savedBlockSource(html, "html")).toBe("<p>Saved footer</p>");
    expect(savedBlockSource(html, "mjml")).toBeNull();

    const mjml = block("", {
      moosewave_template_fragment_format: "mjml",
      source: "<mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section>",
    });
    expect(savedBlockSource(mjml, "mjml")).toContain("<mj-section>");
    expect(savedBlockSource(mjml, "html")).toBeNull();
  });

  it("rejects full MJML documents as fragments and retains legacy HTML blocks", () => {
    expect(savedBlockSource(block("", {
      moosewave_template_fragment_format: "mjml",
      source: "<mjml><mj-body /></mjml>",
    }), "mjml")).toBeNull();
    expect(savedBlockSource(block("<table><tr><td>Legacy</td></tr></table>", {}), "html"))
      .toContain("Legacy");
  });
});
