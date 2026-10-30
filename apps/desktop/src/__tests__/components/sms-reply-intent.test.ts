import { describe, expect, it } from "vitest";

import {
  classifySMSReplyUncertainty,
  createSMSReplyIntentKey,
  eligibleSMSSenders,
  isSMSReplyOutcomeUnknown,
  normalizeSMSUSCA,
  smsReplyBodyConstraint,
  smsReplyDispatchHoldCopy,
  smsReplyReconciliationCopy,
} from "../../components/sms/sms-reply-intent";

describe("SMS reply intent safety", () => {
  it("creates stable-format unique intent identities", () => {
    const first = createSMSReplyIntentKey();
    const second = createSMSReplyIntentKey();
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(second).not.toBe(first);
  });

  it("treats only response-less and explicit reconciliation outcomes as unknown", () => {
    expect(
      isSMSReplyOutcomeUnknown({
        message: "reconciling",
        code: "reply_reconciliation_required",
        status: 503,
      }),
    ).toBe(true);
    expect(
      isSMSReplyOutcomeUnknown({
        message: "key conflict",
        code: "idempotency_key_request_mismatch",
        status: 422,
      }),
    ).toBe(true);
    expect(
      isSMSReplyOutcomeUnknown({
        message: "another reconciliation is pending",
        code: "reply_reconciliation_pending",
        status: 409,
      }),
    ).toBe(true);
    expect(
      isSMSReplyOutcomeUnknown({ message: "offline", kind: "network" }),
    ).toBe(true);
    expect(
      isSMSReplyOutcomeUnknown({ message: "timed out", kind: "timeout" }),
    ).toBe(true);
    expect(
      isSMSReplyOutcomeUnknown({
        message: "completion persistence failed",
        code: "idempotency_complete_failed",
        status: 500,
      }),
    ).toBe(true);
    expect(
      isSMSReplyOutcomeUnknown({ message: "unclassified", status: 502 }),
    ).toBe(true);
    expect(
      isSMSReplyOutcomeUnknown({
        message: "release held",
        code: "sms_reply_dispatch_release_held",
        status: 503,
      }),
    ).toBe(false);
    expect(
      isSMSReplyOutcomeUnknown({
        message: "financial reservation held",
        code: "sms_financial_reservation_unavailable",
        status: 503,
      }),
    ).toBe(false);
    expect(
      isSMSReplyOutcomeUnknown({
        message: "consent required",
        code: "consent_required",
        status: 422,
      }),
    ).toBe(false);

    expect(
      classifySMSReplyUncertainty({
        message: "key conflict",
        code: "idempotency_key_request_mismatch",
        status: 422,
      }),
    ).toBe("request-identity-conflict");
    expect(
      classifySMSReplyUncertainty({
        message: "another reconciliation is pending",
        code: "reply_reconciliation_pending",
        status: 409,
      }),
    ).toBe("another-intent-pending");
  });

  it("states the no-resend boundary without claiming delivery or failure", () => {
    const copy = smsReplyReconciliationCopy();
    expect(copy).toContain("not yet known");
    expect(copy).toContain("Do not send");
    expect(copy).not.toMatch(/delivered|failed/iu);
  });

  it("explains the authoritative reply dispatch release hold", () => {
    const copy = smsReplyDispatchHoldCopy("sms_reply_dispatch_release_held");
    expect(copy).toContain("provider reconciliation and budget settlement");
    expect(copy).toContain("No provider request can be started");
  });

  it("offers only approved NANP senders on a live provider", () => {
    const senders = [
      {
        id: "approved",
        registration_status: "approved",
        provider: "twilio",
        phone_number: "+12025550101",
      },
      {
        id: "legacy-wrong-state",
        registration_status: "registered",
        provider: "twilio",
        phone_number: "+12025550102",
      },
      {
        id: "pending",
        registration_status: "pending",
        provider: "telnyx",
        phone_number: "+12025550103",
      },
      {
        id: "unknown-provider",
        registration_status: "approved",
        provider: "future-provider",
        phone_number: "+12025550104",
      },
      {
        id: "outside-launch-market",
        registration_status: "approved",
        provider: "bandwidth",
        phone_number: "+442079460018",
      },
      {
        id: "invalid-nanp-exchange",
        registration_status: "approved",
        provider: "twilio",
        phone_number: "+12021550104",
      },
    ];

    expect(eligibleSMSSenders(senders).map((sender) => sender.id)).toEqual([
      "approved",
    ]);
  });

  it("normalizes only the backend-supported US/Canada launch boundary", () => {
    expect(normalizeSMSUSCA("(202) 555-0118")).toBe("+12025550118");
    expect(normalizeSMSUSCA("1 202 555 0118")).toBe("+12025550118");
    expect(normalizeSMSUSCA("+44 20 7946 0018")).toBeNull();
    expect(normalizeSMSUSCA("555-0118")).toBeNull();
    expect(normalizeSMSUSCA("+1+202-555-0118")).toBeNull();
    expect(normalizeSMSUSCA("202-CALL-NOW")).toBeNull();
    expect(normalizeSMSUSCA("202-555-0118\u202e")).toBeNull();
    expect(normalizeSMSUSCA("202-555-0118\n")).toBeNull();
    expect(normalizeSMSUSCA("２０２-555-0118")).toBeNull();
    expect(normalizeSMSUSCA("102-555-0118")).toBeNull();
    expect(normalizeSMSUSCA("202-155-0118")).toBeNull();
  });

  it("mirrors the reply rune, UTF-8 byte, and null boundaries", () => {
    expect(smsReplyBodyConstraint(" hello ")).toMatchObject({
      trimmed: "hello",
      runes: 5,
      bytes: 5,
      error: null,
    });
    expect(smsReplyBodyConstraint("x".repeat(4_801)).error).toContain("4,800");
    expect(smsReplyBodyConstraint("🧑".repeat(4_200)).error).toContain(
      "16 KiB",
    );
    expect(smsReplyBodyConstraint("hello\u0000world").error).toContain("null");
  });
});
