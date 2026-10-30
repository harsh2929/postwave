/**
 * PreferencesPanel — SUB-134 hosted-preference-center preview, shown as a
 * dedicated "Preferences" tab in the subscriber slideover.
 *
 * Renders each tenant preference-center topic with the subscriber's current
 * opt-in state and a per-topic toggle, mirroring what the public hosted
 * preference page shows. The topic list is hydrated inline on the
 * subscriber detail GET (`preference_topics`) — no separate fetch — and each
 * toggle writes via the per-topic subscribe / unsubscribe endpoints:
 *
 *   POST /api/v1/subscribers/{email}/topics/{topicId}/subscribe
 *   POST /api/v1/subscribers/{email}/topics/{topicId}/unsubscribe
 *
 * Graceful degradation: when `preference_topics` is absent (older
 * deployment) or empty (no topics configured), the panel shows an honest
 * empty state instead of erroring. Optimistic toggle with rollback on
 * failure.
 */

import { type ReactElement, useEffect, useId, useRef, useState } from "react";

import { type SubscriberTopicView, api } from "../../lib/api-client";
import { redact } from "../../lib/auth";
import { InlineHelp } from "../InlineHelp";
import { toast } from "../Toast";

interface Props {
  /** Subscriber email (the per-topic write endpoints key by it). */
  email: string;
  /** Topics hydrated on the detail GET; absent/empty → empty state. */
  topics: SubscriberTopicView[] | undefined;
  /** Whether the session may mutate (write:subscribers scope). */
  canMutate: boolean;
}

export function PreferencesPanel({
  email,
  topics,
  canMutate,
}: Props): ReactElement {
  // Local working copy so toggles render optimistically. Re-seeded whenever
  // the loaded topics change (subscriber switch / detail refresh).
  const [rows, setRows] = useState<SubscriberTopicView[]>(topics ?? []);
  const [busy, setBusy] = useState<string | null>(null);
  const operationRef = useRef<string | null>(null);
  const permissionReasonId = useId();

  useEffect(() => {
    setRows(topics ?? []);
  }, [topics]);

  const toggle = async (topic: SubscriberTopicView): Promise<void> => {
    if (!canMutate || operationRef.current) return;
    const next = !topic.opted_in;
    operationRef.current = topic.topic_id;
    setBusy(topic.topic_id);
    // Optimistic flip.
    setRows((prev) =>
      prev.map((t) =>
        t.topic_id === topic.topic_id ? { ...t, opted_in: next } : t,
      ),
    );
    try {
      const res = next
        ? await api.subscribeToTopic(email, topic.topic_id)
        : await api.unsubscribeFromTopic(email, topic.topic_id);
      if (res.error) {
        // Roll back the optimistic flip.
        setRows((prev) =>
          prev.map((t) =>
            t.topic_id === topic.topic_id
              ? { ...t, opted_in: topic.opted_in }
              : t,
          ),
        );
        toast.error({
          message: `Couldn't update "${topic.name}"`,
          detail: redact(res.error.message),
        });
        return;
      }
      toast.success({
        message: next
          ? `Opted in to "${topic.name}"`
          : `Opted out of "${topic.name}"`,
      });
    } catch {
      setRows((prev) =>
        prev.map((t) =>
          t.topic_id === topic.topic_id
            ? { ...t, opted_in: topic.opted_in }
            : t,
        ),
      );
      toast.error(`Couldn't update "${topic.name}". Try again.`);
    } finally {
      operationRef.current = null;
      setBusy(null);
    }
  };

  const sorted = [...rows].sort((a, b) => a.display_order - b.display_order);

  return (
    <section>
      <div
        className="label"
        style={{ display: "flex", alignItems: "center", gap: 4 }}
      >
        Preference center
        <InlineHelp text="The tenant's preference-center topics with this subscriber's current opt-in state — the same surface the hosted preference page presents. Toggling here writes the per-topic opt-in immediately." />
      </div>

      {sorted.length === 0 ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          No preference-center topics are configured for this workspace.
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            marginTop: 6,
          }}
        >
          {sorted.map((topic) => (
            <div
              key={topic.topic_id}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                justifyContent: "space-between",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {topic.name}
                  {topic.opted_in ? (
                    <span
                      className="badge success"
                      style={{ fontSize: 10, marginLeft: 6 }}
                    >
                      Opted in
                    </span>
                  ) : (
                    <span
                      className="badge"
                      style={{ fontSize: 10, marginLeft: 6 }}
                    >
                      Opted out
                    </span>
                  )}
                </div>
                {topic.description ? (
                  <div className="muted" style={{ fontSize: 11 }}>
                    {topic.description}
                  </div>
                ) : null}
                <div className="muted" style={{ fontSize: 10 }}>
                  {topic.slug}
                  {" · default "}
                  {topic.default_opt_in ? "opted in" : "opted out"}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy != null}
                aria-disabled={!canMutate || undefined}
                aria-describedby={!canMutate ? permissionReasonId : undefined}
                aria-label={`${topic.opted_in ? "Opt out of" : "Opt in to"} ${topic.name}`}
                onClick={() => void toggle(topic)}
              >
                {busy === topic.topic_id
                  ? "Saving…"
                  : topic.opted_in
                    ? "Opt out"
                    : "Opt in"}
              </button>
            </div>
          ))}
        </div>
      )}
      {!canMutate && sorted.length > 0 ? (
        <p
          id={permissionReasonId}
          className="muted"
          role="status"
          style={{ fontSize: 11, margin: "8px 0 0" }}
        >
          Viewer access can inspect preference topics but cannot change
          subscription choices.
        </p>
      ) : null}
    </section>
  );
}
