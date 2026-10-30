/**
 * VoiceDriftBanner — pre-send voice-fidelity banner. Shown alongside
 * the InboxRealityBanner in the campaign send-confirmation modal.
 * Calls POST /api/v1/voice/drift (proxied to services/voice) and
 * renders a single 0..100 score with a severity badge.
 *
 *   ok       (>= 60): green badge "On brand". Continue without prompt.
 *   warn     (40..59): amber badge "Voice drift detected". Show the
 *            top 1-2 suggestion strings + a "Continue anyway" button.
 *   critical (< 40):  red badge "Strong voice drift". Same affordances.
 *
 * Honest-fallback policy mirrors InboxRealityBanner:
 *   - 404 / 405 / 503 → muted "Voice drift check unavailable" message;
 *     the banner does NOT block the send.
 *   - Any other error → muted message with the error text.
 *
 * The check is non-blocking on purpose — drift is an *advisory*
 * signal. The operator may have legitimate reasons to step outside
 * their usual voice (announcement, product launch, etc).
 */
import { type ReactElement, useEffect, useState } from "react";

import { api, type VoiceDriftResponse } from "../lib/api-client";

interface Props {
  bodyHtml: string;
  /** Optional voice-profile id. When omitted, the upstream uses the
   *  tenant's default active profile. */
  profileId?: string;
}

function severityClass(sev: VoiceDriftResponse["severity"]): {
  color: string;
  label: string;
} {
  switch (sev) {
    case "critical":
      return { color: "var(--pw-danger)", label: "Strong voice drift" };
    case "warn":
      return { color: "var(--pw-warning)", label: "Voice drift detected" };
    default:
      return { color: "var(--pw-success)", label: "On brand" };
  }
}

export function VoiceDriftBanner({ bodyHtml, profileId }: Props): ReactElement {
  const [loading, setLoading] = useState(true);
  const [resp, setResp] = useState<VoiceDriftResponse | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setResp(null);
    setErrMsg(null);
    void (async () => {
      const res = await api.voiceDriftCheck({ html: bodyHtml, profileId });
      if (cancelled) return;
      setLoading(false);
      if (res.error) {
        const status = res.error.status;
        if (
          status === 404 ||
          status === 405 ||
          status === 501 ||
          status === 503
        ) {
          setErrMsg(
            "Voice drift check unavailable — voice service not configured.",
          );
        } else {
          setErrMsg(res.error.message || "Voice drift check failed.");
        }
        return;
      }
      if (res.data) setResp(res.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [bodyHtml, profileId]);

  if (loading) {
    return (
      <div
        data-testid="voice-drift-banner-loading"
        className="muted"
        style={{ fontSize: 12, marginTop: 4, marginBottom: 4 }}
      >
        Checking voice fidelity…
      </div>
    );
  }
  if (errMsg) {
    return (
      <div
        data-testid="voice-drift-banner-error"
        className="muted"
        style={{ fontSize: 12, marginTop: 4, marginBottom: 4 }}
      >
        {errMsg}
      </div>
    );
  }
  if (!resp) return <></>;

  // GAP-2#10: the voice service returns a synthetic {score:100,
  // severity:"ok"} pass for tenants with no voice profile (drift.go
  // ErrNotFound path), carrying an "inactive" disclaimer suggestion
  // that the green "On brand" render otherwise hides behind the
  // !isOk "Why?" gate. Detect that response and render an honest
  // "inactive — build a profile" note instead of a fabricated pass.
  const isInactive =
    resp.severity === "ok" &&
    (resp.suggestions ?? []).some((s) =>
      /drift check is inactive|no voice profile/i.test(s),
    );
  if (isInactive) {
    return (
      <div
        data-testid="voice-drift-banner-inactive"
        className="muted"
        style={{ fontSize: 12, marginTop: 4, marginBottom: 4 }}
      >
        Voice drift check inactive — build a voice profile under Settings →
        Voice to enable brand-voice warnings.
      </div>
    );
  }

  const sev = severityClass(resp.severity);
  const isOk = resp.severity === "ok";

  return (
    <div
      data-testid="voice-drift-banner"
      data-severity={resp.severity}
      style={{
        border: `1px solid ${sev.color}`,
        borderRadius: 6,
        padding: 8,
        marginTop: 4,
        marginBottom: 4,
        fontSize: 13,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <strong style={{ color: sev.color }}>
          {sev.label} — {Math.round(resp.score)}/100
        </strong>
        {!isOk && (
          <button
            type="button"
            className="link-button"
            onClick={() => setDetailsOpen(!detailsOpen)}
          >
            {detailsOpen ? "Hide details" : "Why?"}
          </button>
        )}
      </div>
      {resp.reason && !isOk && (
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {resp.reason}
        </div>
      )}
      {detailsOpen && resp.suggestions && resp.suggestions.length > 0 && (
        <ul style={{ marginTop: 6, marginBottom: 0, paddingLeft: 18 }}>
          {resp.suggestions.slice(0, 3).map((s, i) => (
            <li key={i} style={{ fontSize: 12 }}>
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
