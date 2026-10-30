// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Review evidence modal — the full record behind a queue card, and the three
 * public verbs (Publish / Reject / Reply), each behind a confirm that names
 * its consequence in the desktop's words.
 *
 * Decision controls are withheld until GET /api/v1/reviews/{id} has verified
 * the complete record: the queue snapshot is a partial view, and publishing
 * from a partial view is how a review with a hidden moderation note goes
 * public. Denials render the server's sentence; nothing here invents one.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import type { MeResponse } from "@/lib/auth-api";
import { exactPrincipalKey } from "@/lib/exact-principal";
import { newUUIDv7 } from "@/lib/http-fetch";
import { STALE } from "@/lib/query-keys";
import {
  approveReview,
  getReview,
  rejectReview,
  replyToReview,
  type Review,
  type ReviewPublicReply,
} from "@/lib/reviews-api";
import {
  REVIEW_REPLY_MAX_CHARS,
  evidenceLabel,
  formatDateTime,
  isReviewDecidable,
  statusBadgeVariant,
  statusLabel,
} from "@/lib/reviews-helpers";
import { EngagementLoading } from "../../_engagement/engagement-ui";

type DecisionIntent = "publish" | "reject";

export interface ReviewDetailDialogProps {
  open: boolean;
  /** The queue snapshot; the complete record is fetched on open. */
  review: Review | null;
  canAdmin: boolean;
  identity: MeResponse | null;
  keyBase: readonly unknown[];
  onOpenChange: (open: boolean) => void;
  /** Called after the server accepted a publish/reject with the updated record. */
  onDecision: (updated: Review) => void;
}

interface ModerationOperation {
  body?: string;
  controller: AbortController;
  id: string;
  idempotencyKey: string;
  openedIdentity: MeResponse;
  principalKey: string;
  which?: DecisionIntent;
}

function Stars({ rating }: { rating: number }) {
  return (
    <span
      className="inline-flex items-center gap-0.5 text-warning-emphasis"
      role="img"
      aria-label={`${rating} out of 5 stars`}
    >
      {Array.from({ length: 5 }, (_, index) => (
        <Star
          key={index}
          aria-hidden
          className="size-4"
          fill={index < rating ? "currentColor" : "none"}
        />
      ))}
    </span>
  );
}

function EvidenceItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 break-words text-sm">{value}</dd>
    </div>
  );
}

