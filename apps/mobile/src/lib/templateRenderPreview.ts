/**
 * lib/templateRenderPreview.ts — see the design, not a description of it.
 *
 * The template sheet's own header calls browsing-a-shelf the job a phone is
 * best at, then shows metadata and a body-state sentence and never the design.
 * Desktop's TemplateDetailSlideover renders the body in an iframe with
 * device-width + light/dark toggles; this is the pure half of the mobile port
 * (the component wraps it in a script-disabled WebView).
 *
 * Client-side render only — GET /campaign-templates/{id} (viewer) already
 * carries the body; no server round-trip is added.
 *
 * `{{var}}` placeholders are left visible rather than blanked: a browser
 * choosing a design should see where the variable slots are.
 */
import { isolatedPreviewDocument } from "@/lib/campaignRenderPreview";

export interface TemplatePreviewMode {
  id: "mobile" | "desktop";
  label: string;
  width: number;
}

export const TEMPLATE_PREVIEW_MODES: readonly TemplatePreviewMode[] = [
  { id: "mobile", label: "Phone", width: 375 },
  { id: "desktop", label: "Desktop", width: 600 },
];

export type TemplatePreviewScheme = "light" | "dark";

/**
 * The template body wrapped for the WebView: lockdown CSP, viewport at the
 * chosen device width, and — for the dark toggle — a forced dark ground so
 * the operator sees how the design survives inversion-free dark clients.
 */
export function templatePreviewDocument(
  bodyHtml: string,
  mode: TemplatePreviewMode,
  scheme: TemplatePreviewScheme,
): string {
  const doc = isolatedPreviewDocument(bodyHtml, mode.width);
  if (scheme === "light") return doc;
  const darkStyle =
    "<style>:root{color-scheme:dark}body{background:#111!important;color:#eee}</style>";
  // Appended, not spliced: the same `<head`-shaped substring that let a
  // hostile document capture the CSP would capture this style too. `doc` is
  // already a wrapped document from isolatedPreviewDocument, so appending a
  // <style> at the end is applied by the parser and cannot be swallowed.
  return `${doc}${darkStyle}`;
}

/** True when there is anything to render at all. */
export function templateHasRenderableBody(
  bodyHtml: string | null | undefined,
): boolean {
  return typeof bodyHtml === "string" && bodyHtml.trim() !== "";
}
