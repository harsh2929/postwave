import { describe, expect, it } from "vitest";

import {
  THEME_PREFERENCE_KEY,
  parseThemePreference,
  resolveFirstPaintTheme,
  resolveThemeName,
} from "./themePreference";

describe("stored preference parsing", () => {
  it("accepts exactly the three values the app writes", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("system")).toBe("system");
  });

  it("treats anything else as no stored answer rather than coercing it", () => {
    // A value written by an older/newer build, a partial write, or a
    // SecureStore miss must not be cast into a theme.
    for (const raw of [null, undefined, "", "Light", "auto", 1, {}, []]) {
      expect(parseThemePreference(raw)).toBeNull();
    }
  });

  it("pins the storage key, since changing it silently resets everyone", () => {
    expect(THEME_PREFERENCE_KEY).toBe("postwave.theme_pref");
  });
});

describe("resolving a known preference", () => {
  it("lets an explicit choice win over the OS scheme in both directions", () => {
    expect(resolveThemeName("light", "dark")).toBe("light");
    expect(resolveThemeName("dark", "light")).toBe("dark");
  });

  it("follows the OS only when the user asked it to", () => {
    expect(resolveThemeName("system", "light")).toBe("light");
    expect(resolveThemeName("system", "dark")).toBe("dark");
  });

  it("falls back to dark when the OS has not reported a scheme yet", () => {
    // useColorScheme() is documented to return null on some first paints.
    expect(resolveThemeName("system", null)).toBe("dark");
    expect(resolveThemeName("system", undefined)).toBe("dark");
  });
});

describe("first-paint gate (SHELL#50)", () => {
  it("returns null — paint nothing — while the preference is unknown", () => {
    // This is the whole fix. The old provider had this state and painted the
    // OS scheme through it, which is a dark frame on a system-dark device.
    expect(resolveFirstPaintTheme(null, "dark")).toBeNull();
    expect(resolveFirstPaintTheme(null, "light")).toBeNull();
    expect(resolveFirstPaintTheme(null, null)).toBeNull();
  });

  it("never paints dark for a light-preference user on a dark device", () => {
    // The exact reported symptom: preference 'light', system 'dark'.
    expect(resolveFirstPaintTheme("light", "dark")).toBe("light");
  });

  it("does not confuse an unknown preference with the 'system' answer", () => {
    // 'system' IS an answer and paints immediately; null is the absence of
    // one and must not resolve to the same thing.
    expect(resolveFirstPaintTheme("system", "dark")).toBe("dark");
    expect(resolveFirstPaintTheme(null, "dark")).not.toBe("dark");
  });
});
