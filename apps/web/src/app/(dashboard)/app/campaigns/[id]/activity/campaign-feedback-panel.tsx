// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Feedback thread — parity row campaigns-60 (desktop CampaignFeedback).
 *
 * Reviewers leave comments on a campaign; the author marks them resolved as
 * they are addressed. The ledger is append-only: resolving stamps
 * `resolved_at` and there is NO reopen route, so "Mark resolved" goes through
 * a confirm that says the comment will not come back to the open list.
 *
 * Reading is open to every role (read:campaigns). Posting and resolving are
 * edits (write:campaigns): withheld from a viewer with the workspace's own
 * read-only sentence, and re-checked against a fresh identity before each
 * write so a role that changed while the page was open is caught before the
 * request, not by it.
 *
 * A failed post keeps the draft: the comment is the operator's text, and a
 * refusal must not cost them it.
 */

import { useId, useMemo, useState } from "react";
import { CheckCircle2, MessageSquare } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import {
  createCampaignFeedback,
  listCampaignFeedback,
  resolveCampaignFeedback,
  type CampaignFeedback,
} from "@/lib/campaign-detail-panels-api";
import {
  CAMPAIGN_READ_ONLY_MESSAGE,
  canWriteCampaigns,
  confirmFreshCampaignWriteAuthority,
} from "@/lib/campaign-write-authority";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { STALE } from "@/lib/query-keys";

import { PANEL_CLASS, type CampaignPanelScope } from "./campaign-panel-scope";

