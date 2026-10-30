/**
 * FirewallSection — Settings security section wiring #48
 * (firewall attack mode: /firewall/settings GET+PUT, /events,
 * /stats, POST /detect).
 *
 * - Settings draft + dirty diff → partial PUT (pointer semantics
 *   server-side; firewallPatch sends only changed fields).
 * - 24h / 7d accepted/rejected/observed counters straight off
 *   GET /stats.
 * - Recent events with verbatim action badges.
 * - "Check for surge" runs POST /detect and reports `{flipped}`
 *   verbatim — no invented detail.
 */

import { useId, type ReactElement } from "react";

import type { FirewallEvent, FirewallStats } from "../../lib/api-client";
import { SettingsSectionHeader } from "./SettingsNav";
import { firewallActionTone, firewallStatCounts } from "./firewall-helpers";
import { useFirewallController } from "./useFirewallController";

function FirewallStatsCards({
  stats,
}: {
  stats: FirewallStats | null;
}): ReactElement {
  const { last24h, last7d } = firewallStatCounts(stats);
  return (
    <div className="stat-grid" style={{ marginTop: 8, marginBottom: 8 }}>
      <div className="stat-card">
        <div className="stat-label">Rejected (24h)</div>
        <div className="stat-value">{last24h.rejected}</div>
        <div className="muted" style={{ fontSize: 11 }}>
          {last24h.accepted} accepted · {last24h.observed} observed
        </div>
      </div>
      <div className="stat-card">
        <div className="stat-label">Rejected (7d)</div>
        <div className="stat-value">{last7d.rejected}</div>
        <div className="muted" style={{ fontSize: 11 }}>
          {last7d.accepted} accepted · {last7d.observed} observed
        </div>
      </div>
    </div>
  );
}

