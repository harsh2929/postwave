/**
 * Template handoff — a tiny module-level store that lets the Templates
 * page hand a `CampaignTemplate` to the Campaigns page when the user
 * clicks "Use in campaign".
 *
 * The Templates page calls `setPendingTemplate(t)` and then switches the
 * active section to "campaigns" via `setSection("campaigns")`. The
 * Campaigns page (when it mounts / when its create modal is about to
 * open) calls `consumePendingTemplate()` to take ownership of the value
 * once and atomically clear it. `consumePendingTemplate()` returns
 * `null` on subsequent reads so a stale handoff cannot bleed through.
 *
 * The Campaigns page consumes this when it opens the create flow and
 * pre-fills the draft exactly once.
 */

import type { CampaignTemplate } from "./api-client";

let pending: CampaignTemplate | null = null;

export function setPendingTemplate(t: CampaignTemplate | null): void {
  pending = t;
}

export function consumePendingTemplate(): CampaignTemplate | null {
  const t = pending;
  pending = null;
  return t;
}

export function peekPendingTemplate(): CampaignTemplate | null {
  return pending;
}

/* ---------- AI campaign-draft handoff ------------------------------- */

/**
 * A campaign draft produced by Moosewave AI (the chat panel). The AI page
 * stores one of these via `setPendingCampaignDraft`, then switches the
 * active section to "campaigns". The Campaigns page is expected to call
 * `consumePendingCampaignDraft()` once when its create modal would open
 * (alongside `consumePendingTemplate()`), and prefill the form fields.
 *
 * Same module-singleton pattern as the template handoff above:
 *   - exactly one consumer (the Campaigns page),
 *   - take-once / clear-on-read so a stale draft doesn't bleed through.
 *
 * Shape mirrors the New Campaign modal's required fields. `name` and
 * `subject` are recommended but the consumer should tolerate missing
 * fields by falling back to placeholders.
 */
export interface PendingCampaignDraft {
  name?: string;
  subject?: string;
  body?: string;
  preview_text?: string;
}

/**
 * Machine-readable marker shared with apps/api/internal/aidisclosure.
 * Direct chat drafts do not pass through the API Compose handler, so the
 * desktop stamps their HTML before the one-shot Campaigns handoff. Keep this
 * idempotent: Compose responses may already carry the same marker.
 */
export const AI_GENERATED_HTML_MARKER = "ai-generated:postwave";

const NON_CONTENT_AI_ELEMENTS =
  "script,style,template,noscript,iframe,frame,frameset,object,embed,svg,math,head";
const AI_BODY_BREAK_ELEMENTS =
  "address,article,aside,blockquote,div,dl,fieldset,figcaption,figure,footer,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,ol,p,pre,section,table,tr,ul";

function normalizeAIText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/\u00a0/gu, " ")
    .replace(/[\t ]+\n/gu, "\n")
    .replace(/\n[\t ]+/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function decodeFallbackEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_match, code: string) => {
      const point = Number.parseInt(code, 16);
      return Number.isSafeInteger(point) && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : "�";
    })
    .replace(/&#([0-9]+);/gu, (_match, code: string) => {
      const point = Number.parseInt(code, 10);
      return Number.isSafeInteger(point) && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : "�";
    })
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#(?:39|x27);/giu, "'");
}

function fallbackAITextProjection(value: string): string {
  return normalizeAIText(
    decodeFallbackEntities(
      value
        .replace(
          /<(script|style|template|noscript|iframe|frame|frameset|object|embed|svg|math|head)\b[^>]*>[\s\S]*?<\/\1\s*>/giu,
          "",
        )
        .replace(/<!--?[\s\S]*?-->/gu, "")
        .replace(/<br\s*\/?>/giu, "\n")
        .replace(
          /<\/?(?:address|article|aside|blockquote|div|dl|fieldset|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tr|ul)\b[^>]*>/giu,
          "\n",
        )
        .replace(/<[^>]*>/gu, ""),
    ),
  );
}

/**
 * Convert model-authored markup into the exact inert text a campaign editor
 * will receive. No model-provided element, URL, image, form, CSS, event
 * handler, or hidden document content crosses the desktop handoff boundary.
 */
export function projectAIGeneratedBodyText(value: string): string {
  if (typeof DOMParser === "undefined") return fallbackAITextProjection(value);
  try {
    const document = new DOMParser().parseFromString(value, "text/html");
    document
      .querySelectorAll(NON_CONTENT_AI_ELEMENTS)
      .forEach((element) => element.remove());
    document.querySelectorAll("br").forEach((element) => {
      element.replaceWith(document.createTextNode("\n"));
    });
    document.querySelectorAll(AI_BODY_BREAK_ELEMENTS).forEach((element) => {
      element.before(document.createTextNode("\n"));
      element.after(document.createTextNode("\n"));
    });
    return normalizeAIText(document.body.textContent ?? "");
  } catch {
    return fallbackAITextProjection(value);
  }
}

function escapeAIText(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function safeAITextHTML(value: string): string {
  const text = projectAIGeneratedBodyText(value);
  if (!text) return "<p></p>";
  return text
    .split(/\n{2,}/u)
    .map(
      (paragraph) =>
        `<p>${escapeAIText(paragraph).replace(/\n/gu, "<br>")}</p>`,
    )
    .join("\n");
}

export function markAIGeneratedHTML(
  html: string | undefined,
): string | undefined {
  if (html === undefined) return undefined;
  return `<!-- ${AI_GENERATED_HTML_MARKER} -->\n${safeAITextHTML(html)}`;
}

let pendingDraft: PendingCampaignDraft | null = null;

export function setPendingCampaignDraft(
  draft: PendingCampaignDraft | null,
): void {
  pendingDraft = draft;
}

export function consumePendingCampaignDraft(): PendingCampaignDraft | null {
  const d = pendingDraft;
  pendingDraft = null;
  return d;
}

export function peekPendingCampaignDraft(): PendingCampaignDraft | null {
  return pendingDraft;
}
