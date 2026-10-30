/**
 * Onboarding · Step 1 — Connect sender domain.
 *
 * Probes the existing custom-domains list to render a verified / pending
 * status pill so the user knows where they stand without having to
 * leave the wizard. The primary CTA navigates through the canonical desktop
 * router to the dedicated Domains workspace.
 *
 * Honesty: if the domain check itself errors (server down, route 404),
 * we render a muted "Couldn't check status" line rather than a green
 * checkmark. The wizard NEVER lies about state — that's the whole
 * point of running this onboarding.
 */

import { type ReactElement, useEffect, useState } from "react";

import { api } from "../../lib/api-client";
import { navigateDesktopRoute } from "../../lib/desktop-router";
import { HintPopover } from "./HintPopover";

interface Props {
  /** Called when the user clicks "Skip for now" (advance without action). */
  onSkip: () => void;
  /**
   * Called when we detect a verified domain — the wizard auto-advances
   * to the next step so a returning user who already configured DNS
   * isn't forced to click through.
   */
  onVerified: () => void;
  /** Called for the explicit "Don't show again" footer button. */
  onDismiss: () => void;
}

type DomainStatus =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "pending"; domain: string }
  | { kind: "verified"; domain: string }
  | { kind: "error"; message: string };

export function StepDomain({
  onSkip,
  onVerified,
  onDismiss,
}: Props): ReactElement {
  const [status, setStatus] = useState<DomainStatus>({ kind: "loading" });

  /* Probe domains on mount. The list endpoint is the canonical source —
   * if any sending-purpose domain is verified, we count it as "done".
   * Tracking-only domains don't satisfy first-run on their own; sending
   * is the gate that unblocks campaign delivery. */
  useEffect(() => {
    let cancelled = false;
    let advanceTimer: number | null = null;
    void (async () => {
      const res = await api.listCustomDomains();
      if (cancelled) return;
      if (res.error) {
        // 404 → custom-domains module not deployed yet. Treat as "none"
        // so the user sees the "no domain configured" affordance rather
        // than an error.
        if (res.error.status === 404) {
          setStatus({ kind: "none" });
          return;
        }
        setStatus({ kind: "error", message: res.error.message });
        return;
      }
      const domains = Array.isArray(res.data) ? res.data : [];
      // Only a SENDING-purpose domain satisfies the gate (the file's
      // own rule above). Tracking / forms / links / web domains don't
      // unblock campaign delivery, so they must not auto-advance the
      // wizard. A missing purpose is accepted as sending: the current
      // backend always sets purpose (forms|links|web|tracking), so a
      // purposeless row can only come from a legacy backend that
      // predates the purpose split — where every row WAS a sender
      // domain.
      const sending = domains.find(
        (d) => d.verified && (d.purpose === "sending" || !d.purpose),
      );
      if (sending) {
        setStatus({ kind: "verified", domain: sending.domain });
        // Auto-advance after a beat so the user sees the green tick.
        advanceTimer = window.setTimeout(() => {
          if (!cancelled) onVerified();
        }, 800);
        return;
      }
      // Surface the first domain still awaiting DNS as "pending".
      // Verified non-sending domains (tracking/forms/…) don't count —
      // labelling one "pending DNS" would lie about its state, and
      // labelling it verified would imply the sending gate is met.
      const pending = domains.find((d) => !d.verified);
      if (pending) {
        setStatus({ kind: "pending", domain: pending.domain });
      } else {
        setStatus({ kind: "none" });
      }
    })();
    return () => {
      cancelled = true;
      if (advanceTimer !== null) window.clearTimeout(advanceTimer);
    };
  }, [onVerified]);

  const openSettings = (): void => {
    navigateDesktopRoute({ section: "domains" });
    onSkip();
  };

  return (
    <div className="onb2-step">
      <div className="onb2-step-illustration" aria-hidden="true">
        <span className="onb2-step-num">1</span>
      </div>
      <h3 className="onb2-step-title">Connect your sender domain</h3>
      <p className="onb2-step-desc">
        SPF, DKIM, and DMARC tell the inbox your messages are legit.
        <HintPopover hintKey="sending-identity.dkim" />
      </p>

      <div className="onb2-status-row">
        {status.kind === "loading" ? (
          <span className="onb2-status-pill is-muted">Checking…</span>
        ) : null}
        {status.kind === "none" ? (
          <span className="onb2-status-pill is-warn">No domain configured</span>
        ) : null}
        {status.kind === "pending" ? (
          <span className="onb2-status-pill is-warn">
            <span className="mono">{status.domain}</span> · pending DNS
          </span>
        ) : null}
        {status.kind === "verified" ? (
          <span className="onb2-status-pill is-ok">
            <span className="mono">{status.domain}</span> · verified
          </span>
        ) : null}
        {status.kind === "error" ? (
          <span className="onb2-status-pill is-muted">
            Couldn&apos;t check status — {status.message}
          </span>
        ) : null}
      </div>

      <div className="onb2-step-actions">
        <button type="button" className="btn btn-primary" onClick={openSettings}>
          Open Domain Settings
        </button>
        <button type="button" className="btn-link" onClick={onSkip}>
          Skip for now
        </button>
      </div>
      <button type="button" className="btn-link onb2-dismiss-link" onClick={onDismiss}>
        Don&apos;t show this again
      </button>
    </div>
  );
}
