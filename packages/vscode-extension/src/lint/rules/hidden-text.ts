// SPDX-License-Identifier: MIT
import type { LintFinding, LintRule } from "./types.js";

/**
 * Hidden text — historically used for keyword stuffing — is one of
 * the strongest spam signals. Flags `display: none`, `visibility:
 * hidden`, off-screen positioning, and white-on-white / transparent
 * text colors.
 */
const PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /display\s*:\s*['"]?none['"]?/gi, reason: "display: none" },
  { re: /visibility\s*:\s*['"]?hidden['"]?/gi, reason: "visibility: hidden" },
  {
    re: /position\s*:\s*['"]?absolute['"]?[^;}]*(?:left|top)\s*:\s*['"]?-\d{3,}/gi,
    reason: "off-screen positioning",
  },
  {
    re: /color\s*:\s*['"]?(?:#fff(?:fff)?|white|transparent|rgba?\([^)]*,\s*0(?:\.0+)?\s*\))['"]?/gi,
    reason: "invisible text color",
  },
];

export const hiddenText: LintRule = (source) => {
  const out: LintFinding[] = [];
  for (const { re, reason } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      out.push({
        ruleId: "postwave/hidden-text",
        message: `${reason} is a strong spam signal. Remove or use a non-hidden equivalent.`,
        start: m.index,
        end: m.index + m[0].length,
        severity: "warning",
      });
    }
  }
  return out;
};
