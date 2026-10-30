// SPDX-License-Identifier: AGPL-3.0-only
//
// Source with comments removed.
//
// Three guards in this suite have now failed on their own prose. A test that
// asserts a file no longer contains `aria-label="Copy code"` will match the
// comment explaining why that label was wrong; a test that asserts
// `closeSearch()` precedes `HTMLInputElement` will match the sentence naming
// HTMLInputElement above the code. The better the comment explaining a fix,
// the more likely it is to defeat the check for that fix.
//
// So: strip comments before asserting on code. Only the vitest `include` glob
// (src/__tests__/ ** /*.test.ts) is collected as tests, so this module sits
// here as a plain helper without being run as a suite.

/**
 * Remove `/* … *\/` blocks and `//` line comments.
 *
 * The line-comment pattern requires the `//` to start a line or follow
 * whitespace, so `https://…` inside a string survives — URLs in source are
 * exactly the thing a naive stripper eats.
 */
export function visibleCode(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");
}
