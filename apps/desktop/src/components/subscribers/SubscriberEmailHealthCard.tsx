import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { verificationApi } from "../../lib/api-client";
import type {
  EmailHealth,
  EmailHealthGrade,
  EmailHealthRecommendation,
} from "../../lib/api/verification";
import { fmtDate } from "../../lib/format-date";
import { parseEmailHealth } from "../deliverability/verification-response-contract";

type LoadState = "loading" | "ready" | "unavailable" | "error";

const GRADE_COPY: Record<
  EmailHealthGrade,
  { label: string; detail: string; badge: string }
> = {
  A: {
    label: "Recently validated",
    detail: "The mailbox was validated within the last 30 days.",
    badge: "badge success",
  },
  B: {
    label: "Positive activity",
    detail:
      "A recent first-party delivery, human-classified click, or human reply supports this address.",
    badge: "badge success",
  },
  C: {
    label: "Catch-all",
    detail: "The domain receives mail, but this exact mailbox is uncertain.",
    badge: "badge warning",
  },
  D: {
    label: "Negative activity",
    detail:
      "A hard, soft, or unclassified bounce in the last 30 days has not been superseded by newer first-party positive activity.",
    badge: "badge danger",
  },
  F: {
    label: "Invalid or blocked",
    detail:
      "An invalid, spam-trap, abuse, or do-not-mail result, a complaint, or an active consent/suppression stop applies.",
    badge: "badge danger",
  },
  U: {
    label: "Not enough evidence",
    detail:
      "Moosewave does not have a decisive current signal for this address.",
    badge: "badge",
  },
};

const RECOMMENDATION_COPY: Record<EmailHealthRecommendation, string> = {
  send: "Send",
  caution: "Review before sending",
  do_not_send: "Do not send",
  blocked: "Blocked from sending",
};

export function emailHealthReasonLabel(code: string): string {
  const known: Record<string, string> = {
    verification_valid_30d: "Validated in the last 30 days",
    verification_catch_all: "Catch-all mailbox",
    verification_invalid: "Verifier reported invalid",
    verification_spamtrap: "Spam-trap signal",
    verification_abuse: "Abuse-risk signal",
    verification_do_not_mail: "Verifier marked do not mail",
    verification_stale: "Validation is older than 30 days",
    no_decisive_evidence: "No decisive current signal",
    open_not_high_confidence: "Open activity alone is not conclusive",
    active_send_hard_stop: "Active consent or suppression stop",
    suppression_hard_bounce: "Active hard-bounce suppression",
    suppression_soft_bounce: "Active soft-bounce suppression",
    suppression_soft_bounce_threshold: "Active soft-bounce suppression",
    consent_unsubscribed: "Currently unsubscribed",
    consent_not_proven: "Consent not currently proven",
    address_suppressed: "Address currently suppressed",
    health_evidence_unavailable: "Health evidence is temporarily unavailable",
  };
  return (
    known[code] ??
    code
      .replace(/^(?:event|suppression|consent|evidence)_/u, "")
      .replace(/[_-]+/gu, " ")
      .replace(/^./u, (first) => first.toUpperCase())
  );
}

export function SubscriberEmailHealthCard({
  email,
}: {
  email: string;
}): ReactElement | null {
  const [state, setState] = useState<LoadState>("loading");
  const [health, setHealth] = useState<EmailHealth | null>(null);
  const [reload, setReload] = useState(0);
  const requestRef = useRef(0);

  const retry = useCallback(() => setReload((value) => value + 1), []);

  useEffect(() => {
    const normalized = email.trim().toLowerCase();
    if (!normalized) {
      setState("unavailable");
      setHealth(null);
      return;
    }
    const requestId = ++requestRef.current;
    const controller = new AbortController();
    setState("loading");
    void (async () => {
      try {
        const response = await verificationApi.health(
          normalized,
          controller.signal,
        );
        if (controller.signal.aborted || requestId !== requestRef.current)
          return;
        if (response.error) {
          setHealth(null);
          setState(
            [404, 405, 501].includes(response.error.status ?? 0)
              ? "unavailable"
              : "error",
          );
          return;
        }
        const parsed = parseEmailHealth(response.data, normalized);
        if (!parsed) {
          setHealth(null);
          setState("error");
          return;
        }
        setHealth(parsed);
        setState("ready");
      } catch {
        if (!controller.signal.aborted && requestId === requestRef.current) {
          setHealth(null);
          setState("error");
        }
      }
    })();
    return () => {
      requestRef.current += 1;
      controller.abort();
    };
  }, [email, reload]);

  // Old deployments do not expose this read model. Absence should not turn a
  // subscriber profile into an error state.
  if (state === "unavailable") return null;

  return (
    <section
      aria-labelledby="subscriber-email-health-title"
      aria-busy={state === "loading"}
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 8,
        padding: 12,
        margin: "8px 0 10px",
        background: "var(--pw-bg-elev)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <strong id="subscriber-email-health-title" style={{ fontSize: 13 }}>
          Email health
        </strong>
        {health ? (
          <>
            <span
              className={GRADE_COPY[health.grade].badge}
              aria-label={`Email health grade ${health.grade}`}
            >
              Grade {health.grade}
            </span>
            <span className="muted" style={{ fontSize: 12 }}>
              {GRADE_COPY[health.grade].label}
            </span>
            <span style={{ flex: 1 }} />
            <strong style={{ fontSize: 12 }}>
              {health.evidence_complete
                ? RECOMMENDATION_COPY[health.recommendation]
                : "Sending paused — evidence unavailable"}
            </strong>
          </>
        ) : null}
      </div>

      {state === "loading" ? (
        <p className="muted" role="status" style={{ margin: "8px 0 0" }}>
          Resolving validation, activity, consent, and suppression evidence…
        </p>
      ) : state === "error" ? (
        <div role="alert" style={{ marginTop: 8, fontSize: 12 }}>
          Email health could not be verified. No send recommendation is shown.
          <button
            type="button"
            className="btn btn-xs btn-ghost"
            onClick={retry}
            style={{ marginLeft: 8 }}
          >
            Retry
          </button>
        </div>
      ) : health ? (
        <>
          <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
            {health.evidence_complete
              ? GRADE_COPY[health.grade].detail
              : "Consent and suppression evidence could not be loaded, so this address remains ineligible until health can be recomputed."}
            {health.hard_stop
              ? " An active hard stop takes precedence over every positive signal."
              : ""}
          </p>
          {health.reason_codes.length > 0 ? (
            <ul
              aria-label="Email health reasons"
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                listStyle: "none",
                padding: 0,
                margin: "8px 0 0",
              }}
            >
              {health.reason_codes.map((reason) => (
                <li key={reason} className="badge">
                  {emailHealthReasonLabel(reason)}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="muted" style={{ margin: "8px 0 0", fontSize: 10 }}>
            {health.grade === "A" &&
            health.status === "valid" &&
            health.checked_at
              ? `Validated ${fmtDate(health.checked_at)} · `
              : ""}
            {health.evidence_at
              ? `Latest evidence ${fmtDate(health.evidence_at)} · `
              : ""}
            Model {health.model_version} · computed{" "}
            {fmtDate(health.computed_at)}
          </p>
        </>
      ) : null}
    </section>
  );
}
