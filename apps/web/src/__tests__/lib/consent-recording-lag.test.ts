// SPDX-License-Identifier: AGPL-3.0-only
//
// A consent ledger exists to evidence that someone agreed at a point in time.
// It carries two timestamps and they answer different questions, so the gap
// between them must be computable and must never be faked as zero.

import { describe, expect, it } from "vitest";

import { recordingLagDays, type ConsentEvent } from "@/lib/consent-evidence-api";

const event = (o: Partial<ConsentEvent> = {}): ConsentEvent => ({
  id: "e1",
  subject_type: "subscriber",
  subject_id: "s1",
  subject_email: "leslie.lamport@example.com",
  channel: "api",
  category: "email_marketing",
  action: "granted",
  source: "double_optin",
  policy_version: "privacy-2026-01",
  proof_text: "QA seed",
  created_at: "2026-08-01T10:00:00Z",
  recorded_at: "2026-08-21T20:00:03.062504Z",
  preferences: {},
  ...o,
});

describe("consent recording lag", () => {
  it("measures the gap between consent given and consent recorded", () => {
    // The live shape: given 1 Aug, recorded 21 Aug.
    expect(recordingLagDays(event())).toBe(20);
  });

  it("is zero when the two moments coincide", () => {
    expect(
      recordingLagDays(
        event({
          created_at: "2026-08-01T10:00:00Z",
          recorded_at: "2026-08-01T10:00:00Z",
        }),
      ),
    ).toBe(0);
  });

  it("returns null rather than zero when a timestamp is missing", () => {
    // Zero would assert the two moments coincided, which is a claim the data
    // does not support.
    expect(recordingLagDays(event({ recorded_at: "" }))).toBeNull();
    expect(recordingLagDays(event({ created_at: "" }))).toBeNull();
  });

  it("returns null for an unparseable timestamp", () => {
    expect(recordingLagDays(event({ recorded_at: "not a date" }))).toBeNull();
  });

  it("reports a negative lag rather than hiding it", () => {
    // Recorded before it was given means clock skew or a backdated import.
    // Either way it is a fact about the record worth surfacing.
    expect(
      recordingLagDays(
        event({
          created_at: "2026-08-21T00:00:00Z",
          recorded_at: "2026-08-19T00:00:00Z",
        }),
      ),
    ).toBe(-2);
  });
});
