// SPDX-License-Identifier: AGPL-3.0-only
//
// Client contract for the DSA Art. 16 notice-and-action mechanism.
//
// The vocabulary here mirrors apps/api/internal/contentreports exactly, because
// the values are CHECK-constrained in migration 2041 and a client that invents
// a category produces a 400 the reporter cannot act on. Kept in one module so
// the form, the status lookup and their tests read from the same list.

import { api } from "@/lib/api";

/**
 * The Art. 16(2)(a) grounds.
 *
 * `csam_or_child_safety` is not a convenience label. Art. 16(2)(c) excuses the
 * notifier's name and email specifically for offences under Articles 3-7 of
 * Directive 2011/93/EU, so selecting it is what makes the form stop requiring
 * an email — see `requiresNotifierEmail`.
 */
export const REPORT_GROUNDS = [
  { value: "illegal_content", label: "Illegal content" },
  { value: "intellectual_property", label: "Copyright or trademark infringement" },
  { value: "privacy_violation", label: "Personal data published without consent" },
  { value: "harassment_or_hate", label: "Harassment, threats or hate speech" },
  { value: "csam_or_child_safety", label: "Child sexual abuse material or child safety" },
  { value: "fraud_or_scam", label: "Fraud, scam or impersonation" },
  { value: "spam_or_unsolicited", label: "Spam or unsolicited messages" },
  { value: "ai_output_harmful", label: "Harmful AI-generated content" },
  { value: "other", label: "Something else" },
] as const;

export type ReportGround = (typeof REPORT_GROUNDS)[number]["value"];

export const REPORT_SUBJECT_KINDS = [
  { value: "landing_page", label: "A landing page" },
  { value: "hosted_form", label: "A signup form" },
  { value: "archive_post", label: "A newsletter in a public archive" },
  { value: "archive_comment", label: "A comment on a public archive" },
  { value: "inbound_message", label: "An email or message I received" },
  { value: "ai_output", label: "Something an AI feature generated" },
  { value: "other", label: "Something else" },
] as const;

export type ReportSubjectKind = (typeof REPORT_SUBJECT_KINDS)[number]["value"];

/**
 * Art. 16(2)(c): identity is required EXCEPT for child-safety reports.
 *
 * The exception is the point. A person reporting child sexual abuse material
 * must be able to do so without naming themselves, and a form that demanded an
 * address would be a reason not to report at all.
 */
export function requiresNotifierEmail(ground: ReportGround): boolean {
  return ground !== "csam_or_child_safety";
}

/** Mirrors the server's minimum. Enforced server-side and by a CHECK; this is
 * so the reporter learns before submitting rather than after. */
export const MIN_EXPLANATION_LENGTH = 20;

export type ContentReportInput = {
  subject_kind: ReportSubjectKind;
  subject_url: string;
  reason_category: ReportGround;
  explanation: string;
  notifier_name?: string;
  notifier_email?: string;
  good_faith_declared: boolean;
};

export type ContentReportReceipt = {
  reference: string;
  received_at: string;
  next_steps?: string;
};

export type ContentReportStatus = {
  reference: string;
  status: string;
  received_at: string;
  decision_action?: string;
  decision_reasoning?: string;
  decided_at?: string;
  automated_means_used?: boolean;
};

/**
 * `credentials: "omit"` is load-bearing, not hygiene. The endpoint is anonymous
 * by legal mandate; sending a session cookie from a signed-in operator's
 * browser would attach an identity the reporter did not choose to disclose.
 */
const ANONYMOUS = { credentials: "omit", cache: "no-store" } as const;

export function submitContentReport(
  input: ContentReportInput,
): Promise<ContentReportReceipt> {
  return api.post<ContentReportReceipt>("/api/public/content-reports", input, ANONYMOUS);
}

export function lookupContentReport(
  reference: string,
): Promise<ContentReportStatus> {
  return api.get<ContentReportStatus>(
    `/api/public/content-reports/${encodeURIComponent(reference.trim().toUpperCase())}`,
    ANONYMOUS,
  );
}

/** Human labels for the terminal states, so the status page does not show a
 * database enum to a member of the public. */
export const REPORT_STATUS_LABELS: Record<string, string> = {
  received: "Received — not yet reviewed",
  under_review: "Under review",
  action_taken: "Reviewed — we acted on this report",
  no_action: "Reviewed — we did not act on this report",
  forwarded_to_authority: "Referred to a law-enforcement authority",
  withdrawn: "Withdrawn",
};

export const REPORT_ACTION_LABELS: Record<string, string> = {
  content_removed: "The content was removed",
  content_disabled: "Access to the content was disabled",
  visibility_restricted: "The content's visibility was restricted",
  account_suspended: "The account was suspended",
  account_terminated: "The account was terminated",
  no_action: "No action was taken",
};
