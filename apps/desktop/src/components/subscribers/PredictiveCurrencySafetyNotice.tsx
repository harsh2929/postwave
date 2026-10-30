import type { ReactElement } from "react";

/**
 * The current predictive contract exposes cents without the source currency.
 * Never label or combine those values in the UI: a number such as `12500`
 * could represent USD, EUR, or a mixture of both.
 */
export function PredictiveCurrencySafetyNotice(): ReactElement {
  return (
    <div
      className="notice"
      role="note"
      aria-label="Currency-safe predictive values unavailable"
      style={{ display: "grid", gap: 4, fontSize: 11 }}
    >
      <strong>Currency-safe value insights unavailable</strong>
      <span className="muted">
        The current predictive result does not identify the currency behind
        order values. Moosewave hides CLV amounts, monetary scores, and composite
        RFM segments until the model provides verified currency provenance.
      </span>
    </div>
  );
}
