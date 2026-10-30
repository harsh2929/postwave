/**
 * SkeletonCard — placeholder for per-card loading states.
 *
 * Replaces the global "one big progress bar" with cards that pulse in
 * place, so users can see which sections are still resolving without the
 * whole page collapsing into a single loading bar.
 *
 * Kept dependency-free and inline-styled because the rest of the
 * Analytics page follows the same convention (no Tailwind, no CSS-in-JS
 * runtime — just CSS vars + the shared styles.css helpers).
 */

import type { ReactElement } from "react";

export function SkeletonCard({
  height = 160,
  /** Optional label to keep card-shape consistency with rendered cards. */
  label,
}: {
  height?: number;
  label?: string;
}): ReactElement {
  return (
    <div className="card pw-chart-card" style={{ overflow: "hidden" }}>
      {label ? (
        <div className="pw-chart-head">
          <div
            className="section-title"
            style={{ marginBottom: 0, opacity: 0.7 }}
          >
            {label}
          </div>
        </div>
      ) : null}
      <div
        style={{
          height,
          borderRadius: 6,
          background:
            "linear-gradient(90deg, var(--pw-bg-elev-2), color-mix(in srgb, var(--pw-bg-elev-2) 60%, var(--pw-bg-elev)), var(--pw-bg-elev-2))",
          backgroundSize: "200% 100%",
          animation: "pw-skeleton 1.4s ease-in-out infinite",
        }}
      />
    </div>
  );
}

export function SkeletonStatCard(): ReactElement {
  return (
    <div className="stat-card" style={{ overflow: "hidden" }}>
      <div
        style={{
          height: 11,
          width: 80,
          borderRadius: 4,
          background: "var(--pw-bg-elev-2)",
          marginBottom: 8,
          backgroundSize: "200% 100%",
          animation: "pw-skeleton 1.4s ease-in-out infinite",
        }}
      />
      <div
        style={{
          height: 24,
          width: 110,
          borderRadius: 4,
          background:
            "linear-gradient(90deg, var(--pw-bg-elev-2), color-mix(in srgb, var(--pw-bg-elev-2) 60%, var(--pw-bg-elev)), var(--pw-bg-elev-2))",
          backgroundSize: "200% 100%",
          animation: "pw-skeleton 1.4s ease-in-out infinite",
          marginBottom: 8,
        }}
      />
      <div
        style={{
          height: 26,
          width: 120,
          borderRadius: 4,
          background: "var(--pw-bg-elev-2)",
          backgroundSize: "200% 100%",
          animation: "pw-skeleton 1.4s ease-in-out infinite",
        }}
      />
    </div>
  );
}
