import { describe, expect, it } from "vitest";

import {
  approvalDecisionStats,
  approvalEmptyCopy,
  approvalGateNotice,
  approvalRowDecisionState,
  approvalRowNotices,
  approvalTruncationNotice,
  canRefreshApprovals,
  expiryHint,
  formatTimeToDecide,
  isApprovalExpired,
  rejectDraftSubmitState,
  rejectReasonModalState,
  requestedAtLine,
  resourceLabel,
} from "./approvalPresentation";
import { governanceEmptyCopy } from "@/lib/governanceEmptyStates";

describe("approval disabled-query presentation", () => {
  it("does not replace a cached-session-disabled query with the caught-up empty state", () => {
    const gateNotice = approvalGateNotice({
      gateEnabled: false,
      hasTenant: true,
    });

    expect(gateNotice?.staleMessage).toContain("Showing the last loaded");
    expect(
      approvalEmptyCopy({
        filter: "pending",
        query: "",
        gateNotice,
      }),
    ).toEqual({
      title: "Reconnect to load approvals",
      description:
        "This cached session has not been validated online yet. Reconnect before reviewing approval requests.",
    });
  });

  it("keeps the normal pending and all-tab empty copy when the query gate is open", () => {
    expect(
      approvalEmptyCopy({
        filter: "pending",
        query: "",
        gateNotice: null,
      }),
    ).toEqual({
      title: "You're caught up",
      description: "Nothing pending right now. Pull to refresh.",
    });

    expect(
      approvalEmptyCopy({
        filter: "all",
        query: "spring",
        gateNotice: null,
      }),
    ).toEqual({
      title: "Nothing matches",
      description: 'No approvals match "spring"',
    });
  });

  it("explains what the queue is FOR on a first run, not just that it is empty", () => {
    // GOVERNANCE#30. The unfiltered all-tab used to say "Nothing matches" /
    // "No approvals on file yet." — a restatement of the empty list, on one of
    // the screens whose purpose is least self-evident to a new admin. It now
    // reads the SHARED governance copy, so Approvals, Audit, SCIM, Audit sinks
    // and Agency answer the same two questions in the same voice.
    const copy = approvalEmptyCopy({
      filter: "all",
      query: "",
      gateNotice: null,
    });
    expect(copy).toEqual(governanceEmptyCopy("approvals"));
    expect(copy.description).toContain("approve");
    // The narrowed case above must NOT have been flattened into it: a user who
    // searched and found nothing has learned something the shared copy cannot
    // say.
    expect(copy).not.toEqual(
      approvalEmptyCopy({ filter: "all", query: "spring", gateNotice: null }),
    );
  });

  it("uses a sign-in-oriented message when no tenant is available", () => {
    expect(
      approvalGateNotice({
        gateEnabled: false,
        hasTenant: false,
      }),
    ).toMatchObject({
      title: "Reconnect your workspace",
    });
  });

  it("blocks manual refresh while the query gate is disabled", () => {
    expect(
      canRefreshApprovals(
        approvalGateNotice({
          gateEnabled: false,
          hasTenant: true,
        }),
      ),
    ).toBe(false);
    expect(canRefreshApprovals(null)).toBe(true);
  });

  it("turns cached pending rows read-only until the session validates online", () => {
    const gateNotice = approvalGateNotice({
      gateEnabled: false,
      hasTenant: true,
    });

    expect(
      approvalRowDecisionState({
        isPending: true,
        isRowDeciding: false,
        gateNotice,
      }),
    ).toEqual({
      disabled: true,
      opacity: 0.6,
      accessibilityLabelSuffix: " - reconnect before deciding",
    });

    expect(
      approvalRowDecisionState({
        isPending: true,
        isRowDeciding: false,
        gateNotice: null,
      }),
    ).toEqual({
      disabled: false,
      opacity: 1,
      accessibilityLabelSuffix: " - tap to approve or reject",
    });
  });
});

