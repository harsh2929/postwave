// SPDX-License-Identifier: AGPL-3.0-only
//
// The model emits a churn risk of exactly 0.5 with confidence 0.1 when it has
// nothing to work from. Shown as "50% churn risk" that is a placeholder
// wearing the clothes of a finding, and the obvious next action — targeting
// those people with win-back offers — is taken on nothing.

import { describe, expect, it } from "vitest";

import {
  placeholderCount,
  predictionIsPlaceholder,
  type PredictiveProfile,
} from "@/lib/predictive-api";

const profile = (o: Partial<PredictiveProfile> = {}): PredictiveProfile => ({
  email: "ada.lovelace@example.com",
  subscriber_id: "s1",
  historic_clv_cents: 0,
  predicted_clv_cents: 0,
  total_clv_cents: 0,
  churn_risk: 0.5,
  confidence: 0.1,
  data_sufficiency: "insufficient",
  predicted_gender: "unknown",
  predicted_order_count: 0,
  churn_drivers: [],
  ...o,
});

describe("prediction sufficiency", () => {
  it("treats an insufficient profile as a placeholder", () => {
    // The live state for all twelve scored subscribers.
    expect(predictionIsPlaceholder(profile())).toBe(true);
  });

  it("accepts a sufficient profile as a real prediction", () => {
    expect(
      predictionIsPlaceholder(
        profile({ data_sufficiency: "sufficient", churn_risk: 0.82, confidence: 0.9 }),
      ),
    ).toBe(false);
  });

  it("does not call a profile a placeholder when sufficiency is unreported", () => {
    // An absent field is not evidence the data was insufficient; inventing
    // that claim would suppress a real prediction.
    expect(predictionIsPlaceholder(profile({ data_sufficiency: "" }))).toBe(
      false,
    );
  });

  it("counts placeholders across a set", () => {
    const rows = [
      profile(),
      profile({ subscriber_id: "s2" }),
      profile({ subscriber_id: "s3", data_sufficiency: "sufficient" }),
    ];
    expect(placeholderCount(rows)).toBe(2);
  });

  it("does not treat a genuine 0.5 risk as a placeholder when data suffices", () => {
    // A real prediction may legitimately land on 0.5. It is the sufficiency
    // flag that decides, never the value.
    expect(
      predictionIsPlaceholder(
        profile({ data_sufficiency: "sufficient", churn_risk: 0.5 }),
      ),
    ).toBe(false);
  });
});
