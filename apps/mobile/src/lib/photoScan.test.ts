import { describe, expect, it } from "vitest";

import { photoScanHint, photoScanOutcome } from "./photoScan";

describe("photoScanOutcome", () => {
  it("returns the first non-empty payload", () => {
    expect(
      photoScanOutcome([{ data: "" }, { data: "moosewave://campaign/1" }]),
    ).toEqual({ kind: "code", data: "moosewave://campaign/1" });
  });

  it("trims the payload", () => {
    expect(photoScanOutcome([{ data: "  moosewave://dmarc \n" }])).toEqual({
      kind: "code",
      data: "moosewave://dmarc",
    });
  });

  it("distinguishes an image with no code from a decode failure", () => {
    // ABSENCE IS NOT FAILURE — these send the user to different next steps.
    expect(photoScanOutcome([])).toEqual({ kind: "no-code" });
    expect(photoScanOutcome(null)).toEqual({ kind: "failed" });
    expect(photoScanOutcome(undefined)).toEqual({ kind: "failed" });
  });

  it("treats a code with a non-string payload as no code, not as a crash", () => {
    expect(photoScanOutcome([{ data: 42 as unknown as string }])).toEqual({
      kind: "no-code",
    });
    expect(photoScanOutcome([{}])).toEqual({ kind: "no-code" });
  });
});

describe("photoScanHint", () => {
  it("stays silent for a cancelled pick and for a successful read", () => {
    expect(photoScanHint({ kind: "cancelled" })).toBeNull();
    expect(photoScanHint({ kind: "code", data: "x" })).toBeNull();
  });

  it("says something different for no-code and for failure", () => {
    const noCode = photoScanHint({ kind: "no-code" });
    const failed = photoScanHint({ kind: "failed" });
    expect(noCode).toBeTruthy();
    expect(failed).toBeTruthy();
    expect(noCode).not.toBe(failed);
  });
});
