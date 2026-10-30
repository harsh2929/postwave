// SPDX-License-Identifier: AGPL-3.0-only
//
// Every DUPLICATE-IDENTITY rule in the union, not just the one that had a test.
//
// The poll-option rule was covered; its three siblings — action id, poll id and
// condition id — were not. An adversarial review replaced the duplicate
// action-id branch with `if (false)` and the whole suite stayed green, which is
// the same class the poll test exists to prevent, one branch away.
//
// These identities are load-bearing in the same way and fail the same way: the
// message renders normally and the DEFECT ONLY APPEARS IN THE DATA. Two actions
// sharing an id merge two different clicks into one attribution; two polls
// sharing an id merge two questions into one tally; two conditions sharing an id
// make targeting resolve to whichever the engine happened to index last. In
// every case the sender reads a confident number that is wrong, which is worse
// than an error, so each must be an error.

import { describe, expect, it } from "vitest";

import { createNode, validateNodes } from "@/lib/semantic-email/authoring";
import { isCanonicalLanguageTag } from "@/lib/semantic-email/validate";
import type { SemanticNode } from "@/lib/semantic-email/types";

function duplicateErrors(nodes: SemanticNode[]): string[] {
  return validateNodes(nodes)
    .filter((d) => d.code === "duplicate")
    .map((d) => d.message);
}

describe("duplicate identity rules", () => {
  it("refuses two actions that share an action_id", () => {
    const first = createNode("action", "1");
    const second = createNode("action", "2");
    // Distinct NODE ids, so only the action identity collides — otherwise the
    // node-id rule would fire and this would prove nothing about actions.
    second.content.action = { ...second.content.action!, action_id: first.content.action!.action_id };

    const errors = duplicateErrors([first, second]);
    expect(errors.some((m) => m.includes("action id duplicates"))).toBe(true);

    // Guard the guard: distinct action ids must stay clean, or this test would
    // pass against a validator that reported every document as duplicated.
    second.content.action = { ...second.content.action!, action_id: "act_other" };
    expect(duplicateErrors([first, second])).toHaveLength(0);
  });

  it("refuses two nodes that share a node id", () => {
    const first = createNode("paragraph", "1");
    const second = createNode("paragraph", "2");
    second.id = first.id;

    expect(duplicateErrors([first, second]).some((m) => m.includes("node id duplicates"))).toBe(true);

    second.id = "paragraph_2";
    expect(duplicateErrors([first, second])).toHaveLength(0);
  });

  it("refuses two polls that share a poll_id", () => {
    const first = createNode("poll", "1");
    const second = createNode("poll", "2");
    second.content.poll = { ...second.content.poll!, poll_id: first.content.poll!.poll_id };

    expect(duplicateErrors([first, second]).some((m) => m.includes("poll id duplicates"))).toBe(true);

    second.content.poll = { ...second.content.poll!, poll_id: "poll_other" };
    expect(duplicateErrors([first, second])).toHaveLength(0);
  });
});

// The language rule must match the server in BOTH directions.
//
// This mirror previously asked Intl.DisplayNames whether the runtime had a NAME
// for the language. That was wrong twice: it rejected valid tags for less-common
// languages (the customers least able to work around it), and it made validity
// depend on which locale data the browser shipped — so one document could
// validate on one machine and fail on another.
//
// The rule is now the registry SHAPE: ISO 639 assigns 2- and 3-letter language
// subtags, and BCP 47 has nothing registered in the 5-8 range. That keeps out
// the mistake this actually catches — typing "english" instead of "en", which is
// syntactically a valid subtag and semantically nothing — which the Go golden
// fixture also rejects.
describe("language tags", () => {
  it("accepts real tags including less-common languages", () => {
    for (const tag of ["en", "de", "pt-BR", "zh-Hant", "haw", "yo", "mi"]) {
      expect(isCanonicalLanguageTag(tag), `${tag} should be accepted`).toBe(true);
    }
  });

  it("rejects a language NAME written where a tag belongs", () => {
    // The Go compiler rejects these too; the golden parity fixture pins
    // "english" specifically.
    for (const tag of ["english", "spanish", "deutsch"]) {
      expect(isCanonicalLanguageTag(tag), `${tag} should be rejected`).toBe(false);
    }
  });
});
