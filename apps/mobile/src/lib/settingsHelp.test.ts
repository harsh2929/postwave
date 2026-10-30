import { describe, expect, it } from "vitest";

import { SETTINGS_ANCHORS } from "./settingsIA";
import {
  SETTINGS_HELP,
  settingsHelpFor,
  settingsHelpParagraphs,
} from "./settingsHelp";

describe("settings contextual help coverage", () => {
  it("writes help for EVERY section the settings index can jump to", () => {
    const missing = SETTINGS_ANCHORS.filter(
      (anchor) => settingsHelpFor(anchor.key) === null,
    ).map((anchor) => anchor.key);
    expect(missing).toEqual([]);
  });

  it("has no orphan help for a section that no longer exists", () => {
    const anchorKeys = new Set(SETTINGS_ANCHORS.map((a) => a.key));
    const orphans = Object.keys(SETTINGS_HELP).filter(
      (key) => !anchorKeys.has(key),
    );
    expect(orphans).toEqual([]);
  });

  it("always states the scope, which is the thing people get wrong", () => {
    for (const [key, help] of Object.entries(SETTINGS_HELP)) {
      expect(help.scope, `${key} must declare a scope`).toBeTruthy();
      expect(help.what.trim().length, `${key} needs a 'what'`).toBeGreaterThan(
        20,
      );
    }
  });

  it("never ships an empty consequence string — absent means 'none to state'", () => {
    for (const [key, help] of Object.entries(SETTINGS_HELP)) {
      if (help.consequence === undefined) continue;
      expect(help.consequence.trim(), `${key}`).not.toBe("");
    }
  });
});

describe("settingsHelpParagraphs", () => {
  it("omits the consequence line entirely when there is none", () => {
    expect(settingsHelpParagraphs({ what: "A", scope: "This device only" })).toEqual(
      ["A"],
    );
  });

  it("keeps 'what' first and 'consequence' second", () => {
    expect(
      settingsHelpParagraphs({
        what: "A",
        consequence: "B",
        scope: "Everyone in this workspace",
      }),
    ).toEqual(["A", "B"]);
  });
});

describe("the sections whose consequence is irreversible say so", () => {
  it.each(["retention", "account-deletion", "outbound-webhooks"])(
    "%s states a consequence",
    (key) => {
      expect(settingsHelpFor(key)?.consequence).toBeTruthy();
    },
  );
});
