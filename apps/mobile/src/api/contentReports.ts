import { errorPresentation, statusOf } from "@/lib/errorCopy";

import { checkedApiResult, rawRequest } from "./request";

/**
 * In-app content reporting.
 *
 * WHY IT EXISTS. Apple Guideline 1.2 requires an app that displays content from
 * third parties to offer a way to report it, and Google Play imposes the same
 * requirement through its UGC policy and, separately, through its generative-AI
 * policy for anything a model produced. Both are conditions of distribution
 * rather than nice-to-haves: this app renders inbound email replies, helpdesk
 * threads, archive comments and model output, and before this module none of
 * them could be reported at all.
 *
 * WHERE IT GOES. Not to a feedback bucket. The report lands in the same
 * `content_reports` table as a public DSA Art. 16 notice, so one moderation
 * queue sees everything and a report made from a phone is as actionable as one
 * made by a stranger on the web.
 */

/** Mirrors the server's CHECK-constrained vocabulary. A value not on this list
 * produces a 400 the user cannot act on, so the two lists must not drift. */
export const REPORT_GROUNDS = [
  { value: "harassment_or_hate", label: "Harassment, threats or hate speech" },
  { value: "illegal_content", label: "Illegal content" },
  { value: "privacy_violation", label: "Personal data shared without consent" },
  { value: "csam_or_child_safety", label: "Child safety" },
  { value: "fraud_or_scam", label: "Fraud, scam or impersonation" },
  { value: "spam_or_unsolicited", label: "Spam" },
  { value: "ai_output_harmful", label: "Harmful AI-generated content" },
  { value: "intellectual_property", label: "Copyright or trademark" },
  { value: "other", label: "Something else" },
] as const;

export type ReportGround = (typeof REPORT_GROUNDS)[number]["value"];

export type ReportSubjectKind =
  | "archive_comment"
  | "inbound_message"
  | "ai_output"
  | "hosted_form"
  | "landing_page"
  | "archive_post"
  | "other";

export type ReportOrigin = "in_app_ugc" | "in_app_ai_output";

/** The server enforces these and so does a database CHECK; duplicated here only
 * so the sheet can disable its button before a round trip. Both are counted
 * the way the server counts them — see `reportExplanationLength`. */
export const MIN_REPORT_EXPLANATION = 20;
export const MAX_REPORT_EXPLANATION = 10000;

export type ContentReportInput = {
  origin: ReportOrigin;
  subject_kind: ReportSubjectKind;
  /** The row being reported, when the client knows it. */
  subject_ref?: string;
  /** A public URL, when one exists. Optional for in-app rows. */
  subject_url?: string;
  reason_category: ReportGround;
  explanation: string;
};

export type ContentReportReceipt = {
  /** Null when the 2xx carried none. The report still landed. */
  reference: string | null;
};

/** Go's `strings.TrimSpace` also strips U+0085, which `String#trim` keeps. */
const EDGE_WHITESPACE = /^[\s\u0085]+|[\s\u0085]+$/g;

/** The explanation exactly as the server will measure it. Sent in this form
 * too, so the count the Send button used is the count the server makes. */
export function trimReportExplanation(explanation: string): string {
  return explanation.replace(EDGE_WHITESPACE, "");
}

/**
 * Mirrors the server's `len([]rune(strings.TrimSpace(explanation)))`.
 *
 * `.length` counts UTF-16 units, so ten emoji measured 20 and enabled Send on
 * a body the server refuses; spreading the string counts code points, which is
 * what a Go rune count and Postgres `length()` both see.
 */
export function reportExplanationLength(explanation: string): number {
  return [...trimReportExplanation(explanation)].length;
}

export function canSubmitContentReport(explanation: string): boolean {
  const length = reportExplanationLength(explanation);
  return (
    length >= MIN_REPORT_EXPLANATION && length <= MAX_REPORT_EXPLANATION
  );
}

const RETRY_REPORT_COPY =
  "We couldn't send that just now. Try again — your report is still here.";

/**
 * What to tell someone whose report did not land.
 *
 * Every failure used to say "Try again", including a role refusal that no
 * retry can clear — so the reporter retried forever and nothing reached
 * moderation. A retry sentence is kept only for the failures a retry can fix
 * (connectivity, 5xx); everything else takes the app's one error-copy
 * chokepoint, which reads the server's classified denial and never echoes a
 * raw server message.
 */
export function reportFailureMessage(error: unknown): string {
  const status = statusOf(error);
  // The only field the reporter controls is the explanation; the grounds and
  // the subject are pinned to the server's vocabulary by the consistency guard.
  // A 422 is the same definite refusal: errorCopy's generic branch would call
  // it retryable, and retrying the same text can never succeed.
  if (status === 400 || status === 422) {
    return "This report couldn't be accepted as written. The explanation needs 20 to 10,000 characters.";
  }
  const presentation = errorPresentation(error);
  if (!presentation.retryable || status === 429) return presentation.message;
  return RETRY_REPORT_COPY;
}

/**
 * `origin` is derived from the subject kind rather than passed in by each call
 * site. Play's generative-AI policy and its UGC policy are different policies
 * with different audits, and a screen that mislabelled model output as UGC
 * would put the report in the wrong bucket for whichever one is being checked.
 */
export function originForSubject(kind: ReportSubjectKind): ReportOrigin {
  return kind === "ai_output" ? "in_app_ai_output" : "in_app_ugc";
}

/**
 * File the report. Rejects with the status/code/denial-tagged error that
 * `checkedApiResult` builds, so `reportFailureMessage` can tell a refusal from
 * a dropped connection.
 *
 * Never throws on a 2xx: the row is committed before the 201 is written, and
 * an error here would invite the reporter to file the same report twice.
 */
export async function submitContentReport(
  input: ContentReportInput,
): Promise<ContentReportReceipt> {
  const res = await checkedApiResult(
    rawRequest<unknown>("POST", "/api/v1/content-reports", input),
  );
  return { reference: referenceOf(res.data) };
}

function referenceOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const reference = (body as { reference?: unknown }).reference;
  return typeof reference === "string" && reference.trim() ? reference : null;
}
