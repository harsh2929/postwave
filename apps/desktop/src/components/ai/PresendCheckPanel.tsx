/**
 * Standalone, advisory pre-send review for a draft that is not yet bound to a
 * campaign. The server response is decoded at runtime because an HTTP 200 is
 * not evidence that all three checks completed.
 */

import {
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { api } from "../../lib/api-client";
import "../../styles-postwave-ai-presend.css";

const EXPECTED_COMPONENTS = ["eq_score", "voice_drift", "placement"] as const;

type PresendComponentName = (typeof EXPECTED_COMPONENTS)[number];
type PresendComponentStatus =
  | "ok"
  | "warn"
  | "critical"
  | "error"
  | "skipped"
  | "unknown";
type PresendVerdict = "ok" | "warn" | "critical" | "incomplete";
type PresentationState = "pass" | "warn" | "critical" | "incomplete";

interface DecodedPresendComponent {
  error?: string;
  message?: string;
  name: PresendComponentName;
  received: boolean;
  score?: number;
  status: PresendComponentStatus;
}

export interface DecodedPresendVerdict {
  complete: boolean;
  components: DecodedPresendComponent[];
  computedAt: string;
  summary: string;
  verdict: PresendVerdict;
}

export type PresendVerdictDecodeResult =
  | { ok: true; value: DecodedPresendVerdict }
  | { ok: false; reason: string };

interface ResultSnapshot {
  bodyLength: number;
  inputKey: string;
  result: DecodedPresendVerdict;
  sender: string;
  subject: string;
}

interface Presentation {
  label: string;
  state: PresentationState;
  summary: string;
}

interface Props {
  canMutate: boolean;
}

const STATUS_VALUES = new Set(["ok", "warn", "critical", "error", "skipped"]);
const VERDICT_VALUES = new Set(["ok", "warn", "critical", "incomplete"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(
  value: Record<string, unknown>,
  key: "message" | "error",
): string | null | undefined {
  if (!(key in value)) return undefined;
  const candidate = value[key];
  if (typeof candidate !== "string") return null;
  return candidate.trim() || undefined;
}

function isExpectedComponentName(value: string): value is PresendComponentName {
  return EXPECTED_COMPONENTS.some((name) => name === value);
}

function validScore(name: PresendComponentName, score: number): boolean {
  if (!Number.isFinite(score)) return false;
  if (name === "placement") return score >= 0 && score <= 1;
  return score >= 0 && score <= 100;
}

/**
 * Decode both the preferred completeness contract
 * `{ verdict, complete, summary, components, computed_at }` and the legacy
 * transition where `complete` was absent. Completeness is always re-derived
 * from the exact component set so a contradictory server response fails
 * closed instead of producing a green verdict.
 */
export function decodePresendVerdictResponse(
  raw: unknown,
): PresendVerdictDecodeResult {
  if (!isRecord(raw)) {
    return { ok: false, reason: "response is not an object" };
  }

  if (typeof raw.verdict !== "string" || !VERDICT_VALUES.has(raw.verdict)) {
    return { ok: false, reason: "verdict is missing or unsupported" };
  }
  const verdict = raw.verdict as PresendVerdict;

  if (typeof raw.summary !== "string" || !raw.summary.trim()) {
    return { ok: false, reason: "summary is missing" };
  }
  if (raw.summary.length > 4_000) {
    return { ok: false, reason: "summary is unexpectedly large" };
  }

  if (typeof raw.computed_at !== "string") {
    return { ok: false, reason: "computed_at is missing" };
  }
  const computedTime = Date.parse(raw.computed_at);
  if (!Number.isFinite(computedTime)) {
    return { ok: false, reason: "computed_at is invalid" };
  }

  if ("complete" in raw && typeof raw.complete !== "boolean") {
    return { ok: false, reason: "complete must be a boolean" };
  }
  if (!Array.isArray(raw.components)) {
    return { ok: false, reason: "components is missing" };
  }

  const decoded = new Map<PresendComponentName, DecodedPresendComponent>();
  let contractMismatch = false;

  for (const candidate of raw.components) {
    if (!isRecord(candidate) || typeof candidate.name !== "string") {
      return { ok: false, reason: "a component is malformed" };
    }
    if (!isExpectedComponentName(candidate.name)) {
      contractMismatch = true;
      continue;
    }
    if (decoded.has(candidate.name)) {
      contractMismatch = true;
      continue;
    }
    if (typeof candidate.status !== "string") {
      return { ok: false, reason: `${candidate.name} status is malformed` };
    }

    const message = optionalString(candidate, "message");
    const error = optionalString(candidate, "error");
    if (message === null || error === null) {
      return {
        ok: false,
        reason: `${candidate.name} detail is malformed`,
      };
    }
    if ((message?.length ?? 0) > 4_000 || (error?.length ?? 0) > 4_000) {
      return {
        ok: false,
        reason: `${candidate.name} detail is unexpectedly large`,
      };
    }

    let score: number | undefined;
    if ("score" in candidate) {
      if (
        typeof candidate.score !== "number" ||
        !validScore(candidate.name, candidate.score)
      ) {
        return { ok: false, reason: `${candidate.name} score is invalid` };
      }
      score = candidate.score;
    }

    const status = STATUS_VALUES.has(candidate.status)
      ? (candidate.status as Exclude<PresendComponentStatus, "unknown">)
      : "unknown";
    if (status === "unknown") contractMismatch = true;
    const completedStatus = ["ok", "warn", "critical"].includes(status);
    if (completedStatus && score === undefined) {
      return {
        ok: false,
        reason: `${candidate.name} completed without a score`,
      };
    }
    if (["error", "skipped"].includes(status) && score !== undefined) {
      return {
        ok: false,
        reason: `${candidate.name} unavailable result included a score`,
      };
    }

    decoded.set(candidate.name, {
      error,
      message,
      name: candidate.name,
      received: true,
      score,
      status,
    });
  }

  const components = EXPECTED_COMPONENTS.map((name) => {
    const component = decoded.get(name);
    if (component) return component;
    contractMismatch = true;
    return {
      name,
      received: false,
      status: "unknown" as const,
      message: "No result was returned for this check.",
    };
  });

  const allChecksCompleted = components.every((component) =>
    ["ok", "warn", "critical"].includes(component.status),
  );
  const reportedComplete =
    typeof raw.complete === "boolean" ? raw.complete : allChecksCompleted;
  const complete =
    reportedComplete &&
    allChecksCompleted &&
    !contractMismatch &&
    verdict !== "incomplete";

  return {
    ok: true,
    value: {
      complete,
      components,
      computedAt: new Date(computedTime).toISOString(),
      summary: raw.summary.trim(),
      verdict,
    },
  };
}

function presentationFor(result: DecodedPresendVerdict): Presentation {
  const hasCritical =
    result.verdict === "critical" ||
    result.components.some((component) => component.status === "critical");
  const hasWarning =
    result.verdict === "warn" ||
    result.components.some((component) => component.status === "warn");

  if (hasCritical) {
    return {
      label: "Critical issues",
      state: "critical",
      summary: result.complete
        ? "At least one advisory check found a critical issue. Review the details before moving this draft forward."
        : "Critical issues were found, and one or more checks did not complete. Treat this draft as unverified.",
    };
  }
  if (!result.complete) {
    return {
      label: "Incomplete review",
      state: "incomplete",
      summary:
        "One or more advisory checks were unavailable or returned an unknown result. Run the review again before relying on it.",
    };
  }
  if (hasWarning) {
    return {
      label: "Review suggested",
      state: "warn",
      summary:
        "At least one advisory check found something to review before moving this draft forward.",
    };
  }
  return {
    label: "Checks completed",
    state: "pass",
    summary: "All three advisory checks completed without warnings.",
  };
}

function formatCheckedAt(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function inputKey(subject: string, sender: string, body: string): string {
  return JSON.stringify([subject.trim(), sender.trim().toLowerCase(), body]);
}

function isValidSender(value: string): boolean {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value.trim());
}

function clipped(value: string, maximum = 96): string {
  const normalized = value.trim();
  return normalized.length > maximum
    ? `${normalized.slice(0, maximum - 1)}…`
    : normalized;
}

function userFacingRequestError(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "The pre-send check was cancelled. Your draft was kept.";
  }
  return "The pre-send check couldn't be completed. Your draft was kept; try again.";
}

export function PresendCheckPanel({ canMutate }: Props): ReactElement {
  const id = useId();
  const titleId = `${id}-presend-title`;
  const subjectId = `${id}-presend-subject`;
  const senderId = `${id}-presend-sender`;
  const bodyId = `${id}-presend-body`;
  const subjectHintId = `${subjectId}-hint`;
  const senderHintId = `${senderId}-hint`;
  const senderErrorId = `${senderId}-error`;
  const bodyHintId = `${bodyId}-hint`;
  const submitHintId = `${id}-presend-submit-hint`;

  const [subject, setSubject] = useState("");
  const [sender, setSender] = useState("");
  const [body, setBody] = useState("");
  const [result, setResult] = useState<ResultSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const requestTokenRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestTokenRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (canMutate) return;
    // A role downgrade invalidates any in-flight client receipt. The server
    // remains the authorization boundary; this prevents a late response from
    // making a viewer surface look current or actionable.
    requestTokenRef.current += 1;
    setLoading(false);
    setOperationError(null);
  }, [canMutate]);

  const normalizedSubject = subject.trim();
  const normalizedSender = sender.trim();
  const hasValidSender = isValidSender(normalizedSender);
  const validDraft =
    normalizedSubject.length > 0 && hasValidSender && body.trim().length > 0;
  const currentInputKey = inputKey(subject, sender, body);
  const resultIsCurrent =
    result !== null &&
    result.inputKey === currentInputKey &&
    !loading &&
    operationError === null;

  function invalidatePendingRequest(): void {
    requestTokenRef.current += 1;
    setLoading(false);
    setOperationError(null);
  }

  function changeSubject(event: ChangeEvent<HTMLInputElement>): void {
    invalidatePendingRequest();
    setSubject(event.target.value);
  }

  function changeSender(event: ChangeEvent<HTMLInputElement>): void {
    invalidatePendingRequest();
    setSender(event.target.value);
  }

  function changeBody(event: ChangeEvent<HTMLTextAreaElement>): void {
    invalidatePendingRequest();
    setBody(event.target.value);
  }

  async function run(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canMutate || !validDraft || loading) return;

    const submittedSubject = normalizedSubject;
    const submittedSender = normalizedSender;
    const submittedBody = body;
    const submittedInputKey = inputKey(
      submittedSubject,
      submittedSender,
      submittedBody,
    );
    const token = requestTokenRef.current + 1;
    requestTokenRef.current = token;
    setLoading(true);
    setOperationError(null);

    try {
      const response = await api.presendVerdict({
        subject: submittedSubject,
        from: submittedSender,
        html: submittedBody,
        text: submittedBody,
      });
      if (!mountedRef.current || requestTokenRef.current !== token) return;

      if (response.error) {
        setOperationError(userFacingRequestError(response.error));
        return;
      }

      const decoded = decodePresendVerdictResponse(response.data);
      if (!decoded.ok) {
        setOperationError(
          "The pre-send service returned an incomplete or invalid response. No current verdict is available.",
        );
        return;
      }

      setResult({
        bodyLength: submittedBody.length,
        inputKey: submittedInputKey,
        result: decoded.value,
        sender: submittedSender,
        subject: submittedSubject,
      });
    } catch (error) {
      if (!mountedRef.current || requestTokenRef.current !== token) return;
      setOperationError(userFacingRequestError(error));
    } finally {
      if (mountedRef.current && requestTokenRef.current === token) {
        setLoading(false);
      }
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    void run(event);
  }

  let operationStatus = !canMutate
    ? "View-only access. Ask a workspace editor or admin to run a new pre-send review."
    : "Add a subject, sender email, and body to run the advisory review.";
  if (canMutate && loading) {
    operationStatus = "Running three advisory checks on the current draft.";
  } else if (canMutate && operationError) {
    operationStatus = result
      ? "The latest review failed. The previous result is not current."
      : "The pre-send review failed. Your draft is unchanged.";
  } else if (canMutate && result && !resultIsCurrent) {
    operationStatus =
      "Draft changed. The previous result is retained for comparison but is not current.";
  } else if (canMutate && result) {
    operationStatus = `${presentationFor(result.result).label}. Result is current for this draft.`;
  } else if (canMutate && validDraft) {
    operationStatus = "Draft is ready for an advisory pre-send review.";
  }

  return (
    <section
      aria-busy={loading}
      aria-labelledby={titleId}
      className="card presend-check"
    >
      <header className="presend-check__header">
        <div className="presend-check__heading-copy">
          <span className="presend-check__eyebrow">Draft health</span>
          <h2 className="section-title presend-check__title" id={titleId}>
            Pre-send check
          </h2>
          <p className="presend-check__intro">
            Review content quality, voice alignment, and predicted placement
            before you move a draft forward.
          </p>
        </div>
        <span className="presend-check__advisory-badge">Advisory only</span>
      </header>

      <div className="presend-check__boundary">
        <span aria-hidden="true" className="presend-check__boundary-icon">
          i
        </span>
        <p>
          This review does not authorize a send. Verify sender identity,
          consent, suppressions, approvals, links, and final campaign settings
          in the campaign workflow.
        </p>
      </div>

      {!canMutate ? (
        <div className="notice presend-check__permission" role="status">
          Your role can prepare and review draft values here, but only editors
          and admins can run a new advisory check.
        </div>
      ) : null}

      <form className="presend-check__form" noValidate onSubmit={submit}>
        <div className="presend-check__field-grid">
          <div className="presend-check__field">
            <label className="presend-check__label" htmlFor={subjectId}>
              Subject
              <span className="presend-check__required">Required</span>
            </label>
            <input
              aria-describedby={subjectHintId}
              autoComplete="off"
              className="presend-check__input"
              id={subjectId}
              name="presend-subject"
              onChange={changeSubject}
              placeholder="Your campaign subject line"
              required
              type="text"
              value={subject}
            />
            <span className="presend-check__hint" id={subjectHintId}>
              Use the exact subject you plan to review.
            </span>
          </div>

          <div className="presend-check__field">
            <label className="presend-check__label" htmlFor={senderId}>
              Sender email
              <span className="presend-check__required">Required</span>
            </label>
            <input
              aria-describedby={`${senderHintId}${
                normalizedSender && !hasValidSender ? ` ${senderErrorId}` : ""
              }`}
              aria-invalid={
                normalizedSender && !hasValidSender ? "true" : undefined
              }
              autoCapitalize="none"
              autoComplete="email"
              className="presend-check__input"
              id={senderId}
              inputMode="email"
              name="presend-sender"
              onChange={changeSender}
              placeholder="hello@yourdomain.com"
              required
              spellCheck={false}
              type="email"
              value={sender}
            />
            <span className="presend-check__hint" id={senderHintId}>
              Enter the email address shown in the From field.
            </span>
            {normalizedSender && !hasValidSender ? (
              <span className="presend-check__field-error" id={senderErrorId}>
                Enter a complete sender email address.
              </span>
            ) : null}
          </div>
        </div>

        <div className="presend-check__field">
          <label className="presend-check__label" htmlFor={bodyId}>
            Message body
            <span className="presend-check__required">Required</span>
          </label>
          <textarea
            aria-describedby={bodyHintId}
            className="presend-check__textarea"
            id={bodyId}
            name="presend-body"
            onChange={changeBody}
            placeholder="Paste the full HTML or plain-text campaign body."
            required
            rows={7}
            value={body}
          />
          <span className="presend-check__hint" id={bodyHintId}>
            Paste the complete draft for the most representative result.
          </span>
        </div>

        <div className="presend-check__actions">
          <button
            aria-describedby={submitHintId}
            className="btn btn-primary presend-check__submit"
            disabled={!canMutate || !validDraft || loading}
            type="submit"
          >
            {loading ? (
              <span aria-hidden="true" className="presend-check__spinner" />
            ) : null}
            {loading ? "Running checks…" : "Run pre-send check"}
          </button>
          <span className="presend-check__submit-hint" id={submitHintId}>
            {!canMutate
              ? "Ask a workspace editor or admin to run this review."
              : validDraft
                ? "Results apply only to the current draft values."
                : "Complete all three fields with a valid sender email."}
          </span>
        </div>
      </form>

      <p
        aria-atomic="true"
        aria-live="polite"
        className="presend-check__operation-status"
        role="status"
      >
        {operationStatus}
      </p>

      {operationError ? (
        <div className="presend-check__error" role="alert">
          <strong>Review unavailable</strong>
          <span>{operationError}</span>
        </div>
      ) : null}

      {loading && !result ? <LoadingState /> : null}
      {!loading && !operationError && !result ? <EmptyState /> : null}
      {result ? (
        <ResultView
          current={resultIsCurrent}
          loading={loading}
          snapshot={result}
        />
      ) : null}
    </section>
  );
}

