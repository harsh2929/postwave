/**
 * WinnerBanner — the prominent "Variant N won by X% (Y% confident)"
 * call-out at the top of the A/B Results view. Renders only when the
 * server marks a winner with confidence >= 0.95; otherwise renders a
 * neutral "no clear winner yet" hint.
 */

import { type ReactElement } from "react";

import { Banner } from "../Banner";

export type WinnerMethod = "bayesian" | "frequentist" | "not_decided";

export interface WinnerBannerProps {
  variantIndex: number;
  variantLabel?: string | null;
  liftPercent?: number;
  method: WinnerMethod;
  confidence: number;
}

export function WinnerBanner(props: WinnerBannerProps): ReactElement {
  const { variantIndex, variantLabel, liftPercent, method, confidence } = props;
  if (method === "not_decided" || variantIndex < 0) {
    return (
      <Banner
        tone="neutral"
        announcement="off"
        title="No clear winner yet"
        style={{ marginBottom: 12 }}
        data-testid="winner-banner-pending"
      >
        Keep the test running or widen the recipient pool. We&apos;ll mark a
        winner once the challenger crosses 95% confidence.
      </Banner>
    );
  }
  const labelTxt = variantLabel ?? `Variant ${variantIndex + 1}`;
  const liftTxt = liftPercent != null ? `by ${liftPercent.toFixed(1)}%` : "";
  const conf = confidence > 1 ? confidence : confidence * 100;
  const methodTxt =
    method === "bayesian" ? "Bayesian P(B>A)" : "frequentist 1−p";
  return (
    <Banner
      tone="success"
      title={`${labelTxt} won ${liftTxt}`.trim()}
      style={{ marginBottom: 12 }}
      data-testid="winner-banner"
    >
      <span className="muted">
        ({conf.toFixed(1)}% confident · {methodTxt})
      </span>
    </Banner>
  );
}
