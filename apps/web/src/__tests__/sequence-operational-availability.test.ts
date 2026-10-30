import { describe, expect, it } from "vitest";

import {
  SEQUENCE_REGENERATION_AVAILABLE,
  SEQUENCE_RUNTIME_AVAILABLE,
  canEditSequenceDraft,
  sequenceEditUnavailableReason,
  sequenceStatusPresentation,
} from "@/lib/sequence-operational-availability";

describe("web sequence operational boundary", () => {
  it("keeps runtime closed while allowing two-phase draft regeneration", () => {
    expect(SEQUENCE_RUNTIME_AVAILABLE).toBe(false);
    expect(SEQUENCE_REGENERATION_AVAILABLE).toBe(true);
  });

  it.each(["active", "running"])(
    "presents %s as an untrusted legacy label rather than live runtime",
    (status) => {
      expect(sequenceStatusPresentation(status)).toMatchObject({
        label: "Legacy active label",
        tone: "danger",
        detail: expect.stringMatching(/no qualified sequence runtime/i),
      });
    },
  );

  it("requires both draft status and a positive confirmed version to edit", () => {
    expect(canEditSequenceDraft("draft", 4)).toBe(true);
    expect(canEditSequenceDraft("draft", undefined)).toBe(false);
    expect(canEditSequenceDraft("draft", 0)).toBe(false);
    expect(canEditSequenceDraft("archived", 4)).toBe(false);
    expect(canEditSequenceDraft("active", 4)).toBe(false);
    expect(sequenceEditUnavailableReason("draft", undefined)).toMatch(
      /no confirmed server version/i,
    );
  });
});
