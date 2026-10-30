// SPDX-License-Identifier: MIT
import type { LintFinding, LintRule } from "./types.js";

/**
 * Every image in an email must carry an `alt` attribute. Most clients
 * block images by default; the alt text is the only fallback. Matches
 * `<img …>`, `<Image …>`, and `<mj-image …>` opening tags that lack
 * an `alt=` attribute.
 */
const TAG_RE = /<(img|Image|mj-image)\b([^>]*?)\/?\s*>/g;
const ALT_RE = /\balt\s*=/i;

export const missingAlt: LintRule = (source) => {
  const out: LintFinding[] = [];
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(source)) !== null) {
    const attrs = m[2] ?? "";
    if (!ALT_RE.test(attrs)) {
      out.push({
        ruleId: "postwave/missing-alt",
        message: `<${m[1]}> is missing an \`alt\` attribute. Required for accessibility and image-blocked clients.`,
        start: m.index,
        end: m.index + m[0].length,
        severity: "warning",
      });
    }
  }
  return out;
};
