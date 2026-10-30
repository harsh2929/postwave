// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState } from "react";
import { Monitor, Smartphone } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Rendered email preview (CAMP-007 / CAMP-046). Renders the campaign HTML in a
 * sandboxed iframe via `srcDoc` with a desktop/mobile width toggle so authors
 * see the message without sending a test. The iframe is fully sandboxed (no
 * `allow-scripts`, no `allow-same-origin`) so hostile campaign HTML can't touch
 * the app; links are neutralised to open in a new tab.
 */
type Device = "desktop" | "mobile";

const MOBILE_WIDTH = 390;

export function EmailPreview({
  html,
  emptyLabel = "Nothing to preview yet — add some content above.",
  className,
}: {
  html: string;
  emptyLabel?: string;
  className?: string;
}) {
  const [device, setDevice] = useState<Device>("desktop");
  const trimmed = html?.trim() ?? "";

  const srcDoc =
    `<!doctype html><html><head><meta charset="utf-8" />` +
    `<meta name="viewport" content="width=device-width, initial-scale=1" />` +
    `<base target="_blank" />` +
    `<style>body{margin:0;padding:16px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;background:#fff;word-break:break-word;}img{max-width:100%;height:auto;}</style>` +
    `</head><body>${trimmed}</body></html>`;

  return (
    <section className={cn("rounded-md border bg-card p-4", className)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Preview</h2>
        <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Preview width">
          <Button
            type="button"
            variant={device === "desktop" ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={device === "desktop"}
            onClick={() => setDevice("desktop")}
          >
            <Monitor className="h-4 w-4" />
            Desktop
          </Button>
          <Button
            type="button"
            variant={device === "mobile" ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={device === "mobile"}
            onClick={() => setDevice("mobile")}
          >
            <Smartphone className="h-4 w-4" />
            Mobile
          </Button>
        </div>
      </div>
      {trimmed ? (
        <div className="flex justify-center overflow-x-auto rounded-md border bg-muted/20 p-3">
          <iframe
            title="Email preview"
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={srcDoc}
            className="h-[520px] rounded bg-white shadow-sm transition-[width]"
            style={{
              width: device === "mobile" ? MOBILE_WIDTH : "100%",
              maxWidth: "100%",
            }}
          />
        </div>
      ) : (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          {emptyLabel}
        </p>
      )}
    </section>
  );
}
