import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const nativeRoot = resolve(import.meta.dirname, "../../../src-tauri/src");
const readNative = (file: string): string =>
  readFileSync(resolve(nativeRoot, file), "utf8");

describe("native desktop hide lifecycle", () => {
  it("hides and restores the whole macOS application instead of a lone window", () => {
    const lifecycle = readNative("window_lifecycle.rs");

    expect(lifecycle).toMatch(
      /#\[cfg\(target_os = "macos"\)\][\s\S]*?window\s*\.app_handle\(\)\s*\.hide\(\)/,
    );
    expect(lifecycle).toMatch(
      /pub fn reveal_main_window[\s\S]*?#\[cfg\(target_os = "macos"\)\][\s\S]*?app\.show\(\)/,
    );
    expect(lifecycle).toMatch(
      /#\[cfg\(not\(target_os = "macos"\)\)\][\s\S]*?window\s*\.hide\(\)/,
    );
    expect(lifecycle).toContain("pub async fn desktop_window_hide");
    expect(lifecycle).toContain(".set_fullscreen(false)");
    expect(lifecycle).toContain("FULLSCREEN_EXIT_STABLE_SAMPLES");
    expect(lifecycle).toContain(
      "leave_macos_fullscreen_and_wait_for_stable_frame(&window).await?",
    );
  });

  it("routes every post-hide activation through the application-aware reveal", () => {
    expect(readNative("main.rs")).toContain(
      "window_lifecycle::reveal_main_window(app);",
    );
    expect(readNative("shortcut.rs")).toContain(
      "crate::window_lifecycle::reveal_main_window(app);",
    );
    expect(readNative("tray.rs")).toContain(
      "crate::window_lifecycle::reveal_main_window(app);",
    );
  });
});
