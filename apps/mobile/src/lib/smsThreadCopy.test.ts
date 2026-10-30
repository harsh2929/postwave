import { describe, expect, it } from "vitest";

import {
  smsReplyFailureCopy,
  smsReplyIntentReason,
  smsReplySelectionReason,
  smsThreadFreshnessText,
} from "./smsThreadCopy";

const record = {
  version: 1 as const,
  identityHash: "a".repeat(64),
  threadHash: "b".repeat(64),
  signatureHash: "c".repeat(64),
  idempotencyKey: "key-1",
  createdAt: "2026-08-21T09:00:00Z",
};

describe("smsReplyIntentReason", () => {
  it("puts a storage failure above every other state", () => {
    expect(
      smsReplyIntentReason({
        storageError: "keychain is unavailable",
        loading: true,
        inspection: { status: "none" },
      }),
    ).toBe("keychain is unavailable");
  });

  it("says nothing when there is no hold and nothing in flight", () => {
    expect(
      smsReplyIntentReason({
        storageError: null,
        loading: false,
        inspection: { status: "none" },
      }),
    ).toBeNull();
  });

  it("names the state without naming the other identity", () => {
    const other = smsReplyIntentReason({
      storageError: null,
      loading: false,
      inspection: { status: "other_identity" },
    });
    expect(other).toMatch(/different workspace identity/u);
    expect(other).toMatch(/no new reply can be sent/iu);
    expect(
      smsReplyIntentReason({
        storageError: null,
        loading: false,
        inspection: { status: "other_thread", state: "pending" },
      }),
    ).toMatch(/Another conversation/u);
  });

  it("distinguishes a reconciling dispatch from an unresolved one", () => {
    expect(
      smsReplyIntentReason({
        storageError: null,
        loading: false,
        inspection: {
          status: "current",
          record: { ...record, state: "reconciliation_required" },
        },
      }),
    ).toBe("Provider dispatch is reconciling. Do not retry this held reply.");
    expect(
      smsReplyIntentReason({
        storageError: null,
        loading: false,
        inspection: {
          status: "current",
          record: { ...record, state: "pending" },
        },
      }),
    ).toMatch(
      /remains held until the server can provide authoritative replay/u,
    );
  });

  it("reports the in-flight check only when nothing else is wrong", () => {
    expect(
      smsReplyIntentReason({
        storageError: null,
        loading: true,
        inspection: { status: "other_identity" },
      }),
    ).toBe("Checking encrypted reply recovery…");
  });
});

describe("smsReplySelectionReason", () => {
  const base = {
    intentReason: null,
    blockReason: null,
    senderId: "",
    senderCount: 1,
    listId: "",
    listCount: 1,
  };

  it("prefers the hold, then the block, then the missing choice", () => {
    expect(
      smsReplySelectionReason({
        ...base,
        intentReason: "held",
        blockReason: "offline",
        senderCount: 2,
      }),
    ).toBe("held");
    expect(
      smsReplySelectionReason({
        ...base,
        blockReason: "offline",
        senderCount: 2,
      }),
    ).toBe("offline");
  });

  it("only asks for a choice when more than one candidate is offered", () => {
    expect(smsReplySelectionReason(base)).toBeNull();
    expect(smsReplySelectionReason({ ...base, senderCount: 2 })).toBe(
      "Choose the sender that received this conversation",
    );
    expect(
      smsReplySelectionReason({ ...base, senderId: "s1", listCount: 2 }),
    ).toBe("Choose the opted-in list authorizing this reply");
    expect(
      smsReplySelectionReason({
        ...base,
        senderId: "s1",
        listId: "l1",
        listCount: 2,
      }),
    ).toBeNull();
  });
});

describe("smsReplyFailureCopy", () => {
  it("locks sending when the hold could not be cleared", () => {
    expect(
      smsReplyFailureCopy({
        error: Object.assign(new Error("boom"), { status: 400 }),
        holdRetired: false,
        holdCleanupFailed: true,
      }),
    ).toEqual({
      kind: "warning",
      message:
        "Nothing was sent, but local safety cleanup failed. Sending remains locked.",
    });
  });

  it("names a release-held dispatch only once its hold is retired", () => {
    const error = { status: 409, code: "sms_reply_dispatch_release_held" };
    expect(
      smsReplyFailureCopy({
        error,
        holdRetired: true,
        holdCleanupFailed: false,
      }).message,
    ).toMatch(/release-held before provider dispatch/u);
    expect(
      smsReplyFailureCopy({
        error,
        holdRetired: false,
        holdCleanupFailed: false,
      }).message,
    ).toMatch(/Delivery outcome is not confirmed/u);
  });

  it("passes a 4xx message through and refuses to call a 5xx a failure", () => {
    expect(
      smsReplyFailureCopy({
        error: Object.assign(new Error("Consent was withdrawn"), {
          status: 422,
        }),
        holdRetired: false,
        holdCleanupFailed: false,
      }),
    ).toEqual({ kind: "error", message: "Consent was withdrawn" });
    expect(
      smsReplyFailureCopy({
        error: Object.assign(new Error("upstream exploded"), { status: 503 }),
        holdRetired: false,
        holdCleanupFailed: false,
      }).message,
    ).toMatch(/not confirmed/u);
    expect(
      smsReplyFailureCopy({
        error: new TypeError("Network request failed"),
        holdRetired: false,
        holdCleanupFailed: false,
      }).message,
    ).toMatch(/not confirmed/u);
  });
});

describe("smsThreadFreshnessText", () => {
  const base = {
    online: true,
    fetching: false,
    refreshFailed: false,
    restartRequired: false,
    snapshotAt: null as string | null,
    partial: false,
  };

  it("says offline before anything else, even mid-fetch", () => {
    expect(
      smsThreadFreshnessText({
        ...base,
        online: false,
        fetching: true,
        restartRequired: true,
      }),
    ).toBe("Offline · showing the last verified page set");
  });

  it("only mentions a failed refresh once there is a page set to keep", () => {
    expect(smsThreadFreshnessText({ ...base, refreshFailed: true })).toBe(
      "Waiting for a verified response…",
    );
    expect(
      smsThreadFreshnessText({
        ...base,
        refreshFailed: true,
        snapshotAt: "2026-08-21T09:00:00Z",
      }),
    ).toMatch(
      /^Automatic refresh failed · showing the last verified page set/u,
    );
  });

  it("explains a paused poll and how to restart it", () => {
    expect(
      smsThreadFreshnessText({
        ...base,
        restartRequired: true,
        fetching: true,
      }),
    ).toMatch(/automatic refresh paused · pull to refresh to restart/u);
  });

  it("distinguishes a known older-page cursor from no cursor at all", () => {
    expect(
      smsThreadFreshnessText({
        ...base,
        snapshotAt: "2026-08-21T09:00:00Z",
        partial: true,
      }),
    ).toMatch(/· older messages available$/u);
    expect(
      smsThreadFreshnessText({ ...base, snapshotAt: "2026-08-21T09:00:00Z" }),
    ).toMatch(/no older-page cursor returned; newer writes may still exist$/u);
  });
});
