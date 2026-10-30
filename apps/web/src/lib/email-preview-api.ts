// SPDX-License-Identifier: AGPL-3.0-only
//
// Typed client for the multi-client email preview endpoint.
// Backend: apps/api/internal/emailpreview/handlers.go (Render).
//
// The endpoint takes MJML + a vars map, renders once, and applies four
// per-client transforms server-side. We surface those as
// EmailPreviewResponse below; consumer components pick the active tab
// and feed the chosen HTML into an iframe srcDoc.

import { api } from "@/lib/api";

export type EmailClientId = "gmail" | "outlook" | "apple" | "dark";

export interface EmailPreviewResponse {
  /** Per-client HTML, keyed by client id. Each value is a complete HTML doc. */
  previews: Record<EmailClientId, string>;
  /**
   * Non-fatal observations from the render pipeline — e.g. "stub renderer
   * used" or "unmatched template variable: firstname". Surface these in
   * the UI so reviewers know what they're looking at.
   */
  warnings: string[];
}

export interface RenderEmailPreviewInput {
  mjml: string;
  vars?: Record<string, string>;
}

/**
 * Render an MJML+vars combo into per-client HTML approximations.
 *
 * Body cap: 1 MiB (server enforces). Tenant-scoped — calls go through
 * the standard tenant header / bearer flow in lib/api.ts.
 */
export function renderEmailPreview(
  input: RenderEmailPreviewInput,
): Promise<EmailPreviewResponse> {
  return api.post<EmailPreviewResponse>("/api/v1/email-preview/render", {
    mjml: input.mjml,
    vars: input.vars ?? {},
  });
}

/** UI-friendly metadata for each tab. Centralized so the component and
 *  any future surface (e.g. campaign editor) agree on labels + viewports. */
export const EMAIL_CLIENTS: ReadonlyArray<{
  id: EmailClientId;
  label: string;
  description: string;
  /** iframe width in CSS px — matches the documented viewport for the
   *  client's "default" reading surface. */
  viewportWidth: number;
}> = [
  {
    id: "gmail",
    label: "Gmail web",
    description: "Strips <style>; sans-serif default; 600px content width.",
    viewportWidth: 600,
  },
  {
    id: "outlook",
    label: "Outlook desktop",
    description: "Word rendering engine; ignores border-radius, flex, gap.",
    viewportWidth: 580,
  },
  {
    id: "apple",
    label: "Apple Mail (iOS)",
    description: "WebKit; permissive; 375px mobile viewport.",
    viewportWidth: 375,
  },
  {
    id: "dark",
    label: "Dark mode",
    description: "prefers-color-scheme: dark — Apple Mail / Outlook.com.",
    viewportWidth: 600,
  },
];
