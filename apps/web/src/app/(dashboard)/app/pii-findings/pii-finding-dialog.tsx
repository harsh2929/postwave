// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileCheck2, ShieldX } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import type { MeResponse } from "@/lib/auth-api";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import {
  listSubscriberPiiFindings,
  piiFindingStatusLabel,
  piiFindingTypeLabel,
  piiReviewCommentContainsStrongPii,
  piiRuneCount,
  reviewPiiFinding,
  shortPiiFingerprint,
  validatePiiReviewInput,
  type PiiFinding,
  type PiiReviewInput,
  type PiiReviewReason,
  type PiiTerminalStatus,
} from "@/lib/pii-findings-api";

import {
  describePiiError,
  reasonOptions,
  reviewReasonLabel,
  statusBadgeVariant,
} from "./pii-findings-ui";

const RELATED_PAGE_SIZE = 20;

interface Props {
  identity: MeResponse | null;
  protectedBase: readonly unknown[];
  open: boolean;
  initialFinding: PiiFinding | null;
  onClose: () => void;
}

export function PiiFindingDialog({
  open,
  initialFinding,
  onClose,
  identity,
  protectedBase,
}: Props) {
  const queryClient = useQueryClient();
  const [finding, setFinding] = useState(initialFinding);
  const [relatedPage, setRelatedPage] = useState(1);
  const [outcome, setOutcome] = useState<PiiTerminalStatus | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const lockRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setFinding(initialFinding);
    setRelatedPage(1);
    setOutcome(null);
    setAnnouncement("");
  }, [initialFinding]);

  const relatedKey = useMemo(
    () => [
      ...protectedBase,
      "subscriber-findings",
      finding?.subscriber_id ?? "none",
      relatedPage,
      RELATED_PAGE_SIZE,
    ],
    [finding?.subscriber_id, protectedBase, relatedPage],
  );
  const related = useQuery({
    queryKey: relatedKey,
    queryFn: ({ signal }) =>
      listSubscriberPiiFindings(finding!.subscriber_id, {
        page: relatedPage,
        perPage: RELATED_PAGE_SIZE,
        signal,
      }),
    enabled: open && Boolean(finding),
  });

  const decision = useMutation({
    mutationFn: async ({
      id,
      input,
    }: {
      id: string;
      input: PiiReviewInput;
    }) => {
      if (!identity || lockRef.current)
        throw new Error(
          "Owner or admin access is required or another review is running.",
        );
      lockRef.current = true;
      const controller = new AbortController();
      controllerRef.current = controller;
      const frozen = { ...input };
      try {
        await verifyFreshAdminAuthority(identity, controller.signal);
        return await reviewPiiFinding(id, frozen, {
          signal: controller.signal,
          requireOnline: true,
          maxAttempts: 1,
        });
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
        lockRef.current = false;
      }
    },
    onSuccess: async (next) => {
      setFinding(next);
      setOutcome(null);
      setAnnouncement(
        `${piiFindingStatusLabel(next.status)} decision recorded with immutable receipt ${next.review_receipt?.receipt_id ?? ""}.`,
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: protectedBase,
          exact: false,
        }),
        queryClient.invalidateQueries({
          queryKey: [
            ...protectedBase,
            "subscriber-findings",
            next.subscriber_id,
          ],
          exact: false,
        }),
      ]);
    },
  });
  useEffect(() => () => controllerRef.current?.abort(), []);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !decision.isPending) onClose();
      }}
    >
      <DialogContent closeDisabled={decision.isPending} className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Shadow-PII finding</DialogTitle>
          <DialogDescription>
            Review safe field metadata and protected fingerprint evidence. The
            matched subscriber value is never returned or displayed.
          </DialogDescription>
        </DialogHeader>
        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>

        {finding ? (
          <div className="space-y-5">
            <FindingFacts finding={finding} />

            {finding.status === "pending" ? (
              outcome ? (
                <DecisionForm
                  finding={finding}
                  outcome={outcome}
                  busy={decision.isPending}
                  error={decision.error}
                  onCancel={() => {
                    if (!decision.isPending) {
                      decision.reset();
                      setOutcome(null);
                    }
                  }}
                  onSubmit={(input) =>
                    decision.mutate({ id: finding.id, input })
                  }
                />
              ) : (
                <div className="flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h3 className="text-sm font-semibold">Decision required</h3>
                    <p className="text-xs leading-5 text-muted-foreground">
                      A terminal decision requires a reason, safe comment,
                      evidence reference, and compare-and-set finding version.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      onClick={() => {
                        decision.reset();
                        setOutcome("reviewed");
                      }}
                    >
                      <CheckCircle2 aria-hidden /> Record reviewed
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        decision.reset();
                        setOutcome("dismissed");
                      }}
                    >
                      <ShieldX aria-hidden /> Dismiss finding
                    </Button>
                  </div>
                </div>
              )
            ) : finding.review_receipt ? (
              <Receipt receipt={finding.review_receipt} />
            ) : null}

            <RelatedFindings
              currentId={finding.id}
              loading={related.isPending}
              fetching={related.isFetching}
              error={related.error}
              items={
                Array.isArray(related.data?.items) ? related.data.items : []
              }
              page={related.data?.page ?? relatedPage}
              perPage={related.data?.per_page ?? RELATED_PAGE_SIZE}
              total={related.data?.total ?? 0}
              onRetry={() => void related.refetch()}
              onPage={setRelatedPage}
              onInspect={(next) => {
                setFinding(next);
                setOutcome(null);
                decision.reset();
              }}
            />
          </div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={decision.isPending}
            onClick={onClose}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FindingFacts({ finding }: { finding: PiiFinding }) {
  return (
    <section aria-labelledby="pii-finding-facts" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="pii-finding-facts" className="text-sm font-semibold">
          Safe finding metadata
        </h3>
        <Badge variant={statusBadgeVariant(finding.status)}>
          {piiFindingStatusLabel(finding.status)}
        </Badge>
      </div>
      <dl className="grid gap-3 rounded-lg border p-4 text-sm sm:grid-cols-2">
        <Fact label="Field key" value={finding.field_name} mono />
        <Fact
          label="Detected type"
          value={piiFindingTypeLabel(finding.detected_type)}
        />
        <Fact
          label="Confidence"
          value={`${Math.round(finding.confidence * 100)}%`}
        />
        <Fact
          label="Detected"
          value={formatWireTimestamp(finding.created_at, "Unknown time")}
        />
        <Fact label="Subscriber ID" value={finding.subscriber_id} mono />
        <Fact label="Finding ID" value={finding.id} mono />
        <Fact
          label="Protected fingerprint"
          value={shortPiiFingerprint(finding.fingerprint)}
          mono
        />
        <Fact
          label="Fingerprint protection"
          value={
            finding.fingerprint_scheme === "hmac-sha256-v1"
              ? `HMAC-SHA256 · key ${finding.fingerprint_key_version}`
              : "Legacy non-recomputable linkage token"
          }
        />
        <Fact
          label="Detector / policy"
          value={`${finding.detector_name} ${finding.detector_version} · ${finding.policy_name} ${finding.policy_version}`}
        />
        <Fact
          label="Current version"
          value={formatWireTimestamp(finding.updated_at, "Unknown time")}
        />
      </dl>
    </section>
  );
}

