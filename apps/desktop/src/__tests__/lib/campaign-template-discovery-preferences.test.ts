import { describe, expect, it } from "vitest";

import {
  DEFAULT_CAMPAIGN_TEMPLATE_DISCOVERY_PREFERENCES,
  readCampaignTemplateDiscoveryPreferences,
  writeCampaignTemplateDiscoveryPreferences,
} from "../../lib/campaign-template-discovery-preferences";

const SCOPE = "0123456789abcdef";
const OTHER_SCOPE = "fedcba9876543210";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe("campaign template discovery preferences", () => {
  it("retains bounded catalog state for only the verified workspace and user", () => {
    const storage = memoryStorage();
    const preferences = {
      query: "editorial launch",
      goal: "newsletter" as const,
      source: "platform" as const,
      sort: "most_used" as const,
      view: "compact" as const,
      lifecycle: "all" as const,
    };
    expect(
      writeCampaignTemplateDiscoveryPreferences(
        SCOPE,
        preferences,
        storage,
      ),
    ).toBe(true);
    expect(
      readCampaignTemplateDiscoveryPreferences(SCOPE, storage),
    ).toEqual(preferences);
    expect(
      readCampaignTemplateDiscoveryPreferences(OTHER_SCOPE, storage),
    ).toEqual(DEFAULT_CAMPAIGN_TEMPLATE_DISCOVERY_PREFERENCES);
  });

  it("rejects unresolved identities and removes malformed or oversized records", () => {
    const storage = memoryStorage();
    expect(
      writeCampaignTemplateDiscoveryPreferences(
        "raw-user:raw-workspace",
        DEFAULT_CAMPAIGN_TEMPLATE_DISCOVERY_PREFERENCES,
        storage,
      ),
    ).toBe(false);
    const key = `postwave.template-discovery-preferences.v1.${SCOPE}`;
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        query: "x",
        goal: "",
        source: "future-source",
        sort: "recommended",
        view: "grid",
        lifecycle: "active",
      }),
    );
    expect(
      readCampaignTemplateDiscoveryPreferences(SCOPE, storage),
    ).toEqual(DEFAULT_CAMPAIGN_TEMPLATE_DISCOVERY_PREFERENCES);
    expect(storage.getItem(key)).toBeNull();

    storage.setItem(key, "x".repeat(1_025));
    expect(
      readCampaignTemplateDiscoveryPreferences(SCOPE, storage),
    ).toEqual(DEFAULT_CAMPAIGN_TEMPLATE_DISCOVERY_PREFERENCES);
    expect(storage.getItem(key)).toBeNull();
  });

  it("keeps archived source and lifecycle coherent", () => {
    const storage = memoryStorage();
    expect(
      writeCampaignTemplateDiscoveryPreferences(
        SCOPE,
        {
          ...DEFAULT_CAMPAIGN_TEMPLATE_DISCOVERY_PREFERENCES,
          source: "archived",
          lifecycle: "active",
        },
        storage,
      ),
    ).toBe(false);
  });
});
