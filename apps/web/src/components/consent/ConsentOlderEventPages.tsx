// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Badge } from "@/components/ui/badge";
import {
  getConsentLedgerPage,
  olderEventPageFailure,
  recordingLagDays,
  type ConsentEvent,
  type ConsentLedger,
} from "@/lib/consent-evidence-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";

import { ConsentLoadOlder } from "./ConsentLoadOlder";
import { useConsentPageFamily } from "./use-consent-page-family";

const eventsOf = (page: ConsentLedger) => page.events;

function lagText(event: ConsentEvent): string {
  const lag = recordingLagDays(event);
  if (lag === null) return " (gap unknown)";
  if (lag === 0) return "";
  const days = Math.abs(lag);
  return ` — ${days} day${days === 1 ? "" : "s"} ${lag > 0 ? "later" : "earlier"}`;
}

/**
 * Older consent-event pages, appended under page one of the consent-event
 * ledger, with "Load older events" / "Retry older page" (desktop
 * Consent.tsx:828-947, 1517-1528).
 *
 * `ledger` is page one exactly as the owning page's admin-gated query read it;
 * this component renders only the rows it appended after it, so page one is
 * never rendered twice.
 */
export function ConsentOlderEventPages({ ledger }: { ledger: ConsentLedger }) {
  const family = useConsentPageFamily<ConsentLedger, ConsentEvent>({
    base: ledger,
    rowsOf: eventsOf,
    fetchPage: getConsentLedgerPage,
    pageFailure: olderEventPageFailure,
    noun: "event",
    keptNoun: "correlation evidence",
  });

  return (
    <div>
      {family.appended.length > 0 ? (
        <ul
          className="mt-3 divide-y rounded-xl border"
          aria-label="Older consent events"
        >
          {family.appended.map((event) => (
            <li key={event.id} className="min-w-0 p-4">
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-all text-sm font-medium">
                    {event.subject_email || event.subject_id || "Unknown subject"}
                  </p>
                  <p className="mt-1 break-words text-xs text-muted-foreground">
                    {event.category.replace(/_/gu, " ") || "category unstated"}
                    {" · via "}
                    {event.source.replace(/_/gu, " ") || "source unstated"}
                  </p>
                </div>
                <Badge
                  className="w-fit capitalize"
                  variant={event.action === "granted" ? "success" : "outline"}
                >
                  {event.action.replace(/_/gu, " ") || "action unstated"}
                </Badge>
              </div>
              <p className="mt-3 break-words text-sm leading-6 text-muted-foreground">
                Agreed{" "}
                {formatWireTimestamp(event.created_at, "at an unrecorded time")}
                ; recorded{" "}
                {formatWireTimestamp(event.recorded_at, "at an unrecorded time")}
                {lagText(event)}.
              </p>
              <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">
                Under policy{" "}
                <span className="break-all font-mono">
                  {event.policy_version || "unstated"}
                </span>
                {event.proof_text ? ` · proof: ${event.proof_text}` : null}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
      <ConsentLoadOlder
        family={family}
        label="consent event"
        loadLabel="Load older events"
        endLabel="End of the loaded consent-event page family"
      />
    </div>
  );
}
