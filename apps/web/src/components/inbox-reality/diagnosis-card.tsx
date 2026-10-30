// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { normalizePredictedImpact } from "@/lib/inbox-reality-helpers";
import type { Diagnosis } from "@/lib/inbox-reality-types";
import { FixCard } from "./fix-card";
import { PlacementBar } from "./placement-bar";

export interface DiagnosisCardProps {
  diagnosis: Diagnosis;
  campaignId?: string;
}

export function DiagnosisCard({ diagnosis, campaignId }: DiagnosisCardProps) {
  const projected = normalizePredictedImpact(diagnosis.predicted_impact);
  const hasProjection =
    projected.primary + projected.promotions + projected.spam > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>AI Diagnostician</CardTitle>
        <CardDescription>
          Generated{" "}
          {new Date(diagnosis.generated_at).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm leading-relaxed">{diagnosis.diagnosis}</p>

        {/* Projected post-fix placement — the most motivating output (INBOX-029):
            "here's where placement lands if you apply these fixes." */}
        {hasProjection ? (
          <div className="rounded-md border bg-muted/30 p-3 space-y-2">
            <h3 className="text-sm font-semibold">
              Projected placement after applying all fixes
            </h3>
            <PlacementBar
              primary={projected.primary}
              promotions={projected.promotions}
              spam={projected.spam}
              showLabels
            />
            <p className="text-xs text-muted-foreground">
              Estimated distribution once every recommended fix below is applied.
            </p>
          </div>
        ) : null}

        {diagnosis.fixes.length > 0 && (
          <>
            <h3 className="text-sm font-semibold mt-4">
              Recommended fixes ({diagnosis.fixes.length})
            </h3>
            <div className="space-y-3">
              {diagnosis.fixes.map((fix, i) => (
                <FixCard
                  key={`${fix.title}-${i}`}
                  fix={fix}
                  index={i}
                  campaignId={campaignId}
                />
              ))}
            </div>
          </>
        )}
        {diagnosis.fixes.length === 0 && (
          <p className="text-sm text-muted-foreground italic">
            No fixes recommended — current configuration looks healthy.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
