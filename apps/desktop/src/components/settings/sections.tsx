/**
 * Settings v2 — section components for the three previously-unwired
 * backend APIs:
 *
 *   - WorkspaceProfileSection: GET/PATCH /api/v1/settings/workspace
 *     (display name, default reply-to, timezone, date format, brand
 *     color, logo URL).
 *   - NotificationsSection:   GET/PATCH /api/v1/settings/notifications
 *     (3 per-event booleans + daily/weekly/never digest).
 *   - RetentionSection:       GET/PATCH /api/v1/settings/privacy
 *     (audit log days, email event days, unsubscribed subscriber days).
 *
 * All three share the same shape:
 *
 *   1. Loads the canonical value on mount.
 *   2. Tracks a local "working copy" + dirty boolean.
 *   3. Renders the SaveBar when dirty.
 *   4. Save POSTs the PATCH; rollback on failure; reload on success.
 *
 * Audit identified each as fully implemented backend + zero UI wiring.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  type AuditRoleWithScopes,
  type NotificationPrefs,
  type NotificationPrefsPatch,
  type RetentionPolicy,
  type RetentionPolicyPatch,
  type WorkspaceSettings,
  type WorkspaceSettingsPatch,
  api,
  getNotificationPrefs,
  getRetentionPolicy,
  getWorkspaceSettings,
  patchNotificationPrefs,
  patchRetentionPolicy,
  patchWorkspaceSettings,
} from "../../lib/api-client";
import { useAuditScopes } from "../../lib/auditScopes";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";
import { useCanAdmin } from "../../lib/store";
import { toast } from "../Toast";
import { DesktopNotificationPreferencesPanel } from "./DesktopNotificationPreferencesPanel";
import { SaveBar } from "./SaveBar";
import { SettingsSectionHeader } from "./SettingsNav";

/* ---------- helpers ------------------------------------------------- */

