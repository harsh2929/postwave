// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure filtering/aggregation for the form-submissions view (FORM-007). All
// filtering is client-side over the full fetched set (the submissions endpoint
// has no server filter params), so it's kept here and unit-tested.

import type { FormSubmission, SubmissionStatus } from "./forms-types";

export const SUBMISSION_STATUS_FILTERS = [
  "all",
  "pending",
  "confirmed",
  "unsubscribed",
  "received",
] as const;
export type SubmissionStatusFilter = (typeof SUBMISSION_STATUS_FILTERS)[number];

export interface SubmissionFilter {
  status?: SubmissionStatusFilter;
  email?: string;
  /** Inclusive lower bound, `YYYY-MM-DD` (local). */
  from?: string;
  /** Inclusive upper bound, `YYYY-MM-DD` (local). */
  to?: string;
}

export interface SubmissionTotals {
  total: number;
  confirmed: number;
  pending: number;
  unsubscribed: number;
  received: number;
}

export function submissionTotals(items: readonly FormSubmission[]): SubmissionTotals {
  const totals: SubmissionTotals = {
    total: items.length,
    confirmed: 0,
    pending: 0,
    unsubscribed: 0,
    received: 0,
  };
  for (const s of items) {
    if (s.status === "confirmed") totals.confirmed++;
    else if (s.status === "pending") totals.pending++;
    else if (s.status === "unsubscribed") totals.unsubscribed++;
    else if (s.status === "received") totals.received++;
  }
  return totals;
}

/** The badge text for a submission's status. */
export function submissionStatusLabel(status: SubmissionStatus): string {
  switch (status) {
    case "pending":
      return "pending-confirmation";
    case "received":
      return "response only";
    default:
      return status;
  }
}

/**
 * What the operator needs to know about a pending submission's confirmation
 * email that has not reached the visitor, or null when there is nothing to
 * act on (sent, queued, or no email at all).
 */
export function confirmationEmailProblem(
  s: Pick<FormSubmission, "status" | "confirmationEmail">,
): { message: string; tone: "error" | "warning" } | null {
  if (s.status !== "pending") return null;
  switch (s.confirmationEmail) {
    case "send_failed":
      return {
        tone: "error",
        message:
          "Confirmation email not delivered. It's retried automatically, or you can resend it.",
      };
    case "no_sender":
      return {
        tone: "error",
        message:
          "Confirmation email not sent: this form has no sender. Set a sender address on a verified domain in the form's settings, then resend.",
      };
    case "quota_exceeded":
      return {
        tone: "warning",
        message:
          "Confirmation email delayed: the standard sender's hourly limit was reached. It's retried automatically.",
      };
    case "recipient_suppressed":
      return {
        tone: "error",
        message:
          "Confirmation email not sent: this address bounced, reported spam, or was erased.",
      };
    default:
      return null;
  }
}

/** Epoch ms for the START of a local `YYYY-MM-DD`, or null when unparseable. */
function startOfDay(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const t = new Date(`${day}T00:00:00`).getTime();
  return Number.isFinite(t) ? t : null;
}

export function filterSubmissions(
  items: readonly FormSubmission[],
  filter: SubmissionFilter,
): FormSubmission[] {
  const status = filter.status ?? "all";
  const email = (filter.email ?? "").trim().toLowerCase();
  const fromMs = filter.from ? startOfDay(filter.from) : null;
  // `to` is inclusive of the whole day → add 24h to its start.
  const toStart = filter.to ? startOfDay(filter.to) : null;
  const toMs = toStart === null ? null : toStart + 86_400_000;

  return items.filter((s) => {
    if (status !== "all" && s.status !== (status as SubmissionStatus)) return false;
    if (email && !s.email.toLowerCase().includes(email)) return false;
    if (fromMs !== null || toMs !== null) {
      const t = new Date(s.submittedAt).getTime();
      if (!Number.isFinite(t)) return false;
      if (fromMs !== null && t < fromMs) return false;
      if (toMs !== null && t >= toMs) return false;
    }
    return true;
  });
}
