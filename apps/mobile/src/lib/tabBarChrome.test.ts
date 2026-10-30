import { describe, expect, it } from "vitest";
import { dark, light } from "@postwave/design-tokens";

import { tabBarScreenOptions } from "./tabBarChrome";
import { TAB_BAR_BASE_HEIGHT } from "./typeScale";

const base = { t: dark, bottomInset: 0, fontScale: 1 };

describe("tab bar height is derived, never a literal", () => {
  it("matches the historical 60 at the default text size", () => {
    // No visual change for the overwhelming majority of users.
    expect(tabBarScreenOptions(base).tabBarStyle.height).toBe(
      TAB_BAR_BASE_HEIGHT,
    );
  });

  it("grows with the OS text scale so the label cannot clip", () => {
    const normal = tabBarScreenOptions(base).tabBarStyle.height;
    const large = tabBarScreenOptions({ ...base, fontScale: 2 }).tabBarStyle
      .height;
    expect(large).toBeGreaterThan(normal);
  });

  it("is bounded by the tabLabel role's own ceiling", () => {
    // Unbounded, a 3x label would add ~26pt and shoulder the icon out.
    const huge = tabBarScreenOptions({ ...base, fontScale: 5 }).tabBarStyle
      .height;
    expect(huge).toBeLessThanOrEqual(TAB_BAR_BASE_HEIGHT + 8);
  });

  it("never shrinks below the base height on a down-scaled launcher", () => {
    // Some Android launchers report fontScale < 1; the touch target must hold.
    expect(
      tabBarScreenOptions({ ...base, fontScale: 0.8 }).tabBarStyle.height,
    ).toBeGreaterThanOrEqual(TAB_BAR_BASE_HEIGHT);
  });

  it("adds the safe-area inset on top of the content height", () => {
    const withInset = tabBarScreenOptions({ ...base, bottomInset: 34 });
    expect(withInset.tabBarStyle.height).toBe(TAB_BAR_BASE_HEIGHT + 34);
    expect(withInset.tabBarStyle.paddingBottom).toBe(34);
  });
});

describe("tab bar chrome tracks the theme", () => {
  it("takes its colours from the active palette, not a constant", () => {
    const d = tabBarScreenOptions({ ...base, t: dark });
    const l = tabBarScreenOptions({ ...base, t: light });
    expect(d.tabBarStyle.backgroundColor).toBe(dark.bgSubtle);
    expect(l.tabBarStyle.backgroundColor).toBe(light.bgSubtle);
    expect(d.tabBarActiveTintColor).not.toBe(l.tabBarActiveTintColor);
    expect(d.tabBarInactiveTintColor).toBe(dark.fgMuted);
    expect(l.tabBarInactiveTintColor).toBe(light.fgMuted);
  });

  it("carries the label's font-scale ceiling as a PROP, not inside the style", () => {
    // maxFontSizeMultiplier in a style object silently does nothing — it must
    // sit alongside tabBarLabelStyle, not within it.
    const opts = tabBarScreenOptions(base);
    expect(opts.maxFontSizeMultiplier).toBeGreaterThan(1);
    expect(
      (opts.tabBarLabelStyle as Record<string, unknown>).maxFontSizeMultiplier,
    ).toBeUndefined();
  });
});
