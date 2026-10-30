// SPDX-License-Identifier: AGPL-3.0-only
//
// Generates the three embed snippet variants for a form:
//   - iframe       (drop-in, stylable via parent CSS)
//   - JS popup     (loads embed.js + shows a modal on a configured trigger)
//   - JS inline    (loads embed.js + injects the form into a div)
//
// Snippet building + escaping + dimension validation live in the pure
// `embed-snippet-helpers` module (unit-tested); this component is the UI shell.
"use client";

import { AlertTriangle, Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { copyToClipboard } from "@/lib/clipboard";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DEFAULT_EMBED_OPTIONS,
  iframeSnippet,
  inlineSnippet,
  normalizeHeight,
  normalizeWidth,
  popupSnippet,
  type EmbedOptions,
  type PopupTrigger,
} from "@/lib/embed-snippet-helpers";

export type {
  EmbedMode,
  EmbedOptions,
  PopupTrigger,
} from "@/lib/embed-snippet-helpers";

interface EmbedSnippetProps {
  slug: string;
  /** Public host (e.g. https://forms.moosewave.com). */
  host: string;
}

export function EmbedSnippet({ slug, host }: EmbedSnippetProps) {
  const [opts, setOpts] = useState<EmbedOptions>(DEFAULT_EMBED_OPTIONS);

  const widthResult = normalizeWidth(opts.width);
  const heightResult = normalizeHeight(opts.height);
  const widthError = "error" in widthResult ? widthResult.error : null;
  const heightError = "error" in heightResult ? heightResult.error : null;

  return (
    <div className="min-w-0 space-y-6">
      <Tabs defaultValue="iframe" className="min-w-0">
        <TabsList aria-label="Embed code format">
          <TabsTrigger value="iframe">iframe</TabsTrigger>
          <TabsTrigger value="popup">JS popup</TabsTrigger>
          <TabsTrigger value="inline">JS inline</TabsTrigger>
        </TabsList>

        <TabsContent value="iframe" className="min-w-0 space-y-4">
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <Label htmlFor="iframe-width">Width</Label>
              <Input
                id="iframe-width"
                value={opts.width}
                aria-invalid={widthError ? true : undefined}
                aria-describedby={widthError ? "iframe-width-error" : undefined}
                onChange={(e) => setOpts({ ...opts, width: e.target.value })}
              />
              {widthError ? (
                <p
                  id="iframe-width-error"
                  className="mt-1 text-xs text-destructive"
                >
                  {widthError}
                </p>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  Number (px), a percentage, or auto.
                </p>
              )}
            </div>
            <div className="min-w-0">
              <Label htmlFor="iframe-height">Height (px)</Label>
              <Input
                id="iframe-height"
                value={opts.height}
                aria-invalid={heightError ? true : undefined}
                aria-describedby={
                  heightError ? "iframe-height-error" : undefined
                }
                onChange={(e) => setOpts({ ...opts, height: e.target.value })}
              />
              {heightError ? (
                <p
                  id="iframe-height-error"
                  className="mt-1 text-xs text-destructive"
                >
                  {heightError}
                </p>
              ) : null}
            </div>
          </div>
          <CodeBlock value={iframeSnippet(host, slug, opts)} />
        </TabsContent>

        <TabsContent value="popup" className="min-w-0 space-y-4">
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <Label htmlFor="popup-trigger">Trigger</Label>
              <Select
                id="popup-trigger"
                value={opts.trigger}
                onChange={(e) =>
                  setOpts({ ...opts, trigger: e.target.value as PopupTrigger })
                }
              >
                <option value="page-load">On page load</option>
                <option value="scroll-50">After 50% scroll</option>
                <option value="exit-intent">On exit intent</option>
                <option value="time-delay">After delay</option>
              </Select>
            </div>
            <div className="min-w-0">
              <Label htmlFor="popup-delay">
                Delay (seconds, time-delay only)
              </Label>
              <Input
                id="popup-delay"
                type="number"
                min={0}
                value={opts.delaySeconds}
                onChange={(e) =>
                  setOpts({
                    ...opts,
                    delaySeconds: Number(e.target.value) || 0,
                  })
                }
              />
            </div>
            <div className="min-w-0">
              <Label htmlFor="popup-frequency">Frequency cap (days)</Label>
              <Input
                id="popup-frequency"
                type="number"
                min={0}
                value={opts.frequencyDays}
                onChange={(e) =>
                  setOpts({
                    ...opts,
                    frequencyDays: Number(e.target.value) || 0,
                  })
                }
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Don&apos;t re-show for N days after it&apos;s seen. 0 = every
                visit.
              </p>
            </div>
            <div className="min-w-0">
              <Label htmlFor="popup-paths">Page targeting (optional)</Label>
              <Input
                id="popup-paths"
                placeholder="/pricing, /blog"
                value={opts.targetPaths}
                onChange={(e) =>
                  setOpts({ ...opts, targetPaths: e.target.value })
                }
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Only show on these path prefixes. Blank = every page.
              </p>
            </div>
          </div>
          <CodeBlock value={popupSnippet(host, slug, opts)} />
        </TabsContent>

        <TabsContent value="inline" className="min-w-0 space-y-4">
          <div className="min-w-0">
            <Label htmlFor="inline-class">CSS class hooks</Label>
            <Input
              id="inline-class"
              placeholder="my-form-wrap dark"
              value={opts.cssClass}
              onChange={(e) => setOpts({ ...opts, cssClass: e.target.value })}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Style via <code>.postwave-form</code> on the parent page.
            </p>
          </div>
          <CodeBlock value={inlineSnippet(host, slug, opts)} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CodeBlock({ value }: { value: string }) {
  // Was `void navigator.clipboard.writeText(value)` followed by an
  // unconditional `setCopied(true)`: a rejected write (non-secure context,
  // permission denied, unfocused document) still reported "Copied". The whole
  // point of this page is handing over a snippet to paste, so a silent no-op
  // ends with an embed that was never installed. `copyToClipboard` never
  // throws and reports which of the two failure modes occurred.
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  return (
    <div className="relative min-w-0 max-w-full">
      {/* Snippets overflow horizontally and hold nothing focusable, so the
          block itself has to take focus or a keyboard user cannot scroll it
          (WCAG 2.1.1). role="group" rather than "region": a form page shows
          several snippets and that many landmarks is noise. */}
      <pre
        tabIndex={0}
        role="group"
        aria-label="Embed snippet"
        className="max-w-full overflow-x-auto whitespace-pre rounded-md bg-muted p-4 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {value}
      </pre>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="absolute top-2 right-2 gap-1.5"
        onClick={() => {
          void (async () => {
            const result = await copyToClipboard(value);
            setStatus(result === "copied" ? "copied" : "error");
            if (result !== "copied") {
              toast.error(
                result === "unavailable"
                  ? "Clipboard unavailable here — select the snippet and copy manually."
                  : "Could not copy the snippet. Select it and copy manually.",
              );
            }
            if (resetTimerRef.current !== null) {
              clearTimeout(resetTimerRef.current);
            }
            resetTimerRef.current = setTimeout(() => {
              setStatus("idle");
              resetTimerRef.current = null;
            }, 1600);
          })();
        }}
      >
        {status === "copied" ? (
          <Check className="h-3.5 w-3.5" />
        ) : status === "error" ? (
          <AlertTriangle className="h-3.5 w-3.5" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
        {status === "copied"
          ? "Copied"
          : status === "error"
            ? "Copy failed"
            : "Copy"}
      </Button>
    </div>
  );
}
