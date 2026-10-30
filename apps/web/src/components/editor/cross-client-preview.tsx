// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Inbox } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { renderEmail } from "@/lib/render-api";
import { safeImageURL } from "@/lib/safe-navigation";
import {
  ENVIRONMENT_LABELS,
  severityFor,
  type RenderEnvironment,
  type RenderResponse,
  type RenderedClient,
} from "@/lib/render-types";

interface CrossClientPreviewProps {
  /** Compiled HTML to preview. Empty string renders the empty state. */
  html: string;
  /** Debounce window before re-fetching renders (ms). Default 600ms. */
  debounceMs?: number;
  /** Saved source for an on-demand simulated screenshot overlay. */
  baselineHtml?: string;
  baselineMjml?: string;
}

export function CrossClientPreview({
  html,
  debounceMs = 600,
  baselineHtml,
  baselineMjml,
}: CrossClientPreviewProps) {
  const [data, setData] = useState<RenderResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<RenderedClient | null>(null);
  const [baselineRender, setBaselineRender] = useState<RenderedClient | null>(null);
  const [baselineLoading, setBaselineLoading] = useState(false);
  const [baselineError, setBaselineError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(50);
  const baselineReqRef = useRef(0);
  const [retryNonce, setRetryNonce] = useState(0);
  const activeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const activeImageUrl = active ? safeImageURL(active.image_url) : null;

  // Track the most recent request so a stale resolve doesn't overwrite a newer
  // result.
  const reqIdRef = useRef(0);

  useEffect(() => {
    const id = ++reqIdRef.current;
    const controller = new AbortController();
    setActive(null);
    baselineReqRef.current += 1;
    setBaselineLoading(false);
    setBaselineRender(null);
    setError(null);
    setData(null);
    if (!html.trim()) {
      setLoading(false);
      return () => controller.abort();
    }
    setLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await renderEmail(
            html,
            undefined,
            controller.signal,
          );
          if (reqIdRef.current !== id) return;
          setData(response);
        } catch (requestError) {
          if (reqIdRef.current !== id) return;
          setError(
            apiErrorMessage(
              requestError,
              "Could not render cross-client previews.",
            ),
          );
        } finally {
          if (reqIdRef.current === id) setLoading(false);
        }
      })();
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
      if (reqIdRef.current === id) reqIdRef.current += 1;
    };
  }, [debounceMs, html, retryNonce]);

  if (!html.trim()) {
    return <EmptyState />;
  }

  const activeLabel = active
    ? (ENVIRONMENT_LABELS[active.environment.name as RenderEnvironment] ??
      active.environment.name)
    : "";
  const baselineImageUrl = baselineRender ? safeImageURL(baselineRender.image_url) : null;

  const loadBaseline = async () => {
    if (!active || baselineLoading || (!baselineHtml?.trim() && !baselineMjml?.trim())) return;
    const requestID = ++baselineReqRef.current;
    const environment = active.environment.name as RenderEnvironment;
    setBaselineLoading(true);
    setBaselineError(null);
    try {
      let source = baselineHtml?.trim() ?? "";
      if (!source && baselineMjml?.trim()) {
        const { compileMjmlSource } = await import("@/components/editor/compile-mjml");
        const compiled = await compileMjmlSource(baselineMjml);
        if (compiled.errors.length) throw new Error("The saved MJML version could not compile cleanly.");
        source = compiled.html;
      }
      if (requestID !== baselineReqRef.current) return;
      const result = await renderEmail(source, [environment]);
      if (requestID !== baselineReqRef.current) return;
      const matched = result.renders.find((render) => render.environment.name === environment);
      if (!matched || !safeImageURL(matched.image_url)) throw new Error("No comparable saved-version screenshot is available.");
      setBaselineRender(matched);
    } catch (cause) {
      if (requestID === baselineReqRef.current) setBaselineError(cause instanceof Error ? cause.message : "Could not render the saved version.");
    } finally {
      if (requestID === baselineReqRef.current) setBaselineLoading(false);
    }
  };

  return (
    <div
      className="h-full overflow-auto bg-muted/30 p-4 sm:p-6"
      aria-busy={loading}
    >
      <header className="mb-4 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">
            Mailbox simulations
          </h2>
          <p className="text-sm text-muted-foreground">
            Browser-based approximations for 10 mailbox environments, not
            screenshots from the mail apps. Send a test to real inboxes before
            publishing. Current HTML may be sent to the configured external
            screenshot provider; do not include private sample data. Open a
            preview to inspect its heuristic findings.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className="w-fit shrink-0 text-xs">
            Real inbox captures · Coming soon
          </Badge>
          <Badge variant="outline" className="w-fit shrink-0 text-xs">
            {data?.render_mode === "placeholder"
              ? "Placeholder · no screenshot"
              : data?.render_mode === "simulation"
                ? "Simulation · not a real inbox"
                : "Preview provenance unverified"}
          </Badge>
          {data?.cache_hit ? (
            <Badge variant="secondary" className="w-fit shrink-0 text-xs">
              cache hit
            </Badge>
          ) : null}
        </div>
      </header>

      {error ? (
        <div
          className="mb-4 flex flex-col items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
          role="alert"
        >
          <div className="min-w-0">
            <p className="font-medium">Previews could not be rendered.</p>
            <p className="mt-1 break-words">{error}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-8"
            onClick={() => setRetryNonce((value) => value + 1)}
          >
            Retry previews
          </Button>
        </div>
      ) : null}

      <div
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5"
        role={loading ? "status" : undefined}
        aria-label={loading ? "Loading cross-client previews" : undefined}
      >
        {loading ? (
          <>
            <span className="sr-only">Loading cross-client previews…</span>
            {Array.from({ length: 10 }).map((_, index) => (
              <ClientCardSkeleton key={index} />
            ))}
          </>
        ) : data && data.renders?.length === 0 ? (
          <Card className="p-5 sm:col-span-2 lg:col-span-3 xl:col-span-5">
            <p className="text-sm font-medium">No preview renders returned</p>
            <p className="mt-1 text-sm text-muted-foreground">
              The render request completed, but no mailbox environments were
              returned. Retry, or come back after the renderer recovers.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3 min-h-11 sm:min-h-8"
              onClick={() => setRetryNonce((value) => value + 1)}
            >
              Retry previews
            </Button>
          </Card>
        ) : (
          data?.renders?.map((render) => (
            <ClientCard
              key={render.environment.name}
              render={render}
              onOpen={(trigger) => {
                baselineReqRef.current += 1;
                activeTriggerRef.current = trigger;
                setBaselineRender(null);
                setBaselineError(null);
                setBaselineLoading(false);
                setReveal(50);
                setActive(render);
              }}
            />
          ))
        )}
      </div>

      <Dialog
        open={active !== null}
        onOpenChange={(open) => {
          if (!open) {
            baselineReqRef.current += 1;
            setActive(null);
            setBaselineLoading(false);
          }
        }}
      >
        <DialogContent
          className="max-w-4xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (activeTriggerRef.current?.isConnected) {
              activeTriggerRef.current.focus();
            }
          }}
        >
          {active ? (
            <>
              <DialogHeader>
                <DialogTitle className="break-words">{activeLabel}</DialogTitle>
                <DialogDescription>
                  {active.environment.viewport_width}×
                  {active.environment.viewport_height} ·{" "}
                  {active.environment.dark_mode ? "Dark mode" : "Light mode"}
                </DialogDescription>
              </DialogHeader>
              {(baselineHtml?.trim() || baselineMjml?.trim()) && !baselineRender ? (
                <Button type="button" size="sm" variant="outline" disabled={baselineLoading || !activeImageUrl}
                  onClick={() => void loadBaseline()}>
                  {baselineLoading ? "Rendering saved version…" : "Compare saved screenshot"}
                </Button>
              ) : null}
              {baselineError ? <p role="alert" className="text-sm text-destructive">{baselineError}</p> : null}
              {baselineImageUrl && activeImageUrl ? (
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span>Saved version ← drag to compare → current draft</span>
                  <input type="range" min={0} max={100} value={reveal} className="w-full"
                    aria-label="Reveal current draft screenshot" onChange={(event) => setReveal(Number(event.target.value))} />
                </label>
              ) : null}
              <div className="max-h-[55dvh] overflow-auto rounded-md border bg-background">
                {activeImageUrl && baselineImageUrl ? (
                  <div className="relative w-full" aria-label="Saved and current screenshot overlay">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={baselineImageUrl} alt={`Saved version simulated in ${activeLabel}`} className="block h-auto w-full" />
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={activeImageUrl} alt={`Current draft simulated in ${activeLabel}`} className="absolute inset-0 h-auto w-full"
                      style={{ clipPath: `inset(0 ${100 - reveal}% 0 0)` }} />
                  </div>
                ) : activeImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={activeImageUrl}
                    alt={`Full-size preview for ${activeLabel}`}
                    className="h-auto w-full"
                  />
                ) : (
                  <div className="p-6 text-sm text-muted-foreground">
                    Preview image unavailable.
                  </div>
                )}
              </div>
              {baselineImageUrl ? <p className="text-xs text-muted-foreground">This is an image overlay of simulated renders, not a real Gmail, Outlook, or Apple Mail capture. Different content heights may not align.</p> : null}
              <IssueList issues={active.issues} />
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setActive(null)}
                >
                  Close
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/*
 * The branches below stay small because the request lifecycle above owns all
 * truth about which HTML the cards represent. Never keep an old card grid
 * interactive while a newer body is being rendered.
 */

