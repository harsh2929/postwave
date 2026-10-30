// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getEmailHealth,
  type EmailHealth,
  type EmailHealthGrade,
  type EmailHealthRecommendation,
} from "@/lib/email-health-api";
import { base, STALE, type RoleKey } from "@/lib/query-keys";
import { absoluteTime, timeAgo } from "@/lib/relative-time";

const gradeCopy: Record<
  EmailHealthGrade,
  {
    label: string;
    detail: string;
    tone: "success" | "warning" | "destructive" | "outline";
  }
> = {
  A: {
    label: "Recently validated",
    detail: "Validated within the last 30 days.",
    tone: "success",
  },
  B: {
    label: "Positive activity",
    detail:
      "A recent first-party delivery, human-classified click, or human reply supports this address.",
    tone: "success",
  },
  C: {
    label: "Catch-all",
    detail: "The domain receives mail; the exact mailbox is uncertain.",
    tone: "warning",
  },
  D: {
    label: "Negative activity",
    detail:
      "A hard, soft, or unclassified bounce in the last 30 days has not been superseded by newer first-party positive activity.",
    tone: "destructive",
  },
  F: {
    label: "Invalid or blocked",
    detail:
      "An invalid, spam-trap, abuse, or do-not-mail result, a complaint, or an active consent/suppression stop applies.",
    tone: "destructive",
  },
  U: {
    label: "Not enough evidence",
    detail: "No decisive current signal is available.",
    tone: "outline",
  },
};

const recommendationCopy: Record<EmailHealthRecommendation, string> = {
  send: "Send",
  caution: "Review before sending",
  do_not_send: "Do not send",
  blocked: "Blocked from sending",
};

export function healthReasonLabel(code: string): string {
  const known: Record<string, string> = {
    verification_valid_30d: "Validated in the last 30 days",
    verification_catch_all: "Catch-all mailbox",
    verification_invalid: "Verifier reported invalid",
    verification_spamtrap: "Spam-trap signal",
    verification_abuse: "Abuse-risk signal",
    verification_do_not_mail: "Verifier marked do not mail",
    verification_stale: "Validation is older than 30 days",
    no_decisive_evidence: "No decisive current signal",
    open_not_high_confidence: "Open activity alone is not conclusive",
    active_send_hard_stop: "Active consent or suppression stop",
    suppression_hard_bounce: "Active hard-bounce suppression",
    suppression_soft_bounce: "Active soft-bounce suppression",
    suppression_soft_bounce_threshold: "Active soft-bounce suppression",
    consent_unsubscribed: "Currently unsubscribed",
    consent_not_proven: "Consent not currently proven",
    address_suppressed: "Address currently suppressed",
    health_evidence_unavailable: "Health evidence is temporarily unavailable",
  };
  return (
    known[code] ??
    code
      .replace(/^(?:event|suppression|consent|evidence)_/u, "")
      .replace(/[_-]+/gu, " ")
      .replace(/^./u, (first) => first.toUpperCase())
  );
}

function statusOf(error: unknown): number {
  if (!error || typeof error !== "object" || !("status" in error)) return 0;
  return Number((error as { status?: unknown }).status) || 0;
}

export function EmailHealthCard({
  email,
  subscriberId,
  tenantId,
  role,
}: {
  email: string;
  subscriberId: string;
  tenantId: string;
  role: RoleKey;
}) {
  const normalized = email.trim().toLowerCase();
  const health = useQuery({
    // Keep PII out of query keys. Nesting under the canonical subscriber key
    // also makes every existing subscriber mutation invalidate this read.
    queryKey: [
      ...base("subscriber", tenantId, role),
      subscriberId,
      "email-health",
    ] as const,
    queryFn: () => getEmailHealth(normalized),
    enabled: Boolean(normalized && tenantId !== "anon"),
    staleTime: STALE.detail,
    retry: (count, error) =>
      ![404, 405, 501].includes(statusOf(error)) && count < 2,
  });

  if ([404, 405, 501].includes(statusOf(health.error))) return null;
  if (health.isPending) {
    return (
      <section
        aria-label="Email health"
        aria-busy="true"
        className="rounded-lg border bg-card p-4"
      >
        <Skeleton className="h-5 w-44" />
        <Skeleton className="mt-3 h-4 w-full max-w-md" />
      </section>
    );
  }
  if (health.error || !health.data) {
    return (
      <section
        aria-labelledby="email-health-title"
        className="rounded-lg border border-destructive/30 bg-destructive/5 p-4"
      >
        <h2 id="email-health-title" className="text-sm font-medium">
          Email health
        </h2>
        <p role="alert" className="mt-1 text-sm text-muted-foreground">
          Health evidence could not be verified. No send recommendation is
          shown.
        </p>
        <Button
          className="mt-3"
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void health.refetch()}
        >
          Retry
        </Button>
      </section>
    );
  }
  return <ResolvedEmailHealth health={health.data} />;
}

function ResolvedEmailHealth({ health }: { health: EmailHealth }) {
  const copy = gradeCopy[health.grade];
  return (
    <section
      aria-labelledby="email-health-title"
      className="rounded-lg border bg-card p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="email-health-title" className="mr-1 text-sm font-medium">
          Email health
        </h2>
        <Badge
          variant={copy.tone}
          aria-label={`Email health grade ${health.grade}`}
        >
          Grade {health.grade}
        </Badge>
        <span className="text-sm text-muted-foreground">{copy.label}</span>
        <strong className="ml-auto text-sm">
          {health.evidence_complete
            ? recommendationCopy[health.recommendation]
            : "Sending paused — evidence unavailable"}
        </strong>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {health.evidence_complete
          ? copy.detail
          : "Consent and suppression evidence could not be loaded, so this address remains ineligible until health can be recomputed."}
        {health.hard_stop
          ? " An active hard stop takes precedence over every positive signal."
          : ""}
      </p>
      {health.reason_codes.length > 0 ? (
        <ul
          aria-label="Email health reasons"
          className="mt-3 flex list-none flex-wrap gap-1.5 p-0"
        >
          {health.reason_codes.map((reason) => (
            <li key={reason}>
              <Badge variant="outline">{healthReasonLabel(reason)}</Badge>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-3 text-xs text-muted-foreground">
        {health.grade === "A" &&
        health.status === "valid" &&
        health.checked_at ? (
          <>
            <span title={absoluteTime(health.checked_at)}>
              Validated {absoluteTime(health.checked_at)}
            </span>
            <span> · </span>
          </>
        ) : null}
        {health.evidence_at ? (
          <>
            <span title={absoluteTime(health.evidence_at)}>
              Latest evidence {timeAgo(health.evidence_at)}
            </span>
            <span> · </span>
          </>
        ) : null}
        Model {health.model_version} · computed {timeAgo(health.computed_at)}
      </p>
    </section>
  );
}
