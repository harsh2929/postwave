// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Review installation — bounded, inert inspection of the iframe / script
 * snippet the service generates for an ACTIVE widget.
 *
 * Deliberately fail closed, matching desktop: only an active widget with a
 * policy-safe reported endpoint exposes the control at all; snippets are
 * fetched one flavor at a time and rendered as read-only text, never parsed
 * into a DOM; and Copy is withheld unless the selected method clears its
 * known delivery blockers (iframe must name its content and target the
 * rendered /html view; script delivery is not yet certified). A blocked copy
 * says why, beside the button.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, Code2, Copy } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import { copyToClipboard } from "@/lib/clipboard";
import { STALE } from "@/lib/query-keys";
import { getReviewWidgetEmbed, type ReviewWidget } from "@/lib/reviews-api";
import {
  EMBED_FLAVORS,
  embedCopyBlocker,
  inactiveWidgetReason,
  inspectEmbedMarkup,
  invalidSnippetMessage,
  parseReviewEmbedSnippet,
  safePublicWidgetUrl,
  type EmbedFlavor,
} from "@/lib/reviews-helpers";

type SnippetState =
  | { kind: "invalid"; message: string }
  | { kind: "ready"; snippet: string; blocker: string | null };

function flavorTitle(flavor: EmbedFlavor): string {
  return flavor === "iframe" ? "Iframe" : "Script";
}

function WidgetInstallationDialog({
  open,
  widgetId,
  widgetName,
  reportedEndpoint,
  keyBase,
  onOpenChange,
}: {
  open: boolean;
  widgetId: string;
  widgetName: string;
  reportedEndpoint: string;
  keyBase: readonly unknown[];
  onOpenChange: (open: boolean) => void;
}) {
  const [flavor, setFlavor] = useState<EmbedFlavor>("iframe");
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blockerId = useId();

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    };
  }, []);

  const embed = useQuery({
    queryKey: [...keyBase, "embed", widgetId, flavor],
    queryFn: () => getReviewWidgetEmbed(widgetId, flavor),
    enabled: open,
    staleTime: STALE.reference,
    // Retry stays a visible, manual verb (desktop parity): an automatic
    // background retry would make "the service returned nothing" look like
    // "still loading".
    retry: false,
  });

  const state = useMemo<SnippetState | null>(() => {
    if (!embed.data) return null;
    const parsed = parseReviewEmbedSnippet(embed.data.snippet);
    if (!parsed.ok) {
      return { kind: "invalid", message: invalidSnippetMessage(parsed.reason) };
    }
    const inspection = inspectEmbedMarkup(
      flavor,
      parsed.snippet,
      reportedEndpoint,
    );
    if (!inspection.valid) {
      return {
        kind: "invalid",
        message: `Moosewave did not receive a valid ${flavor} installation snippet.`,
      };
    }
    return {
      kind: "ready",
      snippet: parsed.snippet,
      blocker: embedCopyBlocker(flavor, inspection),
    };
  }, [embed.data, flavor, reportedEndpoint]);

  const errorMessage = embed.isError
    ? apiErrorMessage(
        embed.error,
        "The service did not return installation code for this method.",
      )
    : state?.kind === "invalid"
      ? state.message
      : null;
  const ready = state?.kind === "ready" ? state : null;
  const copyBlocked = ready !== null && ready.blocker !== null;

  async function copySnippet(snippet: string): Promise<void> {
    const result = await copyToClipboard(snippet);
    setCopyStatus(result === "copied" ? "copied" : "error");
    if (result === "copied") {
      toast.success(`${flavorTitle(flavor)} installation code copied`);
    } else {
      toast.error(
        result === "unavailable"
          ? "Clipboard unavailable here — select the code and copy manually."
          : "Could not copy the installation code. Select it and copy manually.",
      );
    }
    if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => {
      setCopyStatus("idle");
      resetTimerRef.current = null;
    }, 1600);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setFlavor("iframe");
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-2xl" aria-busy={embed.isFetching}>
        <DialogHeader>
          <DialogTitle>Review installation · {widgetName}</DialogTitle>
          <DialogDescription>
            Inspect bounded service-reported code for this active widget. Copy
            is available only for an iframe that names its content and targets
            rendered /html output; script delivery is not yet certified.
          </DialogDescription>
        </DialogHeader>

        <div
          role="group"
          aria-label="Installation method"
          className="flex flex-wrap gap-2"
        >
          {EMBED_FLAVORS.map((candidate) => (
            <Button
              key={candidate}
              type="button"
              size="sm"
              variant={flavor === candidate ? "default" : "outline"}
              aria-pressed={flavor === candidate}
              onClick={() => setFlavor(candidate)}
            >
              <Code2 aria-hidden />
              {flavorTitle(candidate)}
            </Button>
          ))}
        </div>

        <section
          aria-label={`${flavorTitle(flavor)} code`}
          className="space-y-3"
        >
          <h3 className="text-sm font-medium">{flavorTitle(flavor)} code</h3>

          {embed.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              Requesting {flavor} installation code…
            </p>
          ) : null}

          {errorMessage ? (
            <Alert variant="destructive">
              <AlertTitle>Installation code unavailable</AlertTitle>
              <AlertDescription>{errorMessage}</AlertDescription>
              <div className="mt-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  loading={embed.isFetching}
                  onClick={() => void embed.refetch()}
                >
                  Retry {flavor}
                </Button>
              </div>
            </Alert>
          ) : null}

          {ready ? (
            <>
              {ready.blocker ? (
                <Alert
                  variant="warning"
                  id={blockerId}
                  role="alert"
                  className="text-sm"
                >
                  <AlertTitle>
                    {flavor === "iframe"
                      ? "Iframe copy blocked"
                      : "Storefront delivery not certified"}
                  </AlertTitle>
                  <AlertDescription>{ready.blocker}</AlertDescription>
                </Alert>
              ) : null}
              <Textarea
                aria-label={`${flavor} installation code`}
                readOnly
                rows={8}
                spellCheck={false}
                className="font-mono text-xs"
                value={ready.snippet}
              />
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant={copyBlocked ? "outline" : "default"}
                  disabled={copyBlocked}
                  aria-describedby={copyBlocked ? blockerId : undefined}
                  onClick={() => void copySnippet(ready.snippet)}
                >
                  {copyStatus === "copied" ? (
                    <Check aria-hidden />
                  ) : copyStatus === "error" ? (
                    <AlertTriangle aria-hidden />
                  ) : (
                    <Copy aria-hidden />
                  )}
                  {copyBlocked
                    ? `${flavorTitle(flavor)} copy unavailable`
                    : copyStatus === "copied"
                      ? "Copied"
                      : copyStatus === "error"
                        ? "Copy failed"
                        : `Copy ${flavor} code`}
                </Button>
              </div>
            </>
          ) : null}
        </section>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The per-widget control: either the "Review installation" button with its
 * dialog, or a note saying exactly why installation review is withheld.
 */
