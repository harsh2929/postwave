import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SETTINGS_ANCHORS,
  settingsAnchorFromHeading,
} from "../../lib/desktop-router";
import {
  normalizeSettingsSearch,
  searchSettings,
  SETTINGS_CATEGORIES,
  SETTINGS_INFORMATION_ARCHITECTURE,
  settingsItemsForCategory,
} from "../../lib/settings-information-architecture";

describe("Settings information architecture", () => {
  it("source-discovers every mounted Settings section without an orphan heading", () => {
    const discovered = new Set<string>();
    const headingAnchors = new Set<string>();
    const unknownHeadings: string[] = [];
    for (const path of settingsSurfaceSources()) {
      const content = readFileSync(path, "utf8");
      const explicit = [
        ...content.matchAll(/\sdata-settings-anchor="([a-z][a-z0-9-]*)"/gu),
      ].map((match) => match[1] ?? "");
      explicit.forEach((anchor) => discovered.add(anchor));
      for (const heading of literalSettingsHeadings(content)) {
        const anchor = settingsAnchorFromHeading(heading);
        if (anchor) {
          discovered.add(anchor);
          headingAnchors.add(anchor);
        } else unknownHeadings.push(`${path}: ${heading}`);
      }
    }
    expect(unknownHeadings).toEqual([]);
    expect(discovered).toEqual(new Set(SETTINGS_ANCHORS));
    expect(headingAnchors).toEqual(new Set(SETTINGS_ANCHORS));
  });

  it("describes every routable setting exactly once with a canonical label", () => {
    expect(SETTINGS_INFORMATION_ARCHITECTURE).toHaveLength(
      SETTINGS_ANCHORS.length,
    );
    expect(
      new Set(SETTINGS_INFORMATION_ARCHITECTURE.map((item) => item.anchor)),
    ).toEqual(new Set(SETTINGS_ANCHORS));
    for (const item of SETTINGS_INFORMATION_ARCHITECTURE) {
      expect(settingsAnchorFromHeading(item.label)).toBe(item.anchor);
      expect(item.summary.length).toBeGreaterThan(20);
    }
  });

  it("keeps every category populated", () => {
    for (const category of SETTINGS_CATEGORIES) {
      expect(settingsItemsForCategory(category.id).length).toBeGreaterThan(0);
    }
  });

  it("rejects generic or hand-authored Settings contextual navigation", () => {
    const violations: string[] = [];
    for (const path of productionTypeScriptSources()) {
      const content = readFileSync(path, "utf8");
      const compact = content.replace(/\s+/gu, " ");
      const forbidden = [
        /setSection\(\s*["']settings["']/u,
        /navigateDesktopSection\(\s*["']settings["']/u,
        /requestDesktopRouteNavigation\(\s*\{\s*section:\s*["']settings["']\s*\}/u,
        /navigateDesktopRoute\(\s*\{\s*section:\s*["']settings["']\s*\}/u,
        /["']\/app\/settings\?anchor=/u,
      ];
      if (forbidden.some((pattern) => pattern.test(compact))) {
        violations.push(path);
      }
    }
    expect(violations).toEqual([]);
  });

  it("ranks labels first and supports task-oriented synonyms", () => {
    expect(searchSettings("api keys")[0]?.anchor).toBe("api-keys");
    expect(searchSettings("2FA")[0]?.anchor).toBe("security");
    expect(searchSettings("DNS")[0]?.anchor).toBe("archive-domain");
    expect(searchSettings("hide to tray")[0]?.anchor).toBe("desktop-window");
    expect(
      searchSettings("portable workspace download").map((item) => item.anchor),
    ).toContain("data-exports");
  });

  it("normalizes safely, bounds input, and returns no result for noise", () => {
    expect(normalizeSettingsSearch("  ÀPI---Keys  ")).toBe("api keys");
    expect(normalizeSettingsSearch("x".repeat(200))).toHaveLength(128);
    expect(searchSettings("definitely-not-a-setting")).toEqual([]);
    expect(searchSettings("api", 0)).toEqual([]);
  });
});

function settingsSurfaceSources(): string[] {
  const sourceRoot = resolve(import.meta.dirname, "../..");
  const settingsRoot = resolve(sourceRoot, "components/settings");
  return [
    resolve(sourceRoot, "pages/Settings.tsx"),
    resolve(sourceRoot, "components/dashboard/DigestPrefsSection.tsx"),
    resolve(sourceRoot, "components/webhooks/AlertPrefsSection.tsx"),
    ...readdirSync(settingsRoot)
      .filter((name) => name.endsWith(".tsx"))
      .map((name) => resolve(settingsRoot, name)),
  ];
}

function productionTypeScriptSources(): string[] {
  const root = resolve(import.meta.dirname, "../..");
  const sources: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") visit(path);
      } else if (/\.(?:ts|tsx)$/u.test(entry.name)) {
        sources.push(path);
      }
    }
  };
  visit(root);
  return sources;
}

function literalSettingsHeadings(content: string): string[] {
  const headings: string[] = [];
  const patterns = [
    /<h2\b[^>]*className="settings-section-title"[^>]*>([^<{]+)<\/h2>/gu,
    /<SettingsSectionHeader\b[^>]*title="([^"]+)"/gu,
    /<div\b[^>]*className="section-title"[^>]*>([^<{]+)<\/div>/gu,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const value = match[1]?.replace(/\s+/gu, " ").trim();
      if (value) headings.push(value);
    }
  }
  return headings;
}
