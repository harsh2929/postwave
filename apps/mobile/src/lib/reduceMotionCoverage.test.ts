import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Reduce-motion is honoured today by CONVENTION, not by anything structural:
 * `lib/motion.ts` exists precisely to be the seam, three components use it,
 * and the rest reach for `react-native-reanimated` directly and each remember
 * to read `AccessibilityInfo.isReduceMotionEnabled()` on their own. Nothing
 * catches the next author who forgets — and "forgot" here means a user who
 * asked the OS to stop animations gets them anyway, which for a vestibular
 * disorder is a health issue, not a polish one.
 *
 * This guard makes the seam enforceable: any module that animates must reach
 * the setting, through `useMotion` or reanimated's `useReducedMotion`.
 *
 * ONE SOURCE. Reading `AccessibilityInfo.isReduceMotionEnabled()` directly is
 * no longer an accepted form of awareness. Four components each re-implemented
 * that read plus a `reduceMotionChanged` listener -- the same fifteen lines,
 * four times, one of them racing the read against AsyncStorage -- and a fifth
 * would have copied it again. reanimated's hook is synchronous, OS-change-aware
 * and already the source the modal seam uses; the second test below forbids
 * the native read anywhere else. What a surface DOES with the answer is shared
 * too: `reducedMotion()` in @postwave/design-tokens.
 *
 * THE EXEMPTIONS ARE THE INTERESTING PART, so they are named, not silent:
 *
 *  - DIRECT MANIPULATION is exempt. A row that tracks the user's finger is
 *    not an animation playing AT the user; iOS keeps scrolling, sheet drags
 *    and swipe gestures moving under Reduce Motion for exactly this reason.
 *  - A LEAF whose CALLER owns the decision is exempt, because the decision
 *    still exists — it just lives one level up. Each entry says where.
 *
 * Add to `EXEMPT` only with a reason of that kind. "It looked fine" is not
 * one: the whole point is that the person raising the OS text/motion setting
 * is not in the room.
 */

const mobileRoot = process.cwd();

/** Modules that animate but legitimately do not read the setting themselves. */
const EXEMPT: Readonly<Record<string, string>> = {
  "src/lib/motion.ts": "IS the seam — it exposes the setting to everyone else.",
  "src/components/SwipeableRow.tsx":
    "Direct manipulation: the row tracks the finger and settles it. iOS keeps " +
    "swipe gestures moving under Reduce Motion.",
  "src/components/onboarding/ChecklistConfetti.tsx":
    "Leaf: OnboardingChecklist only mounts it when reduce-motion is off, so " +
    "the decision lives in exactly one place.",
};

/** Importing any of these means the module animates. */
const ANIMATION_IMPORTS = [
  "react-native-reanimated",
  "LayoutAnimation",
] as const;

/** Any of these means the module can see the user's preference. */
const AWARENESS_MARKERS = [
  "useMotion",
  "useReducedMotion",
  "reduceMotion",
  "reducedMotion",
] as const;

/** The native read and its listener: allowed nowhere. reanimated's hook is the
 *  one source, and a second copy of this is how the drift starts again. */
const DIRECT_NATIVE_READ = [
  "isReduceMotionEnabled(",
  '"reduceMotionChanged"',
] as const;

/** A native Modal animation must be routed through ReducedMotionModal. */
const NATIVE_MODAL_IMPORT =
  /import\s*\{[^}]*\bModal\b[^}]*\}\s*from\s*["']react-native["']/su;

/** Literal native transitions are the easy-to-miss accessibility regression. */
const HARDCODED_MODAL_ANIMATION =
  /\banimationType\s*=\s*(?:["'](?:fade|slide)["']|\{\s*["'](?:fade|slide)["']\s*\})/gu;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.isFile()) return [];
    if (!/\.tsx?$/u.test(path)) return [];
    if (/\.(?:test|spec)\.tsx?$/u.test(path)) return [];
    return [path];
  });
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
}

function repoPath(path: string): string {
  return relative(mobileRoot, path).split(sep).join("/");
}

describe("reduce-motion coverage", () => {
  it("every animating module can see the user's reduce-motion setting", () => {
    const files = [
      ...sourceFiles(join(mobileRoot, "app")),
      ...sourceFiles(join(mobileRoot, "src")),
    ];
    const offenders: string[] = [];
    for (const path of files) {
      const rel = repoPath(path);
      if (rel in EXEMPT) continue;
      const text = readFileSync(path, "utf8");
      const animates = ANIMATION_IMPORTS.some((marker) => text.includes(marker));
      if (!animates) continue;
      const aware = AWARENESS_MARKERS.some((marker) => text.includes(marker));
      if (!aware) {
        offenders.push(
          `${rel} animates but never reads reduce-motion — route it through ` +
            `lib/motion.ts (useMotion), or add a NAMED exemption if it is ` +
            `direct manipulation or a leaf whose caller decides.`,
        );
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("reads the preference from one source — never AccessibilityInfo directly", () => {
    const files = [
      ...sourceFiles(join(mobileRoot, "app")),
      ...sourceFiles(join(mobileRoot, "src")),
    ];
    const offenders: string[] = [];
    for (const path of files) {
      // Comments are stripped first. The fix for this very duplication
      // documents the old pattern in prose, and a guard that flags the
      // explanation of a removal reports the opposite of the truth.
      const text = stripComments(readFileSync(path, "utf8"));
      for (const marker of DIRECT_NATIVE_READ) {
        if (text.includes(marker)) {
          offenders.push(
            `${repoPath(path)} reads Reduce Motion from AccessibilityInfo (${marker}) — ` +
              "use useReducedMotion() from react-native-reanimated, the one source.",
          );
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("keeps the exemption list honest — every entry still animates", () => {
    const stale = Object.keys(EXEMPT).filter((rel) => {
      const text = readFileSync(join(mobileRoot, rel), "utf8");
      return !ANIMATION_IMPORTS.some((marker) => text.includes(marker));
    });
    // An exemption for a file that no longer animates is a licence nobody is
    // using, and the next edit inherits it silently.
    expect(stale, `stale exemptions: ${stale.join(", ")}`).toEqual([]);
  });

  it("never hardcodes an animated transition on a native Modal", () => {
    const files = [
      ...sourceFiles(join(mobileRoot, "app")),
      ...sourceFiles(join(mobileRoot, "src")),
    ];
    const offenders: string[] = [];

    for (const path of files) {
      const text = readFileSync(path, "utf8");
      if (!NATIVE_MODAL_IMPORT.test(text)) continue;

      const rel = repoPath(path);
      const declaresAnimation = /\banimationType\s*=/u.test(text);
      const aware = AWARENESS_MARKERS.some((marker) => text.includes(marker));
      if (declaresAnimation && !aware) {
        offenders.push(
          `${rel} configures a native Modal animation but cannot see Reduce ` +
            "Motion — use ReducedMotionModal or resolve the preference here.",
        );
      }
      for (const match of text.matchAll(HARDCODED_MODAL_ANIMATION)) {
        const line = text.slice(0, match.index).split("\n").length;
        offenders.push(
          `${rel}:${line} hardcodes a native Modal animation — use ` +
            "ReducedMotionModal, or resolve the animation to `none` when " +
            "Reduce Motion is enabled.",
        );
      }
    }

    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
