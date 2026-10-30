/**
 * Settings sections as palette targets — one per IA entry, routed with the
 * anchor the settings screen's jump already understands; and the param parser
 * that stands between a URL and that jump.
 */
import { describe, expect, it } from "vitest";

import { scorePaletteItem } from "./paletteItems";
import {
  SETTINGS_ANCHOR_PARAM,
  SETTINGS_ROUTE,
  buildSettingsItems,
  parseSettingsAnchorParam,
  settingsAnchorTarget,
} from "./paletteSettingsItems";
import { SETTINGS_ANCHORS } from "./settingsIA";

describe("buildSettingsItems", () => {
  const items = buildSettingsItems();

  it("indexes every section in the IA, once, in IA order", () => {
    expect(items.map((item) => item.id)).toEqual(
      SETTINGS_ANCHORS.map((anchor) => `settings:${anchor.key}`),
    );
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });

  it("routes each to Settings with its own anchor as the param", () => {
    items.forEach((item, i) => {
      expect(item.kind).toBe("settings");
      expect(item.route).toBe(SETTINGS_ROUTE);
      expect(item.params).toEqual({
        [SETTINGS_ANCHOR_PARAM]: SETTINGS_ANCHORS[i]!.key,
      });
      expect(item.actionKey).toBeUndefined();
    });
  });

  it("shows the category as the hint, as desktop does", () => {
    const appLock = items.find((item) => item.id === "settings:app-lock");
    expect(appLock?.title).toBe("App lock");
    expect(appLock?.subtitle).toBe("Settings · Device");
  });

  it("answers the IA's own keywords — 'face id' finds App lock", () => {
    const appLock = items.find((item) => item.id === "settings:app-lock")!;
    expect(scorePaletteItem(appLock, "face id")).toBeLessThan(
      Number.POSITIVE_INFINITY,
    );
  });

  it("answers 'passkey', which the IA alone does not, without losing the IA's words", () => {
    const security = items.find((item) => item.id === "settings:security")!;
    expect(scorePaletteItem(security, "passkey")).toBeLessThan(
      Number.POSITIVE_INFINITY,
    );
    expect(scorePaletteItem(security, "2fa")).toBeLessThan(
      Number.POSITIVE_INFINITY,
    );
  });

  it("builds from whatever anchor list it is given", () => {
    expect(buildSettingsItems([])).toEqual([]);
  });
});

describe("settingsAnchorTarget", () => {
  it("is the {pathname, params} href useNavigateTo takes", () => {
    expect(settingsAnchorTarget("telemetry")).toEqual({
      pathname: "/(tabs)/settings",
      params: { anchor: "telemetry" },
    });
  });
});

describe("parseSettingsAnchorParam", () => {
  it("accepts a declared key", () => {
    expect(parseSettingsAnchorParam("app-lock")).toBe("app-lock");
  });

  it("trims", () => {
    expect(parseSettingsAnchorParam(" app-lock ")).toBe("app-lock");
  });

  it("takes the first of a repeated param", () => {
    expect(parseSettingsAnchorParam(["telemetry", "widget"])).toBe("telemetry");
  });

  it("rejects an undeclared key, so a stale link cannot scroll to nowhere", () => {
    expect(parseSettingsAnchorParam("nope")).toBeNull();
    expect(parseSettingsAnchorParam(["nope"])).toBeNull();
  });

  it("is case-sensitive: anchor keys are canonical", () => {
    expect(parseSettingsAnchorParam("App-Lock")).toBeNull();
  });

  it("rejects empty and non-string input", () => {
    for (const raw of ["", "   ", undefined, null, 42, [], {}, true]) {
      expect(parseSettingsAnchorParam(raw)).toBeNull();
    }
  });
});
