import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  desktopShortcutById,
  formatShortcutBinding,
} from "../lib/desktop-shortcuts";

const tauriRoot = resolve(process.cwd(), "src-tauri/src");
const menuSource = readFileSync(resolve(tauriRoot, "menu.rs"), "utf8");
const globalSource = readFileSync(resolve(tauriRoot, "shortcut.rs"), "utf8");
const rendererRoot = resolve(process.cwd(), "src");

describe("native shortcuts consume the canonical renderer contract", () => {
  it.each([
    ["nav.dashboard", "CmdOrCtrl+1"],
    ["nav.approvals", "CmdOrCtrl+8"],
    ["native.new-campaign", "CmdOrCtrl+N"],
    ["native.settings", "CmdOrCtrl+,"],
    ["native.close-window", "CmdOrCtrl+W"],
    ["native.quit", "CmdOrCtrl+Q"],
  ])("keeps %s aligned with %s", (id, nativeAccelerator) => {
    const definition = desktopShortcutById(id);
    expect(definition).not.toBeNull();
    expect(menuSource).toContain(`Some("${nativeAccelerator}")`);
    expect(formatShortcutBinding(definition!.binding, "macos")).toContain("⌘");
    expect(formatShortcutBinding(definition!.binding, "windows")).toContain(
      "Ctrl+",
    );
  });

  it("keeps the opt-in OS-global quick-compose accelerator aligned", () => {
    expect(globalSource).toContain(
      'QUICK_COMPOSE_ACCELERATOR: &str = "CmdOrCtrl+Shift+P"',
    );
    expect(
      formatShortcutBinding(
        desktopShortcutById("native.quick-compose")!.binding,
        "windows",
      ),
    ).toBe("Ctrl+Shift+P");
  });

  it("keeps shell consumers on semantic registry projections", () => {
    const app = readFileSync(resolve(rendererRoot, "App.tsx"), "utf8");
    const routes = readFileSync(
      resolve(rendererRoot, "lib/desktop-routes.ts"),
      "utf8",
    );
    const help = readFileSync(
      resolve(rendererRoot, "components/tour/TourLauncher.tsx"),
      "utf8",
    );
    const account = readFileSync(
      resolve(rendererRoot, "components/AccountMenu.tsx"),
      "utf8",
    );
    expect(app).toContain("createDesktopShortcutDispatcher");
    expect(app).not.toContain("NUMERIC_SECTIONS");
    expect(app).not.toContain("LETTER_SECTIONS");
    expect(app).not.toContain("GOTO_SECTIONS");
    expect(routes).not.toMatch(/kbd:\s*["'](?:⌘|Ctrl)/);
    expect(help).not.toContain('e.key === "/"');
    expect(account).toContain('onSettings("keyboard-shortcuts")');
    expect(account).toContain(
      'navigateDesktopRoute({ section: "settings", settingsAnchor })',
    );
    expect(account).not.toContain("docs.moosewave.com/keyboard-shortcuts");
  });
});
