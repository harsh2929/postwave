// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { applyLinkedBlockUpdate, linkedBlockOccurrenceCount, readLinkedTemplateBlocks, type LinkedTemplateBlock } from "@/lib/template-linked-blocks";
import type { SavedBlock } from "@/lib/content-library-api";

const id = "8d58fa63-1766-4717-b374-b1863372e364";
const link: LinkedTemplateBlock = { id, name: "Offer", format: "html", version: 1, source: "<p>Old offer</p>" };
const latest: SavedBlock = {
  id, tenantId: id, name: "Offer", kind: "snippet", bodyHtml: "<p>New offer</p>",
  bodyJson: { moosewave_template_fragment_format: "html", source: "<p>New offer</p>" },
  version: 2, createdAt: "", updatedAt: "",
};

describe("linked template blocks", () => {
  it("updates only the exact, unique pinned source", () => {
    expect(applyLinkedBlockUpdate("<main><p>Old offer</p></main>", link, latest)).toEqual({
      body: "<main><p>New offer</p></main>",
      link: { ...link, version: 2, source: "<p>New offer</p>" },
    });
  });
  it("refuses customized or ambiguous content", () => {
    expect(applyLinkedBlockUpdate("<p>Customized offer</p>", link, latest)).toBeNull();
    expect(linkedBlockOccurrenceCount("<p>Old offer</p><p>Old offer</p>", link.source)).toBe(2);
    expect(applyLinkedBlockUpdate("<p>Old offer</p><p>Old offer</p>", link, latest)).toBeNull();
  });
  it("deduplicates malformed stored references", () => {
    expect(readLinkedTemplateBlocks({ moosewave_linked_blocks: [link, link, { ...link, id: "bad" }] })).toEqual([link]);
  });
});
