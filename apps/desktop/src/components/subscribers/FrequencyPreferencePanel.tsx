/**
 * FrequencyPreferencePanel — SUB-132 subscriber-level send-cadence
 * preference, shown in the subscriber slideover Profile tab.
 *
 * Reads/writes two columns the queue-fill frequency filter enforces at
 * send time (migration 0180):
 *   - frequency_preference: 'default' | 'weekly' | 'monthly' | 'paused'
 *   - paused_until:         auto-reactivation timestamp (NULL = indefinite)
 *
 * A 'paused' subscriber — or one whose `paused_until` is still in the
 * future — is excluded from the campaign audience server-side. This panel
 * surfaces:
 *   - a radio group for the four cadence options,
 *   - a "Pause for X days" convenience dropdown (SUB-135 vacation mode)
 *     that sends `pause_days` so the server computes the expiry and pins
 *     the preference to 'paused' in one PATCH,
 *   - a datetime picker for an explicit `paused_until`, with a clear action.
 *
 * Backed by PATCH /api/v1/subscribers/{id} (the existing subscriber update
 * endpoint) — no dedicated route. The parent owns the loaded detail; this
 * panel calls `onChange` with the server-returned row so the slideover and
 * list stay reconciled.
 */

import { type ReactElement, useMemo, useRef, useState } from "react";

import {
  type FrequencyPreference,
  type SubscriberDetail,
  api,
} from "../../lib/api-client";
import { redact } from "../../lib/auth";
import { fmtDateTime } from "../../lib/format-date";
import { InlineHelp } from "../InlineHelp";
import { toast } from "../Toast";

interface Props {
  /** Subscriber row id (the PATCH endpoint keys by it). */
  subscriberId: string | number;
  /** Exact profile revision loaded with the current detail. */
  version: string | undefined;
  /** Current preference; defaults to 'default' when absent. */
  frequencyPreference: FrequencyPreference | undefined;
  /** Current auto-reactivation timestamp (ISO), or null when none. */
  pausedUntil: string | null | undefined;
  /** Whether the session may mutate (write:subscribers scope). */
  canMutate: boolean;
  /** Fired with the server-returned row after a successful PATCH. */
  onChange: (updated: SubscriberDetail) => void;
}

const OPTIONS: Array<{
  value: FrequencyPreference;
  label: string;
  hint: string;
}> = [
  { value: "default", label: "Default", hint: "No subscriber-level cap" },
  { value: "weekly", label: "Weekly", hint: "At most one send per week" },
  { value: "monthly", label: "Monthly", hint: "At most one send per month" },
  {
    value: "paused",
    label: "Paused",
    hint: "Excluded from all sends until reactivated",
  },
];

/** "Pause for N days" presets — each maps to a `pause_days` PATCH. */
const PAUSE_PRESETS = [7, 14, 30, 60, 90] as const;

/** Convert an ISO timestamp to the value a `datetime-local` input wants
 *  (`YYYY-MM-DDTHH:mm`), in the operator's local time. Empty on parse fail. */
function toDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  // Shift by the local TZ offset so the wall-clock value displayed matches
  // the operator's locale rather than UTC.
  const local = new Date(t.getTime() - t.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function FrequencyPreferencePanel({
  subscriberId,
  version,
  frequencyPreference,
  pausedUntil,
  canMutate,
  onChange,
}: Props): ReactElement {
  const current: FrequencyPreference = frequencyPreference ?? "default";
  const [saving, setSaving] = useState<string | null>(null);
  const operationRef = useRef(false);
  // Local draft for the explicit datetime picker; seeded from the prop and
  // re-seeded whenever the loaded value changes (keyed via useMemo below).
  const seededPaused = useMemo(
    () => toDatetimeLocal(pausedUntil),
    [pausedUntil],
  );
  const [pausedDraft, setPausedDraft] = useState(seededPaused);
  // Keep the draft in lockstep with the loaded row across subscriber switches.
  const [seedKey, setSeedKey] = useState(seededPaused);
  if (seedKey !== seededPaused) {
    setSeedKey(seededPaused);
    setPausedDraft(seededPaused);
  }

  const pausedInFuture =
    !!pausedUntil && new Date(pausedUntil).getTime() > Date.now();

  /** Patch the subscriber and hand the returned row up. `busyKey` gates the
   *  specific control that triggered the save. */
  const patch = async (
    busyKey: string,
    body: Parameters<typeof api.updateSubscriber>[1],
    successMsg: string,
  ): Promise<void> => {
    if (!canMutate || operationRef.current) return;
    operationRef.current = true;
    setSaving(busyKey);
    try {
      const res = await api.updateSubscriber(subscriberId, body, {
        version: version ?? "",
      });
      if (res.error) {
        toast.error({
          message: "Couldn't update send preference",
          detail: redact(res.error.message),
        });
        return;
      }
      if (res.queued) {
        toast.info({
          message: "Send preference is pending server confirmation",
          detail:
            "Moosewave will keep showing the current enforced preference until the server confirms the change.",
        });
        return;
      }
      if (res.data) onChange(res.data);
      toast.success({ message: successMsg });
    } catch {
      toast.error("Couldn't update send preference. Try again.");
    } finally {
      operationRef.current = false;
      setSaving(null);
    }
  };

  const setPreference = (value: FrequencyPreference): void => {
    if (value === current) return;
    void patch(
      `pref:${value}`,
      { frequency_preference: value },
      value === "paused" ? "Sends paused" : `Cadence set to ${value}`,
    );
  };

  const pauseForDays = (days: number): void => {
    void patch(
      `pause:${days}`,
      { pause_days: days },
      `Paused for ${days} day${days === 1 ? "" : "s"}`,
    );
  };

  const savePausedUntil = (): void => {
    if (!pausedDraft) return;
    // datetime-local is local wall-clock; new Date() reads it as local and
    // toISOString() normalises to UTC for the wire.
    const iso = new Date(pausedDraft).toISOString();
    void patch(
      "paused_until",
      { frequency_preference: "paused", paused_until: iso },
      "Pause expiry updated",
    );
  };

  const clearPausedUntil = (): void => {
    void patch(
      "clear_paused",
      { clear_paused_until: true },
      "Pause expiry cleared",
    );
  };

  return (
    <section style={{ marginTop: 12 }}>
      <div
        className="label"
        style={{ display: "flex", alignItems: "center", gap: 4 }}
      >
        Send frequency
        <InlineHelp text="The subscriber's own send-cadence preference. 'Paused' (or a future pause expiry) excludes them from every campaign at queue-fill until reactivated." />
      </div>

      {/* Cadence radio group */}
      <div
        role="radiogroup"
        aria-label="Send frequency preference"
        style={{ display: "flex", flexDirection: "column", gap: 4 }}
      >
        {OPTIONS.map((opt) => {
          const checked = current === opt.value;
          return (
            <label
              key={opt.value}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
                cursor: canMutate ? "pointer" : "default",
              }}
            >
              <input
                type="radio"
                name={`freq-pref-${subscriberId}`}
                value={opt.value}
                checked={checked}
                disabled={!canMutate || saving != null}
                onChange={() => setPreference(opt.value)}
              />
              <span>{opt.label}</span>
              <span className="muted" style={{ fontSize: 11 }}>
                {opt.hint}
              </span>
              {saving === `pref:${opt.value}` ? (
                <span className="muted" style={{ fontSize: 11 }}>
                  Saving…
                </span>
              ) : null}
            </label>
          );
        })}
      </div>

      {/* Pause-expiry controls — only meaningful while paused. */}
      <div style={{ marginTop: 10 }}>
        <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
          Pause expiry
          {pausedInFuture ? (
            <span
              className="badge warning"
              style={{ fontSize: 10, marginLeft: 6 }}
              title="Excluded from sends until this passes."
            >
              Until {fmtDateTime(pausedUntil)}
            </span>
          ) : current === "paused" ? (
            <span
              className="badge"
              style={{ fontSize: 10, marginLeft: 6 }}
              title="Paused with no expiry — stays paused until reactivated."
            >
              Indefinite
            </span>
          ) : (
            <span style={{ marginLeft: 6 }}>None</span>
          )}
        </div>

        {canMutate ? (
          <>
            {/* "Pause for X days" convenience — auto-calculates the expiry. */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginBottom: 6,
                fontSize: 12,
              }}
            >
              <label htmlFor={`pause-days-${subscriberId}`}>Pause for</label>
              <select
                id={`pause-days-${subscriberId}`}
                className="input"
                style={{ width: "auto" }}
                disabled={saving != null}
                value=""
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (v > 0) pauseForDays(v);
                }}
              >
                <option value="">Choose…</option>
                {PAUSE_PRESETS.map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </select>
              {saving?.startsWith("pause:") ? (
                <span className="muted">Saving…</span>
              ) : null}
            </div>

            {/* Explicit expiry datetime picker + clear. */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                flexWrap: "wrap",
              }}
            >
              <input
                type="datetime-local"
                className="input"
                style={{ width: "auto" }}
                value={pausedDraft}
                disabled={saving != null}
                onChange={(e) => setPausedDraft(e.target.value)}
                aria-label="Pause until"
              />
              <button
                type="button"
                className="btn btn-sm"
                disabled={!pausedDraft || saving != null}
                onClick={savePausedUntil}
              >
                {saving === "paused_until" ? "Saving…" : "Set expiry"}
              </button>
              {pausedUntil ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={saving != null}
                  onClick={clearPausedUntil}
                >
                  {saving === "clear_paused" ? "Clearing…" : "Clear expiry"}
                </button>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
