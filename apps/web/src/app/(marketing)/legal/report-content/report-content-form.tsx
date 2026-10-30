"use client";

// SPDX-License-Identifier: AGPL-3.0-only
//
// The DSA Art. 16 notice form and the Art. 16(5) outcome lookup.
//
// DESIGN CONSTRAINT THAT SHAPES EVERYTHING HERE. The person using this page is
// having a bad day: their address has been published, their work has been
// copied, their child has been targeted. They are not a customer, they did not
// choose this product, and they will abandon a form that argues with them. So
// the form validates on submit rather than while typing, states what is
// required before it is missing, and never discards what was typed.
//
// The one place it deliberately relaxes is child safety. Art. 16(2)(c) excuses
// the notifier's name and email for offences under Articles 3-7 of Directive
// 2011/93/EU, and the field visibly stops being required the moment that ground
// is chosen — because a form that demanded an address there would be a reason
// not to report at all.

import { useCallback, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  MIN_EXPLANATION_LENGTH,
  REPORT_ACTION_LABELS,
  REPORT_GROUNDS,
  REPORT_STATUS_LABELS,
  REPORT_SUBJECT_KINDS,
  type ContentReportReceipt,
  type ContentReportStatus,
  type ReportGround,
  type ReportSubjectKind,
  lookupContentReport,
  requiresNotifierEmail,
  submitContentReport,
} from "@/lib/legal/content-report";

const FIELD =
  "w-full rounded-md border border-pw-border bg-pw-surface px-3 py-2 text-sm " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500";

function fieldError(message: string | null, id: string) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1 text-xs text-destructive">
      {message}
    </p>
  );
}