function EmptyState(): ReactElement {
  return (
    <div className="presend-check__empty">
      <span aria-hidden="true" className="presend-check__empty-mark">
        3
      </span>
      <div>
        <strong>No advisory result yet</strong>
        <p>
          Complete the draft above to review all three independent signals in
          one place.
        </p>
      </div>
    </div>
  );
}

function LoadingState(): ReactElement {
  return (
    <div className="presend-check__loading-panel">
      <span aria-hidden="true" className="presend-check__spinner" />
      <div>
        <strong>Reviewing this draft</strong>
        <p>Content, voice, and placement checks may finish independently.</p>
      </div>
    </div>
  );
}

function ResultView({
  current,
  loading,
  snapshot,
}: {
  current: boolean;
  loading: boolean;
  snapshot: ResultSnapshot;
}): ReactElement {
  const presentation = presentationFor(snapshot.result);
  const stale = !current;
  const resultTitle = stale
    ? `Previous result — was ${presentation.label.toLowerCase()}`
    : presentation.label;
  const allowPositiveComponents = snapshot.result.complete && !stale;

  return (
    <article
      className={`presend-check__result is-${presentation.state}${
        stale ? " is-stale" : ""
      }`}
    >
      <header className="presend-check__result-header">
        <span aria-hidden="true" className="presend-check__result-signal" />
        <div className="presend-check__result-heading">
          <span className="presend-check__result-kicker">
            {stale ? "Not current" : "Current draft"}
          </span>
          <h3>{resultTitle}</h3>
        </div>
        <span className="presend-check__result-badge">
          {stale
            ? loading
              ? "Rechecking"
              : "Draft changed"
            : presentation.state === "pass"
              ? "Complete"
              : presentation.state}
        </span>
      </header>

      <p className="presend-check__result-summary">
        {stale
          ? "This result is retained for comparison only. It does not describe the draft currently in the fields above."
          : presentation.summary}
      </p>

      <dl className="presend-check__receipt">
        <div>
          <dt>Checked</dt>
          <dd>
            <time dateTime={snapshot.result.computedAt}>
              {formatCheckedAt(snapshot.result.computedAt)}
            </time>
          </dd>
        </div>
        <div>
          <dt>Freshness</dt>
          <dd>{current ? "Current for this draft" : "Previous draft only"}</dd>
        </div>
        <div>
          <dt>Coverage</dt>
          <dd>
            {snapshot.result.complete
              ? "3 of 3 checks completed"
              : "Incomplete — do not infer a pass"}
          </dd>
        </div>
      </dl>

      <p className="presend-check__snapshot">
        Based on <strong>{clipped(snapshot.subject)}</strong> from{" "}
        <strong>{clipped(snapshot.sender)}</strong> ·{" "}
        {snapshot.bodyLength.toLocaleString()} body characters
      </p>

      <ul
        aria-label="Pre-send check results"
        className="presend-check__components"
      >
        {snapshot.result.components.map((component) => (
          <ComponentCard
            allowPositive={allowPositiveComponents}
            component={component}
            key={component.name}
          />
        ))}
      </ul>

      <footer className="presend-check__result-footer">
        Advisory evidence only. Final send readiness must be verified in the
        campaign workflow.
      </footer>
    </article>
  );
}

