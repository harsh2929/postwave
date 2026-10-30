/**
 * `useTickingNow(active)` gates its 1 Hz interval on the caller's focus flag,
 * because Expo Router keeps every visited tab MOUNTED. A tab the user
 * navigated away from still renders; without the gate its clock keeps ticking
 * and re-rendering that whole screen once a second, forever, in the
 * background.
 *
 * Passing a literal `true` disables the gate the hook exists to provide. It
 * also defeats React.memo on any row that takes `now` as a prop: the value
 * changes every second, so memoised rows re-render every second too. On the
 * landing-page detail sheet that meant 5,000 lead rows re-rendering at 1 Hz.
 *
 * `dashboard.tsx` and `subscriber-imports.tsx` always passed `useIsFocused()`,
 * so this is a consistency gate around a pattern the codebase already had.
 *
 * Legitimate non-focus arguments are fine and common — visibility of a sheet
 * (`props.visible`), or a data-driven condition (`hasPendingExpiry`). Only a
 * hardcoded literal is banned, because it can never be false.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const APP_ROOT = join(__dirname, "..", "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/u.test(entry) && !/\.test\.tsx?$/u.test(entry)) out.push(full);
  }
  return out;
}

describe("useTickingNow is always focus-gated", () => {
  const files = [
    ...sourceFiles(join(APP_ROOT, "src")),
    ...sourceFiles(join(APP_ROOT, "app")),
  ];

  it("finds the call sites at all", () => {
    // Vacuity floor: a rename would make the assertion below pass while
    // proving nothing.
    const callers = files.filter((f) =>
      /useTickingNow\(/u.test(readFileSync(f, "utf8")),
    );
    expect(callers.length).toBeGreaterThan(5);
  });

  it("passes no hardcoded literal as the active flag", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const match of src.matchAll(/useTickingNow\(\s*(true|false)\s*\)/gu)) {
        offenders.push(`${file.replace(APP_ROOT, "")}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
