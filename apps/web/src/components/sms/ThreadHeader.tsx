// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Subscriber + consent context for one SMS conversation (desktop
// components/sms/ThreadHeader.tsx:107-207). Reads
// GET /api/v1/sms/conversations/{phone}/context and renders what the server
// loaded: the linked subscriber, the exact send-eligible consent lists with
// their source and time, the suppression category, whether live reply
// dispatch can start, and the retained message count.
//
// This is loaded evidence, not a consent authority ledger — the send gate on
// the server stays authoritative, and the panel says so.
//
// The query key is supplied by the caller and must be opaque: a raw phone
// number never enters cache metadata (same rule as the inbox thread).

import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api";
import { getSmsConversationContext } from "@/lib/sms-api";
import type { SmsConversationContext } from "@/lib/sms-conversation-lookup-contract";
import { safeSmsText } from "@/lib/sms-inbox-contract";

type BadgeVariant = "success" | "destructive" | "warning" | "secondary";

const SUPPRESSION_LABELS: Record<string, string> = {
  manual: "Manual suppression",
  stop_keyword: "STOP keyword",
  help_keyword: "HELP keyword",
  carrier_block: "Carrier block",
  complaint: "Complaint",
  quiet_hours: "Quiet hours",
  expired: "Expired consent",
};

const DISPATCH_REASONS: Record<string, string> = {
  sms_reply_dispatch_release_held:
    "SMS reply dispatch is release-held on the server.",
  sms_financial_reservation_unavailable:
    "The SMS financial reservation needed to send is unavailable.",
  sms_configured_sender_unavailable:
    "No configured sender can dispatch a reply for this workspace.",
};

export function smsConsentBadge(context: SmsConversationContext): {
  label: string;
  variant: BadgeVariant;
  description: string;
} {
  if (context.suppressed) {
    return {
      label: "Suppressed",
      variant: "destructive",
      description:
        "This number is on the workspace suppression list. No SMS can be sent to it.",
    };
  }
  if (context.consentStatus === "opted_out") {
    return {
      label: "Opted out",
      variant: "destructive",
      description: "The loaded consent evidence records an opt-out.",
    };
  }
  if (context.consentStatus === "opted_in") {
    return {
      label: context.consentMixed ? "Opted in · mixed lists" : "Opted in",
      variant: context.consentMixed ? "warning" : "success",
      description: context.consentMixed
        ? "At least one list holds send-eligible consent; other lists for this number disagree."
        : "At least one list holds complete, timestamped send-eligible consent.",
    };
  }
  if (context.consentStatus === "pending") {
    return {
      label: "Consent pending",
      variant: "warning",
      description:
        "Consent is recorded but not send-eligible yet (incomplete or unconfirmed evidence).",
    };
  }
  return {
    label: "No consent record",
    variant: "secondary",
    description: "No SMS subscription row exists for this number.",
  };
}

export function SmsConversationContextPanel({
  tenantId,
  phoneE164,
  queryKey,
  enabled = true,
}: {
  tenantId: string;
  phoneE164: string;
  /** Opaque, caller-owned key (never containing the raw phone). */
  queryKey: readonly unknown[];
  enabled?: boolean;
}) {
  const context = useQuery({
    queryKey,
    enabled,
    queryFn: ({ signal }) =>
      getSmsConversationContext({ tenantId, phoneE164, signal }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  return (
    <section
      aria-label="Subscriber and consent context"
      className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm"
    >
      {context.isPending ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading subscriber context…
        </p>
      ) : context.isError ? (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-destructive">
            Subscriber context could not be loaded.{" "}
            {apiErrorMessage(context.error)}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void context.refetch()}
            loading={context.isFetching}
          >
            {!context.isFetching ? <RefreshCw aria-hidden /> : null}
            Retry context
          </Button>
        </div>
      ) : (
        <ContextBody context={context.data} />
      )}
    </section>
  );
}

function ContextBody({ context }: { context: SmsConversationContext }) {
  const badge = smsConsentBadge(context);
  const eligible = Array.isArray(context.eligibleLists)
    ? context.eligibleLists
    : [];
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <span className="text-xs text-muted-foreground">
          {badge.description}
        </span>
      </div>
      <p>
        {context.identityAmbiguous ? (
          <span className="text-muted-foreground">
            Multiple linked identities · no subscriber was selected
          </span>
        ) : context.subscriberEmail ? (
          <>
            <span className="text-muted-foreground">Subscriber: </span>
            <bdi dir="auto" className="[overflow-wrap:anywhere]">
              {safeSmsText(context.subscriberEmail, 320)}
            </bdi>
          </>
        ) : (
          <span className="text-muted-foreground">
            Not linked to a subscriber
          </span>
        )}
      </p>
      {eligible.length > 0 ? (
        <ul aria-label="Eligible SMS consent lists" className="space-y-1">
          {eligible.map((list) => (
            <li key={list.id} className="rounded border bg-background p-2">
              <strong>
                <bdi dir="auto">{safeSmsText(list.name, 256)}</bdi>
              </strong>
              {list.description ? (
                <span className="block text-xs text-muted-foreground">
                  <bdi dir="auto">{safeSmsText(list.description, 2048)}</bdi>
                </span>
              ) : null}
              <span className="block text-xs text-muted-foreground">
                {list.consentSource
                  ? `Source: ${list.consentSource}`
                  : "Source not reported"}
                {list.consentAt ? (
                  <>
                    {" "}
                    · recorded <RelativeTime iso={list.consentAt} />
                  </>
                ) : (
                  " · time not reported"
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          No exact send-eligible SMS list in this loaded context.
        </p>
      )}
      {context.suppressed && context.suppressionReason ? (
        <p className="text-xs">
          Suppression category:{" "}
          <strong>
            {SUPPRESSION_LABELS[context.suppressionReason] ??
              context.suppressionReason}
          </strong>
          {context.suppressionReversible
            ? " · reversible from the Suppressions card"
            : " · not reversible by an operator"}
        </p>
      ) : null}
      {context.replyDispatchAvailable ? (
        <p className="text-xs text-muted-foreground">
          Live reply dispatch is available; the server send gate still decides
          each reply.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Live dispatch unavailable · no provider request can start.{" "}
          {context.replyDispatchUnavailableReason
            ? (DISPATCH_REASONS[context.replyDispatchUnavailableReason] ?? "")
            : ""}{" "}
          {context.replyDispatchUnavailableReason ? (
            <code className="text-[11px]">
              {context.replyDispatchUnavailableReason}
            </code>
          ) : null}
        </p>
      )}
      <p className="text-xs tabular-nums text-muted-foreground">
        {context.totalMessages.toLocaleString()} retained message record
        {context.totalMessages === 1 ? "" : "s"}
        {context.firstSeenAt ? (
          <>
            {" "}
            · first seen <RelativeTime iso={context.firstSeenAt} />
          </>
        ) : null}
        {context.lastReadAt ? (
          <>
            {" "}
            · marked read <RelativeTime iso={context.lastReadAt} />
          </>
        ) : null}
      </p>
      <p className="text-[11px] text-muted-foreground">
        This is loaded consent evidence, not a complete authority ledger.
        Free-form revocations may need separate review; the server send gate
        remains authoritative.
      </p>
    </>
  );
}
