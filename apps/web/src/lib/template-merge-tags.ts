// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure helpers for reasoning about a template's `{{ merge tags }}` and running a
// lightweight, client-side pre-flight over its source. Kept JSX-free so the
// parsing/scan logic is synchronously unit-testable and shared across the
// detail page, the preview sample-data panel, and the pre-flight card
// (TMPL-014 / TMPL-023 / TMPL-027).

/** Matches a `{{ ... }}` double-mustache with no nested braces inside. */
const DOUBLE_MUSTACHE_RE = /\{\{([^{}]+)\}\}/g;
/** A bare merge key: letters, digits, underscore, dot, or hyphen. */
const MERGE_KEY_RE = /^[A-Za-z0-9_.-]+$/;
const CONDITIONAL_KEY_RE = /\{%\s*if\s+([A-Za-z0-9_.-]+)\s*%\}/g;

/**
 * Extract the distinct merge-tag keys referenced by `{{ tag }}` occurrences in
 * a template body, sorted for stable display. Handlebars block/section/partial/
 * comment/helper prefixes (`#`, `/`, `>`, `!`, `^`, `&`) are skipped, and for a
 * helper-style expression (`{{ name fallback }}`) only the leading token — the
 * merge key — is taken.
 */
export function extractMergeTags(source: string): string[] {
  const out = new Set<string>();
  for (const match of source.matchAll(DOUBLE_MUSTACHE_RE)) {
    const raw = match[1].trim();
    if (!raw || /^[#/>!^&]/.test(raw)) continue;
    const key = raw.split(/[|\s]+/)[0];
    if (MERGE_KEY_RE.test(key)) out.add(key);
  }
  return Array.from(out).sort((a, b) => a.localeCompare(b));
}

/** Truthy conditions use the same bare-key grammar as the send-time merge engine. */
export function extractConditionalKeys(source: string): string[] {
  return Array.from(new Set(Array.from(source.matchAll(CONDITIONAL_KEY_RE), (match) => match[1])))
    .sort((a, b) => a.localeCompare(b));
}

export interface TemplateVariableEntry {
  key: string;
  /** Default / example / value string, or "" when none is declared. */
  value: string;
}

/**
 * Enumerate a template's declared variables as `{ key, value }` rows, reading
 * the key from `key` | `name` and a sample from `default` | `example` | `value`.
 * Rows without a resolvable key are dropped; declaration order is preserved.
 */
export function templateVariableEntries(
  variables: Array<Record<string, unknown>> | undefined,
): TemplateVariableEntry[] {
  const entries: TemplateVariableEntry[] = [];
  for (const variable of variables ?? []) {
    const key =
      typeof variable.key === "string"
        ? variable.key
        : typeof variable.name === "string"
          ? variable.name
          : "";
    if (!key) continue;
    const sample = variable.default ?? variable.example ?? variable.value ?? "";
    entries.push({
      key,
      value: typeof sample === "string" ? sample : String(sample ?? ""),
    });
  }
  return entries;
}

export type PreflightStatus = "pass" | "warn";

export interface PreflightCheck {
  id:
    | "unsubscribe"
    | "image-alt"
    | "merge-tags"
    | "malformed-tags"
    | "placeholder-links"
    | "unsafe-links"
    | "link-text"
    | "conditional-syntax"
    | "subject"
    | "preview-text"
    | "message-size"
    | "compiled-render";
  label: string;
  status: PreflightStatus;
  detail: string;
}

const IMG_TAG_RE = /<(?:img|mj-image)\b[^>]*>/gi;
const ALT_ATTR_RE = /\balt\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i;

function altIsMissing(imgTag: string): boolean {
  // alt="" is correct for decorative images; only absence is provably wrong.
  return !ALT_ATTR_RE.test(imgTag);
}

export interface TemplatePreflightContext {
  subject: string;
  previewText: string;
  /** Current compiled HTML, or null while MJML is not cleanly compiled. */
  compiledHtml: string | null;
}

/**
 * The in-body unsubscribe placeholder spellings the send loop renders (the
 * same set as the API's unsubscribetoken package).
 */
const UNSUBSCRIBE_PLACEHOLDER_RE =
  /\{\{\s*(?:unsubscribe_url|Unsubscribe\.URL|UnsubscribeURL)\s*\}\}/;

/**
 * Run a lightweight template pre-flight, shifting the campaign-level checks left
 * to the template surface: unsubscribe/footer presence, image alt-text
 * coverage, the merge variables the template expects, and unbalanced mustache
 * braces. Returns one row per check with a pass/warn status and actionable
 * detail. Purely lexical — no DOM, so it runs anywhere and is testable.
 */
export function runTemplatePreflight(
  source: string,
  context?: TemplatePreflightContext,
): PreflightCheck[] {
  const checks: PreflightCheck[] = [];

  // Unsubscribe placeholder. Only the placeholder the send loop replaces with
  // each recipient's own link counts: the send gate refuses a fixed
  // unsubscribe URL, or the word "unsubscribe" with no link, so passing them
  // here would promise a send that is then blocked.
  const hasUnsubscribe = UNSUBSCRIBE_PLACEHOLDER_RE.test(source);
  checks.push({
    id: "unsubscribe",
    label: "Unsubscribe link",
    status: hasUnsubscribe ? "pass" : "warn",
    detail: hasUnsubscribe
      ? "The unsubscribe link uses {{ unsubscribe_url }}, so each recipient gets their own."
      : "Add an unsubscribe link that uses {{ unsubscribe_url }}. Campaigns without one can't be sent.",
  });

  // Image alt-text coverage.
  const imgs = source.match(IMG_TAG_RE) ?? [];
  const missingAlt = imgs.filter(altIsMissing).length;
  checks.push({
    id: "image-alt",
    label: "Image alt text",
    status: missingAlt === 0 ? "pass" : "warn",
    detail:
      imgs.length === 0
        ? "No images in the source."
        : missingAlt === 0
          ? `All ${imgs.length} image${imgs.length === 1 ? "" : "s"} have an alt attribute; review whether each description is useful.`
          : `${missingAlt} of ${imgs.length} image${imgs.length === 1 ? "" : "s"} missing an alt attribute. Use alt="" only for decorative images.`,
  });

  // Merge variables the template expects.
  const tags = extractMergeTags(source);
  checks.push({
    id: "merge-tags",
    label: "Merge variables",
    status: "pass",
    detail: tags.length
      ? `Supply ${tags.length} variable${tags.length === 1 ? "" : "s"} at send: ${tags.join(", ")}.`
      : "No merge variables to resolve.",
  });

  // Unbalanced mustache braces (a common source of literal `{{tag}}` in inboxes).
  const opens = (source.match(/\{\{/g) ?? []).length;
  const closes = (source.match(/\}\}/g) ?? []).length;
  checks.push({
    id: "malformed-tags",
    label: "Merge-tag syntax",
    status: opens === closes ? "pass" : "warn",
    detail:
      opens === closes
        ? "Merge-tag braces are balanced."
        : "Unbalanced merge-tag braces — a tag may render literally in the inbox.",
  });

  const hasPlaceholderLink =
    /\bhref\s*=\s*["'](?:#|https?:\/\/(?:www\.)?example\.(?:com|org)(?:\/[^"']*)?)["']/i.test(
      source,
    );
  checks.push({
    id: "placeholder-links",
    label: "Link destinations",
    status: hasPlaceholderLink ? "warn" : "pass",
    detail: hasPlaceholderLink
      ? "Replace example.com or # links with a real destination before sending."
      : "No obvious placeholder links found.",
  });

  const hrefs = Array.from(source.matchAll(/\bhref\s*=\s*["']([^"']*)["']/gi), (match) => match[1].trim());
  const unsafeLinks = hrefs.filter((href) => {
    if (/^(?:https:\/\/|mailto:|tel:|\{\{\s*[A-Za-z0-9_.-]+\s*\}\})/i.test(href)) return false;
    return true;
  });
  checks.push({
    id: "unsafe-links",
    label: "Link schemes",
    status: unsafeLinks.length ? "warn" : "pass",
    detail: unsafeLinks.length
      ? `${unsafeLinks.length} link${unsafeLinks.length === 1 ? "" : "s"} use a relative, insecure, or unsupported destination. Use HTTPS, mailto, tel, or a supported merge URL.`
      : "No insecure or unsupported link destinations detected.",
  });

  const ambiguousLinks = Array.from(source.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi), (match) => {
    const content = match[1];
    const text = content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    const imageAlt = Array.from(content.matchAll(/<img\b[^>]*\balt\s*=\s*["']([^"']*)["']/gi), (image) => image[1].trim()).join(" ");
    return `${text} ${imageAlt}`.trim();
  }).filter((text) => !text || /^(?:click here|here|link)$/i.test(text));
  checks.push({
    id: "link-text",
    label: "Accessible link labels",
    status: ambiguousLinks.length ? "warn" : "pass",
    detail: ambiguousLinks.length
      ? `${ambiguousLinks.length} link${ambiguousLinks.length === 1 ? "" : "s"} may be unlabeled or vague. Use descriptive text or meaningful image alt text.`
      : "No empty or obviously vague HTML link labels detected.",
  });

  let conditionalDepth = 0;
  // A half-typed directive is otherwise invisible to matchAll and can look
  // valid even though the send-time engine will not interpret it.
  let conditionalProblem = (source.match(/\{%/g) ?? []).length !==
    (source.match(/%\}/g) ?? []).length;
  for (const token of source.matchAll(/\{%\s*([^%]*?)\s*%\}/g)) {
    const expression = token[1].trim();
    if (expression.startsWith("if ")) {
      if (!/^if\s+[A-Za-z0-9_.-]+$/.test(expression)) conditionalProblem = true;
      conditionalDepth += 1;
      if (conditionalDepth > 1) conditionalProblem = true;
    } else if (expression === "endif") {
      conditionalDepth -= 1;
      if (conditionalDepth < 0) conditionalProblem = true;
    } else if (expression === "else" || expression.startsWith("elif ")) {
      conditionalProblem = true;
    }
  }
  if (conditionalDepth !== 0) conditionalProblem = true;
  checks.push({
    id: "conditional-syntax",
    label: "Conditional content",
    status: conditionalProblem ? "warn" : "pass",
    detail: conditionalProblem
      ? "Use balanced, non-nested {% if key %}…{% endif %} blocks. Else branches and comparisons are not supported by the send-time merge engine."
      : "Conditional blocks use the supported truthy-key syntax.",
  });

  if (context) {
    const subject = context.subject.trim();
    checks.push({
      id: "subject",
      label: "Inbox subject",
      status: subject ? "pass" : "warn",
      detail: subject
        ? `${[...subject].length} characters. Review the full subject in a real inbox.`
        : "Add a subject before saving or sending.",
    });
    checks.push({
      id: "preview-text",
      label: "Inbox preview text",
      status: context.previewText.trim() ? "pass" : "warn",
      detail: context.previewText.trim()
        ? "Preview text is set; verify it beside the subject in a test inbox."
        : "Add intentional preview text so the inbox does not pick up an unintended first line.",
    });
    const compiled = context.compiledHtml;
    checks.push({
      id: "compiled-render",
      label: "Current HTML render",
      status: compiled?.trim() ? "pass" : "warn",
      detail: compiled?.trim()
        ? "The current draft has an HTML render. This is not a test of the final MIME message."
        : "No clean HTML render of the current source is available yet.",
    });
    const bytes = compiled ? new TextEncoder().encode(compiled).byteLength : 0;
    checks.push({
      id: "message-size",
      label: "Rendered HTML size",
      status: !compiled || bytes > 100_000 ? "warn" : "pass",
      detail: compiled
        ? `${(bytes / 1024).toFixed(1)} KiB of HTML. ${bytes > 100_000 ? "Large messages may be clipped by inbox providers; inspect a real test send." : "Final MIME size may differ after tracking and personalization."}`
        : "Size will be available after a clean compile.",
    });
  }

  return checks;
}
