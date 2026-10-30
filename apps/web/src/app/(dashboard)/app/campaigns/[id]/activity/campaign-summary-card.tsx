// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * AI post-send summary — parity row campaigns-58 (desktop
 * CampaignAISummaryCard).
 *
 * GET …/summary serves the persisted row; 404 means none has been generated,
 * which is a state of this card (a "Generate summary" CTA), not an error.
 * POST …/summary/regenerate computes one: voice-authored when a voice client
 * is configured, the deterministic template otherwise (open rate against the
 * workspace baseline, top-link concentration, replies by intent, voice drift
 * — the next-best-action framing lives in that body).
 *
 * Two things the card says rather than lets the server say with a status code:
 *  - A campaign that has not sent has nothing to summarise (the POST answers
 *    409 campaign_not_sent), so pre-send campaigns get the reason, no button.
 *  - Generating is an edit (write:campaigns). A viewer sees the summary and
 *    the reason the button is withheld.
 *
 * Refreshing REPLACES the summary in place — the server upserts on
 * campaign_id and keeps no history — so a refresh over an existing summary
 * goes through a confirm that says so. A first generation has nothing to
 * overwrite and does not.
 */

import { Fragment, useMemo, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api";
import {
  campaignSummaryAvailable,
  getCampaignSummary,
  parseSummaryMarkdown,
  regenerateCampaignSummary,
  type CampaignAISummary,
} from "@/lib/campaign-detail-panels-api";
import {
  CAMPAIGN_READ_ONLY_MESSAGE,
  canWriteCampaigns,
  confirmFreshCampaignWriteAuthority,
} from "@/lib/campaign-write-authority";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { STALE } from "@/lib/query-keys";

import { PANEL_CLASS, type CampaignPanelScope } from "./campaign-panel-scope";

export function CampaignSummaryCard({
  scope,
  status,
}: {
  scope: CampaignPanelScope;
  /**
   * The campaign's status; null while the campaign is still loading. The
   * page passes "unknown" when the campaign failed to load, which does not
   * block the read — only a known pre-send status does.
   */
  status: string | null;
}) {
  const { campaignId, campaignKey, identity, identityReady } = scope;
  const queryClient = useQueryClient();
  const summaryKey = useMemo(
    () => [...campaignKey, "summary"] as const,
    [campaignKey],
  );
  const statusKnown = status !== null;
  const available = !statusKnown || campaignSummaryAvailable(status ?? undefined);
  const summaryQuery = useQuery({
    queryKey: summaryKey,
    queryFn: () => getCampaignSummary(campaignId),
    // Wait for the status: reading a draft's summary is a request whose only
    // possible answer is "none".
    enabled: identityReady && statusKnown && available && campaignId !== "",
    staleTime: STALE.detail,
  });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);

  const canWrite = canWriteCampaigns(identity);

  const regenerate = useMutation({
    mutationFn: async () => {
      await confirmFreshCampaignWriteAuthority(identity);
      return regenerateCampaignSummary(campaignId);
    },
    onMutate: () => setOperationError(null),
    onSuccess: (summary) => {
      const hadSummary = Boolean(
        queryClient.getQueryData<CampaignAISummary | null>(summaryKey),
      );
      queryClient.setQueryData(summaryKey, summary);
      toast.success(hadSummary ? "Summary refreshed" : "Summary generated");
    },
    onError: (error: unknown) => {
      // 409 campaign_not_sent, 429 rate limit, 403 role — each explains
      // itself; render the server's sentence.
      setOperationError(
        apiErrorMessage(error, "The campaign summary could not be generated."),
      );
    },
  });

  const summary = summaryQuery.data ?? null;
  const writeBlockedReason = !identityReady
    ? "Checking your access…"
    : !canWrite
      ? CAMPAIGN_READ_ONLY_MESSAGE
      : regenerate.isPending
        ? "A summary is already being generated."
        : null;

  return (
    <section
      className={PANEL_CLASS}
      aria-labelledby="campaign-summary-heading"
      data-testid="campaign-summary-card"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Sparkles className="h-4 w-4" aria-hidden />
        <h2 id="campaign-summary-heading" className="text-base font-semibold">
          AI summary
        </h2>
        {summary ? (
          <Badge variant="secondary">
            {summary.source === "voice"
              ? "Voice-authored"
              : "Deterministic template"}
          </Badge>
        ) : null}
        <span className="flex-1" />
        {summary ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={writeBlockedReason !== null}
            aria-describedby="campaign-summary-write-note"
            onClick={() => setConfirmOpen(true)}
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            {regenerate.isPending ? "Refreshing…" : "Refresh"}
          </Button>
        ) : null}
      </div>

      {!available ? (
        <p className="text-sm text-muted-foreground">
          A summary is available after the campaign sends — a {status} campaign
          has no engagement to summarise yet.
        </p>
      ) : summaryQuery.isPending ? (
        <div role="status" aria-label="Loading campaign summary">
          <Skeleton className="h-20 w-full" />
        </div>
      ) : summaryQuery.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load the campaign summary</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{apiErrorMessage(summaryQuery.error)}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void summaryQuery.refetch()}
            >
              Retry the summary
            </Button>
          </AlertDescription>
        </Alert>
      ) : summary ? (
        <div className="space-y-2 text-sm leading-relaxed">
          {parseSummaryMarkdown(summary.body_markdown).map((runs, index) => (
            <p key={index}>
              {runs.map((run, runIndex) =>
                run.kind === "bold" ? (
                  <strong key={runIndex}>{run.text}</strong>
                ) : run.kind === "code" ? (
                  <code
                    key={runIndex}
                    className="rounded bg-muted px-1 font-mono text-xs"
                  >
                    {run.text}
                  </code>
                ) : (
                  <Fragment key={runIndex}>{run.text}</Fragment>
                ),
              )}
            </p>
          ))}
          <p className="text-xs text-muted-foreground">
            Generated{" "}
            {formatWireTimestamp(summary.generated_at, "at an unrecorded time")}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            No summary yet. Generate a baseline-aware summary of this
            campaign&rsquo;s open rate, top link, replies, and voice drift,
            with the next actions it suggests.
          </p>
          <Button
            type="button"
            size="sm"
            disabled={writeBlockedReason !== null}
            aria-describedby="campaign-summary-write-note"
            onClick={() => regenerate.mutate()}
          >
            <Sparkles className="h-4 w-4" aria-hidden />
            {regenerate.isPending ? "Generating…" : "Generate summary"}
          </Button>
        </div>
      )}

      {available ? (
        <p
          id="campaign-summary-write-note"
          className="mt-2 text-xs text-muted-foreground"
        >
          {writeBlockedReason ??
            "Generating reads this campaign's latest numbers and may call the voice service."}
        </p>
      ) : null}

      {operationError ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          Couldn&apos;t generate the summary: {operationError}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!regenerate.isPending) setConfirmOpen(open);
        }}
        title="Replace this summary?"
        description="Refreshing regenerates the summary from this campaign's latest numbers and overwrites the current one in place. The server keeps no earlier version, so the text above cannot be recovered afterwards."
        confirmLabel="Replace summary"
        cancelLabel="Keep this summary"
        confirmVariant="default"
        onConfirm={async () => {
          await regenerate.mutateAsync();
        }}
      />
    </section>
  );
}
