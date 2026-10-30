// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useQuery } from "@tanstack/react-query";

import { Skeleton } from "@/components/ui/skeleton";
import {
  getBestSendTime,
  getDemographics,
  getPredictionMetadata,
  getReplenishmentCadence,
} from "@/lib/subscriber-profile-api";
import { absoluteTime, timeAgo } from "@/lib/relative-time";

function PredictionCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-3 shadow-sm">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
      {sub ? <div className="text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

const HOUR_FMT = (utcHour: number): string => {
  const h = ((utcHour % 24) + 24) % 24;
  const period = h < 12 ? "AM" : "PM";
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:00 ${period} UTC`;
};

/** Always-visible predictive summary, kept separate from the lazy tab panel
 * module so rendering it cannot fetch every inactive profile implementation. */
export function PredictionCards({
  id,
  tenantId,
  role,
}: {
  id: string;
  tenantId: string;
  role: string | null;
}) {
  const query = useQuery({
    queryKey: ["subscriber-predictions", tenantId, role ?? "viewer", id],
    queryFn: async ({ signal }) => {
      // Each of these can 404 on a low-data tenant; tolerate individually.
      const [demographics, cadence, bestTime, meta] = await Promise.allSettled([
        getDemographics(id, signal),
        getReplenishmentCadence(id, signal),
        getBestSendTime(id, signal),
        getPredictionMetadata(id, signal),
      ]);
      return {
        demographics:
          demographics.status === "fulfilled" ? demographics.value : null,
        cadence: cadence.status === "fulfilled" ? cadence.value : null,
        bestTime: bestTime.status === "fulfilled" ? bestTime.value : null,
        meta: meta.status === "fulfilled" ? meta.value : null,
      };
    },
    staleTime: 60_000,
  });

  if (query.isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-lg" />
        ))}
      </div>
    );
  }
  if (query.error || !query.data) return null;

  const { demographics, cadence, bestTime, meta } = query.data;
  const metadataItems = Array.isArray(meta?.items) ? meta.items : [];
  const churn = metadataItems.find((m) => m.score_type === "churn");
  const clv = metadataItems.find(
    (m) => m.score_type === "clv" || m.score_type === "ltv",
  );

  const cards: { label: string; value: string; sub?: string }[] = [];
  if (churn) {
    cards.push({
      label: "Churn risk",
      value:
        churn.confidence != null
          ? `${Math.round(churn.confidence * 100)}%`
          : "—",
      sub: `model ${churn.model_version}`,
    });
  }
  if (clv) {
    const ltv = clv.features?.["ltv_cents"];
    cards.push({
      label: "Predicted CLV",
      value:
        typeof ltv === "number"
          ? `$${(ltv / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
          : "—",
    });
  }
  if (bestTime) {
    cards.push({
      label: "Best send time",
      value: HOUR_FMT(bestTime.best_hour_utc),
      sub: `n=${bestTime.sample_size}`,
    });
  }
  if (cadence?.expected_next_order_at) {
    cards.push({
      label: "Next order",
      value: absoluteTime(cadence.expected_next_order_at).split(",")[0] ?? "—",
      sub:
        cadence.average_days_between_orders != null
          ? `~${Math.round(cadence.average_days_between_orders)}d cadence`
          : undefined,
    });
  }
  const gender = demographics?.gender?.value;
  if (typeof gender === "string" && gender) {
    cards.push({ label: "Gender (predicted)", value: gender });
  }

  if (cards.length === 0 && metadataItems.length === 0) return null;

  return (
    <div className="space-y-3">
      {cards.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {cards.map((card) => (
            <PredictionCard
              key={card.label}
              label={card.label}
              value={card.value}
              sub={card.sub}
            />
          ))}
        </div>
      ) : null}
      {metadataItems.length > 0 ? (
        <details className="rounded-md border bg-card p-3 text-sm">
          <summary className="cursor-pointer font-medium">
            Prediction provenance and model features
          </summary>
          <ul className="mt-3 divide-y">
            {metadataItems.map((item) => {
              const encoded = JSON.stringify(item.features);
              return (
                <li key={item.id} className="space-y-1 py-2 first:pt-0">
                  <div className="flex flex-wrap justify-between gap-2">
                    <span>{item.score_type.replaceAll("_", " ")}</span>
                    <span className="text-xs text-muted-foreground">
                      model {item.model_version} · {timeAgo(item.computed_at)}
                    </span>
                  </div>
                  <code className="block break-all text-xs text-muted-foreground">
                    {encoded.length > 1_000
                      ? `${encoded.slice(0, 1_000)}…`
                      : encoded}
                  </code>
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