function FirewallEventList({
  events,
}: {
  events: FirewallEvent[] | null;
}): ReactElement {
  return (
    <>
      <div style={{ fontSize: 13, fontWeight: 600, margin: "8px 0 4px" }}>
        Recent events
      </div>
      {(events ?? []).length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          No firewall events recorded yet.
        </div>
      ) : (
        <div>
          {(events ?? []).map((event) => (
            <div
              key={event.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "6px 0",
                borderBottom: "1px solid var(--pw-border-soft)",
                fontSize: 12,
              }}
            >
              <span className={`badge ${firewallActionTone(event.action)}`}>
                {event.action}
              </span>
              <span className="tabular">risk {event.risk_score}</span>
              <span
                className="muted mono"
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {event.ip ?? "—"}
                {event.form_id ? ` · form ${event.form_id}` : ""}
              </span>
              <span className="muted">
                {new Date(event.at).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function FirewallSection(): ReactElement {
  const detectDescriptionId = useId();
  const saveDescriptionId = useId();
  const {
    canAdmin,
    server,
    draft,
    stats,
    events,
    loading,
    error: err,
    saveError: saveErr,
    saving,
    detecting,
    detectResult,
    dirty,
    mutationsLocked,
    load,
    save: onSave,
    detect: onDetect,
    setDraft: setD,
  } = useFirewallController();
  const detectUnavailableReason = !canAdmin
    ? "Admin role required."
    : loading
      ? "Wait for firewall state to load."
      : mutationsLocked
        ? "Another firewall request is already in progress."
        : null;
  const saveUnavailableReason = !canAdmin
    ? "Admin role required."
    : mutationsLocked
      ? "Another firewall request is already in progress."
      : !dirty
        ? "No changes to save."
        : null;

  return (
    <div className="settings-section">
      <SettingsSectionHeader
        title="Form firewall"
        description="Bot defense for public signup forms. Attack mode rejects submissions scoring above the risk threshold; auto mode flips it on when a signup surge is detected."
        meta={
          <>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                if (!detectUnavailableReason) void onDetect();
              }}
              aria-disabled={detectUnavailableReason !== null || undefined}
              aria-describedby={detectDescriptionId}
              aria-busy={detecting || undefined}
            >
              {detecting ? "Checking…" : "Check for surge"}
            </button>
            <span id={detectDescriptionId} className="visually-hidden">
              {detectUnavailableReason ?? "Run the signup-surge sweep now."}
            </span>
          </>
        }
      />
      <div className="settings-section-body">
        {detectResult ? (
          <div
            className="notice"
            style={{ marginBottom: 10 }}
            role="status"
            aria-live="polite"
          >
            <span>{detectResult}</span>
          </div>
        ) : null}

        {err ? (
          <div className="notice" role="alert">
            <span>Couldn&apos;t load firewall state: {err}</span>
            <span className="spacer" />
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void load()}
              disabled={loading}
            >
              Retry
            </button>
          </div>
        ) : loading || !draft ? (
          <>
            <div className="skel-row" />
            <div className="skel-row" />
            <div className="skel-row" />
          </>
        ) : (
          <>
            {/* ---- toggles ------------------------------------------ */}
            <div className="settings-row">
              <div>
                <div>Attack mode</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  Reject form submissions whose risk score exceeds the
                  threshold.
                  {server?.attack_mode_auto_enabled_at
                    ? ` Auto-enabled ${new Date(server.attack_mode_auto_enabled_at).toLocaleString()}.`
                    : ""}
                </div>
              </div>
              <label className="radio-row" style={{ gap: 8 }}>
                <input
                  type="checkbox"
                  checked={draft.attack_mode_enabled ?? false}
                  onChange={(e) =>
                    setD({ attack_mode_enabled: e.target.checked })
                  }
                  disabled={!canAdmin || mutationsLocked}
                />
                {draft.attack_mode_enabled ? "On" : "Off"}
              </label>
            </div>
            <div className="settings-row">
              <div>
                <div>Auto attack mode</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  Enable attack mode automatically when signups surge past the
                  multiplier below.
                </div>
              </div>
              <label className="radio-row" style={{ gap: 8 }}>
                <input
                  type="checkbox"
                  checked={draft.auto_attack_mode ?? false}
                  onChange={(e) => setD({ auto_attack_mode: e.target.checked })}
                  disabled={!canAdmin || mutationsLocked}
                />
                {draft.auto_attack_mode ? "On" : "Off"}
              </label>
            </div>
            <div className="settings-row">
              <div>
                <div>Require browser fingerprint</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  Treat submissions without a browser fingerprint as
                  higher-risk.
                </div>
              </div>
              <label className="radio-row" style={{ gap: 8 }}>
                <input
                  type="checkbox"
                  checked={draft.fingerprint_required ?? false}
                  onChange={(e) =>
                    setD({ fingerprint_required: e.target.checked })
                  }
                  disabled={!canAdmin || mutationsLocked}
                />
                {draft.fingerprint_required ? "Required" : "Optional"}
              </label>
            </div>

            {/* ---- thresholds --------------------------------------- */}
            <div className="settings-row">
              <div>
                <div>Risk threshold</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  0–100. Submissions scoring above this are rejected in attack
                  mode.
                </div>
              </div>
              <input
                type="number"
                className="input"
                min={0}
                max={100}
                value={draft.attack_mode_threshold ?? ""}
                onChange={(e) =>
                  setD({ attack_mode_threshold: Number(e.target.value) })
                }
                disabled={!canAdmin || mutationsLocked}
                style={{ width: 90 }}
                aria-label="Risk threshold"
              />
            </div>
            <div className="settings-row">
              <div>
                <div>Surge multiplier</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  2–100. A surge is this many times the baseline signup rate.
                </div>
              </div>
              <input
                type="number"
                className="input"
                min={2}
                max={100}
                value={draft.surge_multiplier ?? ""}
                onChange={(e) =>
                  setD({ surge_multiplier: Number(e.target.value) })
                }
                disabled={!canAdmin || mutationsLocked}
                style={{ width: 90 }}
                aria-label="Surge multiplier"
              />
            </div>
            <div className="settings-row">
              <div>
                <div>Surge minimum per hour</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  1–100,000. Below this hourly volume, surges are ignored.
                </div>
              </div>
              <input
                type="number"
                className="input"
                min={1}
                max={100000}
                value={draft.surge_min_per_hour ?? ""}
                onChange={(e) =>
                  setD({ surge_min_per_hour: Number(e.target.value) })
                }
                disabled={!canAdmin || mutationsLocked}
                style={{ width: 110 }}
                aria-label="Surge minimum per hour"
              />
            </div>

            {saveErr ? (
              <div className="field-error" role="alert">
                {saveErr}
              </div>
            ) : null}
            <div className="settings-row">
              <div className="muted" style={{ fontSize: 12 }}>
                {server?.updated_at
                  ? `Last updated ${new Date(server.updated_at).toLocaleString()}`
                  : ""}
              </div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  if (!saveUnavailableReason) void onSave();
                }}
                aria-disabled={saveUnavailableReason !== null || undefined}
                aria-describedby={saveDescriptionId}
                aria-busy={saving || undefined}
              >
                {saving ? "Saving…" : "Save settings"}
              </button>
              <span id={saveDescriptionId} className="visually-hidden">
                {saveUnavailableReason ?? "Save firewall settings."}
              </span>
            </div>

            <FirewallStatsCards stats={stats} />
            <FirewallEventList events={events} />
          </>
        )}
      </div>
    </div>
  );
}
