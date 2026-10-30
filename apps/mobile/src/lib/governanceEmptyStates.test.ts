import { describe, expect, it } from "vitest";

import {
  GOVERNANCE_SURFACES,
  governanceEmptyCopy,
  type GovernanceSurface,
} from "./governanceEmptyStates";

describe("governanceEmptyCopy", () => {
  it("resolves real copy for every surface, not catalogue keys", () => {
    // `msg()` returns the KEY when an entry is missing. A key on screen is the
    // exact failure this module exists to prevent, so it is asserted, not
    // assumed.
    for (const surface of GOVERNANCE_SURFACES) {
      const copy = governanceEmptyCopy(surface);
      expect(copy.title).not.toContain("governance.empty.");
      expect(copy.description).not.toContain("governance.empty.");
      expect(copy.title.trim().length).toBeGreaterThan(0);
      expect(copy.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("answers WHAT THIS IS FOR before WHERE ROWS COME FROM", () => {
    // The finding's substance: a first-time admin gets an explanation, not a
    // restatement of the empty list. Two sentences is the shape that carries
    // both clauses, and a one-sentence entry has dropped one of them.
    for (const surface of GOVERNANCE_SURFACES) {
      const { description } = governanceEmptyCopy(surface);
      const sentences = description
        .split(/(?<=[.!?])\s+/u)
        .filter((part) => part.trim().length > 0);
      expect(
        sentences.length,
        `${surface}: "${description}" — governance copy needs a purpose ` +
          `clause AND a "what makes a row appear" clause.`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("never restates the title inside the description", () => {
    // "No SCIM tokens" / "Create a SCIM token" is the deficit-restating shape
    // the finding names. The title says what is absent; the description must
    // spend its words on something else.
    for (const surface of GOVERNANCE_SURFACES) {
      const { title, description } = governanceEmptyCopy(surface);
      expect(description.toLowerCase()).not.toContain(title.toLowerCase());
    }
  });

  it("does not apologise or promise", () => {
    // "unavailable", "coming soon", "sorry" are the three ways an empty
    // governance screen reads as a fault rather than as a state.
    for (const surface of GOVERNANCE_SURFACES) {
      const text =
        `${governanceEmptyCopy(surface).title} ` +
        governanceEmptyCopy(surface).description;
      expect(text.toLowerCase()).not.toMatch(
        /unavailable|coming soon|sorry|not supported/u,
      );
    }
  });

  it("covers the surfaces the finding named", () => {
    const named: GovernanceSurface[] = ["approvals", "audit"];
    for (const surface of named) {
      expect(GOVERNANCE_SURFACES).toContain(surface);
    }
    expect(GOVERNANCE_SURFACES.length).toBeGreaterThanOrEqual(6);
  });
});
