/**
 * Onboarding · Step 3 — Create your first campaign.
 *
 * Auto-detects whether the tenant already has a campaign on mount and
 * if so skips straight to the success step (a returning user who
 * already drafted something shouldn't be nagged to "create your first"
 * again). Otherwise renders a single primary CTA that hands off to the
 * Campaigns page; the user clicks New Campaign there themselves. We
 * deliberately don't try to programmatically open the new-campaign
 * modal from here — Campaigns.tsx is owned by another sibling agent
 * this round, and a future "?new=1" query-param hand-off is the right
 * fix for v2.
 */

import { type ReactElement, useEffect, useState } from "react";

import { api } from "../../lib/api-client";
import { navigateDesktopRoute } from "../../lib/desktop-router";

interface Props {
  /**
   * Called when we detect the user already has campaigns — the wizard
   * advances straight to the Done step so we don't waste their time.
   */
  onAlreadyHasCampaigns: () => void;
  onSkip: () => void;
  onDismiss: () => void;
}

export function StepCampaign({
  onAlreadyHasCampaigns,
  onSkip,
  onDismiss,
}: Props): ReactElement {
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await api.listCampaigns({ perPage: 1 });
      if (cancelled) return;
      setChecking(false);
      if (res.error) return;
      const items =
        res.data.items ?? res.data.results ?? res.data.data ?? [];
      if (Array.isArray(items) && items.length > 0) {
        onAlreadyHasCampaigns();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onAlreadyHasCampaigns]);

  const startCampaign = (): void => {
    navigateDesktopRoute({ section: "campaigns" });
    // The Campaigns page is owned by another sibling — for v1 we just
    // navigate. The user clicks "New campaign" there. We close the
    // wizard so it doesn't cover the page.
    onSkip();
  };

  return (
    <div className="onb2-step">
      <div className="onb2-step-illustration" aria-hidden="true">
        <span className="onb2-step-num">3</span>
      </div>
      <h3 className="onb2-step-title">Create your first campaign</h3>
      <p className="onb2-step-desc">
        We&apos;ll drop you on the Campaigns page — click <span className="mono">New campaign</span> to
        draft something. You can edit subject and body before sending.
      </p>

      {checking ? (
        <div className="onb2-status-row">
          <span className="onb2-status-pill is-muted">Checking your drafts…</span>
        </div>
      ) : null}

      <div className="onb2-step-actions">
        <button
          type="button"
          className="btn btn-primary onb2-big-cta"
          onClick={startCampaign}
        >
          Create your first campaign
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
