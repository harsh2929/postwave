/**
 * ActivityFeed — small expandable timeline of lifecycle events for
 * one conversation. Refined SMS Inbox PR 2.
 *
 * Pulls from /api/v1/sms/conversations/{phone}/activity which stitches
 * sms_consent_events + sms_subscriptions lifecycle into one stream.
 * Newest-first. Collapsed by default to keep the thread header
 * minimal; an operator who needs context expands it.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { type SMSActivityEvent, api } from "../../lib/api-client";
import { useSMSDocumentVisible } from "./sms-page-activity";

interface Props {
  phone: string;
}

function fmt(s: string): string {
  const d = new Date(s);
  return Number.isNaN(d.getTime())
    ? s
    : d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

function kindLabel(k: string): string {
  switch (k) {
    case "consent":
      return "Consent";
    case "subscription":
      return "Subscription";
    default:
      return k;
  }
}

export function ActivityFeed({ phone }: Props): ReactElement {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<SMSActivityEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<{
    snapshotAt: string;
    truncated: boolean;
  } | null>(null);
  const generationRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const documentVisible = useSMSDocumentVisible();

  const load = useCallback(async (): Promise<void> => {
    if (!documentVisible) return;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api.getSMSConversationActivity(phone, {
        signal: controller.signal,
      });
      if (controller.signal.aborted || generation !== generationRef.current) {
        return;
      }
      if (res.error || !res.data) {
        setError("Lifecycle activity could not be loaded.");
        return;
      }
      setEvents(res.data.events);
      setEvidence({
        snapshotAt: res.data.snapshotAt,
        truncated: res.data.truncated,
      });
    } catch {
      if (!controller.signal.aborted && generation === generationRef.current) {
        setError(
          "Lifecycle activity could not be loaded. Check the connection and retry.",
        );
      }
    } finally {
      if (!controller.signal.aborted && generation === generationRef.current) {
        setLoading(false);
      }
      if (loadAbortRef.current === controller) loadAbortRef.current = null;
    }
  }, [documentVisible, phone]);

  useEffect(() => {
    if (!open || !documentVisible) {
      loadAbortRef.current?.abort();
      setLoading(false);
      return;
    }
    if (events !== null || loading || error) return;
    void load();
  }, [documentVisible, error, events, load, loading, open]);

  // Reset when the phone changes (the parent re-mounts for each
  // distinct phone, so this is a defensive guard).
  useEffect(() => {
    setEvents(null);
    setEvidence(null);
    setError(null);
    setOpen(false);
    generationRef.current += 1;
    loadAbortRef.current?.abort();
  }, [phone]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      loadAbortRef.current?.abort();
    },
    [],
  );

  return (
    <details
      className="sms-activity"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="muted small">
        Activity{" "}
        {events && events.length > 0 ? `(${events.length})` : open ? "" : "▸"}
      </summary>
      <div className="sms-activity-list">
        {loading || (events === null && !error) ? (
          <div className="muted small" style={{ padding: "6px 0" }}>
            Loading…
          </div>
        ) : error ? (
          <div className="sms-activity-error" role="alert">
            <span>{error}</span>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void load()}
            >
              Retry activity
            </button>
          </div>
        ) : (events ?? []).length === 0 ? (
          <div className="muted small" style={{ padding: "6px 0" }}>
            No events in the loaded evidence sources.
          </div>
        ) : (
          (events ?? []).map((e, i) => (
            <div key={`${e.kind}:${e.at}:${i}`} className="sms-activity-row">
              <span className="sms-activity-kind">{kindLabel(e.kind)}</span>
              <bdi className="sms-activity-title" dir="auto">
                {e.title}
              </bdi>
              <span className="muted small tabular">{fmt(e.at)}</span>
            </div>
          ))
        )}
        {evidence ? (
          <p className="muted small sms-activity-evidence-boundary">
            Loaded consent-event and current-subscription evidence through{" "}
            {fmt(evidence.snapshotAt)}. This is not complete suppression or
            operator-state history.
            {evidence.truncated
              ? " The server reports that the loaded evidence window is truncated."
              : " The server did not report truncation within these sources."}
          </p>
        ) : null}
      </div>
    </details>
  );
}
