// SPDX-License-Identifier: MIT
import type { LintFinding, LintRule } from "./types.js";

/**
 * Outlook (Word renderer) does not support modern CSS layout. Flag any
 * `display: flex`, `display: grid`, or `gap:` style declarations
 * encountered in the source, whether they appear in inline `style="…"`
 * attributes, JSX `style={{…}}` objects, or `<style>` blocks.
 */
const PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /display\s*:\s*['"]?flex['"]?/gi, reason: "display: flex" },
  { re: /display\s*:\s*['"]?grid['"]?/gi, reason: "display: grid" },
  { re: /(?<![a-zA-Z])gap\s*:\s*['"]?[^;'"}\n]+/gi, reason: "gap" },
  { re: /flex-(?:direction|wrap|grow|shrink|basis)\s*:/gi, reason: "flex-*" },
  { re: /grid-(?:template|area|column|row)[a-z-]*\s*:/gi, reason: "grid-*" },
];

export const outlookUnsupported: LintRule = (source) => {
  const out: LintFinding[] = [];
  for (const { re, reason } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      out.push({
        ruleId: "postwave/outlook-unsupported",
        message: `\`${reason}\` is not supported by Outlook (Word renderer). Use table layout instead.`,
        start: m.index,
        end: m.index + m[0].length,
        severity: "warning",
      });
    }
  }
  return out;
};
