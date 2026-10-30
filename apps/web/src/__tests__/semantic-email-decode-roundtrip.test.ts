// SPDX-License-Identifier: AGPL-3.0-only
//
// Losslessness of the block editor's decode/encode boundary.
//
// Opening a document in a block editor and saving it must not change anything
// the author did not touch. The failure mode this guards is silent: a field the
// editor did not model is dropped on save, no diagnostic is raised, and the
// campaign is now missing content nobody deleted. So there are two rules —
// what the editor CAN open it must reproduce exactly, and what it cannot model
// it must REFUSE to open rather than partially understand.

import { describe, expect, it } from "vitest";

import fixtureFile from "./fixtures/semantic-email-projection.json";
import { decodeSemanticNodes } from "@/lib/semantic-email/decode";
import { wireNodes } from "@/lib/semantic-email/wire";
import type { SemanticNode } from "@/lib/semantic-email/types";

const fixture = fixtureFile as unknown as {
  cases: Array<{ name: string; normalized: { nodes: unknown[] | null } }>;
};

describe("semantic node decode/encode round trip", () => {
  for (const testCase of fixture.cases) {
    it(`reproduces the stored document byte for byte: ${testCase.name}`, () => {
      // The input here is Go's OWN normalized output — exactly the bytes the
      // API persists in campaigns.content_blocks.
      const stored = testCase.normalized.nodes ?? [];
      const decoded = decodeSemanticNodes(stored);
      expect(decoded.diagnostics).toEqual([]);
      expect(decoded.nodes).not.toBeNull();
      expect(wireNodes(decoded.nodes as SemanticNode[])).toEqual(stored);
    });
  }

  it("refuses a node carrying a field this editor does not model", () => {
    const decoded = decodeSemanticNodes([
      {
        id: "body",
        type: "paragraph",
        role: "body",
        version: 2,
        content: { paragraph: { text: { runs: [{ kind: "text", text: "Hi" }] } } },
        conditions: [],
        localizations: {},
        provenance: { source: "user" },
        // A field from a newer API than this editor knows about.
        rendering_hint: { emphasis: "loud" },
      },
    ]);
    expect(decoded.nodes).toBeNull();
    expect(decoded.diagnostics).toHaveLength(1);
    expect(decoded.diagnostics[0].code).toBe("invalid_json");
    expect(decoded.diagnostics[0].message).toContain(
      'unknown field "rendering_hint"',
    );
  });

  it("refuses an unknown field nested inside content", () => {
    const decoded = decodeSemanticNodes([
      {
        id: "vote",
        type: "poll",
        role: "poll",
        version: 2,
        content: {
          poll: {
            poll_id: "p",
            question: { runs: [] },
            options: [{ option_id: "a", label: { runs: [] }, tally: 4 }],
          },
        },
        conditions: [],
        localizations: {},
        provenance: { source: "user" },
      },
    ]);
    expect(decoded.nodes).toBeNull();
    expect(decoded.diagnostics[0].message).toContain('unknown field "tally"');
  });

  it("refuses a field whose type is wrong rather than coercing it", () => {
    const decoded = decodeSemanticNodes([
      {
        id: "title",
        type: "heading",
        role: "heading",
        version: 2,
        content: { heading: { level: "1", text: { runs: [] } } },
        conditions: [],
        localizations: {},
        provenance: { source: "user" },
      },
    ]);
    expect(decoded.nodes).toBeNull();
    expect(decoded.diagnostics[0].message).toContain("expected an integer");
  });

  it("preserves conditions, localizations and provenance it does not edit", () => {
    const stored = [
      {
        id: "deal",
        type: "offer",
        role: "offer",
        version: 2,
        content: {
          offer: {
            description: { runs: [{ kind: "text", text: "Save" }] },
            terms: { runs: [] },
            canonical_offer_id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
          },
        },
        conditions: [{ id: "c1", slot_id: "segment", operator: "present" }],
        localizations: {
          "fr-FR": {
            offer: {
              description: { runs: [{ kind: "text", text: "Économisez" }] },
              terms: { runs: [] },
              canonical_offer_id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
            },
          },
        },
        provenance: { source: "template", source_id: "tpl_1" },
      },
    ];
    const decoded = decodeSemanticNodes(stored);
    expect(decoded.nodes).not.toBeNull();
    expect(wireNodes(decoded.nodes as SemanticNode[])).toEqual(stored);
  });
});
