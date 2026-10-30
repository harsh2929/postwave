// SPDX-License-Identifier: MIT
import { hiddenText } from "./hidden-text.js";
import { imageRatio } from "./image-ratio.js";
import { missingAlt } from "./missing-alt.js";
import { obfuscatedSpam } from "./obfuscated-spam.js";
import { outlookUnsupported } from "./outlook-unsupported.js";
import { tinyFont } from "./tiny-font.js";
import type { LintFinding, LintRule } from "./types.js";

export const ALL_RULES: LintRule[] = [
  outlookUnsupported,
  missingAlt,
  imageRatio,
  hiddenText,
  tinyFont,
  obfuscatedSpam,
];

export const MAX_LINT_SOURCE_CHARS = 500_000;

/** Run every rule against the given source and return the merged findings. */
export function runAllRules(source: string): LintFinding[] {
  if (source.length > MAX_LINT_SOURCE_CHARS) {
    return [
      {
        ruleId: "postwave/document-too-large",
        message: `Moosewave skipped deliverability lint because this document is larger than ${MAX_LINT_SOURCE_CHARS.toLocaleString()} characters.`,
        start: 0,
        end: Math.min(source.length, 1),
        severity: "info",
      },
    ];
  }

  const out: LintFinding[] = [];
  for (const rule of ALL_RULES) {
    out.push(...rule(source));
  }
  return out;
}

export type { LintFinding, LintRule } from "./types.js";
