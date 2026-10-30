import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _internal } from "../../components/CommandPalette";
import { clearNavigationRecents } from "../../lib/navigation-preferences";
import { SETTINGS_INFORMATION_ARCHITECTURE } from "../../lib/settings-information-architecture";

const values = new Map<string, string>();

beforeEach(() => {
  values.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  clearNavigationRecents();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("command palette identity-scoped recents", () => {
  it("never exposes one identity's exact record recent to another", () => {
    _internal.pushRecent("scope-a", {
      id: "campaign:42",
      label: "Private launch",
      group: "Campaigns",
      kind: "campaign",
      section: "campaigns",
      resourceId: "campaign_42",
    });

    expect(_internal.loadRecents("scope-a")).toMatchObject([
      {
        section: "campaigns",
        resourceId: "campaign_42",
      },
    ]);
    expect(_internal.loadRecents("scope-b")).toEqual([]);
    expect(_internal.loadRecents(null)).toEqual([]);
    expect([...values.keys()]).toEqual([]);
  });

  it("purges the unsafe legacy flat key instead of migrating it", () => {
    values.set(
      "postwave.cmdk.recents.v1",
      JSON.stringify([{ id: "subscriber:secret@example.com" }]),
    );

    expect(_internal.loadRecents("scope-a")).toEqual([]);
    expect(values.has("postwave.cmdk.recents.v1")).toBe(false);
  });
});

describe("command palette Settings destinations", () => {
  it("indexes every typed Settings destination with task-oriented search text", () => {
    expect(_internal.settingsNavigationItems).toHaveLength(
      SETTINGS_INFORMATION_ARCHITECTURE.length,
    );
    expect(
      _internal.settingsNavigationItems.find(
        (item) => item.id === "settings:security",
      ),
    ).toMatchObject({
      label: "Security",
      hint: "Account",
      searchText: expect.stringContaining("2fa"),
    });
    expect(
      _internal.settingsNavigationItems.find(
        (item) => item.id === "settings:archive-domain",
      )?.searchText,
    ).toContain("dns");
  });

  it("actually returns Settings destinations matched only by non-rendered synonyms", () => {
    expect(
      _internal.filterRankedPaletteItems(
        _internal.settingsNavigationItems,
        "2FA",
      )[0]?.id,
    ).toBe("settings:security");
    expect(
      _internal.filterRankedPaletteItems(
        _internal.settingsNavigationItems,
        "DNS",
      )[0]?.id,
    ).toBe("settings:archive-domain");
  });
});
