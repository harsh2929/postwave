/**
 * InboxRealityBanner — pre-send placement predictor banner. Shown above
 * the "Send now" button in the campaign send-confirmation flow. Calls
 * POST /api/v1/predict (proxied to the deliverability service) and
 * renders three stacked progress bars for Primary / Promotions / Spam.
 *
 * When predicted-Primary < 70%, two recovery affordances surface:
 *   - "Why?" expands a one-paragraph muted explanation derived from
 *     the `risk` breakdown the predictor returns.
 *   - "Improve subject" opens an inline subject-line generator
 *     (handed off to the parent via `onImproveSubject`) so the user
 *     can pick a healthier subject without leaving the modal.
 *
 * Honest-fallback policy:
 *   - 404 / 405 / 503 → muted "Inbox Reality unavailable" message;
 *     the Send button stays enabled so the user is never blocked.
 *   - Any other error → muted message with the error text.
 */
import { type ReactElement, useEffect, useId, useState } from "react";

import {
  apiInlineAi,
  type InboxRealityPrediction,
  type InboxRealityPredictInput,
} from "../lib/api-client";

interface Props {
  subject: string;
  bodyHtml: string;
  /** Called when the user clicks "Send now". The banner does not
   *  block sending — even on error / low-primary the parent decides. */
  onContinue: () => void;
  /** Called when the user clicks "Cancel". */
  onCancel: () => void;
  /** Called when the user clicks "Improve subject" in the low-primary
   *  branch. Optional — when omitted, the Improve button is hidden. */
  onImproveSubject?: () => void;
  /** Whether the parent is mid-send (disables both buttons). */
  busy?: boolean;
  /** Continue-button label. Defaults to "Send now". */
  continueLabel?: string;
  /** G7: parent-supplied hard disable on the Continue button. Used by
   *  AudiencePreviewPanel to block Send when the audience exceeds
   *  today's warmup cap. The Cancel button stays enabled. */
  continueDisabled?: boolean;
  /** Explanation announced and shown when Continue is unavailable. */
  continueDisabledReason?: string;
}

/** Clamp a 0..1 number into 0..100 with one decimal of precision. */
function pct(n: number | undefined | null): number {
  if (n == null || Number.isNaN(n)) return 0;
  const v = n > 1 ? n : n * 100;
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10));
}