function Fact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "break-all font-mono text-xs" : "break-words"}>
        {value}
      </dd>
    </div>
  );
}

function DecisionForm({
  finding,
  outcome,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  finding: PiiFinding;
  outcome: PiiTerminalStatus;
  busy: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (input: PiiReviewInput) => void;
}) {
  const [reason, setReason] = useState<PiiReviewReason | "">("");
  const [comment, setComment] = useState("");
  const [evidence, setEvidence] = useState("");
  const [attempted, setAttempted] = useState(false);
  const reasonId = useId();
  const commentId = useId();
  const commentHelpId = useId();
  const evidenceId = useId();
  const evidenceHelpId = useId();
  const formErrorId = useId();
  const options = reasonOptions(outcome);
  const input: PiiReviewInput = {
    status: outcome,
    reason: reason || options[0].value,
    comment: comment.trim(),
    evidence_reference: evidence.trim(),
    expected_updated_at: finding.updated_at,
  };
  const commentHasPii = piiReviewCommentContainsStrongPii(comment);
  const commentLength = piiRuneCount(comment.trim());
  const validation =
    reason === ""
      ? "Choose a documented reason."
      : validatePiiReviewInput(input);
  const requestFailure = error ? describePiiError(error) : null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAttempted(true);
    if (validation || busy) return;
    onSubmit(input);
  }

  return (
    <form
      className="space-y-4 rounded-lg border p-4"
      aria-label={`${outcome === "reviewed" ? "Review" : "Dismiss"} PII finding`}
      aria-describedby={requestFailure ? formErrorId : undefined}
      onSubmit={submit}
    >
      <div>
        <h3 className="text-sm font-semibold">Document the decision</h3>
        <p className="text-xs leading-5 text-muted-foreground">
          Every field below is retained in an immutable receipt. Never paste the
          detected value.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor={reasonId}>Reason</Label>
        <Select
          id={reasonId}
          value={reason}
          autoFocus
          required
          disabled={busy}
          aria-invalid={attempted && reason === ""}
          onChange={(event) =>
            setReason(event.currentTarget.value as PiiReviewReason | "")
          }
        >
          <option value="">Choose a documented reason…</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        {reason ? (
          <p className="text-xs text-muted-foreground">
            {options.find((option) => option.value === reason)?.description}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor={commentId}>Decision comment</Label>
        <Textarea
          id={commentId}
          value={comment}
          rows={4}
          required
          disabled={busy}
          placeholder="Record what was verified and the follow-up owner. Never paste the detected value."
          aria-describedby={commentHelpId}
          aria-invalid={commentHasPii || commentLength > 2_000}
          onChange={(event) => setComment(event.currentTarget.value)}
        />
        <p
          id={commentHelpId}
          className={
            commentHasPii || commentLength > 2_000
              ? "text-xs text-destructive-emphasis"
              : "text-xs text-muted-foreground"
          }
        >
          {commentLength.toLocaleString()} / 2,000 characters ·{" "}
          {commentHasPii
            ? "Remove personal-data-shaped values and cite the evidence reference instead."
            : "Do not include personal data."}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor={evidenceId}>Evidence reference</Label>
        <Input
          id={evidenceId}
          value={evidence}
          required
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          placeholder="ticket:DPO-123"
          aria-describedby={evidenceHelpId}
          aria-invalid={attempted && Boolean(validation)}
          onChange={(event) => setEvidence(event.currentTarget.value)}
        />
        <p id={evidenceHelpId} className="text-xs text-muted-foreground">
          Use a non-secret typed reference such as ticket:DPO-123,
          case:privacy/2026-071, or policy:PII-v3.
        </p>
      </div>

      {attempted && validation ? (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden />
          <AlertTitle>Decision is incomplete</AlertTitle>
          <AlertDescription>{validation}</AlertDescription>
        </Alert>
      ) : null}

      {requestFailure ? (
        <Alert id={formErrorId} variant="destructive">
          <AlertTriangle aria-hidden />
          <AlertTitle>{requestFailure.title}</AlertTitle>
          <AlertDescription>
            {requestFailure.message} Your form has been preserved.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" loading={busy} disabled={busy}>
          {outcome === "reviewed" ? "Record reviewed" : "Record dismissal"}
        </Button>
      </div>
    </form>
  );
}

function Receipt({
  receipt,
}: {
  receipt: NonNullable<PiiFinding["review_receipt"]>;
}) {
  return (
    <section
      className="space-y-3 rounded-lg border p-4"
      aria-labelledby="receipt-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3
          id="receipt-title"
          className="flex items-center gap-2 text-sm font-semibold"
        >
          <FileCheck2 className="size-4" aria-hidden /> Immutable decision
          receipt
        </h3>
        <Badge variant="success">Verified response contract</Badge>
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <Fact label="Outcome" value={piiFindingStatusLabel(receipt.status)} />
        <Fact label="Reason" value={reviewReasonLabel(receipt.reason)} />
        <Fact label="Comment" value={receipt.comment} />
        <Fact
          label="Evidence reference"
          value={receipt.evidence_reference}
          mono
        />
        <Fact
          label="Reviewed"
          value={formatWireTimestamp(receipt.reviewed_at, "Unknown time")}
        />
        <Fact
          label="Stable actor"
          value={`${receipt.actor_type}:${receipt.actor_id}`}
          mono
        />
        <Fact label="Receipt ID" value={receipt.receipt_id} mono />
        <Fact
          label="Accepted finding version"
          value={formatWireTimestamp(
            receipt.finding_updated_at,
            "Unknown time",
          )}
        />
      </dl>
    </section>
  );
}

function RelatedFindings({
  currentId,
  loading,
  fetching,
  error,
  items,
  page,
  perPage,
  total,
  onRetry,
  onPage,
  onInspect,
}: {
  currentId: string;
  loading: boolean;
  fetching: boolean;
  error: unknown;
  items: PiiFinding[];
  page: number;
  perPage: number;
  total: number;
  onRetry: () => void;
  onPage: (page: number) => void;
  onInspect: (finding: PiiFinding) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const failure = error ? describePiiError(error) : null;
  return (
    <section aria-labelledby="subscriber-history-title" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id="subscriber-history-title" className="text-sm font-semibold">
            Subscriber finding history
          </h3>
          <p className="text-xs text-muted-foreground">
            Loaded from the tenant-bound subscriber endpoint; no subscriber
            name, address, or matched value is requested.
          </p>
        </div>
        {fetching && !loading ? (
          <span role="status" className="text-xs text-muted-foreground">
            Refreshing…
          </span>
        ) : null}
      </div>
      {loading ? (
        <div
          className="space-y-2"
          aria-label="Loading subscriber finding history"
        >
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : failure ? (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden />
          <AlertTitle>{failure.title}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{failure.message}</p>
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              Retry subscriber history
            </Button>
          </AlertDescription>
        </Alert>
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No findings were returned for this subscriber.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-3 p-3"
            >
              <div className="min-w-0">
                <p className="break-all font-mono text-xs">{item.field_name}</p>
                <p className="text-xs text-muted-foreground">
                  {piiFindingTypeLabel(item.detected_type)} ·{" "}
                  {piiFindingStatusLabel(item.status)} ·{" "}
                  {formatWireTimestamp(item.created_at, "Unknown time")}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant={item.id === currentId ? "secondary" : "outline"}
                disabled={item.id === currentId}
                onClick={() => onInspect(item)}
              >
                {item.id === currentId ? "Viewing" : "Inspect"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {total > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground" aria-live="polite">
            Subscriber history page {page.toLocaleString()} of{" "}
            {pages.toLocaleString()} · {total.toLocaleString()} finding
            {total === 1 ? "" : "s"}
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={page <= 1 || fetching}
              onClick={() => onPage(page - 1)}
            >
              Previous
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={page >= pages || fetching}
              onClick={() => onPage(page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