export function ReportContentForm(): JSX.Element {
  const [subjectKind, setSubjectKind] = useState<ReportSubjectKind>("landing_page");
  const [subjectURL, setSubjectURL] = useState("");
  const [ground, setGround] = useState<ReportGround>("illegal_content");
  const [explanation, setExplanation] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [goodFaith, setGoodFaith] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<ContentReportReceipt | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const emailRequired = useMemo(() => requiresNotifierEmail(ground), [ground]);

  const validate = useCallback((): Record<string, string> => {
    const next: Record<string, string> = {};
    if (!subjectURL.trim()) {
      next.subjectURL = "Paste the full web address of the content you are reporting.";
    } else if (!/^https?:\/\/.+/i.test(subjectURL.trim())) {
      next.subjectURL = "That does not look like a web address. It should start with https://";
    }
    if (explanation.trim().length < MIN_EXPLANATION_LENGTH) {
      next.explanation = `Please say why this content is illegal or breaks the rules — at least ${MIN_EXPLANATION_LENGTH} characters.`;
    }
    if (emailRequired && !email.trim()) {
      next.email = "We need an email address so we can tell you the outcome.";
    }
    if (!goodFaith) {
      next.goodFaith = "Please confirm the information in this report is accurate.";
    }
    return next;
  }, [subjectURL, explanation, emailRequired, email, goodFaith]);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (submitting) return;
      setSubmitError(null);
      const found = validate();
      setErrors(found);
      if (Object.keys(found).length > 0) return;

      setSubmitting(true);
      try {
        const result = await submitContentReport({
          subject_kind: subjectKind,
          subject_url: subjectURL.trim(),
          reason_category: ground,
          explanation: explanation.trim(),
          notifier_name: name.trim() || undefined,
          notifier_email: email.trim() || undefined,
          good_faith_declared: goodFaith,
        });
        setReceipt(result);
      } catch {
        // Nothing typed is discarded on failure. A reporter who has just
        // written three paragraphs about a threat should not have to write
        // them again because a request timed out.
        setSubmitError(
          "We could not record your report just now. Please try again — nothing you typed has been lost. " +
            "If it keeps failing, email legal@moosewave.com with the same details.",
        );
      } finally {
        setSubmitting(false);
      }
    },
    [submitting, validate, subjectKind, subjectURL, ground, explanation, name, email, goodFaith],
  );

  if (receipt) {
    return (
      <div className="not-prose rounded-lg border border-pw-border bg-pw-surface p-6" role="status">
        <h3 className="text-lg font-medium">Report received</h3>
        <p className="mt-2 text-sm">
          Your reference is{" "}
          <strong className="font-mono text-base tracking-wide">{receipt.reference}</strong>. Keep
          it — you can check the outcome below without an account.
        </p>
        <p className="mt-2 text-sm text-pw-muted-on-paper">
          We received this at {new Date(receipt.received_at).toUTCString()}. We review reports in
          the order they arrive and act on illegal content as quickly as we can.
          {emailRequired
            ? " We will email you when a decision is made."
            : " You chose to report anonymously, so use the reference above to check back."}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="not-prose space-y-5">
      <div>
        <label htmlFor="cr-kind" className="block text-sm font-medium">
          What are you reporting?
        </label>
        <select
          id="cr-kind"
          className={FIELD}
          value={subjectKind}
          onChange={(e) => setSubjectKind(e.target.value as ReportSubjectKind)}
        >
          {REPORT_SUBJECT_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="cr-url" className="block text-sm font-medium">
          Where is it? <span className="text-destructive">*</span>
        </label>
        <input
          id="cr-url"
          type="url"
          inputMode="url"
          className={FIELD}
          placeholder="https://…"
          value={subjectURL}
          onChange={(e) => setSubjectURL(e.target.value)}
          aria-invalid={Boolean(errors.subjectURL)}
          aria-describedby={errors.subjectURL ? "cr-url-error" : "cr-url-help"}
        />
        <p id="cr-url-help" className="mt-1 text-xs text-pw-muted-on-paper">
          The exact address of the page or message. If you cannot copy a link, describe where you
          saw it in the box below.
        </p>
        {fieldError(errors.subjectURL ?? null, "cr-url-error")}
      </div>

      <div>
        <label htmlFor="cr-ground" className="block text-sm font-medium">
          Why is it a problem?
        </label>
        <select
          id="cr-ground"
          className={FIELD}
          value={ground}
          onChange={(e) => setGround(e.target.value as ReportGround)}
        >
          {REPORT_GROUNDS.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="cr-explanation" className="block text-sm font-medium">
          Tell us what is wrong <span className="text-destructive">*</span>
        </label>
        <textarea
          id="cr-explanation"
          rows={6}
          className={FIELD}
          value={explanation}
          onChange={(e) => setExplanation(e.target.value)}
          aria-invalid={Boolean(errors.explanation)}
          aria-describedby={errors.explanation ? "cr-explanation-error" : "cr-explanation-help"}
        />
        <p id="cr-explanation-help" className="mt-1 text-xs text-pw-muted-on-paper">
          The more specific you can be about what is unlawful and why, the faster we can act.
        </p>
        {fieldError(errors.explanation ?? null, "cr-explanation-error")}
      </div>

      <fieldset className="space-y-3 rounded-md border border-pw-border p-4">
        <legend className="px-1 text-sm font-medium">About you</legend>
        {!emailRequired ? (
          <p className="text-xs text-pw-muted-on-paper">
            You can submit this report anonymously. The law does not require us to ask who you are
            when the report concerns child sexual abuse material or child safety, so both fields
            below are optional.
          </p>
        ) : null}
        <div>
          <label htmlFor="cr-name" className="block text-sm">
            Name
          </label>
          <input
            id="cr-name"
            className={FIELD}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
          />
        </div>
        <div>
          <label htmlFor="cr-email" className="block text-sm">
            Email {emailRequired ? <span className="text-destructive">*</span> : "(optional)"}
          </label>
          <input
            id="cr-email"
            type="email"
            inputMode="email"
            className={FIELD}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            aria-invalid={Boolean(errors.email)}
            aria-describedby={errors.email ? "cr-email-error" : undefined}
          />
          {fieldError(errors.email ?? null, "cr-email-error")}
        </div>
      </fieldset>

      <div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={goodFaith}
            onChange={(e) => setGoodFaith(e.target.checked)}
            aria-invalid={Boolean(errors.goodFaith)}
            aria-describedby={errors.goodFaith ? "cr-good-faith-error" : undefined}
          />
          <span>
            I confirm that the information in this report is accurate and complete to the best of my
            knowledge and belief. <span className="text-destructive">*</span>
          </span>
        </label>
        {fieldError(errors.goodFaith ?? null, "cr-good-faith-error")}
      </div>

      {submitError ? (
        <p role="alert" className="text-sm text-destructive">
          {submitError}
        </p>
      ) : null}

      <Button type="submit" disabled={submitting}>
        {submitting ? "Sending report…" : "Send report"}
      </Button>
    </form>
  );
}

export function ReportStatusLookup(): JSX.Element {
  const [reference, setReference] = useState("");
  const [status, setStatus] = useState<ContentReportStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onLookup = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (busy) return;
      setError(null);
      setStatus(null);
      const ref = reference.trim();
      if (!ref) {
        setError("Enter the reference from your report confirmation.");
        return;
      }
      setBusy(true);
      try {
        setStatus(await lookupContentReport(ref));
      } catch {
        setError("We could not find a report with that reference.");
      } finally {
        setBusy(false);
      }
    },
    [busy, reference],
  );

  return (
    <div className="not-prose space-y-4">
      <form onSubmit={onLookup} className="flex flex-wrap items-end gap-3">
        <div className="min-w-[16rem] flex-1">
          <label htmlFor="cr-lookup" className="block text-sm font-medium">
            Report reference
          </label>
          <input
            id="cr-lookup"
            className={`${FIELD} font-mono`}
            placeholder="PWR-XXXXXXXXXX"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            aria-describedby={error ? "cr-lookup-error" : undefined}
            aria-invalid={Boolean(error)}
          />
        </div>
        <Button type="submit" variant="outline" disabled={busy}>
          {busy ? "Checking…" : "Check status"}
        </Button>
      </form>
      {fieldError(error, "cr-lookup-error")}
      {status ? (
        <div className="rounded-lg border border-pw-border bg-pw-surface p-4 text-sm" role="status">
          <p>
            <strong>{REPORT_STATUS_LABELS[status.status] ?? status.status}</strong>
          </p>
          <p className="mt-1 text-pw-muted-on-paper">
            Received {new Date(status.received_at).toUTCString()}.
          </p>
          {status.decision_action ? (
            <div className="mt-3 border-t border-pw-border pt-3">
              <p>
                <strong>
                  {REPORT_ACTION_LABELS[status.decision_action] ?? status.decision_action}
                </strong>
                {status.decided_at ? ` on ${new Date(status.decided_at).toUTCString()}` : null}
              </p>
              {status.decision_reasoning ? (
                <p className="mt-2 whitespace-pre-wrap">{status.decision_reasoning}</p>
              ) : null}
              {status.automated_means_used ? (
                <p className="mt-2 text-xs text-pw-muted-on-paper">
                  Automated means were used in reaching this decision.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
