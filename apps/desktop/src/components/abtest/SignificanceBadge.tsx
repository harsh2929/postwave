/**
 * SignificanceBadge — small visual indicator next to a pairwise
 * comparison row. Green check when the test crossed the threshold,
 * neutral dot otherwise. The label spells out the threshold so the
 * operator doesn't have to remember whether 95% means raw or
 * Bonferroni-corrected.
 */

import { type ReactElement } from "react";

export interface SignificanceBadgeProps {
  significant: boolean;
  /** "95%" / "99%" / "Bonferroni" — short label rendered next to the icon. */
  label?: string;
  /** Tooltip text shown on hover (e.g. "p=0.021 < 0.05"). */
  title?: string;
}

export function SignificanceBadge(
  props: SignificanceBadgeProps,
): ReactElement {
  const { significant, label = "95%", title } = props;
  return (
    <span
      className={`badge${significant ? " accent" : ""}`}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <span aria-hidden="true">{significant ? "✓" : "·"}</span>
      <span>{significant ? `Significant @ ${label}` : "Not significant"}</span>
    </span>
  );
}
