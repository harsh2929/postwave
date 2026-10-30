import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");
const layers = read("src/styles/overlay-layers.css");
const entry = read("src/styles.css");

function layerValue(name: string): number {
  const match = new RegExp(`--pw-layer-${name}:\\s*(\\d+);`).exec(layers);
  if (!match?.[1]) throw new Error(`Missing layer token: ${name}`);
  return Number(match[1]);
}

describe("DUX-023 overlay layer contract", () => {
  it("loads the authoritative scale after every other global stylesheet", () => {
    const imports = entry.trim().split(/\r?\n/);
    expect(imports.at(-1)).toBe('@import "./styles/overlay-layers.css";');
    expect(imports.filter((line) => line.includes("overlay-layers.css"))).toHaveLength(
      1,
    );
  });

  it("keeps painted order aligned with nested interaction order", () => {
    const ordered = [
      "popover",
      "drawer-backdrop",
      "drawer",
      "tour",
      "tour-content",
      "modal",
      "command",
      "tooltip",
      "toast",
      "diagnostics",
      "shortcut-hud",
    ].map(layerValue);

    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
    expect(new Set(ordered).size).toBe(ordered.length);
  });

  it("assigns every critical global layer to a named token", () => {
    for (const selector of [
      ".ws-menu",
      ".account-menu",
      ".notif-panel",
      ".transfer-center-panel",
      ".slideover-overlay",
      ".queue-tray-backdrop",
      ".tour-overlay",
      ".modal-backdrop",
      ".onboarding-backdrop",
      ".cmdk-overlay",
      ".inline-help-tooltip",
      ".toast-host",
      ".desktop-diagnostics-notice",
      ".shortcut-chord-hud",
    ]) {
      const escaped = selector.replace(".", "\\.");
      expect(layers).toMatch(
        new RegExp(`${escaped}[^{}]*\\{[^}]*z-index:\\s*var\\(--pw-layer-`, "s"),
      );
    }
    expect(layers).not.toMatch(/!important/);
  });

  it("bounds command and modal shells against dynamic viewport height", () => {
    expect(layers).toContain("--pw-command-top-offset: clamp(");
    expect(layers).toMatch(/\.cmdk\s*\{[^}]*100dvh/s);
    expect(layers).toContain("--pw-modal-top-offset: clamp(");
    expect(layers).toMatch(/\.modal-card\s*\{[^}]*100dvh/s);
  });
});
