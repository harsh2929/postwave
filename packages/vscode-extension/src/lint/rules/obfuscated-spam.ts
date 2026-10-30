// SPDX-License-Identifier: MIT
import type { LintFinding, LintRule } from "./types.js";

/**
 * Common obfuscation patterns used to hide spam keywords from filters:
 *   - Zero-width characters (U+200B, U+200C, U+200D, U+FEFF) embedded
 *     inside words.
 *   - HTML numeric character entities standing in for plain ASCII
 *     letters (e.g. `F&#82;EE`).
 *   - Long runs of mixed-script Cyrillic look-alikes inside Latin
 *     words.
 */
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF]/g;
const NUMERIC_ENTITY_LETTER_RE = /&#(?:6[5-9]|[78]\d|9[0-9]|1[01]\d|12[0-2]);/g;
const CYRILLIC_LOOKALIKE_RE = /[A-Za-z][\u0400-\u04FF]+[A-Za-z]/g;

export const obfuscatedSpam: LintRule = (source) => {
  const out: LintFinding[] = [];

  ZERO_WIDTH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ZERO_WIDTH_RE.exec(source)) !== null) {
    out.push({
      ruleId: "postwave/obfuscated-spam",
      message: "Zero-width character detected. This is a common spam-obfuscation pattern.",
      start: m.index,
      end: m.index + m[0].length,
      severity: "warning",
    });
  }

  NUMERIC_ENTITY_LETTER_RE.lastIndex = 0;
  while ((m = NUMERIC_ENTITY_LETTER_RE.exec(source)) !== null) {
    out.push({
      ruleId: "postwave/obfuscated-spam",
      message: "Numeric HTML entity used in place of an ASCII letter. Spam filters flag this pattern.",
      start: m.index,
      end: m.index + m[0].length,
      severity: "warning",
    });
  }

  CYRILLIC_LOOKALIKE_RE.lastIndex = 0;
  while ((m = CYRILLIC_LOOKALIKE_RE.exec(source)) !== null) {
    out.push({
      ruleId: "postwave/obfuscated-spam",
      message: "Mixed Latin/Cyrillic word — likely homograph obfuscation.",
      start: m.index,
      end: m.index + m[0].length,
      severity: "warning",
    });
  }

  return out;
};
