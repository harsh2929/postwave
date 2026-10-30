// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const skill = readFileSync(
  new URL("../skills/postwave-migrate/SKILL.md", import.meta.url),
  "utf8",
);

describe("postwave-migrate release hold", () => {
  it("is a non-runnable record with model invocation disabled", () => {
    expect(skill).toContain("mcp_distribution_release_held");
    expect(skill).toContain("disable-model-invocation: true");
    expect(skill).toContain("Do not call tools");
    expect(skill).not.toMatch(/source=["']|migrate_(?:start|credentials|commit)/i);
  });
});
