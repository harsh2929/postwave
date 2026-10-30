// SPDX-License-Identifier: AGPL-3.0-only
//
// The poll node's two identity rules, and the save gate that depends on them.
//
// A poll is the one node in the union whose defects are INVISIBLE in the
// rendered message. A duplicate option id renders as two normal-looking
// choices; it is only at tally time that two answers have silently become one,
// and the campaign then reports a confident wrong result. That is worse than
// an error, so it has to be an error.
//
// These assertions are the mutation targets named in the brief: delete the
// uniqueness check in validate.ts and the first three fail; make stageNodes
// ignore diagnostics and the last two fail.

import { describe, expect, it } from "vitest";

import {
  createNode,
  stageNodes,
  validateNodes,
} from "@/lib/semantic-email/authoring";
import type { PollOption, SemanticNode } from "@/lib/semantic-email/types";

function pollWithOptions(options: PollOption[]): SemanticNode {
  const node = createNode("poll", "1");
  node.content.poll = { ...node.content.poll!, options };
  return node;
}

function option(id: string, label: string): PollOption {
  return {
    option_id: id,
    label: {
      runs: [{ kind: "text", text: label, url: "", accessible_label: "", slot: null }],
    },
  };
}

describe("poll authoring rules", () => {
  it("does not seed semantic actions or images with live-looking example links", () => {
    expect(createNode("action", "1").content.action?.canonical_url).toBe("");
    expect(createNode("image", "1").content.image?.url).toBe("");
  });

  it("rejects two options that share an id, at the offending option's path", () => {
    const diagnostics = validateNodes([
      pollWithOptions([option("same", "Morning"), option("same", "Evening")]),
    ]);

    const duplicate = diagnostics.find(
      (diagnostic) => diagnostic.code === "duplicate",
    );
    expect(duplicate).toBeDefined();
    expect(duplicate!.severity).toBe("error");
    // Addressed to the SECOND option, so the editor can put the message under
    // the box the author must change.
    expect(duplicate!.path).toBe("/nodes/0/content/poll/options/1/option_id");
    expect(duplicate!.message).toContain("merge two choices into one tally");
  });

  it("reports the duplicate for every later option that repeats an id", () => {
    const diagnostics = validateNodes([
      pollWithOptions([
        option("a", "A"),
        option("a", "B"),
        option("b", "C"),
        option("a", "D"),
      ]),
    ]);
    const paths = diagnostics
      .filter((diagnostic) => diagnostic.code === "duplicate")
      .map((diagnostic) => diagnostic.path);
    expect(paths).toEqual([
      "/nodes/0/content/poll/options/1/option_id",
      "/nodes/0/content/poll/options/3/option_id",
    ]);
  });

  it("accepts distinct ids", () => {
    const diagnostics = validateNodes([
      pollWithOptions([option("morning", "Morning"), option("evening", "Evening")]),
    ]);
    expect(diagnostics.filter((item) => item.code === "duplicate")).toEqual([]);
    expect(diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  });

  it("requires at least two options — one option is not a question", () => {
    const diagnostics = validateNodes([
      pollWithOptions([option("only", "Only")]),
    ]);
    const required = diagnostics.find(
      (diagnostic) => diagnostic.path === "/nodes/0/content/poll/options",
    );
    expect(required?.code).toBe("required");
    expect(required?.severity).toBe("error");
  });

  it("caps options at ten so one node cannot mint unbounded per-recipient URLs", () => {
    const options = Array.from({ length: 11 }, (_, index) =>
      option(`option_${index}`, `Option ${index}`),
    );
    const diagnostics = validateNodes([pollWithOptions(options)]);
    const limit = diagnostics.find(
      (diagnostic) => diagnostic.path === "/nodes/0/content/poll/options",
    );
    expect(limit?.code).toBe("limit_exceeded");
  });

  it("rejects two poll nodes that share a poll id", () => {
    const first = createNode("poll", "1");
    const second = createNode("poll", "2");
    second.content.poll = { ...second.content.poll!, poll_id: first.content.poll!.poll_id };
    const diagnostics = validateNodes([first, second]);
    const duplicate = diagnostics.find(
      (diagnostic) => diagnostic.path === "/nodes/1/content/poll/poll_id",
    );
    expect(duplicate?.code).toBe("duplicate");
  });

  it("does not stage a document whose poll would produce a wrong tally", () => {
    const result = stageNodes([
      pollWithOptions([option("same", "Morning"), option("same", "Evening")]),
    ]);
    expect(result.ok).toBe(false);
    expect(result.nodes).toBeNull();
  });

  it("does not stage any document that carries an error diagnostic", () => {
    // Sweep the class rather than the poll instance: every one of these is a
    // different rule, and the gate is "no errors", not "no duplicate ids".
    const withBadRole = createNode("paragraph", "1");
    withBadRole.role = "primary_action";

    const withBadURL = createNode("action", "1");
    withBadURL.content.action = {
      ...withBadURL.content.action!,
      canonical_url: "https://example.com/a#top",
    };

    const withMissingAlt = createNode("image", "1");
    withMissingAlt.content.image = { ...withMissingAlt.content.image!, alt: "" };

    const withBadCurrency = createNode("money", "1");
    withBadCurrency.content.money = {
      display_value: "10",
      amount: "1.5e1",
      currency: "XXX",
    };

    const withEmptyList = createNode("list", "1");
    withEmptyList.content.list = { ordered: false, items: [] };

    for (const node of [
      withBadRole,
      withBadURL,
      withMissingAlt,
      withBadCurrency,
      withEmptyList,
    ]) {
      const result = stageNodes([node]);
      expect(result.ok, `${node.type} should not stage`).toBe(false);
      expect(result.nodes).toBeNull();
    }
  });

  it("stages a valid document as the wire shape the API stores", () => {
    const heading = createNode("heading", "1");
    heading.content.heading = { ...heading.content.heading!, level: 1 };
    const result = stageNodes([heading, createNode("paragraph", "2")]);
    expect(result.ok).toBe(true);
    expect(result.nodes).toEqual([
      {
        id: "heading_1",
        type: "heading",
        role: "heading",
        version: 2,
        content: {
          heading: { level: 1, text: { runs: [{ kind: "text", text: "Section heading" }] } },
        },
        conditions: [],
        localizations: {},
        provenance: { source: "user" },
      },
      {
        id: "paragraph_2",
        type: "paragraph",
        role: "body",
        version: 2,
        content: {
          paragraph: { text: { runs: [{ kind: "text", text: "Body copy." }] } },
        },
        conditions: [],
        localizations: {},
        provenance: { source: "user" },
      },
    ]);
  });
});
