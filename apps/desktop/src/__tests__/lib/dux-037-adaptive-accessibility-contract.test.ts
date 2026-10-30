import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");

describe("DUX-037 adaptive desktop contract", () => {
  it("pins the supported default and minimum native window geometry", () => {
    const config = JSON.parse(read("src-tauri/tauri.conf.json")) as {
      app: { windows: Array<Record<string, unknown>> };
    };
    expect(config.app.windows[0]).toMatchObject({
      width: 1100,
      height: 720,
      minWidth: 880,
      minHeight: 560,
      resizable: true,
    });

    const nativeContract = read("src-tauri/src/window_lifecycle.rs");
    expect(nativeContract).toContain('assert_eq!(window["minWidth"], 880)');
    expect(nativeContract).toContain('assert_eq!(window["minHeight"], 560)');
  });

  it("keeps System separate from the resolved palette and listens live", () => {
    const store = read("src/lib/store.ts");
    expect(store).toContain('export type ThemePreference = Theme | "system"');
    expect(store).toContain('query.addEventListener("change"');
    expect(store).toContain("query?.addListener?.(onSystemThemeChange)");
    expect(store).toContain('window.addEventListener?.("storage"');
    expect(store).toContain('data-theme-preference');

    const settings = read("src/pages/Settings.tsx");
    expect(settings).toContain('["system", "light", "dark"] as const');
    expect(settings).toContain("setThemePreference(choice)");
    expect(settings).toContain("System follows operating");
  });

  it("retains global reduced-motion and forced-colors safeguards", () => {
    const overlays = read("src/styles/shared-overlays.css");
    expect(overlays).toContain("@media (prefers-reduced-motion: reduce)");
    expect(overlays).toContain("@media (forced-colors: active)");
    expect(overlays).toContain("outline: 2px solid Highlight !important");
  });

  it("pins actual-minimum and high-zoom layout-proxy renderer checks", () => {
    const shell = read("src/styles/shell-components.css");
    expect(shell).toContain("min-height: 0;");
    expect(shell).toContain(".sidebar-callout {");
    expect(shell).toContain("display: none;");

    const status = read("src/styles/shared-overlays.css");
    expect(status).toContain("@media (max-width: 700px)");
    expect(status).toContain(".statusbar-version");

    const renderer = read("tests/visual/shell-scroll.spec.ts");
    expect(renderer).toContain("width: 880, height: 560");
    expect(renderer).toContain("width: 440, height: 280");
  });
});
