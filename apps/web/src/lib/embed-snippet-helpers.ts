// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure builders + validation for the form embed snippets. Extracted from the
// embed-snippet component so the escaping, dimension validation (FORM-022), and
// popup frequency-cap / page-targeting attributes (FORM-037) are unit-tested
// without React. The snippet output must be correctly attribute-escaped.

export type EmbedMode = "iframe" | "popup" | "inline";

export type PopupTrigger =
  | "page-load"
  | "scroll-50"
  | "exit-intent"
  | "time-delay";

export interface EmbedOptions {
  width: string;
  height: string;
  trigger: PopupTrigger;
  delaySeconds: number;
  cssClass: string;
  /** FORM-037: don't re-show the popup for N days (0 = every visit). */
  frequencyDays: number;
  /** FORM-037: comma/space/newline-separated path prefixes the popup targets. */
  targetPaths: string;
}

export const DEFAULT_EMBED_OPTIONS: EmbedOptions = {
  width: "100%",
  height: "520",
  trigger: "page-load",
  delaySeconds: 5,
  cssClass: "",
  frequencyDays: 0,
  targetPaths: "",
};

/** HTML-attribute escape for snippet values. */
export function escapeSnippetAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Validate an iframe WIDTH: a bare number becomes `Npx`; a percentage, `auto`,
 * or a number with a CSS length unit passes through. Returns the normalized
 * value, or an error string for anything else — no silent coercion (FORM-022).
 */
export function normalizeWidth(raw: string): { value: string } | { error: string } {
  const v = raw.trim();
  if (!v) return { error: "Width is required." };
  if (/^\d+(\.\d+)?$/.test(v)) return { value: `${v}px` };
  if (v === "auto") return { value: v };
  if (/^\d+(\.\d+)?(px|%|em|rem|vw|vh)$/.test(v)) return { value: v };
  return {
    error: "Use a number (px) or a value like 100%, 480px, or auto.",
  };
}

/**
 * Validate an iframe HEIGHT: pixels only (a bare number → `N`, or `Npx`).
 * Percentages don't work for an iframe with no positioned parent, so they're
 * rejected rather than silently swapped for 520 (FORM-022).
 */
export function normalizeHeight(raw: string): { value: string } | { error: string } {
  const v = raw.trim();
  if (!v) return { error: "Height is required." };
  if (/^\d+$/.test(v)) return { value: v };
  const px = v.match(/^(\d+)px$/);
  if (px) return { value: px[1] };
  return { error: "Height must be a whole number of pixels (e.g. 520)." };
}

/** Split a free-form path-targeting string into clean path prefixes. */
export function parseTargetPaths(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p.startsWith("/") ? p : `/${p}`))
    .slice(0, 20);
}

function safeHost(host: string): string {
  return host.replace(/\/$/, "");
}

export function iframeSnippet(host: string, slug: string, o: EmbedOptions): string {
  const src = `${safeHost(host)}/forms/${encodeURIComponent(slug)}`;
  const width = normalizeWidth(o.width);
  const height = normalizeHeight(o.height);
  const w = "value" in width ? width.value : "100%";
  const h = "value" in height ? height.value : "520";
  return `<iframe
  src="${escapeSnippetAttr(src)}"
  width="${escapeSnippetAttr(w)}"
  height="${escapeSnippetAttr(h)}"
  frameborder="0"
  loading="lazy"
  referrerpolicy="strict-origin-when-cross-origin"
  sandbox="allow-forms allow-same-origin allow-scripts"
  style="border:0;max-width:100%;"
  title="Subscribe form"
></iframe>`;
}

export function popupSnippet(host: string, slug: string, o: EmbedOptions): string {
  const paths = parseTargetPaths(o.targetPaths);
  const freq = Math.max(0, Math.floor(o.frequencyDays || 0));
  const lines = [
    `  src="${escapeSnippetAttr(`${safeHost(host)}/embed.js`)}"`,
    `  data-postwave-form="${escapeSnippetAttr(slug)}"`,
    `  data-postwave-mode="popup"`,
    `  data-postwave-popup-trigger="${escapeSnippetAttr(o.trigger)}"`,
    `  data-postwave-popup-delay="${Math.max(0, Math.floor(o.delaySeconds || 0))}"`,
  ];
  if (freq > 0) lines.push(`  data-postwave-popup-frequency-days="${freq}"`);
  if (paths.length > 0) {
    lines.push(
      `  data-postwave-popup-paths="${escapeSnippetAttr(paths.join(","))}"`,
    );
  }
  lines.push("  defer");
  return `<script\n${lines.join("\n")}\n></script>`;
}

export function inlineSnippet(host: string, slug: string, o: EmbedOptions): string {
  const cls = o.cssClass ? ` ${o.cssClass}` : "";
  return `<div data-postwave-form="${escapeSnippetAttr(slug)}" class="${escapeSnippetAttr(
    `postwave-form${cls}`,
  )}"></div>
<script src="${escapeSnippetAttr(`${safeHost(host)}/embed.js`)}" defer></script>`;
}
