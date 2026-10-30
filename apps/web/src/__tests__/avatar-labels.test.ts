// SPDX-License-Identifier: AGPL-3.0-only
//
// The integrations directory renders a two-character avatar per integration.
// avatarLabel's docstring claimed the label was "collision-free" and cited the
// Microsoft Teams / Microsoft Dynamics fix — but "Snapchat Ads" (initials of
// the first two words) and "Salesforce" (first two letters) both produced
// "SA", so two cards in the same grid carried the same badge.
//
// A pure per-name function cannot guarantee global uniqueness, so the casing
// now distinguishes the two forms ("SA" vs "Sa") and this asserts the shipped
// catalog stays collision-free as integrations are added — the check the
// docstring's claim actually needs.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { avatarLabel } from "@/components/marketing/integrations-directory";

const SRC = resolve(process.cwd(), "src");

/** Integration display names, straight from the catalog module. */
function integrationNames(): string[] {
  const text = readFileSync(join(SRC, "lib/integrations.ts"), "utf8");
  return [
    ...text.matchAll(
      /slug:\s*"[a-z0-9-]+",\s*\n\s*name:\s*"([^"]+)",\s*\n\s*category:/g,
    ),
  ].map((m) => m[1]!);
}

describe("integration avatar labels", () => {
  const names = integrationNames();

  it("reads the catalog", () => {
    // Guard the guard: an empty list would make the uniqueness check vacuous.
    expect(names.length).toBeGreaterThan(20);
  });

  it("keeps the shipped catalog collision-free", () => {
    const byLabel = new Map<string, string[]>();
    for (const name of names) {
      const label = avatarLabel(name);
      byLabel.set(label, [...(byLabel.get(label) ?? []), name]);
    }
    const collisions = [...byLabel.entries()]
      .filter(([, group]) => group.length > 1)
      .map(([label, group]) => `${label}: ${group.join(" / ")}`);
    expect(collisions.sort()).toEqual([]);
  });

  it("distinguishes the one-word and two-word forms", () => {
    // The exact pair that collided.
    expect(avatarLabel("Snapchat Ads")).toBe("SA");
    expect(avatarLabel("Salesforce")).toBe("Sa");
    expect(avatarLabel("Snapchat Ads")).not.toBe(avatarLabel("Salesforce"));
  });

  it("still resolves the Microsoft case the docstring cites", () => {
    expect(avatarLabel("Microsoft Teams")).toBe("MT");
    expect(avatarLabel("Microsoft Dynamics 365")).toBe("MD");
  });

  it("always produces two characters", () => {
    for (const name of names) {
      expect(avatarLabel(name)).toHaveLength(2);
    }
  });
});