export function WidgetInstallation({
  widget,
  keyBase,
}: {
  widget: ReviewWidget;
  keyBase: readonly unknown[];
}) {
  const [open, setOpen] = useState(false);
  const status = widget.status.trim().toLowerCase();
  const active = status === "active";
  const safeUrl = active ? safePublicWidgetUrl(widget.public_url) : null;
  const widgetId = widget.id.trim();

  if (!active) {
    return (
      <p role="note" className="mt-3 text-xs text-muted-foreground">
        {inactiveWidgetReason(status)}
      </p>
    );
  }
  if (!safeUrl) {
    return (
      <p role="note" className="mt-3 text-xs text-muted-foreground">
        Moosewave did not receive a policy-safe reported endpoint, so
        installation review stays hidden.
      </p>
    );
  }
  if (!widgetId) {
    return (
      <p role="note" className="mt-3 text-xs text-muted-foreground">
        Installation code is unavailable because this widget has no stable
        identifier.
      </p>
    );
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="mt-3 self-start"
        onClick={() => setOpen(true)}
      >
        <Code2 aria-hidden />
        Review installation
      </Button>
      <WidgetInstallationDialog
        key={`${widgetId} ${safeUrl}`}
        open={open}
        widgetId={widgetId}
        widgetName={widget.name.trim() || "Untitled widget"}
        reportedEndpoint={safeUrl}
        keyBase={keyBase}
        onOpenChange={setOpen}
      />
    </>
  );
}
