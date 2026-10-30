// SPDX-License-Identifier: MIT
import type { LintFinding, LintRule } from "./types.js";

/**
 * Anything under 9px is treated by spam filters as hidden text. Flags
 * `font-size:` declarations with explicit pixel values below the
 * threshold.
 */
const RE = /font-size\s*:\s*['"]?(\d+(?:\.\d+)?)px/gi;
const MIN_PX = 9;

export const tinyFont: LintRule = (source) => {
  const out: LintFinding[] = [];
  RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(source)) !== null) {
    const val = Number(m[1]);
    if (Number.isFinite(val) && val < MIN_PX) {
      out.push({
        ruleId: "postwave/tiny-font",
        message: `font-size: ${val}px is below ${MIN_PX}px and may be treated as hidden text by spam filters.`,
        start: m.index,
        end: m.index + m[0].length,
        severity: "warning",
      });
    }
  }
  return out;
};
