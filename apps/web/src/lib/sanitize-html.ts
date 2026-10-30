// SPDX-License-Identifier: AGPL-3.0-only
//
// Server-only HTML sanitizer for operator-authored campaign bodies rendered on
// the public archive surface. This remains scoped to trusted-operator archive
// content, not arbitrary user comments, but uses a real parser-backed sanitizer
// rather than ad hoc string rewriting.

import sanitizeHtml from "sanitize-html";

const SAFE_CSS_VALUE =
  /^(?!.*(?:expression\s*\(|url\s*\(|@import|javascript:|data:|vbscript:))[-#(),.%\w\s]+$/i;

const ARCHIVE_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    "img",
    "picture",
    "source",
    "center",
    "font",
    "del",
    "ins",
  ],
  allowedAttributes: {
    "*": ["title", "dir", "lang", "style"],
    a: ["href", "name", "target", "title", "rel"],
    blockquote: ["cite"],
    col: ["align", "span", "width"],
    colgroup: ["align", "span", "width"],
    font: ["color", "face", "size"],
    img: [
      "src",
      "srcset",
      "alt",
      "title",
      "width",
      "height",
      "loading",
      "decoding",
    ],
    li: ["value"],
    ol: ["start", "type"],
    q: ["cite"],
    pre: ["tabindex"],
    source: ["src", "srcset", "media", "type", "width", "height"],
    table: [
      "align",
      "border",
      "cellpadding",
      "cellspacing",
      "summary",
      "tabindex",
      "width",
    ],
    td: ["align", "colspan", "headers", "height", "rowspan", "valign", "width"],
    th: [
      "align",
      "colspan",
      "headers",
      "height",
      "rowspan",
      "scope",
      "valign",
      "width",
    ],
    time: ["datetime"],
    ul: ["type"],
  },
  allowedStyles: {
    "*": {
      "background-color": [SAFE_CSS_VALUE],
      border: [SAFE_CSS_VALUE],
      "border-bottom": [SAFE_CSS_VALUE],
      "border-collapse": [SAFE_CSS_VALUE],
      "border-color": [SAFE_CSS_VALUE],
      "border-left": [SAFE_CSS_VALUE],
      "border-radius": [SAFE_CSS_VALUE],
      "border-right": [SAFE_CSS_VALUE],
      "border-spacing": [SAFE_CSS_VALUE],
      "border-top": [SAFE_CSS_VALUE],
      color: [SAFE_CSS_VALUE],
      display: [SAFE_CSS_VALUE],
      "font-family": [SAFE_CSS_VALUE],
      "font-size": [SAFE_CSS_VALUE],
      "font-style": [SAFE_CSS_VALUE],
      "font-weight": [SAFE_CSS_VALUE],
      height: [SAFE_CSS_VALUE],
      "letter-spacing": [SAFE_CSS_VALUE],
      "line-height": [SAFE_CSS_VALUE],
      margin: [SAFE_CSS_VALUE],
      "margin-bottom": [SAFE_CSS_VALUE],
      "margin-left": [SAFE_CSS_VALUE],
      "margin-right": [SAFE_CSS_VALUE],
      "margin-top": [SAFE_CSS_VALUE],
      "max-width": [SAFE_CSS_VALUE],
      padding: [SAFE_CSS_VALUE],
      "padding-bottom": [SAFE_CSS_VALUE],
      "padding-left": [SAFE_CSS_VALUE],
      "padding-right": [SAFE_CSS_VALUE],
      "padding-top": [SAFE_CSS_VALUE],
      "text-align": [SAFE_CSS_VALUE],
      "text-decoration": [SAFE_CSS_VALUE],
      "vertical-align": [SAFE_CSS_VALUE],
      "white-space": [SAFE_CSS_VALUE],
      width: [SAFE_CSS_VALUE],
    },
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  nonTextTags: [
    "script",
    "style",
    "textarea",
    "option",
    "xmp",
    "noscript",
    "iframe",
    "object",
    "embed",
    "form",
    "input",
    "select",
    "button",
    "link",
    "meta",
    "base",
    "applet",
    "frame",
    "frameset",
    "svg",
    "math",
  ],
  parseStyleAttributes: true,
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs:
        attribs.target === "_blank"
          ? { ...attribs, rel: "noopener noreferrer" }
          : attribs,
    }),
    // Archive CSS deliberately lets wide authored tables and code samples
    // scroll inside the article instead of widening the phone viewport. Make
    // those native scroll containers keyboard reachable too; forcing zero
    // also prevents authored positive tabindex values from reshaping the page's
    // tab order.
    pre: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, tabindex: "0" },
    }),
    table: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, tabindex: "0" },
    }),
  },
};

/**
 * Sanitize one campaign body for public archive render. Idempotent — calling
 * twice yields the same result.
 */
export function sanitizeArchiveHTML(html: string): string {
  if (!html) return "";
  return sanitizeHtml(html, ARCHIVE_SANITIZE_OPTIONS);
}