function ClientCard({
  render,
  onOpen,
}: {
  render: RenderedClient;
  onOpen: (trigger: HTMLButtonElement) => void;
}) {
  const label =
    ENVIRONMENT_LABELS[render.environment.name as RenderEnvironment] ??
    render.environment.name;
  const breaking = useMemo(
    () => render.issues.filter((i) => severityFor(i) === "breaking").length,
    [render.issues],
  );
  const warnings = useMemo(
    () => render.issues.filter((i) => severityFor(i) === "warning").length,
    [render.issues],
  );
  const imageUrl = safeImageURL(render.image_url);

  return (
    <button
      type="button"
      onClick={(event) => onOpen(event.currentTarget)}
      aria-label={`Open ${label} preview full-size`}
      className="group min-h-11 min-w-0 rounded-lg text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card className="overflow-hidden transition-shadow motion-reduce:transition-none group-hover:shadow-md">
        {/* Device-frame chrome — a thin header bar with the three-dot affordance. */}
        <div
          className={cn(
            "h-6 px-2 flex items-center gap-1 border-b",
            render.environment.dark_mode ? "bg-zinc-900" : "bg-zinc-100",
          )}
          aria-hidden
        >
          <span className="h-2 w-2 rounded-full bg-red-400/80" />
          <span className="h-2 w-2 rounded-full bg-amber-400/80" />
          <span className="h-2 w-2 rounded-full bg-emerald-400/80" />
        </div>
        <div
          className={cn(
            "aspect-[4/3] overflow-hidden",
            render.environment.dark_mode ? "bg-zinc-900" : "bg-white",
          )}
        >
          {imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              loading="lazy"
              src={imageUrl}
              alt={`Preview of campaign rendered in ${label}`}
              className="w-full h-full object-cover object-top"
            />
          ) : (
            <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
              Preview image unavailable.
            </div>
          )}
        </div>
        <div className="px-3 py-2 space-y-1">
          <div className="text-xs font-medium truncate">{label}</div>
          <div className="flex flex-wrap gap-1">
            {breaking > 0 && (
              <Badge variant="destructive" className="h-5 text-[10px] px-1.5">
                {breaking} breaking
              </Badge>
            )}
            {warnings > 0 && (
              <Badge
                className="h-5 text-[10px] px-1.5 bg-amber-500 text-white hover:bg-amber-500/90"
                variant="default"
              >
                {warnings} warning{warnings === 1 ? "" : "s"}
              </Badge>
            )}
            {breaking + warnings === 0 && (
              <Badge variant="secondary" className="h-5 text-[10px] px-1.5">
                clean
              </Badge>
            )}
          </div>
        </div>
      </Card>
    </button>
  );
}