function DateEvidence({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  const formatted = formatDateTime(value);
  return (
    <EvidenceItem
      label={label}
      value={
        formatted && value ? (
          <time dateTime={value}>{formatted}</time>
        ) : (
          "Not available"
        )
      }
    />
  );
}

function ReviewEvidence({ review }: { review: Review }) {
  const replies = review.public_replies ?? [];
  const reviewer = review.reviewer_name?.trim() || "Anonymous reviewer";
  const title = review.title?.trim() || "Untitled customer review";
  const body = review.body?.trim() ?? "";

  return (
    <article className="space-y-5" aria-label="Review evidence record">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <Stars rating={review.rating} />
          <span className="text-sm tabular-nums text-muted-foreground">
            {review.rating} / 5
          </span>
          <Badge variant={statusBadgeVariant(review.status)}>
            {statusLabel(review.status)}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">{reviewer}</p>
        <h3 className="break-words text-base font-semibold">{title}</h3>
      </header>

      <section aria-label="Customer's review">
        <h4 className="text-sm font-medium">Customer&apos;s review</h4>
        {body ? (
          <p
            dir="auto"
            className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed"
          >
            {body}
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">
            No written review was supplied.
          </p>
        )}
      </section>

      <section aria-label="Reported trust flags">
        <h4 className="text-sm font-medium">Reported trust flags</h4>
        <p className="mt-1 text-xs text-muted-foreground">
          These service-supplied fields are not independent proof of buyer
          identity or review authenticity.
        </p>
        <ul className="mt-2 flex flex-wrap gap-2 text-xs">
          <li className="rounded-full border px-2.5 py-1">
            {review.verified_buyer
              ? "Buyer verification reported"
              : "Buyer verification not reported"}
          </li>
          <li className="rounded-full border px-2.5 py-1">
            {review.incentivized
              ? "Incentive reported"
              : "No incentive reported"}
          </li>
          <li className="rounded-full border px-2.5 py-1">
            {review.featured
              ? "Featured placement reported"
              : "Featured flag not reported"}
          </li>
        </ul>
      </section>

      <details open className="rounded-lg border bg-muted/20 p-3">
        <summary className="cursor-pointer text-sm font-medium">
          Evidence trail
        </summary>
        <p className="mt-1 text-xs text-muted-foreground">
          These are service-reported record values. This screen does not
          independently verify their provenance or timestamps.
        </p>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <EvidenceItem
            label="Reported product"
            value={review.product_id?.trim() || "Not supplied"}
          />
          <EvidenceItem
            label="Reported variant"
            value={review.variant_id?.trim() || "Not supplied"}
          />
          <EvidenceItem
            label="Reported review type"
            value={evidenceLabel(review.review_type)}
          />
          <EvidenceItem
            label="Reported source"
            value={evidenceLabel(review.source_platform)}
          />
          <DateEvidence
            label="Reported submitted"
            value={review.submitted_at}
          />
          <DateEvidence
            label="Reported public since"
            value={review.published_at}
          />
          <DateEvidence
            label="Reported moderated"
            value={review.moderated_at}
          />
        </dl>
      </details>

      {review.moderation_reason?.trim() ? (
        <section aria-label="Moderation note">
          <h4 className="text-sm font-medium">Moderation note</h4>
          <p dir="auto" className="mt-1 break-words text-sm">
            {review.moderation_reason}
          </p>
        </section>
      ) : null}

      <section aria-label="Service-reported public replies">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-sm font-medium">
            Service-reported public replies
          </h4>
          <span className="text-xs tabular-nums text-muted-foreground">
            {replies.length}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Reply status, author and timestamp come from the service response and
          are not independently verified here.
        </p>
        {replies.length ? (
          <ul className="mt-2 space-y-2">
            {replies.map((reply, index) => (
              <li
                key={reply.id ?? `reply-${index}`}
                className="rounded-md border bg-background/60 p-3"
              >
                <p className="text-xs text-muted-foreground">
                  Reported author: {reply.author?.trim() || "Not provided"}
                  {formatDateTime(reply.created_at)
                    ? ` · ${formatDateTime(reply.created_at)}`
                    : ""}
                </p>
                <p dir="auto" className="mt-1 break-words text-sm">
                  {reply.body}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            No service-reported public reply is available.
          </p>
        )}
      </section>

      <p className="text-xs text-muted-foreground">
        Private contact and import payload fields are intentionally withheld
        from this moderation view.
      </p>
    </article>
  );
}

function ReplyComposer({
  draft,
  busy,
  onChange,
  onCancel,
  onReview,
}: {
  draft: string;
  busy: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onReview: () => void;
}) {
  const inputId = useId();
  const helpId = useId();
  const count = Array.from(draft).length;
  return (
    <section
      className="space-y-2 rounded-lg border p-3"
      aria-label="Write a public store reply"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <Label htmlFor={inputId}>Write a public store reply</Label>
          <p id={helpId} className="mt-1 text-xs text-muted-foreground">
            The next step shows the exact public text before anything is
            published.
          </p>
        </div>
        <output aria-live="polite" className="text-xs tabular-nums">
          {count.toLocaleString()} / {REVIEW_REPLY_MAX_CHARS.toLocaleString()}
        </output>
      </div>
      <Textarea
        id={inputId}
        value={draft}
        maxLength={REVIEW_REPLY_MAX_CHARS}
        rows={5}
        disabled={busy}
        aria-describedby={helpId}
        autoFocus
        onChange={(event) => onChange(event.target.value)}
        placeholder="Write the response customers will see…"
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          disabled={busy || !draft.trim()}
          onClick={onReview}
        >
          Review public reply
        </Button>
      </div>
    </section>
  );
}

export function ReviewDetailDialog({
  open,
  review,
  canAdmin,
  identity,
  keyBase,
  onOpenChange,
  onDecision,
}: ReviewDetailDialogProps) {
  const queryClient = useQueryClient();
  const id = review?.id?.trim() ?? "";
  const hasId = id !== "";
  const detailKey = [...keyBase, "detail", id];
  const principalKey = exactPrincipalKey(identity);
  const principalKeyRef = useRef(principalKey);
  principalKeyRef.current = principalKey;
  const idRef = useRef(id);
  idRef.current = id;
  const operationRef = useRef<ModerationOperation | null>(null);

  const detail = useQuery({
    queryKey: detailKey,
    queryFn: ({ signal }) => getReview(id, { signal }),
    enabled: open && hasId && identity !== null,
    staleTime: STALE.detail,
  });

  const [intent, setIntent] = useState<DecisionIntent | null>(null);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyDraft, setReplyDraft] = useState("");
  const [replyPreview, setReplyPreview] = useState<string | null>(null);

  useEffect(() => {
    const scopedPrincipal = principalKey;
    const scopedId = id;
    return () => {
      const operation = operationRef.current;
      if (
        operation?.principalKey === scopedPrincipal &&
        operation.id === scopedId
      ) {
        operation.controller.abort();
        operationRef.current = null;
      }
    };
  }, [id, principalKey]);

  function beginOperation(
    details: Pick<ModerationOperation, "body" | "which">,
  ): ModerationOperation | null {
    if (operationRef.current || !identity || !canAdmin || !hasId) return null;
    const operation: ModerationOperation = {
      controller: new AbortController(),
      id,
      idempotencyKey: newUUIDv7(),
      openedIdentity: identity,
      principalKey,
      ...details,
    };
    operationRef.current = operation;
    return operation;
  }

  async function authorizeOperation(
    operation: ModerationOperation,
  ): Promise<void> {
    await verifyFreshAdminAuthority(
      operation.openedIdentity,
      operation.controller.signal,
    );
    if (
      principalKeyRef.current !== operation.principalKey ||
      idRef.current !== operation.id
    ) {
      throw new Error(
        "Workspace identity or the selected review changed while this action was in flight. Refresh before trying again.",
      );
    }
  }

  const decide = useMutation({
    mutationKey: ["reviews", principalKey, id, "decision"],
    mutationFn: async (operation: ModerationOperation) => {
      await authorizeOperation(operation);
      const options = {
        signal: operation.controller.signal,
        idempotencyKey: operation.idempotencyKey,
      };
      return operation.which === "publish"
        ? approveReview(operation.id, options)
        : rejectReview(operation.id, options);
    },
    onSuccess: (updated, operation) => {
      if (
        principalKeyRef.current !== operation.principalKey ||
        idRef.current !== operation.id
      ) {
        return;
      }
      queryClient.setQueryData<Review>(detailKey, (previous) => ({
        ...updated,
        public_replies: updated.public_replies ?? previous?.public_replies,
      }));
      void queryClient.invalidateQueries({ queryKey: [...keyBase, "list"] });
      toast.success(
        operation.which === "publish"
          ? "Review marked public by the service"
          : "Review rejected",
      );
      onDecision(updated);
    },
    onSettled: (_data, _error, operation) => {
      if (operationRef.current === operation) operationRef.current = null;
    },
  });

  const reply = useMutation({
    mutationKey: ["reviews", principalKey, id, "public-reply"],
    mutationFn: async (operation: ModerationOperation) => {
      await authorizeOperation(operation);
      if (!operation.body) throw new Error("A public reply is required.");
      return replyToReview(operation.id, operation.body, {
        signal: operation.controller.signal,
        idempotencyKey: operation.idempotencyKey,
      });
    },
    onSuccess: (created: ReviewPublicReply, operation) => {
      if (
        principalKeyRef.current !== operation.principalKey ||
        idRef.current !== operation.id
      ) {
        return;
      }
      queryClient.setQueryData<Review>(detailKey, (previous) =>
        previous
          ? {
              ...previous,
              public_replies: [...(previous.public_replies ?? []), created],
            }
          : previous,
      );
      setReplyPreview(null);
      setReplyDraft("");
      setReplyOpen(false);
      toast.success("Reply marked public by the service");
    },
    onSettled: (_data, _error, operation) => {
      if (operationRef.current === operation) operationRef.current = null;
    },
  });

  const record = detail.data ?? review;
  const ready = detail.isSuccess;
  const busy = decide.isPending || reply.isPending;
  const isPending = record ? isReviewDecidable(record) : false;
  const isPublished = record?.status === "approved";
  const canDecide = canAdmin && isPending && hasId;
  const canReply = canAdmin && isPublished && hasId;
  const actionsEnabled = ready && !busy;

  async function confirmDecision(which: DecisionIntent): Promise<void> {
    const operation = beginOperation({ which });
    if (!operation) return;
    try {
      await decide.mutateAsync(operation);
    } catch (cause) {
      throw new Error(
        `${
          which === "publish"
            ? "The review was not published."
            : "The review was not rejected."
        } ${apiErrorMessage(cause, "The service did not confirm the decision.")}`,
      );
    }
  }

  async function confirmReply(): Promise<void> {
    const body = replyPreview?.trim() ?? "";
    if (!body || Array.from(body).length > REVIEW_REPLY_MAX_CHARS) return;
    const operation = beginOperation({ body });
    if (!operation) return;
    try {
      await reply.mutateAsync(operation);
    } catch (cause) {
      throw new Error(
        `The reply was not marked public. ${apiErrorMessage(
          cause,
          "The service did not confirm the reply.",
        )}`,
      );
    }
  }

  function prepareReply(): void {
    const body = replyDraft.trim();
    if (!body || Array.from(body).length > REVIEW_REPLY_MAX_CHARS) return;
    setReplyPreview(body);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="sm:max-w-2xl"
        closeDisabled={busy}
        aria-busy={busy || detail.isFetching}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Review evidence</DialogTitle>
          <DialogDescription>
            Inspect the complete customer submission before making a public
            decision.
          </DialogDescription>
        </DialogHeader>

        {detail.isPending && hasId && record ? (
          <Alert>
            <AlertTitle>Loading the complete evidence</AlertTitle>
            <AlertDescription>
              This is the partial moderation-queue snapshot. Decision controls
              stay withheld until the server verifies the complete record and
              its public replies.
            </AlertDescription>
          </Alert>
        ) : null}

        {detail.isError ? (
          <Alert variant="destructive">
            <AlertTitle>
              {record
                ? "Complete evidence unavailable"
                : "Review evidence unavailable"}
            </AlertTitle>
            <AlertDescription>
              {apiErrorMessage(
                detail.error,
                "The service did not return a usable review record.",
              )}
              {record
                ? " The partial queue snapshot remains visible below, but moderation actions are withheld."
                : ""}
            </AlertDescription>
            <div className="mt-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                loading={detail.isFetching}
                onClick={() => void detail.refetch()}
              >
                Retry
              </Button>
            </div>
          </Alert>
        ) : null}

        {record ? (
          <ReviewEvidence review={record} />
        ) : detail.isPending && hasId ? (
          <EngagementLoading label="Loading review evidence" rows={5} />
        ) : null}

        {!canAdmin && record ? (
          <Alert>
            <AlertTitle>Read-only review evidence</AlertTitle>
            <AlertDescription>
              Your current workspace role can inspect this record, but only an
              administrator can publish, reject, or post a public store reply.
            </AlertDescription>
          </Alert>
        ) : null}

        {canAdmin && record && isPublished ? (
          <Alert variant="warning">
            <AlertTitle>Server status: approved</AlertTitle>
            <AlertDescription>
              The service reports this review as public. Visibility on any
              storefront integration is not verified here. A store reply is
              stored as public immediately and has no undo.
            </AlertDescription>
          </Alert>
        ) : null}

        {canAdmin && record?.status === "rejected" ? (
          <Alert>
            <AlertTitle>No restore path</AlertTitle>
            <AlertDescription>
              This review is rejected. The current API cannot restore it or add
              a rejection reason.
            </AlertDescription>
          </Alert>
        ) : null}

        {replyOpen && canReply ? (
          <ReplyComposer
            draft={replyDraft}
            busy={busy}
            onChange={setReplyDraft}
            onCancel={() => {
              setReplyOpen(false);
              setReplyDraft("");
            }}
            onReview={prepareReply}
          />
        ) : null}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
          {canReply && !replyOpen ? (
            <Button
              type="button"
              disabled={!actionsEnabled}
              onClick={() => setReplyOpen(true)}
            >
              Write public reply
            </Button>
          ) : null}
          {canDecide ? (
            <>
              <Button
                type="button"
                variant="destructive"
                disabled={!actionsEnabled}
                onClick={() => setIntent("reject")}
              >
                Reject review
              </Button>
              <Button
                type="button"
                disabled={!actionsEnabled}
                onClick={() => setIntent("publish")}
              >
                Publish review
              </Button>
            </>
          ) : null}
        </DialogFooter>

        <ConfirmDialog
          open={intent === "publish"}
          onOpenChange={(next) => {
            if (!next) setIntent(null);
          }}
          title="Publish this review now?"
          description={
            <>
              <span className="block">
                The service marks the review public immediately; storefront
                visibility is not verified here.
              </span>
              <span className="mt-2 block rounded-md border border-warning/40 bg-warning-subtle p-2 text-warning-emphasis">
                <span className="block font-medium">
                  Immediate server-side publication
                </span>
                Any independently working public integration may expose the
                review as soon as the server accepts this decision. There is no
                undo action.
              </span>
            </>
          }
          confirmLabel="Publish review now"
          confirmVariant="default"
          onConfirm={() => confirmDecision("publish")}
        />

        <ConfirmDialog
          open={intent === "reject"}
          onOpenChange={(next) => {
            if (!next) setIntent(null);
          }}
          title="Reject this review?"
          description={
            <>
              <span className="block">
                The review will leave the pending moderation queue.
              </span>
              <span className="mt-2 block rounded-md border border-destructive/40 bg-destructive/10 p-2 text-destructive-emphasis">
                <span className="block font-medium">No recovery path</span>
                The current API has no restore action and no endpoint for
                recording a rejection reason. Confirm only after reviewing the
                full submission.
              </span>
            </>
          }
          confirmLabel="Reject review now"
          confirmVariant="destructive"
          onConfirm={() => confirmDecision("reject")}
        />

        <ConfirmDialog
          open={replyPreview !== null}
          onOpenChange={(next) => {
            if (!next) setReplyPreview(null);
          }}
          title="Publish this store reply?"
          description={
            <>
              <span className="block">
                Review the exact text the service will store as public.
              </span>
              <span className="mt-2 block rounded-md border border-warning/40 bg-warning-subtle p-2 text-warning-emphasis">
                <span className="block font-medium">
                  Immediate server-side publication
                </span>
                The service stores this reply as public immediately. Storefront
                visibility is not verified here, and there is no edit or undo
                action.
              </span>
              <span
                className="mt-2 block rounded-md border bg-muted/30 p-2 text-foreground"
                aria-label="Exact public reply preview"
              >
                <span className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Exact public reply
                </span>
                <span dir="auto" className="mt-1 block whitespace-pre-wrap">
                  {replyPreview}
                </span>
              </span>
            </>
          }
          confirmLabel="Publish reply now"
          confirmVariant="default"
          onConfirm={confirmReply}
        />
      </DialogContent>
    </Dialog>
  );
}