function fmtRelative(iso?: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  // Guard against epoch / zero-value timestamps (e.g. Go zero-time
  // marshalled as "0001-01-01T00:00:00Z") which produce nonsense
  // "739774d ago" output. Treat anything pre-2000 as "never".
  if (!Number.isFinite(t) || t < new Date("2000-01-01").getTime()) {
    return "never";
  }
  const ms = Date.now() - t;
  if (Number.isNaN(ms)) return "never";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

/**
 * Minimal client-side email validator — matches the common
 * "name@host.tld" shape. Backend remains the source of truth, but this
 * pre-flight check prevents the generic "Network error" toast when the
 * user types an obvious typo into the default reply-to field.
 */
function isLikelyEmail(s: string): boolean {
  const v = s.trim();
  if (v.length === 0 || v.length > 254) return false;
  // RFC-5322 lite: local@domain.tld, no spaces.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/** Stable list of IANA tz options — keep it focused on common ones. */
const TIMEZONES: string[] = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Madrid",
  "Africa/Lagos",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

const DATE_FORMATS: { v: string; label: string }[] = [
  { v: "MMM D, YYYY", label: "May 3, 2026 (MMM D, YYYY)" },
  { v: "D MMM YYYY", label: "3 May 2026 (D MMM YYYY)" },
  { v: "YYYY-MM-DD", label: "2026-05-03 (YYYY-MM-DD)" },
  { v: "MM/DD/YYYY", label: "05/03/2026 (MM/DD/YYYY)" },
];

/* ---------- WorkspaceProfileSection -------------------------------- */

export function WorkspaceProfileSection(): ReactElement {
  const canAdmin = useCanAdmin();
  const [server, setServer] = useState<WorkspaceSettings | null>(null);
  const [draft, setDraft] = useState<WorkspaceSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await getWorkspaceSettings();
    if (res.error) {
      // Empty workspace_settings row → backend returns 200 with empty
      // fields; treat actual errors with a toast.
      toast.error(res.error.message);
      return;
    }
    setServer(res.data);
    setDraft(res.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Diff the draft against the server snapshot to compute the dirty
  // flag + the patch body. JSON-stringify is good enough at this
  // shape (handful of scalar fields).
  const patch = useMemo<WorkspaceSettingsPatch | null>(() => {
    if (!server || !draft) return null;
    const p: WorkspaceSettingsPatch = {};
    if ((draft.display_name ?? "") !== (server.display_name ?? ""))
      p.display_name = draft.display_name ?? "";
    if ((draft.default_reply_to ?? "") !== (server.default_reply_to ?? ""))
      p.default_reply_to = draft.default_reply_to ?? "";
    if ((draft.timezone ?? "") !== (server.timezone ?? ""))
      p.timezone = draft.timezone;
    if ((draft.date_format ?? "") !== (server.date_format ?? ""))
      p.date_format = draft.date_format ?? "";
    if ((draft.brand_color ?? "") !== (server.brand_color ?? ""))
      p.brand_color = draft.brand_color ?? "";
    if ((draft.logo_url ?? "") !== (server.logo_url ?? ""))
      p.logo_url = draft.logo_url ?? "";
    return Object.keys(p).length ? p : null;
  }, [server, draft]);
  const dirty = patch !== null;

  const onSave = async () => {
    if (!patch || !draft) return;
    // Pre-flight email-format check on the default reply-to so we
    // catch obvious typos before the network call. The backend also
    // validates, but its error surfaces as a generic "Network error"
    // toast which doesn't tell the user which field was wrong.
    const replyTo = (draft.default_reply_to ?? "").trim();
    if (replyTo.length > 0 && !isLikelyEmail(replyTo)) {
      setError("Default reply-to must be a valid email address.");
      return;
    }
    setSaving(true);
    setError(null);
    const res = await patchWorkspaceSettings(patch);
    setSaving(false);
    if (res.error) {
      setError(res.error.message);
      return;
    }
    setServer(res.data);
    setDraft(res.data);
    setSavedAt(new Date().toISOString());
  };

  const onDiscard = () => {
    if (server) setDraft(server);
    setError(null);
  };

  useEffect(() => {
    if (!dirty && !saving) return;
    return registerLifecycleGuard({
      id: "settings-workspace-profile",
      label: "Workspace profile changes",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : saving
            ? {
                level: "blocking",
                detail: "Workspace profile changes are still being saved.",
              }
            : dirty
              ? {
                  level: "warning",
                  detail: "The workspace profile has unsaved local changes.",
                }
              : null,
      prepare: saving ? undefined : onSave,
      discard: onDiscard,
    });
  }, [dirty, saving, onSave, onDiscard]);

  if (!draft) {
    return (
      <section className="settings-section">
        <SettingsSectionHeader
          title="Workspace profile"
          description="How your workspace identifies itself across the product."
        />
        <SkeletonRows count={5} />
      </section>
    );
  }

  return (
    <section className="settings-section">
      <SettingsSectionHeader
        title="Workspace profile"
        description="Display name, default reply-to, timezone, and brand."
        meta={
          server?.updated_at ? (
            <span className="muted" style={{ fontSize: 12 }}>
              Updated {fmtRelative(server.updated_at)}
            </span>
          ) : undefined
        }
      />

      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        <div className="field" style={{ flex: 1, minWidth: 220 }}>
          <label className="field-label" htmlFor="ws-display-name">
            Display name
          </label>
          <input
            id="ws-display-name"
            className="input"
            placeholder="Acme Inc."
            value={draft.display_name ?? ""}
            onChange={(e) =>
              setDraft({ ...draft, display_name: e.target.value })
            }
            disabled={!canAdmin}
            maxLength={120}
          />
          <div className="field-hint">
            Used in the workspace switcher and in some outbound emails.
          </div>
        </div>
        <div className="field" style={{ flex: 1, minWidth: 220 }}>
          <label className="field-label" htmlFor="ws-reply-to">
            Default reply-to
          </label>
          <input
            id="ws-reply-to"
            className="input"
            type="email"
            placeholder="support@acme.com"
            value={draft.default_reply_to ?? ""}
            onChange={(e) =>
              setDraft({ ...draft, default_reply_to: e.target.value })
            }
            disabled={!canAdmin}
            aria-invalid={
              (draft.default_reply_to ?? "").trim().length > 0 &&
              !isLikelyEmail(draft.default_reply_to ?? "")
            }
          />
          <div className="field-hint">
            {(draft.default_reply_to ?? "").trim().length > 0 &&
            !isLikelyEmail(draft.default_reply_to ?? "")
              ? "Enter a valid email like name@example.com."
              : "Replies route here unless a campaign overrides it."}
          </div>
        </div>
      </div>

      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        <div className="field" style={{ flex: 1, minWidth: 220 }}>
          <label className="field-label" htmlFor="ws-tz">
            Timezone
          </label>
          <select
            id="ws-tz"
            className="input"
            value={draft.timezone || "UTC"}
            onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
            disabled={!canAdmin}
          >
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
            {/* If the persisted tz is outside our curated list, keep
                it selectable so the user doesn't accidentally drop it. */}
            {draft.timezone && !TIMEZONES.includes(draft.timezone) ? (
              <option value={draft.timezone}>{draft.timezone}</option>
            ) : null}
          </select>
          <div className="field-hint">
            Used for scheduling, analytics windows, and digest delivery.
          </div>
        </div>
        <div className="field" style={{ flex: 1, minWidth: 220 }}>
          <label className="field-label" htmlFor="ws-datefmt">
            Date format
          </label>
          <select
            id="ws-datefmt"
            className="input"
            value={draft.date_format || "MMM D, YYYY"}
            onChange={(e) =>
              setDraft({ ...draft, date_format: e.target.value })
            }
            disabled={!canAdmin}
          >
            {DATE_FORMATS.map((d) => (
              <option key={d.v} value={d.v}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        <div className="field" style={{ flex: 1, minWidth: 220 }}>
          <label className="field-label" htmlFor="ws-brand">
            Brand color
          </label>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <input
              id="ws-brand-swatch"
              type="color"
              value={draft.brand_color || "#14b8a6"}
              onChange={(e) =>
                setDraft({ ...draft, brand_color: e.target.value })
              }
              disabled={!canAdmin}
              style={{
                width: 36,
                height: 36,
                border: "1px solid var(--pw-border)",
                borderRadius: 6,
                padding: 2,
                background: "var(--pw-bg-elev)",
                cursor: canAdmin ? "pointer" : "not-allowed",
              }}
              aria-label="Brand color swatch"
            />
            <input
              id="ws-brand"
              className="input mono"
              value={draft.brand_color ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, brand_color: e.target.value })
              }
              disabled={!canAdmin}
              placeholder="#14b8a6"
              style={{ flex: 1 }}
            />
          </div>
          <div className="field-hint">
            6-digit hex. Used in branded email components + the dashboard
            accent. Server validates the format.
          </div>
        </div>
        <div className="field" style={{ flex: 1, minWidth: 220 }}>
          <label className="field-label" htmlFor="ws-logo">
            Logo URL
          </label>
          <input
            id="ws-logo"
            className="input"
            type="url"
            placeholder="https://cdn.example.com/logo.png"
            value={draft.logo_url ?? ""}
            onChange={(e) => setDraft({ ...draft, logo_url: e.target.value })}
            disabled={!canAdmin}
          />
          <div className="field-hint">
            HTTPS only. Internal / private addresses are rejected server-side
            for safety.
          </div>
        </div>
      </div>

      <SaveBar
        dirty={dirty}
        saving={saving}
        error={error}
        savedAt={savedAt}
        onSave={onSave}
        onDiscard={onDiscard}
        summary={
          patch
            ? `${Object.keys(patch).length} unsaved change${Object.keys(patch).length === 1 ? "" : "s"}`
            : undefined
        }
      />
    </section>
  );
}

/* ---------- NotificationsSection ----------------------------------- */

export function NotificationsSection(): ReactElement {
  const [server, setServer] = useState<NotificationPrefs | null>(null);
  const [draft, setDraft] = useState<NotificationPrefs | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await getNotificationPrefs();
    if (res.error) {
      toast.error(res.error.message);
      return;
    }
    setServer(res.data);
    setDraft(res.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useMemo<NotificationPrefsPatch | null>(() => {
    if (!server || !draft) return null;
    const p: NotificationPrefsPatch = {};
    if (draft.email_on_send_complete !== server.email_on_send_complete)
      p.email_on_send_complete = draft.email_on_send_complete;
    if (draft.email_on_approval_request !== server.email_on_approval_request)
      p.email_on_approval_request = draft.email_on_approval_request;
    if (draft.email_on_bounce_alert !== server.email_on_bounce_alert)
      p.email_on_bounce_alert = draft.email_on_bounce_alert;
    if (draft.digest_frequency !== server.digest_frequency)
      p.digest_frequency = draft.digest_frequency as
        | "daily"
        | "weekly"
        | "never";
    return Object.keys(p).length ? p : null;
  }, [server, draft]);
  const dirty = patch !== null;

  const onSave = async () => {
    if (!patch) return;
    setSaving(true);
    setError(null);
    const res = await patchNotificationPrefs(patch);
    setSaving(false);
    if (res.error) {
      setError(res.error.message);
      return;
    }
    setServer(res.data);
    setDraft(res.data);
    setSavedAt(new Date().toISOString());
  };
  const onDiscard = () => {
    if (server) setDraft(server);
    setError(null);
  };

  useEffect(() => {
    if (!dirty && !saving) return;
    return registerLifecycleGuard({
      id: "settings-notifications",
      label: "Notification preference changes",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : saving
            ? {
                level: "blocking",
                detail: "Notification preferences are still being saved.",
              }
            : dirty
              ? {
                  level: "warning",
                  detail:
                    "Notification preferences have unsaved local changes.",
                }
              : null,
      prepare: saving ? undefined : onSave,
      discard: onDiscard,
    });
  }, [dirty, saving, onSave, onDiscard]);

  if (!draft) {
    return (
      <section className="settings-section">
        <SettingsSectionHeader
          title="Notifications"
          description="Per-event email alerts + digest cadence for your account."
        />
        <SkeletonRows count={4} />
        <DesktopNotificationPreferencesPanel />
      </section>
    );
  }

  return (
    <section className="settings-section">
      <SettingsSectionHeader
        title="Notifications"
        description="Choose email and privacy-safe desktop delivery for this account. Teammates manage their own preferences."
      />

      <h3 className="settings-subhead">Email delivery</h3>

      <ToggleRow
        id="notif-send-complete"
        label="Send complete"
        hint="Email me when a scheduled campaign finishes sending."
        checked={draft.email_on_send_complete}
        onChange={(v) => setDraft({ ...draft, email_on_send_complete: v })}
      />
      <ToggleRow
        id="notif-approval"
        label="Approval requested"
        hint="Email me when a teammate asks for approval on a campaign."
        checked={draft.email_on_approval_request}
        onChange={(v) => setDraft({ ...draft, email_on_approval_request: v })}
      />
      <ToggleRow
        id="notif-bounce"
        label="Bounce alerts"
        hint="Email me when bounce rate spikes above the workspace threshold."
        checked={draft.email_on_bounce_alert}
        onChange={(v) => setDraft({ ...draft, email_on_bounce_alert: v })}
      />

      <div className="field" style={{ marginTop: 16 }}>
        <label className="field-label" htmlFor="notif-digest">
          Digest cadence
        </label>
        <select
          id="notif-digest"
          className="input"
          value={draft.digest_frequency ?? ""}
          onChange={(e) =>
            setDraft({
              ...draft,
              digest_frequency: e.target.value,
            })
          }
        >
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="never">Never</option>
        </select>
        <div className="field-hint">
          Summary of opens, clicks, and new subscribers in your workspace.
        </div>
      </div>

      <DesktopNotificationPreferencesPanel />

      <SaveBar
        dirty={dirty}
        saving={saving}
        error={error}
        savedAt={savedAt}
        onSave={onSave}
        onDiscard={onDiscard}
        summary={
          patch
            ? `${Object.keys(patch).length} unsaved change${Object.keys(patch).length === 1 ? "" : "s"}`
            : undefined
        }
      />
    </section>
  );
}

/* ---------- RetentionSection --------------------------------------- */

export function RetentionSection(): ReactElement {
  const canAdmin = useCanAdmin();
  const [server, setServer] = useState<RetentionPolicy | null>(null);
  const [draft, setDraft] = useState<RetentionPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await getRetentionPolicy();
    if (res.error) {
      toast.error(res.error.message);
      return;
    }
    setServer(res.data);
    setDraft(res.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useMemo<RetentionPolicyPatch | null>(() => {
    if (!server || !draft) return null;
    const p: RetentionPolicyPatch = {};
    if (draft.audit_log_retention_days !== server.audit_log_retention_days)
      p.audit_log_retention_days = draft.audit_log_retention_days;
    if (draft.email_event_retention_days !== server.email_event_retention_days)
      p.email_event_retention_days = draft.email_event_retention_days;
    if (
      draft.unsubscribed_subscriber_retention_days !==
      server.unsubscribed_subscriber_retention_days
    )
      p.unsubscribed_subscriber_retention_days =
        draft.unsubscribed_subscriber_retention_days;
    return Object.keys(p).length ? p : null;
  }, [server, draft]);
  const dirty = patch !== null;

  const onSave = async () => {
    if (!patch) return;
    setSaving(true);
    setError(null);
    const res = await patchRetentionPolicy(patch);
    setSaving(false);
    if (res.error) {
      setError(res.error.message);
      return;
    }
    setServer(res.data);
    setDraft(res.data);
    setSavedAt(new Date().toISOString());
  };
  const onDiscard = () => {
    if (server) setDraft(server);
    setError(null);
  };

  useEffect(() => {
    if (!dirty && !saving) return;
    return registerLifecycleGuard({
      id: "settings-retention",
      label: "Data retention changes",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : saving
            ? {
                level: "blocking",
                detail: "Data retention changes are still being saved.",
              }
            : dirty
              ? {
                  level: "warning",
                  detail:
                    "The data retention policy has unsaved local changes.",
                }
              : null,
      prepare: saving ? undefined : onSave,
      discard: onDiscard,
    });
  }, [dirty, saving, onSave, onDiscard]);

  if (!draft) {
    return (
      <section className="settings-section">
        <SettingsSectionHeader
          title="Data retention"
          description="How long Moosewave keeps audit logs, email events, and unsubscribed subscriber records."
        />
        <SkeletonRows count={3} />
      </section>
    );
  }

  return (
    <section className="settings-section">
      <SettingsSectionHeader
        title="Data retention"
        description="How long Moosewave keeps audit logs, email events, and unsubscribed subscriber records."
        meta={
          server?.updated_at ? (
            <span className="muted" style={{ fontSize: 12 }}>
              Updated {fmtRelative(server.updated_at)}
            </span>
          ) : undefined
        }
      />

      <RetentionField
        id="ret-audit"
        label="Audit log"
        hint="Action history for compliance and forensics."
        min={7}
        max={2555}
        value={draft.audit_log_retention_days}
        onChange={(v) => setDraft({ ...draft, audit_log_retention_days: v })}
        disabled={!canAdmin}
      />
      <RetentionField
        id="ret-events"
        label="Email events"
        hint="Opens, clicks, bounces, and complaints per send."
        min={30}
        max={2555}
        value={draft.email_event_retention_days}
        onChange={(v) => setDraft({ ...draft, email_event_retention_days: v })}
        disabled={!canAdmin}
      />
      <RetentionField
        id="ret-unsub"
        label="Unsubscribed subscribers"
        hint="Retained for suppression so we don't re-add them automatically."
        min={7}
        max={3650}
        value={draft.unsubscribed_subscriber_retention_days}
        onChange={(v) =>
          setDraft({
            ...draft,
            unsubscribed_subscriber_retention_days: v,
          })
        }
        disabled={!canAdmin}
      />

      <SaveBar
        dirty={dirty}
        saving={saving}
        error={error}
        savedAt={savedAt}
        onSave={onSave}
        onDiscard={onDiscard}
        summary={
          patch
            ? `${Object.keys(patch).length} unsaved change${Object.keys(patch).length === 1 ? "" : "s"}`
            : undefined
        }
      />
    </section>
  );
}

/* ---------- helpers + shared primitives ---------------------------- */

function ToggleRow({
  id,
  label,
  hint,
  checked,
  onChange,
  disabled = false,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}): ReactElement {
  return (
    <div className="settings-toggle-row">
      <label htmlFor={id} className="settings-toggle-label">
        <div>
          <div className="settings-toggle-title">{label}</div>
          {hint ? <div className="settings-toggle-hint">{hint}</div> : null}
        </div>
        <input
          id={id}
          type="checkbox"
          checked={checked ?? false}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
          className="settings-toggle-input"
          role="switch"
          aria-checked={checked ?? false}
        />
      </label>
    </div>
  );
}

function RetentionField({
  id,
  label,
  hint,
  min,
  max,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint: string;
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
  disabled: boolean;
}): ReactElement {
  return (
    <div className="field" style={{ marginBottom: 12 }}>
      <label className="field-label" htmlFor={id}>
        {label}{" "}
        <span className="muted" style={{ fontWeight: 400 }}>
          ({min}–{max} days)
        </span>
      </label>
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <input
          id={id}
          type="number"
          className="input mono"
          min={min}
          max={max}
          value={value ?? ""}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onChange(v);
          }}
          disabled={disabled}
          style={{ width: 120 }}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          days
        </span>
      </div>
      <div className="field-hint">{hint}</div>
    </div>
  );
}

function SkeletonRows({ count }: { count: number }): ReactElement {
  return (
    <div style={{ paddingTop: 8 }}>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="skel"
          style={{ height: 32, marginBottom: 12, borderRadius: 6 }}
        />
      ))}
    </div>
  );
}

/* ---------- RolesSection (rbac-meta-audit) ------------------------- */

/**
 * RolesSection — Settings > Team > Roles.
 *
 * rbac-meta-audit: renders a role × audit-scope matrix so a tenant
 * owner can assign audit:read / audit:read_pii / etc. to existing
 * roles. Persists via PUT /api/v1/roles/{id}/scopes; the backend
 * writes an audit.rbac.role_updated meta-row alongside the rewrite.
 *
 * Only ScopeAdmin can mutate. Lower roles see the matrix read-only.
 */
export function RolesSection(): ReactElement {
  const canAdmin = useCanAdmin();
  const scopes = useAuditScopes();
  const [roles, setRoles] = useState<AuditRoleWithScopes[] | null>(null);
  const [available, setAvailable] = useState<string[]>([]);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const res = await api.listRoles();
    if (res.error) {
      setErr(res.error.message);
      setRoles([]);
      return;
    }
    setRoles(res.data?.roles ?? []);
    setAvailable(res.data?.availableScopes ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (
    role: AuditRoleWithScopes,
    scope: string,
  ): Promise<void> => {
    if (!canAdmin) return;
    const next = role.assignedScopes.includes(scope)
      ? role.assignedScopes.filter((s) => s !== scope)
      : [...role.assignedScopes, scope];
    setSavingId(role.id);
    // Optimistic update.
    setRoles((prev) =>
      prev
        ? prev.map((r) =>
            r.id === role.id ? { ...r, assignedScopes: next } : r,
          )
        : prev,
    );
    const res = await api.updateRoleScopes(role.id, next);
    setSavingId(null);
    if (res.error) {
      toast.error(res.error.message);
      void load(); // rollback by reloading the source-of-truth.
      return;
    }
    toast.success(`Updated ${role.name}`);
    // Refresh own scope cache — the actor may have just been
    // promoted / demoted themselves.
    void scopes.refresh();
  };

  if (roles === null) {
    return (
      <section>
        <SettingsSectionHeader
          title="Audit access"
          description="Assign audit scopes to tenant roles. Loading…"
        />
        <SkeletonRows count={3} />
      </section>
    );
  }
  if (err) {
    return (
      <section>
        <SettingsSectionHeader
          title="Audit access"
          description="Role matrix unavailable. Try again in a moment."
        />
        <div className="alert alert-error">Couldn&apos;t load roles: {err}</div>
      </section>
    );
  }
  if (roles.length === 0) {
    return (
      <section>
        <SettingsSectionHeader
          title="Audit access"
          description="No roles defined yet."
        />
        <p className="muted small">
          Roles are seeded per-tenant on the next migration run.
        </p>
      </section>
    );
  }

  return (
    <section data-testid="settings-roles-section">
      <SettingsSectionHeader
        title="Audit access"
        description={
          canAdmin
            ? "Assign audit scopes to tenant roles. Changes apply to the next request."
            : "Read-only — owner / admin role required to edit."
        }
      />
      <div
        style={{
          overflowX: "auto",
          border: "1px solid var(--pw-border)",
          borderRadius: 8,
        }}
      >
        <table
          className="table"
          style={{ width: "100%", borderCollapse: "collapse" }}
        >
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: 8 }}>Role</th>
              {available.map((s) => (
                <th
                  key={s}
                  style={{ textAlign: "center", padding: 8, fontSize: 11 }}
                  title={s}
                >
                  {s.replace(/^audit:/, "")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.id} data-testid={`role-row-${r.name}`}>
                <td style={{ padding: 8 }}>
                  <div style={{ fontWeight: 500 }}>{r.name}</div>
                  {r.description ? (
                    <div className="muted small">{r.description}</div>
                  ) : null}
                </td>
                {available.map((s) => {
                  const on = r.assignedScopes.includes(s);
                  return (
                    <td key={s} style={{ textAlign: "center", padding: 8 }}>
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!canAdmin || savingId === r.id}
                        onChange={() => void toggle(r, s)}
                        aria-label={`${r.name} — ${s}`}
                        data-testid={`role-scope-${r.name}-${s}`}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {savingId ? (
        <p className="muted small" style={{ marginTop: 6 }}>
          Saving…
        </p>
      ) : null}
    </section>
  );
}
