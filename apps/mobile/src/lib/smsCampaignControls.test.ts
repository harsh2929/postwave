import { describe, expect, it } from "vitest";

import {
  SMS_MUTABLE_STATUSES,
  SMS_VERB_LABELS,
  smsCampaignIsMutable,
  smsCampaignIsPaused,
  smsCampaignIsSending,
  smsCampaignVerbs,
  smsResumeOutcomeCopy,
  smsVerbConfirmCopy,
  smsVerbErrorMessage,
  smsVerbIsDestructive,
} from "./smsCampaignControls";

describe("smsCampaignIsMutable", () => {
  it("matches the pause/cancel UPDATE predicate exactly", () => {
    // store.go:1084 — AND status IN ('draft','scheduled','paused','sending')
    expect([...SMS_MUTABLE_STATUSES]).toEqual([
      "draft",
      "scheduled",
      "paused",
      "sending",
    ]);
    for (const status of SMS_MUTABLE_STATUSES) {
      expect(smsCampaignIsMutable(status)).toBe(true);
    }
  });

  it("refuses terminal statuses the UPDATE would not match", () => {
    for (const status of ["cancelled", "sent", "failed"]) {
      expect(smsCampaignIsMutable(status)).toBe(false);
    }
  });

  it("is case- and whitespace-insensitive", () => {
    expect(smsCampaignIsMutable("  SENDING ")).toBe(true);
  });

  it("refuses an empty or unknown status rather than guessing", () => {
    // Unlike the CRM case, failing OPEN here would offer Cancel on a sent
    // campaign, whose only outcome is an error.
    expect(smsCampaignIsMutable("")).toBe(false);
    expect(smsCampaignIsMutable("reticulating")).toBe(false);
  });
});

describe("smsCampaignVerbs", () => {
  it("offers nothing once the campaign is terminal", () => {
    for (const status of ["cancelled", "sent", "failed"]) {
      expect(smsCampaignVerbs(status)).toEqual([]);
    }
  });

  it("offers pause and cancel while sending", () => {
    expect(smsCampaignVerbs("sending")).toEqual(["pause", "cancel"]);
  });

  it("holds resume unless authoritative broadcast readiness is available", () => {
    const verbs = smsCampaignVerbs("paused");
    expect(verbs).toEqual(["cancel"]);
    expect(verbs).not.toContain("pause");
    expect(smsCampaignVerbs("paused", true)).toEqual(["resume", "cancel"]);
  });

  it("puts cancel last, so a mis-tap is not the irreversible one", () => {
    for (const status of ["sending", "paused", "draft"]) {
      const verbs = smsCampaignVerbs(status);
      expect(verbs[verbs.length - 1]).toBe("cancel");
    }
  });

  it("never offers retry-failed beside pause", () => {
    // It re-sends to every failed recipient and bills per message; it belongs
    // behind its own confirmation with a count.
    for (const status of ["sending", "paused", "draft", "scheduled"]) {
      expect(smsCampaignVerbs(status)).not.toContain("retry-failed");
    }
  });

  it("labels every verb it can return", () => {
    for (const status of SMS_MUTABLE_STATUSES) {
      for (const verb of smsCampaignVerbs(status)) {
        expect(SMS_VERB_LABELS[verb]).toBeTruthy();
      }
    }
  });
});

describe("smsCampaignIsPaused / smsCampaignIsSending", () => {
  it("identifies the two states the UI colours differently", () => {
    expect(smsCampaignIsPaused("paused")).toBe(true);
    expect(smsCampaignIsSending("sending")).toBe(true);
    expect(smsCampaignIsSending("paused")).toBe(false);
  });
});

describe("smsVerbIsDestructive", () => {
  it("marks cancel and retry-failed, since both are irreversible or cost money", () => {
    expect(smsVerbIsDestructive("cancel")).toBe(true);
    expect(smsVerbIsDestructive("retry-failed")).toBe(true);
    expect(smsVerbIsDestructive("pause")).toBe(false);
    expect(smsVerbIsDestructive("resume")).toBe(false);
  });
});

describe("smsResumeOutcomeCopy", () => {
  it("warns that a drained campaign returns to draft rather than sending", () => {
    // store.go:1123-1125 picks `sending` only when recipients remain queued.
    // Landing in draft silently would look like the button failed.
    expect(smsResumeOutcomeCopy(0)).toContain("returns this campaign to draft");
  });

  it("says how many are still queued", () => {
    expect(smsResumeOutcomeCopy(12)).toContain("12 queued recipients");
    expect(smsResumeOutcomeCopy(1)).toContain("1 queued recipient");
    expect(smsResumeOutcomeCopy(1)).not.toContain("recipients");
  });

  it("stays honest when the count is unknown", () => {
    const copy = smsResumeOutcomeCopy(null);
    expect(copy).toContain("If the queue has drained");
    expect(copy).not.toContain("null");
  });
});

describe("smsVerbConfirmCopy", () => {
  it("names the per-message cost on retry", () => {
    const copy = smsVerbConfirmCopy("retry-failed", "Flash sale");
    expect(copy.body).toContain("bills per message");
    expect(copy.title).toContain("Flash sale");
  });

  it("does not promise that cancelling recalls handed-off messages", () => {
    const copy = smsVerbConfirmCopy("cancel", "Flash sale");
    expect(copy.body).toContain("may still arrive");
    expect(copy.body).toContain("cannot be undone");
  });
});

describe("smsVerbErrorMessage", () => {
  it("explains a lost race rather than blaming the operator", () => {
    expect(smsVerbErrorMessage(409, "x")).toContain("moved on");
    expect(smsVerbErrorMessage(422, "x")).toContain("moved on");
  });

  it("names the role problem on a 403", () => {
    expect(smsVerbErrorMessage(403, "x")).toContain("role");
  });

  it("falls back for anything else", () => {
    expect(smsVerbErrorMessage(500, "FALLBACK")).toBe("FALLBACK");
  });
});
