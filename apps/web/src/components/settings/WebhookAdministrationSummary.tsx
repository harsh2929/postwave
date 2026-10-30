// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Read-only configuration summary for the PUBLIC outbound-webhooks entity
 * (GET /api/v1/outbound-webhooks, lib/outbound-webhooks-api.ts). Desktop
 * parity: components/settings/WebhookAdministrationSummary.tsx.
 *
 * Every mutation — create, test, rotate, pause, delete — stays in the
 * destinations workspace at /app/routing/outbound-webhooks. This card only
 * counts what one listing page returned, and says so when that page was not
 * the whole inventory: a non-empty `next_cursor` turns every count into a
 * lower bound ("12+") rather than a figure the server never asserted.
 */
import type {
  OutboundWebhookPage,
  OutboundWebhookRecord,
} from "@/lib/outbound-webhooks-api";
import { cn } from "@/lib/utils";

export interface OutboundWebhookConfigurationSummary {
  total: number;
  active: number;
  paused: number;
  /** Destinations the server reports as failing or not ready to send. */
  attention: number;
  /** Distinct event topics across every returned destination. */
  eventTypes: number;
  /** False when the server has another page beyond the one counted. */
  complete: boolean;
}

/**
 * The same attention rule desktop applies: auto-disabled after failures, an
 * active destination with consecutive failures, or any server-reported
 * `legacy_pending` / `invalid` configuration status.
 */
export function outboundWebhookNeedsAttention(
  row: OutboundWebhookRecord,
): boolean {
  return (
    row.disabled_reason === "auto_failures" ||
    (row.active && (row.consecutive_failures ?? 0) > 0) ||
    row.url_status === "legacy_pending" ||
    row.url_status === "invalid" ||
    row.auth_config_status === "legacy_pending" ||
    row.auth_config_status === "invalid" ||
    row.delivery_policy_status === "invalid"
  );
}

export function summarizeOutboundWebhooks(
  page: OutboundWebhookPage,
): OutboundWebhookConfigurationSummary {
  const rows = page.webhooks;
  return {
    total: rows.length,
    active: rows.filter((row) => row.active).length,
    paused: rows.filter((row) => !row.active).length,
    attention: rows.filter(outboundWebhookNeedsAttention).length,
    eventTypes: new Set(rows.flatMap((row) => row.events)).size,
    complete: page.next_cursor === "",
  };
}

function bound(value: number, complete: boolean): string {
  return complete ? value.toLocaleString() : `${value.toLocaleString()}+`;
}

export function WebhookAdministrationSummary({
  page,
  className,
}: {
  page: OutboundWebhookPage;
  className?: string;
}) {
  const summary = summarizeOutboundWebhooks(page);
  const cells: Array<{ label: string; value: number; tone?: "danger" }> = [
    { label: "Destinations", value: summary.total },
    { label: "Active", value: summary.active },
    { label: "Paused", value: summary.paused },
    {
      label: "Need attention",
      value: summary.attention,
      tone: summary.attention > 0 ? "danger" : undefined,
    },
    { label: "Event types", value: summary.eventTypes },
  ];
  return (
    <div className={cn("space-y-2", className)}>
      <dl
        aria-label="Outbound destination summary"
        className="grid grid-cols-2 gap-2 sm:grid-cols-5"
      >
        {cells.map((cell) => (
          <div
            key={cell.label}
            className={cn(
              "min-w-0 rounded-md border bg-background/60 px-3 py-2",
              cell.tone === "danger" &&
                "border-destructive/40 bg-destructive/5 text-destructive-emphasis",
            )}
          >
            <dt className="text-xs text-muted-foreground">{cell.label}</dt>
            <dd className="mt-0.5 text-base font-semibold tabular-nums">
              {bound(cell.value, summary.complete)}
            </dd>
          </div>
        ))}
      </dl>
      {!summary.complete ? (
        <p role="note" className="text-xs text-muted-foreground">
          Counts are lower bounds from the first{" "}
          {summary.total.toLocaleString()} destinations; the server reported
          more beyond this page.
        </p>
      ) : null}
    </div>
  );
}