function componentLabel(name: PresendComponentName): string {
  switch (name) {
    case "eq_score":
      return "Content quality";
    case "voice_drift":
      return "Voice alignment";
    case "placement":
      return "Primary placement";
  }
}

function componentStatusLabel(status: PresendComponentStatus): string {
  switch (status) {
    case "ok":
      return "Completed";
    case "warn":
      return "Needs review";
    case "critical":
      return "Critical";
    case "error":
      return "Unavailable";
    case "skipped":
      return "Not run";
    case "unknown":
      return "Unknown";
  }
}

function formatComponentScore(component: DecodedPresendComponent): string {
  const score = component.score;
  if (score === undefined) return "—";
  if (component.name === "placement") {
    return `${(score * 100).toFixed(0)}%`;
  }
  return `${score.toFixed(0)} / 100`;
}

function ComponentCard({
  allowPositive,
  component,
}: {
  allowPositive: boolean;
  component: DecodedPresendComponent;
}): ReactElement {
  const visualState =
    component.status === "ok" && !allowPositive ? "neutral" : component.status;
  const detail =
    component.error ||
    component.message ||
    (component.received
      ? "No additional guidance was returned."
      : "This expected check was missing from the response.");

  return (
    <li className={`presend-check__component is-${visualState}`}>
      <div className="presend-check__component-heading">
        <span aria-hidden="true" className="presend-check__component-dot" />
        <h4>{componentLabel(component.name)}</h4>
        <span className="presend-check__component-status">
          {componentStatusLabel(component.status)}
        </span>
      </div>
      <div className="presend-check__component-score tabular">
        {formatComponentScore(component)}
      </div>
      <p>{detail}</p>
    </li>
  );
}