describe("expired and self-requested rows", () => {
  const NOW = Date.parse("2026-07-25T12:00:00.000Z");

  it("disables a pending row whose expiry has passed", () => {
    const state = approvalRowDecisionState({
      isPending: true,
      isRowDeciding: false,
      gateNotice: null,
      isExpired: true,
    });
    expect(state.disabled).toBe(true);
    expect(state.accessibilityLabelSuffix).toBe(
      " - expired, no decision possible",
    );
    expect(state.opacity).toBe(0.6);
  });

  it("disables a pending row the signed-in user requested themselves", () => {
    const state = approvalRowDecisionState({
      isPending: true,
      isRowDeciding: false,
      gateNotice: null,
      isOwnRequest: true,
    });
    expect(state.disabled).toBe(true);
    expect(state.accessibilityLabelSuffix).toContain("you requested this");
  });

  it("keeps the gate notice as the dominant explanation", () => {
    const gateNotice = approvalGateNotice({
      gateEnabled: false,
      hasTenant: true,
    });
    expect(
      approvalRowDecisionState({
        isPending: true,
        isRowDeciding: false,
        gateNotice,
        isExpired: true,
      }).accessibilityLabelSuffix,
    ).toBe(" - reconnect before deciding");
  });

  it("says nothing extra on an already-resolved row", () => {
    expect(
      approvalRowDecisionState({
        isPending: false,
        isRowDeciding: false,
        gateNotice: null,
        isExpired: true,
      }).accessibilityLabelSuffix,
    ).toBe("");
    expect(
      approvalRowNotices({
        isPending: false,
        isExpired: true,
        isOwnRequest: true,
      }),
    ).toEqual([]);
  });

  it("publishes a text badge for each blocking reason", () => {
    expect(
      approvalRowNotices({
        isPending: true,
        isExpired: true,
        isOwnRequest: true,
      }).map((n) => n.label),
    ).toEqual(["Expired", "You requested this"]);
  });

  it("treats an absent or unparseable expiry as not expired", () => {
    expect(isApprovalExpired(undefined, NOW)).toBe(false);
    expect(isApprovalExpired("not-a-date", NOW)).toBe(false);
    expect(isApprovalExpired("2026-07-25T11:59:59.000Z", NOW)).toBe(true);
    expect(isApprovalExpired("2026-07-25T12:00:00.000Z", NOW)).toBe(true);
    expect(isApprovalExpired("2026-07-25T12:00:01.000Z", NOW)).toBe(false);
  });

  it("expiryHint crosses to Expired at the boundary and stays quiet past 7d", () => {
    expect(expiryHint("2026-07-25T12:30:00.000Z", NOW)).toBe("Expires in 30m");
    expect(expiryHint("2026-07-25T15:00:00.000Z", NOW)).toBe("Expires in 3h");
    expect(expiryHint("2026-07-28T12:00:00.000Z", NOW)).toBe("Expires in 3d");
    expect(expiryHint("2026-09-25T12:00:00.000Z", NOW)).toBe("");
    expect(expiryHint("2026-07-25T11:00:00.000Z", NOW)).toBe("Expired");
    expect(expiryHint(undefined, NOW)).toBe("");
    expect(expiryHint("garbage", NOW)).toBe("");
  });
});

describe("row copy helpers", () => {
  it("labels known resource types and falls back to the raw type", () => {
    expect(resourceLabel("campaign")).toBe("Campaign send");
    expect(resourceLabel("sequence")).toBe("Sequence activation");
    expect(resourceLabel("widget")).toBe("widget");
    expect(resourceLabel("")).toBe("Approval");
  });

  it("returns an empty timestamp line rather than 'Invalid Date'", () => {
    expect(requestedAtLine(undefined)).toBe("");
    expect(requestedAtLine("not-a-date")).toBe("");
    expect(requestedAtLine("2026-07-25T11:00:00.000Z", 0)).not.toContain(
      "Invalid",
    );
  });
});

