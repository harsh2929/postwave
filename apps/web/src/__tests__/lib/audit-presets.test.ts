// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure-logic tests for the audit quick-filter presets (SETA-042).

import { describe, it, expect } from "vitest";
import { auditFiltersToSavedSnapshot } from "@/lib/audit-saved-views-access-api";

import {
  AI_ACTIVITY_ACTOR_TYPE,
  AUDIT_ACTION_CATEGORIES,
  AUDIT_PRESETS,
  auditActionCategoryFor,
  auditPresetFilters,
  windowSince,
} from "@/lib/audit-presets";

const NOW = Date.parse("2026-07-21T12:00:00.000Z");

describe("windowSince", () => {
  it("computes an ISO timestamp N hours before now", () => {
    expect(windowSince(24, NOW)).toBe("2026-07-20T12:00:00.000Z");
    expect(windowSince(1, NOW)).toBe("2026-07-21T11:00:00.000Z");
  });
});

describe("auditPresetFilters", () => {
  it("last-24h sets since to 24h ago and no field filters", () => {
    const f = auditPresetFilters("last-24h", NOW);
    expect(f.since).toBe("2026-07-20T12:00:00.000Z");
    expect(f.action).toBeUndefined();
    expect(f.actorType).toBeUndefined();
  });

  it("last-7d and last-30d set the right window", () => {
    expect(auditPresetFilters("last-7d", NOW).since).toBe(
      "2026-07-14T12:00:00.000Z",
    );
    expect(auditPresetFilters("last-30d", NOW).since).toBe(
      "2026-06-21T12:00:00.000Z",
    );
  });

  it("deletions filters by action=delete without a time window", () => {
    const f = auditPresetFilters("deletions", NOW);
    expect(f.action).toBe("delete");
    expect(f.since).toBeUndefined();
  });

  it("API-key changes filters the recorded mutation route, preserving human/agent attribution", () => {
    expect(auditPresetFilters("api-key-activity", NOW)).toEqual({
      action: ".api.v1.api-keys",
    });
  });

  it("every preset is accepted by the saved-view panel without crashing its render", () => {
    for (const preset of AUDIT_PRESETS) {
      expect(() =>
        auditFiltersToSavedSnapshot(auditPresetFilters(preset.id, NOW)),
      ).not.toThrow();
    }
  });

  it("returns an empty object for an unknown preset", () => {
    expect(auditPresetFilters("nope", NOW)).toEqual({});
  });

  it("every preset id resolves to a non-trivial filter", () => {
    for (const preset of AUDIT_PRESETS) {
      const f = auditPresetFilters(preset.id, NOW);
      expect(Object.keys(f).length).toBeGreaterThan(0);
    }
  });
});

describe("AI activity chip (governance-7)", () => {
  it("pivots to the actor type the server writes for agents", () => {
    expect(AI_ACTIVITY_ACTOR_TYPE).toBe("agent");
  });
});

describe("action categories (governance-9)", () => {
  it("map each chip to one literal action substring, mirroring desktop", () => {
    expect(AUDIT_ACTION_CATEGORIES.map((c) => [c.id, c.action])).toEqual([
      ["destructive", "delete"],
      ["auth", "login"],
      ["export", "export"],
      ["one-click", "one_click"],
      ["audit-reads", "audit.read"],
    ]);
  });

  it("light a chip only for an exact match on its substring", () => {
    expect(auditActionCategoryFor("login")?.id).toBe("auth");
    expect(auditActionCategoryFor("audit.read")?.id).toBe("audit-reads");
    // A narrower free-text filter is not the category, and must not claim it.
    expect(auditActionCategoryFor("campaign.delete")).toBeNull();
    expect(auditActionCategoryFor("")).toBeNull();
  });
});
