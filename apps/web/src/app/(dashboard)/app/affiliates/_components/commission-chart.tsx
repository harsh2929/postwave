// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure-SVG monthly commission bar chart. No charting library — keeps the
// admin bundle small and the rendering deterministic. Accepts an array of
// 12 monthly buckets in cents.

import { formatCents } from "@/lib/affiliates-types";

export interface CommissionChartProps {
  /** 12 entries, oldest → newest. */
  monthly: { label: string; commissionCents: number }[];
  height?: number;
  className?: string;
}

export function CommissionChart({
  monthly,
  height = 160,
  className,
}: CommissionChartProps) {
  const max = Math.max(1, ...monthly.map((m) => m.commissionCents));
  const padding = { top: 12, right: 8, bottom: 26, left: 8 };
  const innerH = height - padding.top - padding.bottom;
  const barW = 28;
  const gap = 8;
  const innerW = monthly.length * (barW + gap) - gap;
  const totalW = innerW + padding.left + padding.right;

  return (
    <svg
      viewBox={`0 0 ${totalW} ${height}`}
      width="100%"
      height={height}
      className={className}
      role="img"
      aria-label="Monthly commission earnings, last 12 months"
    >
      {monthly.map((m, i) => {
        const h = (m.commissionCents / max) * innerH;
        const x = padding.left + i * (barW + gap);
        const y = padding.top + (innerH - h);
        return (
          <g key={m.label}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={h}
              rx={3}
              className="fill-primary/80"
            >
              <title>
                {m.label}: {formatCents(m.commissionCents)}
              </title>
            </rect>
            <text
              x={x + barW / 2}
              y={height - 10}
              textAnchor="middle"
              className="fill-muted-foreground"
              fontSize={10}
            >
              {m.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Build 12 month buckets from a list of conversions. Public so the
 *  detail page (RSC- or client-rendered) can compute once and pass in. */
export function bucketByMonth(
  conversions: { commissionCents: number; createdAt: string; status: string }[],
): { label: string; commissionCents: number }[] {
  const out: { label: string; commissionCents: number }[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({
      label: d.toLocaleString("en-US", { month: "short" }),
      commissionCents: 0,
    });
  }
  const start = new Date(now.getFullYear(), now.getMonth() - 11, 1).getTime();
  for (const c of conversions) {
    if (c.status === "reversed" || c.status === "disputed") continue;
    const t = Date.parse(c.createdAt);
    if (t < start) continue;
    const cd = new Date(t);
    const idx =
      (cd.getFullYear() - now.getFullYear()) * 12 +
      (cd.getMonth() - now.getMonth()) +
      11;
    if (idx >= 0 && idx < 12) out[idx].commissionCents += c.commissionCents;
  }
  return out;
}
