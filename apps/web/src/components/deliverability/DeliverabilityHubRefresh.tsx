// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * "Refresh evidence" for the deliverability hub — all SIX surfaces, with a
 * receipt that says how many actually verified. Desktop parity:
 * components/deliverability/DeliverabilityHubWorkspace.tsx RefreshButton
 * (677-699) → pages/useDeliverabilityHubData.ts refresh() (180-194) and
 * deliverabilityRefreshReceipt.
 *
 *   GET /api/v1/deliverability/hub
 *   GET /api/v1/deliverability/hub/history
 *   GET /api/v1/deliverability/hub/dns-health
 *   GET /api/v1/deliverability/hub/blocklist-hits
 *   GET /api/v1/deliverability/hub/webhook-errors
 *   GET /api/v1/deliverability/hub/bounce-class-breakdown
 *
 * Each read is written through the shared QueryClient under
 * `[...keyBase, <surface>]` — the same keys /app/deliverability already
 * observes — so the page's panels show the refreshed values (or their error
 * states) without a second fetch. The six reads settle independently: one
 * failed surface is reported by name and never turns the others into "not
 * refreshed", and a partial refresh is never announced as a clean one.
 */
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  getBlocklistHits,
  getBounceClassBreakdown,
  getDeliverabilityHub,
  getDnsHealth,
  getWebhookErrors,
} from "@/lib/deliverability-hub-api";
import { getScoreHistory } from "@/lib/key-hygiene-api";

/**
 * Key suffixes 1:1 with the page's own queries (summary, dns, blocklist,
 * webhook-errors, bounce-classes) plus the history surface desktop also
 * verifies on every refresh.
 */
export const DELIVERABILITY_HUB_SURFACES = [
  { key: "summary", label: "Reputation score", read: getDeliverabilityHub },
  { key: "history", label: "Score history", read: getScoreHistory },
  { key: "dns", label: "DNS health", read: getDnsHealth },
  { key: "blocklist", label: "Blocklist hits", read: getBlocklistHits },
  { key: "webhook-errors", label: "Webhook errors", read: getWebhookErrors },
  {
    key: "bounce-classes",
    label: "Bounce classes",
    read: getBounceClassBreakdown,
  },
] as const;

export interface DeliverabilityHubRefreshReceipt {
  completedAt: number;
  verified: number;
  failed: string[];
}

export function deliverabilityHubRefreshReceiptText(
  receipt: DeliverabilityHubRefreshReceipt,
): string {
  const total = DELIVERABILITY_HUB_SURFACES.length;
  const at = new Date(receipt.completedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (receipt.failed.length === 0) {
    return `All ${total} evidence surfaces verified at ${at}.`;
  }
  if (receipt.verified === 0) {
    return `Refresh failed at ${at} · 0 of ${total} surfaces verified. Missing results are not being treated as healthy.`;
  }
  return `Partial refresh at ${at} · ${receipt.verified} of ${total} surfaces verified. Not verified: ${receipt.failed.join(", ")}.`;
}

export function DeliverabilityHubRefresh({
  keyBase,
  enabled,
  onRefreshed,
}: {
  /** The page's `base("deliverability-hub", tenant, role)` key prefix. */
  keyBase: readonly unknown[];
  /** False until workspace identity is verified; no read is sent before. */
  enabled: boolean;
  onRefreshed?: (receipt: DeliverabilityHubRefreshReceipt) => void;
}) {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [receipt, setReceipt] =
    useState<DeliverabilityHubRefreshReceipt | null>(null);
  const inFlight = useRef(false);

  const refreshAll = async () => {
    if (!enabled || inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const settled = await Promise.allSettled(
        DELIVERABILITY_HUB_SURFACES.map((surface) =>
          queryClient.fetchQuery<unknown>({
            queryKey: [...keyBase, surface.key],
            queryFn: () => surface.read(),
            // Always a fresh read: a refresh that returns cached data is the
            // one thing this control must never do.
            staleTime: 0,
          }),
        ),
      );
      const failed = DELIVERABILITY_HUB_SURFACES.filter(
        (_, index) => settled[index]?.status === "rejected",
      ).map((surface) => surface.label);
      const next = {
        completedAt: Date.now(),
        verified: DELIVERABILITY_HUB_SURFACES.length - failed.length,
        failed,
      };
      setReceipt(next);
      onRefreshed?.(next);
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-1.5 sm:items-end">
      <Button
        type="button"
        variant="outline"
        onClick={() => void refreshAll()}
        disabled={!enabled || refreshing}
        aria-busy={refreshing}
      >
        <RefreshCw
          aria-hidden
          className={
            refreshing ? "animate-spin motion-reduce:animate-none" : undefined
          }
        />
        {refreshing ? "Verifying six evidence surfaces…" : "Refresh evidence"}
      </Button>
      <p
        role="status"
        aria-live="polite"
        className={
          receipt && receipt.failed.length > 0
            ? "max-w-md text-xs text-destructive"
            : "max-w-md text-xs text-muted-foreground"
        }
      >
        {receipt
          ? deliverabilityHubRefreshReceiptText(receipt)
          : enabled
            ? ""
            : "Resolving workspace identity."}
      </p>
    </div>
  );
}