describe("approvalDecisionStats", () => {
  const NOW = Date.parse("2026-07-25T12:00:00.000Z");
  const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

  it("counts pending and 7-day decisions separately", () => {
    const stats = approvalDecisionStats(
      [
        { status: "pending", requestedAt: hoursAgo(2) },
        { status: "approved", requestedAt: hoursAgo(5), decidedAt: hoursAgo(4) },
        { status: "rejected", requestedAt: hoursAgo(9), decidedAt: hoursAgo(8) },
        // Older than 7d — excluded from both the counts and the average.
        {
          status: "approved",
          requestedAt: hoursAgo(24 * 10),
          decidedAt: hoursAgo(24 * 9),
        },
      ],
      NOW,
    );
    expect(stats.pending).toBe(1);
    expect(stats.approved7d).toBe(1);
    expect(stats.rejected7d).toBe(1);
    expect(stats.decidedSample).toBe(2);
    expect(stats.avgTimeToDecideMs).toBe(3600_000);
  });

  it("returns a null average when nothing was decided in the window", () => {
    const stats = approvalDecisionStats(
      [{ status: "pending", requestedAt: hoursAgo(1) }],
      NOW,
    );
    expect(stats.avgTimeToDecideMs).toBeNull();
    expect(formatTimeToDecide(stats.avgTimeToDecideMs)).toBe("—");
  });

  it("drops clock-skewed rows instead of reporting a negative average", () => {
    const stats = approvalDecisionStats(
      [
        { status: "approved", requestedAt: hoursAgo(1), decidedAt: hoursAgo(3) },
        { status: "approved", requestedAt: hoursAgo(5), decidedAt: hoursAgo(3) },
      ],
      NOW,
    );
    // Both count as approvals; only the well-ordered one feeds the mean.
    expect(stats.approved7d).toBe(2);
    expect(stats.decidedSample).toBe(1);
    expect(stats.avgTimeToDecideMs).toBe(2 * 3600_000);
  });

  it("ignores expired rows and rows with no decidedAt", () => {
    const stats = approvalDecisionStats(
      [
        { status: "expired", requestedAt: hoursAgo(4), decidedAt: hoursAgo(1) },
        { status: "approved", requestedAt: hoursAgo(4) },
      ],
      NOW,
    );
    expect(stats.approved7d).toBe(0);
    expect(stats.rejected7d).toBe(0);
    expect(stats.decidedSample).toBe(0);
  });
});

describe("approvalTruncationNotice", () => {
  it("stays silent below the cap and discloses at or above it", () => {
    expect(approvalTruncationNotice(99, 100)).toBeNull();
    expect(approvalTruncationNotice(100, 100)).toContain("most recent 100");
    expect(approvalTruncationNotice(0, 100)).toBeNull();
  });
});

describe("approval reject-reason presentation", () => {
  it("disables submit until the reason has non-whitespace content", () => {
    expect(rejectReasonModalState("   ")).toEqual({
      trimmedReason: "",
      submitDisabled: true,
      submitLabel: "Reject",
    });

    expect(rejectReasonModalState(" Missing legal footer ")).toEqual({
      trimmedReason: "Missing legal footer",
      submitDisabled: false,
      submitLabel: "Reject",
    });
  });

  it("keeps the reject button disabled while a decision is in flight", () => {
    expect(rejectReasonModalState("Valid reason", true)).toEqual({
      trimmedReason: "Valid reason",
      submitDisabled: true,
      submitLabel: "Rejecting...",
    });
  });

  it("returns the required-reason alert state for blank rejections", () => {
    expect(
      rejectDraftSubmitState({
        id: "approval_1",
        label: "Campaign send",
        reason: " ",
      }),
    ).toEqual({
      kind: "reason_required",
      title: "Reason required",
      message: "Add a short reason so the requester knows what to fix.",
    });
  });

  it("trims and prepares the reject decision input", () => {
    expect(
      rejectDraftSubmitState({
        id: "approval_1",
        label: "Campaign send",
        reason: "  Missing legal footer.  ",
      }),
    ).toEqual({
      kind: "submit",
      input: {
        id: "approval_1",
        decision: "reject",
        notes: "Missing legal footer.",
      },
    });
  });
});