export function InboxRealityBanner({
  subject,
  bodyHtml,
  onContinue,
  onCancel,
  onImproveSubject,
  busy,
  continueLabel,
  continueDisabled,
  continueDisabledReason,
}: Props): ReactElement {
  const [loading, setLoading] = useState(true);
  const [pred, setPred] = useState<InboxRealityPrediction | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [whyOpen, setWhyOpen] = useState<boolean>(false);
  const continueReasonId = useId();
  const continueUnavailableReason = busy
    ? "Sending is already in progress."
    : continueDisabled
      ? (continueDisabledReason ?? "This send is not available yet.")
      : null;
  // D10-deliverability#6: predictInboxPlacement's honesty gate refuses to
  // fire without real reputation + engagement history, so a banner that
  // passed only {subject, bodyHtml} always tripped it and rendered a
  // permanent "not enough sending history" — even for tenants with months
  // of data. Fetch the tenant's real sender-reputation once on mount and
  // thread the best sending domain's score + delivery rates through as
  // reputation + history so established senders get a genuine prediction.
  // When no domain has recent sends we pass nothing and the gate honestly
  // shows "not enough data" (audit §4.2 — never fabricate inputs).
  const [repInput, setRepInput] = useState<Pick<
    InboxRealityPredictInput,
    "reputation" | "history"
  > | null>(null);
  const [repReady, setRepReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rep = await apiInlineAi.getSenderReputation();
      if (cancelled) return;
      const domains = rep.data?.domains ?? [];
      // Pick the domain with the most recent sending volume — it best
      // represents the reputation the next send inherits. Domains with
      // zero recent sends carry no honest engagement history, so they
      // don't qualify; if none qualify we leave repInput null and the
      // predictor gate falls back to the honest "not enough data" note.
      const best = domains
        .filter((d) => d.sends_last_7d > 0)
        .sort((a, b) => b.sends_last_7d - a.sends_last_7d)[0];
      if (best) {
        setRepInput({
          reputation: { domain: best.domain, sender_score: best.score },
          history: {
            // sender-reputation reports bounce/complaint as percentages
            // (0..100); the predictor expects fractions (0..1).
            BounceRate: best.bounce_rate / 100,
            ComplaintRate: best.complaint_rate / 100,
            SendVolume: best.sends_last_7d,
          },
        });
      }
      setRepReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Hold the loading spinner until the one-shot reputation fetch settles
    // so we never fire predict with empty inputs and then re-fire.
    if (!repReady) return;
    let cancelled = false;
    setLoading(true);
    setPred(null);
    setErrMsg(null);
    void (async () => {
      const res = await apiInlineAi.predictInboxPlacement({
        subject,
        bodyHtml,
        ...(repInput ?? {}),
      });
      if (cancelled) return;
      setLoading(false);
      if (res.error) {
        const status = res.error.status;
        if (res.error.code === "insufficient_data") {
          // The client refuses to fabricate reputation/history inputs
          // (audit §4.2) — without real tenant data there is no honest
          // prediction to show. Render the muted absence note; sending
          // stays unblocked.
          setErrMsg(
            "Not enough sending history yet for a placement prediction.",
          );
        } else if (
          status === 404 ||
          status === 405 ||
          status === 501 ||
          status === 503
        ) {
          setErrMsg(
            "Inbox Reality unavailable yet — predictor service not configured.",
          );
        } else {
          setErrMsg(`Inbox Reality unavailable: ${res.error.message}`);
        }
        return;
      }
      setPred(res.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [subject, bodyHtml, repReady, repInput]);

  const primary = pct(pred?.predicted?.primary);
  const promo = pct(pred?.predicted?.promotions);
  const spam = pct(pred?.predicted?.spam);
  const lowPrimary = pred != null && primary > 0 && primary < 70;

  const renderBars = (): ReactElement => (
    <div className="ir-bars" aria-hidden="true">
      <div className="ir-bar ir-bar-primary">
        <span className="ir-bar-fill" style={{ width: `${primary}%` }} />
        <span className="ir-bar-label">
          Primary <strong className="tabular">{primary}%</strong>
        </span>
      </div>
      <div className="ir-bar ir-bar-promo">
        <span className="ir-bar-fill" style={{ width: `${promo}%` }} />
        <span className="ir-bar-label">
          Promotions <strong className="tabular">{promo}%</strong>
        </span>
      </div>
      <div className="ir-bar ir-bar-spam">
        <span className="ir-bar-fill" style={{ width: `${spam}%` }} />
        <span className="ir-bar-label">
          Spam <strong className="tabular">{spam}%</strong>
        </span>
      </div>
    </div>
  );

  return (
    <div
      className="ir-banner"
      role="region"
      aria-label="Inbox Reality prediction"
    >
      <div className="ir-banner-header">
        <span className="ai-banner-icon" aria-hidden="true">
          ✦
        </span>
        <span className="ir-banner-title">
          {loading ? (
            "Inbox Reality is predicting placement…"
          ) : errMsg ? (
            "Inbox Reality"
          ) : (
            <>
              Inbox Reality predicts{" "}
              <strong className="tabular">{primary}%</strong> primary,{" "}
              <strong className="tabular">{promo}%</strong> promo,{" "}
              <strong className="tabular">{spam}%</strong> spam
            </>
          )}
        </span>
      </div>

      {loading ? (
        <div className="ir-bars" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="skel"
              style={{ height: 14, marginBottom: 6, borderRadius: 4 }}
            />
          ))}
        </div>
      ) : errMsg ? (
        <div className="muted" style={{ fontSize: 12 }}>
          {errMsg} — sending will proceed without a placement preview.
        </div>
      ) : (
        renderBars()
      )}

      {lowPrimary ? (
        <div className="ir-low-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setWhyOpen((v) => !v)}
            aria-expanded={whyOpen}
          >
            Why?
          </button>
          {onImproveSubject ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={onImproveSubject}
              disabled={busy}
            >
              Improve subject
            </button>
          ) : null}
        </div>
      ) : null}

      {whyOpen && pred ? (
        <div className="ir-why muted" style={{ fontSize: 12 }}>
          Primary placement is below 70%, which usually points to either subject
          / body content that triggers promo classifiers, or weaker historical
          engagement than top-tier senders. Inspect the full report for the
          per-component risk breakdown.
        </div>
      ) : null}

      {continueUnavailableReason ? (
        <p
          id={continueReasonId}
          className="muted"
          style={{ fontSize: 11, margin: 0, textAlign: "right" }}
        >
          {continueUnavailableReason}
        </p>
      ) : null}
      <div className="ir-actions">
        <button
          type="button"
          className="btn"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            if (continueUnavailableReason) return;
            onContinue();
          }}
          aria-disabled={continueUnavailableReason ? true : undefined}
          aria-describedby={
            continueUnavailableReason ? continueReasonId : undefined
          }
        >
          {busy ? "Sending…" : (continueLabel ?? "Send now")}
        </button>
      </div>
    </div>
  );
}
