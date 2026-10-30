// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from "@/lib/utils";

export interface PlacementBarProps {
  primary: number;
  promotions: number;
  spam: number;
  showLabels?: boolean;
  className?: string;
}

/**
 * Stacked horizontal bar showing primary / promotions / spam shares.
 * SVG-based — no chart libs. Accepts fractional inputs in 0..1.
 */
export function PlacementBar({
  primary,
  promotions,
  spam,
  showLabels = false,
  className,
}: PlacementBarProps) {
  // Defensive normalization keeps a malformed or temporarily incomplete
  // payload from emitting negative/NaN SVG widths that make the chart vanish.
  const safe = [primary, promotions, spam].map((value) =>
    Number.isFinite(value) && value > 0 ? value : 0,
  );
  const total = safe[0] + safe[1] + safe[2] || 1;
  const p = (safe[0] / total) * 100;
  const r = (safe[1] / total) * 100;
  const s = (safe[2] / total) * 100;

  return (
    <div className={cn("w-full", className)}>
      <svg
        role="img"
        aria-label={`Primary ${Math.round(p)}%, Promotions ${Math.round(
          r,
        )}%, Spam ${Math.round(s)}%`}
        viewBox="0 0 100 8"
        preserveAspectRatio="none"
        className="w-full h-3 rounded-full overflow-hidden bg-muted"
      >
        <rect x={0} y={0} width={p} height={8} className="fill-emerald-500" />
        <rect x={p} y={0} width={r} height={8} className="fill-amber-400" />
        <rect x={p + r} y={0} width={s} height={8} className="fill-rose-500" />
      </svg>
      {showLabels && (
        <div className="mt-1 flex justify-between text-xs text-muted-foreground">
          {/* Semantic status tokens (match provider-tile.tsx) so legend labels stay legible in dark mode */}
          <span className="text-success">Primary {Math.round(p)}%</span>
          <span className="text-warning-emphasis">
            Promotions {Math.round(r)}%
          </span>
          <span className="text-destructive">Spam {Math.round(s)}%</span>
        </div>
      )}
    </div>
  );
}
