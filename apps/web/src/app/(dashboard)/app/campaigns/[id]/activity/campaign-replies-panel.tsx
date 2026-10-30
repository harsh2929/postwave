// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Replies to this campaign — parity row campaigns-61 (desktop
 * CampaignRepliesSection).
 *
 * Inbound mail whose In-Reply-To matched this campaign's Message-ID, threaded
 * against the send, with an intent filter (question / praise / unsubscribe /
 * out of office / other → `?intent=`) and an on-demand Classify.
 *
 * RESTRICTED LIKE DESKTOP. Raw replies are private correspondence carrying
 * direct identifiers. The route itself is read:reports, but desktop loads
 * this section for workspace admins only until a least-privilege reply
 * permission exists — and so does this one: anyone else gets the reason and
 * no request is made.
 *
 * The filter tabs always show all five intents. Server counts cover the
 * whole campaign, while the visible list stays bounded to its latest page.
 */

import { useMemo, useState } from "react";
import { Inbox, Tags } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api";
import {
  classifyCampaignReply,
  listCampaignReplies,
  REPLY_INTENT_LABELS,
  REPLY_INTENTS,
  type CampaignRepliesListing,
  type CampaignReply,
  type ReplyIntent,
} from "@/lib/campaign-detail-panels-api";
import {
  CAMPAIGN_READ_ONLY_MESSAGE,
  canAdminCampaigns,
  confirmFreshCampaignAdminAuthority,
} from "@/lib/campaign-write-authority";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { STALE } from "@/lib/query-keys";

import { PANEL_CLASS, type CampaignPanelScope } from "./campaign-panel-scope";

function intentLabel(label: string): string {
  return REPLY_INTENT_LABELS[label as ReplyIntent] ?? label;
}

function previewBody(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 320 ? `${trimmed.slice(0, 320)}…` : trimmed;
}

