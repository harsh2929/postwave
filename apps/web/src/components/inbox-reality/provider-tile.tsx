// SPDX-License-Identifier: AGPL-3.0-only
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { isProviderMeasured } from "@/lib/inbox-reality-helpers";
import {
  PROVIDER_LABEL,
  summarizePlacement,
  type ProviderBreakdown,
} from "@/lib/inbox-reality-types";
import { PlacementBar } from "./placement-bar";

export interface ProviderTileProps {
  breakdown: ProviderBreakdown;
}

export function ProviderTile({ breakdown }: ProviderTileProps) {
  const measured = isProviderMeasured(breakdown);

  // Untested provider: visually distinct "not measured" state so an empty tile
  // never reads as "tested and everything failed" (INBOX-019).
  if (!measured) {
    return (
      <Card className="h-full border-dashed opacity-70">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold tracking-tight text-muted-foreground">
            {PROVIDER_LABEL[breakdown.provider]}
          </CardTitle>
          <p className="text-xs text-muted-foreground">Not measured</p>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            No seed mailboxes for this provider in this test.
          </p>
        </CardContent>
      </Card>
    );
  }

  const summary = summarizePlacement(breakdown);
  const counts = breakdown.placements;
  return (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold tracking-tight">
          {PROVIDER_LABEL[breakdown.provider]}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {breakdown.total.toLocaleString()} seedlist mailbox
          {breakdown.total === 1 ? "" : "es"}
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        <PlacementBar
          primary={summary.primary}
          promotions={summary.promotions}
          spam={summary.spam}
        />
        <div className="grid grid-cols-3 gap-1 text-center text-[11px]">
          <div>
            {/* fix(inconsistent-styling): theme-aware semantic token so the count stays legible in dark mode (was fixed text-emerald-700) */}
            <div className="font-medium text-success">
              {(counts.primary ?? 0).toLocaleString()}
            </div>
            <div className="text-muted-foreground">primary</div>
          </div>
          <div>
            {/* fix(inconsistent-styling): theme-aware semantic token (was fixed text-amber-700) */}
            <div className="font-medium text-warning-emphasis">
              {(counts.promotions ?? 0).toLocaleString()}
            </div>
            <div className="text-muted-foreground">promo</div>
          </div>
          <div>
            {/* fix(inconsistent-styling): theme-aware semantic token (was fixed text-rose-700) */}
            <div className="font-medium text-destructive">
              {(
                (counts.spam ?? 0) +
                (counts.blocked ?? 0) +
                (counts.missing ?? 0)
              ).toLocaleString()}
            </div>
            <div className="text-muted-foreground">spam</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
