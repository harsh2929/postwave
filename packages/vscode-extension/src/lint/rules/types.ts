// SPDX-License-Identifier: MIT

/**
 * A single lint finding produced by a rule. Pure data — no VSCode
 * dependency — so the rules can be reused in CI, in the dev server,
 * and in tests.
 */
export interface LintFinding {
  /** Stable rule identifier, used as the diagnostic `code`. */
  ruleId: string;
  /** Short human-readable message. */
  message: string;
  /** Zero-based offset in the source string where the issue starts. */
  start: number;
  /** Zero-based offset where the issue ends (exclusive). */
  end: number;
  /** Severity hint. The VSCode bridge always promotes to Warning. */
  severity: "warning" | "info";
}

export type LintRule = (source: string) => LintFinding[];