export function CampaignRepliesPanel({ scope }: { scope: CampaignPanelScope }) {
  const { campaignId, campaignKey, identity, identityReady } = scope;
  const queryClient = useQueryClient();
  const [intent, setIntent] = useState<ReplyIntent | null>(null);
  const [classifyError, setClassifyError] = useState<string | null>(null);

  const canRead = canAdminCampaigns(identity);
  const canClassify = canAdminCampaigns(identity);
  const repliesBaseKey = useMemo(
    () => [...campaignKey, "replies"] as const,
    [campaignKey],
  );

  const allQuery = useQuery({
    queryKey: [...repliesBaseKey, "all"],
    queryFn: () => listCampaignReplies(campaignId, null),
    enabled: identityReady && canRead && campaignId !== "",
    staleTime: STALE.list,
  });
  const filteredQuery = useQuery({
    queryKey: [...repliesBaseKey, intent ?? "all"],
    queryFn: () => listCampaignReplies(campaignId, intent),
    enabled: identityReady && canRead && campaignId !== "" && intent !== null,
    staleTime: STALE.list,
  });
  const visibleQuery = intent === null ? allQuery : filteredQuery;

  const classify = useMutation({
    mutationFn: async (reply: CampaignReply) => {
      await confirmFreshCampaignAdminAuthority(identity);
      return classifyCampaignReply(campaignId, reply.id);
    },
    onMutate: () => setClassifyError(null),
    onSuccess: (updated) => {
      queryClient.setQueriesData<CampaignRepliesListing>(
        { queryKey: repliesBaseKey },
        (listing) =>
          listing
            ? {
                ...listing,
                replies: listing.replies.map((row) =>
                  row.id === updated.id ? updated : row,
                ),
              }
            : listing,
      );
      // Tab counts are the server's; refetch rather than recount locally.
      void queryClient.invalidateQueries({ queryKey: repliesBaseKey });
      toast.success(
        updated.intent_label
          ? `Reply classified as ${intentLabel(updated.intent_label)}`
          : "Reply classified",
      );
    },
    onError: (error: unknown) => {
      // 503 classifier_unavailable and 409 reply_body_redacted explain
      // themselves; say them verbatim.
      setClassifyError(
        apiErrorMessage(error, "The reply could not be classified."),
      );
    },
  });

  const header = (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <Inbox className="h-4 w-4" aria-hidden />
      <h2 id="campaign-replies-heading" className="text-base font-semibold">
        Replies
      </h2>
      {allQuery.data ? (
        <span className="text-xs text-muted-foreground tabular-nums">
          {allQuery.data.count.toLocaleString()}{" "}
          {allQuery.data.count === 1 ? "reply" : "replies"}
        </span>
      ) : null}
    </div>
  );

  if (!identityReady) {
    return (
      <section className={PANEL_CLASS} aria-labelledby="campaign-replies-heading">
        {header}
        <p className="text-sm text-muted-foreground">Checking your access…</p>
      </section>
    );
  }

  if (!canRead) {
    return (
      <section
        className={PANEL_CLASS}
        aria-labelledby="campaign-replies-heading"
        data-testid="campaign-replies-panel"
      >
        {header}
        <Alert variant="warning">
          <AlertTitle>Reply content is restricted</AlertTitle>
          <AlertDescription>
            Raw replies can contain private correspondence and direct
            identifiers. Until a least-privilege reply permission exists, only
            workspace owners and admins can load this section.
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  const counts = allQuery.data?.intent_counts ?? {};
  const replies = Array.isArray(visibleQuery.data?.replies)
    ? visibleQuery.data.replies
    : [];

  return (
    <section
      className={PANEL_CLASS}
      aria-labelledby="campaign-replies-heading"
      data-testid="campaign-replies-panel"
    >
      {header}

      <div
        role="group"
        aria-label="Reply intent filter"
        className="mb-3 flex flex-wrap gap-1.5"
      >
        <Button
          type="button"
          size="sm"
          variant={intent === null ? "secondary" : "outline"}
          aria-pressed={intent === null}
          onClick={() => setIntent(null)}
        >
          All
        </Button>
        {REPLY_INTENTS.map((option) => (
          <Button
            key={option}
            type="button"
            size="sm"
            variant={intent === option ? "secondary" : "outline"}
            aria-pressed={intent === option}
            onClick={() => setIntent(option)}
          >
            {REPLY_INTENT_LABELS[option]}
            {counts[option] ? (
              <span className="tabular-nums text-muted-foreground">
                {" "}
                · {counts[option]}
              </span>
            ) : null}
          </Button>
        ))}
      </div>

      {visibleQuery.isPending ? (
        <div role="status" aria-label="Loading replies" className="grid gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : visibleQuery.isError ? (
        <div role="alert" className="space-y-2 text-sm">
          <p className="text-destructive">
            Couldn&apos;t load{" "}
            {intent ? `${REPLY_INTENT_LABELS[intent].toLowerCase()} ` : ""}
            replies: {apiErrorMessage(visibleQuery.error)}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void visibleQuery.refetch()}
          >
            Retry replies
          </Button>
        </div>
      ) : replies.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {intent
            ? `No replies classified as ${REPLY_INTENT_LABELS[intent].toLowerCase()}.`
            : "No replies yet. Replies appear here when subscribers answer this campaign (matched on the outbound Message-ID)."}
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {replies.map((reply) => (
            <li key={reply.id} className="space-y-1 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="break-all font-mono text-xs">
                  {reply.from_email}
                </span>
                <time
                  className="text-xs text-muted-foreground"
                  dateTime={reply.received_at}
                >
                  {formatWireTimestamp(reply.received_at, "time unavailable")}
                </time>
              </div>
              {reply.subject ? (
                <p className="break-words font-medium">{reply.subject}</p>
              ) : null}
              {reply.body_redacted ? (
                <p className="text-xs italic text-muted-foreground">
                  Body redacted.
                </p>
              ) : (
                <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                  {previewBody(reply.body_text)}
                </p>
              )}
              {reply.intent_label ? (
                <Badge variant="outline">
                  Intent: {intentLabel(reply.intent_label)}
                </Badge>
              ) : reply.body_redacted ? (
                <p className="text-xs text-muted-foreground">
                  A redacted reply cannot be classified.
                </p>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={!canClassify || classify.isPending}
                  title={canClassify ? undefined : CAMPAIGN_READ_ONLY_MESSAGE}
                  onClick={() => classify.mutate(reply)}
                >
                  <Tags className="h-4 w-4" aria-hidden />
                  {classify.isPending && classify.variables?.id === reply.id
                    ? "Classifying…"
                    : "Classify"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {classifyError ? (
        <Alert variant="destructive" className="mt-3">
          <AlertTitle>Couldn&apos;t classify the reply</AlertTitle>
          <AlertDescription>{classifyError}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}
