// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Monitor, Moon, Smartphone, Sun } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type PreviewDevice = "desktop" | "mobile";

const PREVIEW_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; " +
  "font-src data:; media-src 'none'; connect-src 'none'; frame-src 'none'; " +
  "object-src 'none'; form-action 'none'; base-uri 'none'";

/**
 * Widths the template preview frames are drawn at. The desktop width sits
 * above the 620px breakpoint of the built-in designs' phone stylesheet, so
 * the desktop layout is what a desktop preview (or a card thumbnail) shows.
 */
export const DESKTOP_PREVIEW_WIDTH = 680;
const MOBILE_PREVIEW_WIDTH = 390;

/**
 * Build a deliberately network-silent email preview. `sandbox=""` removes
 * privileges, but it does not by itself stop remote images, CSS, fonts, or
 * tracking pixels from making requests. The document CSP closes that privacy
 * gap; source screenshots are rendered separately from Moosewave-owned assets.
 */
export function previewDocument(html: string, dark: boolean, imagesOff = false): string {
  const colorScheme = dark ? "dark" : "light";
  const head =
    `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">` +
    `<meta name="color-scheme" content="${colorScheme}">` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    (imagesOff ? '<style>img,mj-image{opacity:0!important}body{background-image:none!important}</style>' : "");
  // Prefix the policy before any caller markup. A regex that tries to inject
  // into the first <head> can match a commented or malformed decoy and leave
  // the actual document free to fetch tracking pixels.
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

export function TemplatePreviewFrame({
  html,
  title,
  className,
  compact = false,
}: {
  html: string;
  title: string;
  className?: string;
  compact?: boolean;
}) {
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const [dark, setDark] = useState(false);
  const [imagesOff, setImagesOff] = useState(false);
  const document = useMemo(() => previewDocument(html, dark, imagesOff), [dark, html, imagesOff]);
  const modeDescription = `${device} preview on a ${
    dark ? "dark" : "light"
  } canvas`;

  return (
    <div
      className={cn("min-w-0 space-y-3", className)}
      role="region"
      aria-label={`${title} controls and preview`}
    >
      {/* Device + dark-canvas toggles. In compact mode (draft review inside the
          generate/adapt dialog) they're still shown — a slimmer row — because
          that's exactly when authors need to sanity-check mobile and dark
          before creating the campaign (TMPL-036). */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          className="inline-flex rounded-md border bg-muted/50 p-1"
          role="group"
          aria-label="Preview device"
        >
          <Button
            type="button"
            size="sm"
            variant={device === "desktop" ? "secondary" : "ghost"}
            aria-pressed={device === "desktop"}
            onClick={() => setDevice("desktop")}
          >
            <Monitor className="h-4 w-4" aria-hidden />
            Desktop
          </Button>
          <Button
            type="button"
            size="sm"
            variant={device === "mobile" ? "secondary" : "ghost"}
            aria-pressed={device === "mobile"}
            onClick={() => setDevice("mobile")}
          >
            <Smartphone className="h-4 w-4" aria-hidden />
            Mobile
          </Button>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-pressed={imagesOff}
          onClick={() => setImagesOff((value) => !value)}
        >
          {imagesOff ? "Show images" : "Images off"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-pressed={dark}
          aria-label={`Use ${dark ? "light" : "dark"} preview canvas`}
          onClick={() => setDark((value) => !value)}
        >
          {dark ? (
            <Sun className="h-4 w-4" aria-hidden />
          ) : (
            <Moon className="h-4 w-4" aria-hidden />
          )}
          {dark ? "Light canvas" : "Dark canvas"}
        </Button>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {modeDescription}
      </span>

      <div
        data-slot="template-preview-scroll"
        tabIndex={0}
        aria-label={`${title} — ${modeDescription} scroll area`}
        className={cn(
          "flex justify-center overflow-auto rounded-lg border p-3 sm:p-5",
          dark ? "bg-neutral-950" : "bg-neutral-100",
          compact ? "h-[440px]" : "min-h-[680px]",
        )}
      >
        <iframe
          key={`${device}-${dark ? "dark" : "light"}-${imagesOff ? "images-off" : "images-on"}`}
          title={`${title} — ${modeDescription}`}
          srcDoc={document}
          sandbox=""
          referrerPolicy="no-referrer"
          className={cn(
            "shrink-0 border bg-white shadow-sm transition-[width] duration-200",
            compact ? "h-[680px]" : "h-[820px]",
          )}
          style={{
            width:
              device === "mobile"
                ? MOBILE_PREVIEW_WIDTH
                : DESKTOP_PREVIEW_WIDTH,
          }}
        />
      </div>
      {!compact ? (
        <p className="text-xs text-muted-foreground">
          Sandboxed visual preview. Validate in real inbox clients before a
          high-stakes send.
        </p>
      ) : null}
    </div>
  );
}
