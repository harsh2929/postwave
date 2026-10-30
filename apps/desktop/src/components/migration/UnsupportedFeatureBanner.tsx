/**
 * UnsupportedFeatureBanner — yellow banner listing features the source
 * uses that Moosewave can't migrate as-is. Each feature gets a one-line
 * explanation of how it'll be handled (fallback step, manual rebuild,
 * dropped silently, etc).
 *
 * Honest by design: we'd rather show a long list than silently drop
 * data the operator was counting on.
 */

import { type ReactElement } from "react";

import { Banner } from "../Banner";

export interface UnsupportedFeature {
  /** Stable id, e.g. `"a_b_split"` — used as React key + analytics tag. */
  id: string;
  /** Human label shown in the bullet, e.g. "A/B split steps". */
  label: string;
  /** Short note on what will happen instead. */
  note: string;
}

export interface UnsupportedFeatureBannerProps {
  features: UnsupportedFeature[];
  title?: string;
}

export function UnsupportedFeatureBanner({
  features,
  title,
}: UnsupportedFeatureBannerProps): ReactElement | null {
  if (features.length === 0) return null;
  return (
    <Banner
      tone="warning"
      announcement="off"
      title={title ?? "Features that won't migrate as-is"}
      style={{ marginTop: 12 }}
    >
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {features.map((f) => (
          <li key={f.id} style={{ fontSize: 12, lineHeight: 1.5 }}>
            <strong>{f.label}</strong> <span className="muted">— {f.note}</span>
          </li>
        ))}
      </ul>
    </Banner>
  );
}
