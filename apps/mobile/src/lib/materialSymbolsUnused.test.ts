/**
 * The stub in metro.config.js that removes the Material Symbols icon font is
 * only safe while nothing in this app renders an `expo-symbols` <SymbolView>.
 *
 * THE FONT ARRIVES BY AN EDGE THE PACKAGE ROOT REDIRECT DOES NOT COVER.
 * `@expo-google-fonts/material-symbols/index.js` eagerly requires all seven
 * weights, so metro.config.js redirects that ROOT to the package's `useFonts`
 * submodule. But expo-symbols never imports the root: its Android fallback
 * reaches the face directly --
 *
 *   expo-symbols/build/utils.js
 *     -> ./android/weights/regular
 *          -> '@expo-google-fonts/material-symbols/400Regular'  (955,300 B)
 *
 * -- so the root redirect removed six weights and left the seventh. That one
 * face was 955,300 of the 2,473,300 font bytes in the Android export, against
 * a totalBytes budget it was blowing by 1,624,615.
 *
 * WHY NOTHING CAN REACH IT: expo-symbols is pulled in only by expo-router's
 * `native-tabs`. This app renders the classic <Tabs> navigator in
 * app/(tabs)/_layout.tsx; `NativeTabs`, `SymbolView` and `expo-symbols` appear
 * nowhere in src/ or app/.
 *
 * Failure mode if that changes: icons render as blank boxes rather than
 * crashing (SymbolView shows an empty View while `loaded` is false, and with
 * the font stubbed it never loads). A silent blank icon is exactly the kind of
 * regression a build gate has to catch, because a human reviewing a diff that
 * adds <SymbolView> would have no reason to suspect the bundler.
 *
 * The fix when this fires is to delete MATERIAL_SYMBOLS_ANY from
 * metro.config.js and accept ~955 KB of Android assets.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const APP_ROOT = join(__dirname, "..", "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.[jt]sx?$/u.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Strip comments so prose ABOUT the forbidden symbols cannot fail the test. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
}

describe("Material Symbols icon font stays unreachable", () => {
  const files = [
    ...sourceFiles(join(APP_ROOT, "src")),
    ...sourceFiles(join(APP_ROOT, "app")),
  ].filter((f) => !f.endsWith("materialSymbolsUnused.test.ts"));

  it("scans a non-trivial number of source files", () => {
    // Vacuity floor #1: a broken walker would make every assertion below pass
    // by scanning nothing.
    expect(files.length).toBeGreaterThan(500);
  });

  it("renders the classic Tabs navigator, not NativeTabs", () => {
    // Vacuity floor #2: the stub is safe BECAUSE this app uses <Tabs>. If the
    // tab layout stops importing Tabs from expo-router, the premise is gone
    // and this guard is reasoning about a navigator that no longer exists.
    const layout = stripComments(
      readFileSync(join(APP_ROOT, "app", "(tabs)", "_layout.tsx"), "utf8"),
    );
    expect(layout).toMatch(/import\s*\{[^}]*\bTabs\b[^}]*\}\s*from\s*"expo-router"/u);
  });

  it("uses no expo-symbols API anywhere in app source", () => {
    const offenders = files.filter((f) => {
      const src = stripComments(readFileSync(f, "utf8"));
      return /\bexpo-symbols\b|\bSymbolView\b|\bNativeTabs\b/u.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("keeps the stub wired in metro.config.js", () => {
    // The other half: nothing using SymbolView only helps while the stub exists.
    const metro = stripComments(
      readFileSync(join(APP_ROOT, "metro.config.js"), "utf8"),
    );
    expect(metro).toContain("MATERIAL_SYMBOLS_ANY");
    // And it must still be APPLIED, not merely declared.
    expect(metro).toMatch(/MATERIAL_SYMBOLS_ANY\.test\(moduleName\)/u);
  });

  it("resolves no phantom package while loading the Metro config", () => {
    // The redirect this stub replaced called require.resolve() on
    // @expo-google-fonts/material-symbols at CONFIG LOAD TIME. Nothing declares
    // that package -- it exists only because expo-router pulls in expo-symbols.
    // So an expo-router upgrade that dropped or restructured expo-symbols would
    // throw while loading metro.config.js and break EVERY bundle (dev, CI and
    // release) with an error pointing at Metro instead of at the upgrade.
    // A regex stub needs no resolution, so keep it that way.
    const metro = stripComments(
      readFileSync(join(APP_ROOT, "metro.config.js"), "utf8"),
    );
    expect(metro).not.toContain("@expo-google-fonts/material-symbols");
  });
});
