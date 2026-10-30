/**
 * The edit-list policy: the patch builder must emit ONLY what changed (the
 * server treats every present key as an instruction and 400s an empty
 * body), and the bigint-id predicate must keep UUID deep-link params away
 * from the bigint-only PATCH/DELETE handlers.
 */
import { describe, expect, it } from "vitest";

import {
  isListmonkBigintId,
  listSettingsNameProblem,
  listSettingsPatch,
} from "./listSettingsForm";

const original = {
  name: "Newsletter",
  description: "Weekly",
  type: "private",
  optin: "single",
};

describe("listSettingsPatch", () => {
  it("returns null when nothing changed — the server 400s an empty body", () => {
    expect(
      listSettingsPatch(original, {
        name: "Newsletter",
        description: "Weekly",
        type: "private",
        optin: "single",
      }),
    ).toBeNull();
  });

  it("emits only the fields that changed", () => {
    expect(
      listSettingsPatch(original, {
        name: "Newsletter",
        description: "Weekly",
        type: "private",
        optin: "double",
      }),
    ).toEqual({ optin: "double" });
  });

  it("treats a missing original type/optin as the server defaults", () => {
    // A row without type is "private" server-side; re-submitting "private"
    // must not generate a phantom change.
    expect(
      listSettingsPatch(
        { name: "Newsletter" },
        {
          name: "Newsletter",
          description: "",
          type: "private",
          optin: "single",
        },
      ),
    ).toBeNull();
  });

  it("never emits an empty name", () => {
    const patch = listSettingsPatch(original, {
      name: "   ",
      description: "Weekly",
      type: "private",
      optin: "single",
    });
    expect(patch).toBeNull();
  });
});

describe("listSettingsNameProblem", () => {
  it("rejects blank and over-long names, accepts a normal one", () => {
    expect(listSettingsNameProblem("  ")).not.toBeNull();
    expect(listSettingsNameProblem("x".repeat(121))).not.toBeNull();
    expect(listSettingsNameProblem("Weekly digest")).toBeNull();
  });
});

describe("isListmonkBigintId", () => {
  it("admits bigints and refuses UUIDs / blanks", () => {
    expect(isListmonkBigintId("42")).toBe(true);
    expect(isListmonkBigintId("0b6e1a5e-93a4-4a1e-9a2e-1c2d3e4f5a6b")).toBe(
      false,
    );
    expect(isListmonkBigintId("")).toBe(false);
    expect(isListmonkBigintId(undefined)).toBe(false);
  });
});
