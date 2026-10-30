import { describe, expect, it } from "vitest";

import {
  campaignErrorCode,
  campaignErrorMessage,
  campaignErrorStatus,
  isCampaignMissingError,
} from "./campaignErrors";

const FALLBACK = "Couldn't schedule the campaign.";

describe("campaignErrorStatus / campaignErrorCode", () => {
  it("reads a gateway error envelope", () => {
    expect(campaignErrorStatus({ status: 409 })).toBe(409);
    expect(campaignErrorCode({ code: "campaign_not_draft" })).toBe(
      "campaign_not_draft",
    );
  });

  it("returns neutral values for a bare Error or a non-object", () => {
    expect(campaignErrorStatus(new Error("boom"))).toBe(0);
    expect(campaignErrorStatus(null)).toBe(0);
    expect(campaignErrorStatus("nope")).toBe(0);
    expect(campaignErrorCode(new Error("boom"))).toBe("");
    expect(campaignErrorCode({ code: 42 })).toBe("");
  });

  it("ignores a non-numeric status", () => {
    expect(campaignErrorStatus({ status: "gone" })).toBe(0);
  });
});

describe("campaignErrorMessage", () => {
  it("never returns the raw error message", () => {
    const err = Object.assign(new Error("fetch failed: ECONNRESET"), {
      status: 500,
    });
    expect(campaignErrorMessage(err, FALLBACK)).not.toContain("ECONNRESET");
  });

  it("explains the gateway-owned dispatch state instead of showing a 422", () => {
    const msg = campaignErrorMessage(
      { status: 422, code: "campaign_dispatch_state_owned" },
      FALLBACK,
    );
    expect(msg).toContain("delivery system");
  });

  it("maps role, deletion, conflict and lock", () => {
    expect(campaignErrorMessage({ status: 403 }, FALLBACK)).toContain("role");
    expect(campaignErrorMessage({ status: 404 }, FALLBACK)).toContain(
      "no longer exists",
    );
    expect(campaignErrorMessage({ status: 409 }, FALLBACK)).toContain(
      "changed since you opened it",
    );
    expect(campaignErrorMessage({ status: 423 }, FALLBACK)).toContain("paused");
    expect(campaignErrorMessage({ status: 401 }, FALLBACK)).toContain(
      "Sign in again",
    );
    expect(campaignErrorMessage({ status: 429 }, FALLBACK)).toContain(
      "Too many requests",
    );
  });

  it("treats a status-less failure as a connectivity problem", () => {
    expect(campaignErrorMessage(new Error("Network request failed"), FALLBACK)).toContain(
      "connection",
    );
  });

  it("keeps the caller's fallback for an unmapped 4xx", () => {
    expect(campaignErrorMessage({ status: 418 }, FALLBACK)).toBe(FALLBACK);
  });

  it("adds a server-side note for a 5xx", () => {
    expect(campaignErrorMessage({ status: 503 }, FALLBACK)).toContain("server");
  });

  it("maps the resend duplicate-subject 422", () => {
    expect(
      campaignErrorMessage({ status: 422, code: "duplicate_subject" }, FALLBACK),
    ).toContain("different from the original");
  });
});

describe("isCampaignMissingError", () => {
  it("is true only for a 404", () => {
    expect(isCampaignMissingError({ status: 404 })).toBe(true);
    expect(isCampaignMissingError({ status: 403 })).toBe(false);
    expect(isCampaignMissingError(new Error("x"))).toBe(false);
  });
});

describe("Campaign Assurance send refusals", () => {
  // apps/api/internal/campaigns/handlers_queue.go:133-157 refuses a queue with
  // FIVE distinct codes across three statuses. Three of them are 409, so a
  // status-only mapping collapsed them into the sentence below — which told a
  // blocked operator to do the one thing that cannot help.
  const WRONG_409 =
    "This campaign changed since you opened it. Pull to refresh and try again.";

  it("does not tell a blocked operator that the campaign changed", () => {
    const msg = campaignErrorMessage(
      { status: 422, code: "campaign_assurance_blocked" },
      FALLBACK,
    );
    expect(msg).not.toBe(WRONG_409);
    expect(msg).toContain("block this send");
  });

  it("names the remedy for a stale run instead of suggesting a refresh", () => {
    const msg = campaignErrorMessage(
      { status: 409, code: "campaign_assurance_stale" },
      FALLBACK,
    );
    expect(msg).not.toBe(WRONG_409);
    expect(msg).toContain("Run it again");
  });

  it("gives all five refusals distinct, code-derived sentences", () => {
    const codes = [
      "campaign_assurance_required",
      "campaign_assurance_pending",
      "campaign_assurance_stale",
      "campaign_assurance_blocked",
      "campaign_assurance_unavailable",
    ] as const;
    const seen = codes.map((code) =>
      campaignErrorMessage({ status: 409, code }, FALLBACK),
    );
    expect(new Set(seen).size).toBe(codes.length);
    for (const msg of seen) expect(msg).not.toBe(WRONG_409);
  });

  it("still falls back to the status mapping for a non-assurance 409", () => {
    expect(campaignErrorMessage({ status: 409 }, FALLBACK)).toBe(WRONG_409);
  });

  it("prefers the assurance code over the status even on a 503", () => {
    // _unavailable arrives as 503, which would otherwise pick up the generic
    // "the server had a problem" tail and lose the reason entirely.
    const msg = campaignErrorMessage(
      { status: 503, code: "campaign_assurance_unavailable" },
      FALLBACK,
    );
    expect(msg).toContain("held rather than guessed");
  });
});

describe("the refusal survives the real SDK error shape", () => {
  // The unit tests above use a plain { status, code } literal. That proves the
  // mapping but NOT that a thrown SDK error actually presents those fields as own
  // properties — and if it did not, every test here would pass while the operator
  // still saw the wrong sentence. So use the classes the transport really throws.
  it("reads code off a genuine ConflictError, not just a literal", async () => {
    const { ConflictError } = await import("@postwave/sdk");
    const err = new ConflictError({
      message: "Campaign Assurance is stale",
      code: "campaign_assurance_stale",
    });
    expect(campaignErrorCode(err)).toBe("campaign_assurance_stale");
    expect(campaignErrorStatus(err)).toBe(409);
    expect(campaignErrorMessage(err, FALLBACK)).toContain("Run it again");
  });

  it("reads a ValidationError, whose subclass sets status 422 itself", async () => {
    const { ValidationError } = await import("@postwave/sdk");
    const err = new ValidationError({
      message: "blocked",
      code: "campaign_assurance_blocked",
    });
    expect(campaignErrorStatus(err)).toBe(422);
    expect(campaignErrorMessage(err, FALLBACK)).toContain("block this send");
  });
});
