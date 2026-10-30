import { describe, expect, it } from "vitest";

import {
  confirmationEmailProblem,
  filterSubmissions,
  submissionStatusLabel,
  submissionTotals,
} from "@/lib/submissions-helpers";
import type { FormSubmission } from "@/lib/forms-types";

function sub(over: Partial<FormSubmission>): FormSubmission {
  return {
    id: over.id ?? "1",
    formId: "f",
    email: over.email ?? "a@example.com",
    customFields: over.customFields ?? {},
    status: over.status ?? "pending",
    ip: null,
    userAgent: null,
    submittedAt: over.submittedAt ?? "2026-04-15T12:00:00Z",
    confirmedAt: null,
  };
}

const rows = [
  sub({ id: "1", email: "alice@example.com", status: "confirmed", submittedAt: "2026-04-10T09:00:00Z" }),
  sub({ id: "2", email: "bob@test.com", status: "pending", submittedAt: "2026-04-15T09:00:00Z" }),
  sub({ id: "3", email: "carol@example.com", status: "unsubscribed", submittedAt: "2026-04-20T09:00:00Z" }),
];

describe("submissionTotals", () => {
  it("counts by status across the whole set", () => {
    const withResponse = [...rows, sub({ id: "4", status: "received" })];
    expect(submissionTotals(withResponse)).toEqual({
      total: 4,
      confirmed: 1,
      pending: 1,
      unsubscribed: 1,
      received: 1,
    });
  });

  it("never counts a response without consent as confirmed", () => {
    const totals = submissionTotals([sub({ status: "received" }), sub({ status: "received" })]);
    expect(totals.confirmed).toBe(0);
    expect(totals.received).toBe(2);
  });
});

describe("submission status and confirmation email copy", () => {
  it("labels a response without consent as a response only", () => {
    expect(submissionStatusLabel("received")).toBe("response only");
    expect(submissionStatusLabel("pending")).toBe("pending-confirmation");
    expect(submissionStatusLabel("confirmed")).toBe("confirmed");
  });

  it("tells the operator what to do about an email that did not reach the visitor", () => {
    expect(confirmationEmailProblem({ status: "pending", confirmationEmail: "send_failed" })).toEqual({
      tone: "error",
      message: "Confirmation email not delivered. It's retried automatically, or you can resend it.",
    });
    expect(confirmationEmailProblem({ status: "pending", confirmationEmail: "no_sender" })?.message).toContain(
      "Set a sender address on a verified domain",
    );
    expect(confirmationEmailProblem({ status: "pending", confirmationEmail: "quota_exceeded" })?.tone).toBe("warning");
    expect(confirmationEmailProblem({ status: "pending", confirmationEmail: "recipient_suppressed" })?.message).toContain(
      "bounced, reported spam, or was erased",
    );
  });

  it("says nothing when the email went out, is queued, or the submission is no longer pending", () => {
    expect(confirmationEmailProblem({ status: "pending", confirmationEmail: "sent" })).toBeNull();
    expect(confirmationEmailProblem({ status: "pending", confirmationEmail: "queued" })).toBeNull();
    expect(confirmationEmailProblem({ status: "pending" })).toBeNull();
    expect(confirmationEmailProblem({ status: "confirmed", confirmationEmail: "send_failed" })).toBeNull();
  });
});

describe("filterSubmissions", () => {
  it("filters to responses without consent", () => {
    const withResponse = [...rows, sub({ id: "4", status: "received" })];
    expect(filterSubmissions(withResponse, { status: "received" }).map((s) => s.id)).toEqual(["4"]);
    expect(filterSubmissions(withResponse, { status: "confirmed" }).map((s) => s.id)).toEqual(["1"]);
  });

  it("filters by status", () => {
    expect(
      filterSubmissions(rows, { status: "confirmed" }).map((r) => r.id),
    ).toEqual(["1"]);
    expect(filterSubmissions(rows, { status: "all" })).toHaveLength(3);
  });

  it("filters by email substring (case-insensitive)", () => {
    expect(
      filterSubmissions(rows, { email: "EXAMPLE.com" }).map((r) => r.id),
    ).toEqual(["1", "3"]);
  });

  it("filters by an inclusive date range", () => {
    expect(
      filterSubmissions(rows, { from: "2026-04-15", to: "2026-04-20" }).map(
        (r) => r.id,
      ),
    ).toEqual(["2", "3"]);
  });

  it("combines filters", () => {
    expect(
      filterSubmissions(rows, {
        status: "unsubscribed",
        email: "example",
        from: "2026-04-16",
      }).map((r) => r.id),
    ).toEqual(["3"]);
  });

  it("ignores malformed date bounds gracefully", () => {
    expect(filterSubmissions(rows, { from: "not-a-date" })).toHaveLength(3);
  });
});
