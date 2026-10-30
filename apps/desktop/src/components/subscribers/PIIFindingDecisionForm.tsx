import {
  type FormEvent,
  type ReactElement,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  type PIIDecisionReason,
  type PIIFinding,
  type PIIFindingStatus,
  type PIIReviewInput,
  piiReviewCommentContainsStrongPII,
} from "../../lib/api/pii-findings";
import { DISMISS_REASONS, REVIEW_REASONS } from "./pii-findings-ui";

const EVIDENCE_PATTERN =
  /^[A-Za-z][A-Za-z0-9._-]{1,31}:[A-Za-z0-9][A-Za-z0-9._/#-]{1,255}$/;

function runeCount(value: string): number {
  return Array.from(value).length;
}

interface Props {
  finding: PIIFinding;
  outcome: Exclude<PIIFindingStatus, "pending">;
  error?: string | null;
  onCancel: () => void;
  /** Resolve true only after a verified immutable receipt is accepted. */
  onSubmit: (input: PIIReviewInput) => Promise<boolean>;
}

/** Required evidence form shared by tenant and subscriber review surfaces. */
export function PIIFindingDecisionForm({
  finding,
  outcome,
  error,
  onCancel,
  onSubmit,
}: Props): ReactElement {
  const [reason, setReason] = useState<PIIDecisionReason | "">("");
  const [comment, setComment] = useState("");
  const [evidence, setEvidence] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const reasonRef = useRef<HTMLSelectElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const inFlightRef = useRef(false);
  const commentId = useId();
  const commentHelpId = useId();
  const evidenceId = useId();
  const errorId = useId();
  const options = outcome === "reviewed" ? REVIEW_REASONS : DISMISS_REASONS;
  const trimmedComment = comment.trim();
  const trimmedEvidence = evidence.trim();
  const commentLength = runeCount(trimmedComment);
  const commentContainsStrongPII =
    trimmedComment.length > 0 &&
    piiReviewCommentContainsStrongPII(trimmedComment);
  const evidenceLength = runeCount(trimmedEvidence);
  const evidenceValid =
    evidenceLength >= 3 &&
    evidenceLength <= 288 &&
    EVIDENCE_PATTERN.test(trimmedEvidence);
  const valid =
    reason !== "" &&
    commentLength >= 1 &&
    commentLength <= 2_000 &&
    !commentContainsStrongPII &&
    evidenceValid;

  useEffect(() => reasonRef.current?.focus(), []);

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape" && !submitting) {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };
    form.addEventListener("keydown", handleKeyDown);
    return () => form.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, submitting]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!valid || !reason || inFlightRef.current) return;
    inFlightRef.current = true;
    setSubmitting(true);
    try {
      await onSubmit({
        status: outcome,
        reason,
        comment: trimmedComment,
        evidence_reference: trimmedEvidence,
        expected_updated_at: finding.updated_at,
      });
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <form
      ref={formRef}
      className="pii-decision-form"
      onSubmit={(event) => void submit(event)}
      aria-label={`${outcome === "reviewed" ? "Review" : "Dismiss"} finding ${finding.id}`}
      aria-describedby={error ? errorId : undefined}
    >
      <div className="pii-decision-form-heading">
        <div>
          <span className="pii-review-eyebrow">Document the decision</span>
          <strong>
            {outcome === "reviewed"
              ? "Confirm review outcome"
              : "Explain this dismissal"}
          </strong>
        </div>
        <span>All fields are written to an immutable receipt.</span>
      </div>

      <label className="pii-decision-field">
        <span>Reason</span>
        <select
          ref={reasonRef}
          value={reason}
          onChange={(event) =>
            setReason(event.currentTarget.value as PIIDecisionReason | "")
          }
          disabled={submitting}
          required
        >
          <option value="">Choose a documented reason…</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {reason ? (
          <small>{options.find((option) => option.value === reason)?.description}</small>
        ) : null}
      </label>

      <label className="pii-decision-field" htmlFor={commentId}>
        <span>Decision comment</span>
        <textarea
          id={commentId}
          value={comment}
          onChange={(event) => setComment(event.currentTarget.value)}
          rows={3}
          disabled={submitting}
          placeholder="Record what was verified and the follow-up owner. Never paste the detected value."
          required
          aria-describedby={commentHelpId}
          aria-invalid={commentContainsStrongPII || commentLength > 2_000}
        />
        <small
          id={commentHelpId}
          className={
            commentContainsStrongPII || commentLength > 2_000
              ? "is-invalid"
              : ""
          }
        >
          {commentLength.toLocaleString()} / 2,000 characters ·{" "}
          {commentContainsStrongPII
            ? "remove the personal-data-shaped value and cite the evidence reference instead"
            : "do not include personal data"}
        </small>
      </label>

      <label className="pii-decision-field" htmlFor={evidenceId}>
        <span>Evidence reference</span>
        <input
          id={evidenceId}
          value={evidence}
          onChange={(event) => setEvidence(event.currentTarget.value)}
          disabled={submitting}
          placeholder="ticket:DPO-123"
          spellCheck={false}
          autoComplete="off"
          required
          aria-invalid={trimmedEvidence.length > 0 && !evidenceValid}
        />
        <small className={trimmedEvidence.length > 0 && !evidenceValid ? "is-invalid" : ""}>
          Use a non-secret typed reference such as ticket:DPO-123, case:privacy/2026-071, or policy:PII-v3.
        </small>
      </label>

      {error ? (
        <div id={errorId} className="pii-decision-error" role="alert">
          <strong>Decision not recorded.</strong> {error} Your form has been preserved.
        </div>
      ) : null}

      <div className="pii-decision-actions">
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={!valid || submitting}>
          {submitting
            ? "Recording receipt…"
            : outcome === "reviewed"
              ? "Record reviewed"
              : "Record dismissal"}
        </button>
      </div>
    </form>
  );
}

export const piiEvidenceReferencePattern = EVIDENCE_PATTERN;
export const piiRuneCount = runeCount;
