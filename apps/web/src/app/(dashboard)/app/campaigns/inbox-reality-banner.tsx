// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * InboxRealityBanner — the pre-send placement forecast, in the send
 * confirmation.
 *
 * WHAT IT ADDS THAT THE CHECKLIST DOES NOT. The pre-send checklist answers "is
 * this campaign allowed to go out" (from address, subject, body, unsubscribe).
 * This answers a different question: "given this subject, this body, and this
 * workspace's current sender reputation and authentication, where is it likely
 * to land". Web already had every piece of that — `predict`, `getReputation`,
 * `getAuthChecks`, `extractLinks`, `PlacementBar` — reachable only from
 * /app/inbox-reality/predict, which is a page you have to remember to visit
 * BEFORE you send. Desktop puts the same forecast above the Send button
 * (apps/desktop/src/components/InboxRealityBanner.tsx); web did not.
 *
 * ADVISORY, NEVER BLOCKING. Like the drift banner, this has no effect on the
 * Send button in any state. The gate is the checklist; this is a forecast.
 *
 * NEVER FABRICATE THE INPUTS. `predict` needs real reputation and a real
 * sender-authentication record. When the workspace has neither, the honest
 * answer is "not enough data", NOT a prediction computed from zeros — so the
 * banner reports the absence and says which input was missing. This mirrors the
 * gate desktop had to add after a banner that passed only {subject, body}
 * rendered a permanent fake verdict.
 *
 * The root element always carries data-testid="inbox-reality-banner"; the
 * `data-state` attribute distinguishes loading / unavailable / predicted.
 */

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { PlacementBar } from "@/components/inbox-reality/placement-bar";
import { ApiError } from "@/lib/api";
import {
  getAuthChecks,
  getReputation,
  predict,
} from "@/lib/inbox-reality-api";
import { extractLinks } from "@/lib/inbox-reality-helpers";
import type { PredictResponse } from "@/lib/inbox-reality-types";
import { qk, STALE, type RoleKey } from "@/lib/query-keys";

/** Raised when an input the predictor requires simply does not exist yet. */
class MissingPredictionInput extends Error {}

const UNCONFIGURED_STATUS = new Set([404, 405, 501, 502, 503]);

function describeFailure(err: unknown): string {
  if (err instanceof MissingPredictionInput) return err.message;
  if (err instanceof ApiError) {
    if (UNCONFIGURED_STATUS.has(err.status)) {
      return "Placement forecast unavailable — the deliverability predictor is not responding for this workspace.";
    }
    return `Placement forecast unavailable: ${err.message}`;
  }
  return "Placement forecast unavailable.";
}

/** Clamp a share the API may send as either 0..1 or 0..100 into a percentage. */
function pct(value: number | undefined | null): number {
  if (value == null || Number.isNaN(value)) return 0;
  const scaled = value > 1 ? value : value * 100;
  return Math.max(0, Math.min(100, Math.round(scaled * 10) / 10));
}

async function forecast(
  subject: string,
  html: string,
): Promise<PredictResponse> {
  const [reputation, authChecks] = await Promise.all([
    getReputation(),
    getAuthChecks(),
  ]);
  const auth = authChecks[0];
  if (!auth) {
    throw new MissingPredictionInput(
      "No placement forecast yet — this workspace has no sender-authentication record to predict from.",
    );
  }
  return predict({
    subject,
    html,
    links: extractLinks(html),
    reputation,
    auth,
  });
}

export function InboxRealityBanner({
  bodyHtml,
  campaignId,
  enabled,
  role,
  subject,
  tenantId,
}: {
  bodyHtml: string;
  campaignId: string;
  enabled: boolean;
  role: RoleKey;
  subject: string;
  tenantId: string;
}) {
  const predictQuery = useQuery({
    queryKey: [...qk.campaign(tenantId, role, campaignId), "placement-forecast"],
    queryFn: () => forecast(subject, bodyHtml),
    enabled,
    staleTime: STALE.list,
    retry: false,
  });

  if (!enabled) return null;

  if (predictQuery.isPending) {
    return (
      <p
        data-testid="inbox-reality-banner"
        data-state="loading"
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Forecasting inbox placement…
      </p>
    );
  }

  if (predictQuery.isError || !predictQuery.data) {
    return (
      <p
        data-testid="inbox-reality-banner"
        data-state="unavailable"
        className="text-xs text-muted-foreground"
      >
        {describeFailure(predictQuery.error)}
      </p>
    );
  }

  const predicted = predictQuery.data.predicted;
  const primary = pct(predicted?.primary);
  const promotions = pct(predicted?.promotions);
  const spam = pct(predicted?.spam);
  const lowPrimary = primary > 0 && primary < 70;

  return (
    <div
      data-testid="inbox-reality-banner"
      data-state="predicted"
      className="rounded-md border p-3"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Predicted placement
        </span>
        <span
          className={
            lowPrimary
              ? "text-xs text-warning-emphasis"
              : "text-xs text-muted-foreground"
          }
        >
          {lowPrimary
            ? "Below the 70% primary-inbox mark"
            : "Forecast only — not a delivery guarantee"}
        </span>
      </div>
      <PlacementBar
        primary={primary}
        promotions={promotions}
        spam={spam}
        showLabels
      />
    </div>
  );
}