export function CampaignFeedbackPanel({ scope }: { scope: CampaignPanelScope }) {
  const { campaignId, campaignKey, identity, identityReady } = scope;
  const queryClient = useQueryClient();
  const inputId = useId();
  const feedbackKey = useMemo(
    () => [...campaignKey, "feedback"] as const,
    [campaignKey],
  );
  const feedbackQuery = useQuery({
    queryKey: feedbackKey,
    queryFn: () => listCampaignFeedback(campaignId),
    enabled: identityReady && campaignId !== "",
    staleTime: STALE.list,
  });
  const [draft, setDraft] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  const [resolveTarget, setResolveTarget] = useState<CampaignFeedback | null>(
    null,
  );

  const canWrite = canWriteCampaigns(identity);

  const replaceRow = (updated: CampaignFeedback) => {
    queryClient.setQueryData<CampaignFeedback[]>(feedbackKey, (rows) =>
      Array.isArray(rows)
        ? rows.map((row) => (row.id === updated.id ? updated : row))
        : rows,
    );
  };

  const post = useMutation({
    mutationFn: async (body: string) => {
      await confirmFreshCampaignWriteAuthority(identity);
      return createCampaignFeedback(campaignId, body);
    },
    onSuccess: (row, body) => {
      queryClient.setQueryData<CampaignFeedback[]>(feedbackKey, (rows) => [
        row,
        ...(Array.isArray(rows) ? rows : []).filter(
          (existing) => existing.id !== row.id,
        ),
      ]);
      // Clear only if the operator has not typed on since posting.
      setDraft((current) => (current.trim() === body ? "" : current));
      toast.success("Comment posted");
    },
    onError: (error: unknown) => {
      toast.error(apiErrorMessage(error, "The comment could not be posted."));
    },
  });

  const resolve = useMutation({
    mutationFn: async (feedbackId: string) => {
      await confirmFreshCampaignWriteAuthority(identity);
      return resolveCampaignFeedback(campaignId, feedbackId);
    },
    onSuccess: (row) => {
      replaceRow(row);
      setResolveTarget(null);
      toast.success("Comment marked resolved");
    },
  });

  const rows = Array.isArray(feedbackQuery.data) ? feedbackQuery.data : [];
  const open = rows.filter((row) => !row.resolved_at);
  const resolved = rows.filter((row) => row.resolved_at);
  const visible = showResolved ? rows : open;
  const busy = post.isPending || resolve.isPending;

  const postBlockedReason = !identityReady
    ? "Checking your access…"
    : !canWrite
      ? CAMPAIGN_READ_ONLY_MESSAGE
      : null;

  return (
    <section
      className={PANEL_CLASS}
      aria-labelledby="campaign-feedback-heading"
      data-testid="campaign-feedback-panel"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <MessageSquare className="h-4 w-4" aria-hidden />
        <h2 id="campaign-feedback-heading" className="text-base font-semibold">
          Feedback
        </h2>
        {open.length > 0 ? (
          <Badge variant="secondary">{open.length} open</Badge>
        ) : null}
        <span className="flex-1" />
        {resolved.length > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-pressed={showResolved}
            onClick={() => setShowResolved((value) => !value)}
          >
            {showResolved
              ? "Hide resolved"
              : `Show resolved (${resolved.length})`}
          </Button>
        ) : null}
      </div>
      <p className="mb-3 text-sm text-muted-foreground">
        Collaborate with reviewers on this campaign. Mark comments resolved as
        you address them.
      </p>

      <div className="grid gap-2">
        <Label htmlFor={inputId}>New comment</Label>
        <Textarea
          id={inputId}
          rows={3}
          value={draft}
          readOnly={!canWrite}
          disabled={post.isPending}
          aria-describedby={`${inputId}-note`}
          placeholder="Leave a comment for the team…"
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p id={`${inputId}-note`} className="text-xs text-muted-foreground">
            {postBlockedReason ?? "Comments are visible to everyone in this workspace."}
          </p>
          <Button
            type="button"
            size="sm"
            disabled={postBlockedReason !== null || busy || draft.trim() === ""}
            onClick={() => post.mutate(draft.trim())}
          >
            {post.isPending ? "Posting…" : "Post comment"}
          </Button>
        </div>
      </div>

      <div className="mt-4">
        {feedbackQuery.isPending ? (
          <div role="status" aria-label="Loading feedback" className="grid gap-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : feedbackQuery.isError ? (
          <div role="alert" className="space-y-2 text-sm">
            <p className="text-destructive">
              Couldn&apos;t load feedback: {apiErrorMessage(feedbackQuery.error)}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void feedbackQuery.refetch()}
            >
              Retry feedback
            </Button>
          </div>
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {open.length === 0 && resolved.length > 0
              ? "All comments resolved."
              : "No comments yet."}
          </p>
        ) : (
          <ul className="grid gap-2">
            {visible.map((row) => (
              <li
                key={row.id}
                className={
                  row.resolved_at
                    ? "rounded-md border p-3 opacity-75"
                    : "rounded-md border p-3"
                }
              >
                <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                  <strong>{row.author_label || "Unknown author"}</strong>
                  <span className="text-muted-foreground">
                    {formatWireTimestamp(row.created_at, "time unavailable")}
                  </span>
                  {row.resolved_at ? (
                    <Badge variant="success">Resolved</Badge>
                  ) : null}
                </div>
                <p className="whitespace-pre-wrap break-words text-sm">
                  {row.body}
                </p>
                {!row.resolved_at ? (
                  <div className="mt-2 flex justify-end">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={postBlockedReason !== null || busy}
                      title={postBlockedReason ?? undefined}
                      onClick={() => setResolveTarget(row)}
                    >
                      <CheckCircle2 className="h-4 w-4" aria-hidden />
                      Mark resolved
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={resolveTarget !== null}
        onOpenChange={(next) => {
          if (!next && !resolve.isPending) setResolveTarget(null);
        }}
        title="Mark this comment resolved?"
        description="Resolving is one-way: there is no reopen. The comment leaves the open list and stays readable under “Show resolved”, stamped with who resolved it and when."
        confirmLabel="Mark resolved"
        cancelLabel="Keep it open"
        confirmVariant="default"
        onConfirm={async () => {
          if (resolveTarget) await resolve.mutateAsync(resolveTarget.id);
        }}
      />
    </section>
  );
}
