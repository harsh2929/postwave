/**
 * WinbackCard — "Churn win-backs" settings card for the Retention
 * offers page (roadmap R13).
 *
 * Legacy card retained for source compatibility. It is GET-only and renders
 * stored configuration; the server mounts no PUT and no outbound worker.
 */

import { type ReactElement, useEffect, useState } from "react";

import { type WinbackSettings, winbackSettingsApi } from "../../lib/api-client";
import {
  RETENTION_WINBACK_RELEASE_HOLD_CODE,
  RETENTION_WINBACK_RELEASE_VERDICT,
} from "../../lib/retention-winback-release-status";
import { EstimateBadge, SampleSize } from "../common/Provenance";

export function WinbackCard(): ReactElement {
  const [settings, setSettings] = useState<WinbackSettings | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    setLoadErr(null);
    const res = await winbackSettingsApi.get();
    setLoading(false);
    if (res.error) {
      setLoadErr(res.error.message);
      return;
    }
    setSettings(res.data);
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <section className="pw-retention-winback">
      <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
        Churn win-backs
        {/* Enrollment keys off a PREDICTED churn risk, not an observed
         * cancellation — mark the projection so operators read the
         * threshold accordingly. */}
        <EstimateBadge label="Predicted risk" />
      </h2>
      <p className="pw-page-subtitle">
        Stored configuration only. Automated delivery is{" "}
        {RETENTION_WINBACK_RELEASE_VERDICT} (
        {RETENTION_WINBACK_RELEASE_HOLD_CODE}); no enrollment or send can be
        inferred.
      </p>

      {loadErr ? (
        <div className="pw-error" role="alert">
          Could not load win-back settings: {loadErr}{" "}
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : loading ? (
        <p>Loading…</p>
      ) : settings ? (
        <>
          <p>
            Stored switch: {settings.enabled ? "Enabled" : "Disabled"}. Stored
            threshold: {(settings.churn_threshold * 100).toFixed(0)}%.
          </p>

          {/* The real basis for enrollment: how many subscribers have a
           * churn score at all. When zero, the data-gap explainer below
           * already says why, so we only surface the count once there's
           * a genuine sample. */}
          {settings.churn_profiles_scored > 0 ? (
            <p style={{ margin: "4px 0" }}>
              <SampleSize
                n={settings.churn_profiles_scored}
                noun="scored churn profiles"
              />
            </p>
          ) : null}

          <div className="pw-winback-data-gap" role="note">
            <strong>Runtime unavailable:</strong> This release mounts no
            settings mutation, subscriber portal, or win-back delivery worker.
          </div>
        </>
      ) : null}
    </section>
  );
}
