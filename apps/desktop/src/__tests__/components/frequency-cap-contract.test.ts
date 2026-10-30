import { describe, expect, it } from "vitest";

import {
  EMPTY_FREQUENCY_CAP_DRAFT,
  frequencyCapChannelsChanged,
  frequencyCapDraftFromRow,
  isFrequencyCap,
  validateFrequencyCapDraft,
} from "../../components/deliverability/frequency-cap-contract";

const ROW = {
  id: "cap-1",
  label: "Daily marketing",
  max_sends: 3,
  window_hours: 24,
  active: true,
  channels: ["email"],
  updated_at: "2026-08-30T06:00:00Z",
};

describe("frequency-cap renderer contract", () => {
  it("accepts only trimmed, bounded rows that the canonical API can enforce", () => {
    expect(isFrequencyCap(ROW)).toBe(true);
    expect(isFrequencyCap({ ...ROW, label: " Daily marketing" })).toBe(false);
    expect(isFrequencyCap({ ...ROW, label: "" })).toBe(false);
    expect(isFrequencyCap({ ...ROW, label: "x".repeat(161) })).toBe(false);
    expect(isFrequencyCap({ ...ROW, max_sends: 0 })).toBe(false);
    expect(isFrequencyCap({ ...ROW, max_sends: 1_001 })).toBe(false);
    expect(isFrequencyCap({ ...ROW, window_hours: 0 })).toBe(false);
    expect(isFrequencyCap({ ...ROW, window_hours: 721 })).toBe(false);
    expect(isFrequencyCap({ ...ROW, updated_at: "2026-02-30T00:00:00Z" })).toBe(
      false,
    );
  });

  it("keeps blank numeric drafts blank and rejects non-integer/out-of-range input", () => {
    expect(
      validateFrequencyCapDraft({
        ...EMPTY_FREQUENCY_CAP_DRAFT,
        label: "Cap",
        maxSends: "",
        windowHours: "24.5",
      }),
    ).toMatchObject({
      maxSends: "Use a whole number from 1 to 1,000.",
      windowHours: "Use a whole number from 1 to 720.",
    });
    expect(
      validateFrequencyCapDraft({
        ...EMPTY_FREQUENCY_CAP_DRAFT,
        label: "Cap",
        maxSends: "1000",
        windowHours: "720",
      }),
    ).toEqual({});
  });

  it("represents a legacy global rule without narrowing it on an unchanged edit", () => {
    const legacy = { ...ROW, channels: [] };
    const draft = frequencyCapDraftFromRow(legacy);
    expect(draft.channels).toEqual(["email", "sms", "push"]);
    expect(frequencyCapChannelsChanged(legacy, draft.channels)).toBe(false);
    expect(
      frequencyCapChannelsChanged(legacy, draft.channels.slice(0, 2)),
    ).toBe(true);
  });
});
