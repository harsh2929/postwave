// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  eligibleIsCounterfactual,
  perRecipientTimingIsInert,
  type AutoSuppressState,
  type SendingStatus,
} from "@/lib/sending-reputation-api";

const status = (o: Partial<SendingStatus> = {}): SendingStatus => ({
  quiet_hours_per_recipient: true,
  bucket_count: 0,
  ...o,
});

const suppress = (o: Partial<AutoSuppressState> = {}): AutoSuppressState => ({
  auto_suppress: false,
  eligible_now: 0,
  active_suppressions: 0,
  observed_at: "2026-08-22T06:29:41.378281Z",
  ...o,
});

describe("per-recipient send timing", () => {
  it("is inert when switched on with no recipient time buckets", () => {
    // The tenant's real state: the setting promises per-recipient timing and
    // there is nothing to time against.
    expect(perRecipientTimingIsInert(status())).toBe(true);
  });

  it("is not inert once buckets exist", () => {
    expect(perRecipientTimingIsInert(status({ bucket_count: 7 }))).toBe(false);
  });

  it("is not inert when the setting is off", () => {
    // Off with no buckets is coherent, not a broken promise.
    expect(
      perRecipientTimingIsInert(status({ quiet_hours_per_recipient: false })),
    ).toBe(false);
  });
});

describe("auto-suppression eligibility", () => {
  it("treats eligible_now as counterfactual while auto-suppress is off", () => {
    expect(eligibleIsCounterfactual(suppress({ eligible_now: 40 }))).toBe(true);
  });

  it("treats it as live once auto-suppress is on", () => {
    expect(
      eligibleIsCounterfactual(
        suppress({ auto_suppress: true, eligible_now: 40 }),
      ),
    ).toBe(false);
  });
});