function ClientCardSkeleton() {
  return (
    <Card className="overflow-hidden">
      <div className="h-6 border-b bg-muted" />
      <Skeleton className="aspect-[4/3] w-full rounded-none" />
      <div className="px-3 py-2 space-y-2">
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
      </div>
    </Card>
  );
}

function IssueList({ issues }: { issues: string[] }) {
  if (issues.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No issues detected for this client.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {issues.map((issue, i) => {
        const sev = severityFor(issue);
        return (
          <li
            key={i}
            className={cn(
              "flex gap-2 rounded-md border p-2 text-sm",
              sev === "breaking"
                ? "border-destructive/40 bg-destructive/10 text-destructive-emphasis"
                : "border-warning/40 bg-warning-subtle text-warning-emphasis",
            )}
          >
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span className="min-w-0 break-words">{issue}</span>
          </li>
        );
      })}
    </ul>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center bg-muted/30 p-4 sm:p-6">
      <Card className="max-w-md space-y-3 p-5 text-center sm:p-8">
        <div className="mx-auto h-10 w-10 rounded-full bg-muted inline-flex items-center justify-center">
          <Inbox className="h-5 w-5 text-muted-foreground" />
        </div>
        <h3 className="font-medium">No content to preview yet</h3>
        <p className="text-sm text-muted-foreground">
          Switch to the Writer or Blocks tab and add some content. Cross-client
          previews will render here as soon as you have HTML.
        </p>
      </Card>
    </div>
  );
}
