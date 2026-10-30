import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  listOutboundWebhooks,
  type OutboundWebhook,
} from "../../lib/api-client";
import { navigateDesktopRoute } from "../../lib/desktop-router";
import { useCanAdmin } from "../../lib/store";
import { sanitizeInspectableText } from "../webhook-simulator/ResponseInspector";

export interface WebhookConfigurationSummary {
  total: number;
  active: number;
  paused: number;
  failing: number;
  eventTypes: number;
  complete: boolean;
}

export function summarizeWebhookConfiguration(
  rows: readonly OutboundWebhook[],
  complete = true,
): WebhookConfigurationSummary {
  const isConfigurationFailure = (row: OutboundWebhook): boolean =>
    row.disabled_reason === "auto_failures" ||
    (row.active && row.consecutive_failures > 0) ||
    row.url_status === "legacy_pending" ||
    row.url_status === "invalid" ||
    row.auth_config_status === "legacy_pending" ||
    row.auth_config_status === "invalid" ||
    row.delivery_policy_status === "invalid";
  return {
    total: rows.length,
    active: rows.filter((row) => row.active).length,
    paused: rows.filter((row) => !row.active).length,
    failing: rows.filter(isConfigurationFailure).length,
    eventTypes: new Set(rows.flatMap((row) => row.events ?? [])).size,
    complete,
  };
}

/** Settings-owned read-only projection; all webhook mutations live in Webhooks. */
export function WebhookAdministrationSummary(): ReactElement | null {
  const canAdmin = useCanAdmin();
  const [summary, setSummary] = useState<WebhookConfigurationSummary | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setError(null);
    try {
      const response = await listOutboundWebhooks({ limit: 200 });
      if (requestId !== requestSequence.current) return;
      if (response.error) {
        setError(sanitizeInspectableText(response.error.message).text);
        return;
      }
      setSummary(
        summarizeWebhookConfiguration(
          response.data.webhooks,
          !response.data.next_cursor,
        ),
      );
    } catch (reason) {
      if (requestId !== requestSequence.current) return;
      setError(
        sanitizeInspectableText(
          reason instanceof Error
            ? reason.message
            : "The webhook configuration summary is unavailable.",
        ).text,
      );
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canAdmin) {
      requestSequence.current += 1;
      return;
    }
    void load();
    return () => {
      requestSequence.current += 1;
    };
  }, [canAdmin, load]);

  if (!canAdmin) return null;

  return (
    <div className="settings-section" data-settings-anchor="outbound-webhooks">
      <div className="settings-section-head">
        <div>
          <h2 className="settings-section-title">Outbound webhooks</h2>
          <div className="settings-section-subtitle muted">
            Configuration summary; endpoints and subscriptions are managed in
            Webhooks.
          </div>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() =>
            navigateDesktopRoute({ section: "webhooks", tab: "outbound" })
          }
        >
          Manage webhooks
        </button>
      </div>
      <div className="settings-section-body">
        {loading && !summary ? (
          <div className="muted" role="status">
            Loading webhook status…
          </div>
        ) : error ? (
          <div className="notice" role="alert">
            <span>Couldn&apos;t load webhook status: {error}</span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void load()}
            >
              Retry
            </button>
          </div>
        ) : summary ? (
          <div className="settings-webhook-summary">
            <span className="chip">
              {summary.complete ? summary.total : `${summary.total}+`}{" "}
              subscriptions
            </span>
            <span className="chip">
              {summary.complete ? summary.active : `${summary.active}+`} active
            </span>
            <span className="chip">
              {summary.complete ? summary.paused : `${summary.paused}+`} paused
            </span>
            <span className={`chip${summary.failing > 0 ? " danger" : ""}`}>
              {summary.complete ? summary.failing : `${summary.failing}+`}{" "}
              attention
            </span>
            <span className="chip">
              {summary.complete ? summary.eventTypes : `${summary.eventTypes}+`}{" "}
              event types
            </span>
            {!summary.complete ? (
              <span className="muted small" role="note">
                Counts are lower bounds from the first 200 subscriptions.
              </span>
            ) : null}
          </div>
        ) : null}
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          Delivery tests, signing-secret reveals, retries and CRUD stay in the
          canonical Webhooks workspace. Alert preferences remain in Settings.
        </p>
      </div>
    </div>
  );
}
