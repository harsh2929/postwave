import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { type WebhookAlertPrefs, api } from "../../lib/api-client";
import { useCanAdmin } from "../../lib/store";
import { Notice } from "../Notice";
import { toast } from "../Toast";
import { sanitizeInspectableText } from "../webhook-simulator/ResponseInspector";

function isWebhookAlertPrefs(value: unknown): value is WebhookAlertPrefs {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prefs = value as Record<string, unknown>;
  return (
    typeof prefs.notify_auto_disabled === "boolean" &&
    typeof prefs.notify_failure_rate === "boolean" &&
    Number.isInteger(prefs.failure_rate_pct) &&
    typeof prefs.failure_rate_pct === "number" &&
    prefs.failure_rate_pct >= 1 &&
    prefs.failure_rate_pct <= 100 &&
    typeof prefs.notify_latency === "boolean" &&
    Number.isInteger(prefs.latency_ms) &&
    typeof prefs.latency_ms === "number" &&
    prefs.latency_ms >= 1 &&
    prefs.latency_ms <= 600_000
  );
}

function legacyThresholdSummary(prefs: WebhookAlertPrefs): string {
  const enabled: string[] = [];
  if (prefs.notify_failure_rate) {
    enabled.push(`failure rate at ${prefs.failure_rate_pct}%`);
  }
  if (prefs.notify_latency) {
    enabled.push(`p99 latency at ${prefs.latency_ms.toLocaleString()} ms`);
  }
  return enabled.length > 0 ? enabled.join(" and ") : "none enabled";
}

/**
 * Settings owns notification preferences; destination CRUD and delivery
 * diagnosis remain in the canonical Webhooks workspace.
 *
 * Only auto-disable notification is currently consumed by the canonical
 * outbound engine. Legacy threshold values remain visible but intentionally
 * cannot be edited here until their worker reads canonical delivery evidence.
 */
export function AlertPrefsSection(): ReactElement | null {
  const canAdmin = useCanAdmin();
  const [prefs, setPrefs] = useState<WebhookAlertPrefs | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const activeRef = useRef(true);
  const requestSequenceRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const sequence = ++requestSequenceRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await api.getWebhookAlertPrefs();
      if (!activeRef.current || sequence !== requestSequenceRef.current) return;
      if (result.error) {
        setLoadError(sanitizeInspectableText(result.error.message).text);
        return;
      }
      if (!isWebhookAlertPrefs(result.data)) {
        setLoadError(
          "Moosewave returned malformed webhook notification preferences. No defaults were invented and editing remains disabled.",
        );
        return;
      }
      setPrefs(result.data);
    } catch (caught) {
      if (!activeRef.current || sequence !== requestSequenceRef.current) return;
      setLoadError(
        sanitizeInspectableText(
          caught instanceof Error
            ? caught.message
            : "The webhook notification request failed.",
        ).text,
      );
    } finally {
      if (activeRef.current && sequence === requestSequenceRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    activeRef.current = true;
    if (canAdmin) void load();
    return () => {
      activeRef.current = false;
      requestSequenceRef.current += 1;
    };
  }, [canAdmin, load]);

  const setAutoDisableNotification = async (
    enabled: boolean,
  ): Promise<void> => {
    if (!prefs || saving) return;
    const owner = requestSequenceRef.current;
    const next = { ...prefs, notify_auto_disabled: enabled };
    const input = {
      notify_auto_disabled: next.notify_auto_disabled,
      notify_failure_rate: next.notify_failure_rate,
      failure_rate_pct: next.failure_rate_pct,
      notify_latency: next.notify_latency,
      latency_ms: next.latency_ms,
    };
    setSaving(true);
    try {
      const result = await api.putWebhookAlertPrefs(input);
      if (!activeRef.current || owner !== requestSequenceRef.current) return;
      if (result.error || result.data.ok !== true) {
        const message = sanitizeInspectableText(
          result.error?.message ??
            "Moosewave did not acknowledge the preference update.",
        ).text;
        toast.error(`Notification preference wasn't saved: ${message}`);
        return;
      }
      setPrefs(next);
      toast.success(
        enabled
          ? "Auto-pause owner notification enabled"
          : "Auto-pause owner notification disabled",
      );
    } catch (caught) {
      if (!activeRef.current || owner !== requestSequenceRef.current) return;
      toast.error(
        `Notification preference wasn't saved: ${
          sanitizeInspectableText(
            caught instanceof Error
              ? caught.message
              : "The preference request failed.",
          ).text
        }`,
      );
    } finally {
      if (activeRef.current && owner === requestSequenceRef.current) {
        setSaving(false);
      }
    }
  };

  if (!canAdmin) return null;

  return (
    <section
      className="settings-section"
      data-settings-anchor="webhook-alerts"
      aria-labelledby="webhook-alert-settings-title"
      aria-busy={loading || saving ? "true" : undefined}
    >
      <div className="settings-section-head">
        <div>
          <h2
            id="webhook-alert-settings-title"
            className="settings-section-title"
          >
            Webhook alerts
          </h2>
          <div className="settings-section-sub">
            Honest coverage for canonical outbound delivery incidents.
          </div>
        </div>
      </div>
      <div className="settings-section-body">
        {loading && !prefs ? (
          <p className="muted" role="status">
            Loading webhook notification preferences…
          </p>
        ) : loadError ? (
          <Notice tone="warning" announcement="polite">
            <p style={{ marginTop: 0 }}>
              Couldn&apos;t verify notification preferences: {loadError}
            </p>
            <p className="muted small">
              Existing values were not replaced with local defaults.
            </p>
            <button
              type="button"
              className="btn btn-sm"
              disabled={loading}
              onClick={() => void load()}
            >
              {loading ? "Retrying…" : "Retry"}
            </button>
          </Notice>
        ) : prefs ? (
          <div className="wh-alert-preferences">
            <div className="wh-alert-preference">
              <input
                id="webhook-auto-disable-notification"
                type="checkbox"
                checked={prefs.notify_auto_disabled}
                disabled={saving}
                onChange={(event) =>
                  void setAutoDisableNotification(event.target.checked)
                }
              />
              <div className="wh-alert-preference-copy">
                <label htmlFor="webhook-auto-disable-notification">
                  Email the workspace owner after an auto-pause
                </label>
                <span className="muted small">
                  The canonical outbound worker pauses a destination after its
                  failure threshold, retains delivery evidence, and sends a
                  durable owner notification when this is enabled.
                </span>
              </div>
            </div>
            <Notice tone="neutral" announcement="off">
              <strong>Threshold alerts are not canonical yet</strong>
              <p className="muted small" style={{ marginBottom: 0 }}>
                Saved legacy thresholds: {legacyThresholdSummary(prefs)}. They
                are not presented as controls because the current threshold
                worker does not evaluate canonical outbound deliveries. The
                values remain preserved until that backend migration is
                complete.
              </p>
            </Notice>
            <p className="muted small" style={{ marginBottom: 0 }}>
              The current canonical notification recipient is the workspace
              owner. Per-admin recipient selection and escalation schedules are
              not available yet.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
