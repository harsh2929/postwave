/**
 * subscriberFrequency — "email me less often", honored for ONE person.
 *
 * SUB-132/135: the subscriber-level send-cadence preference. Desktop's
 * FrequencyPreferencePanel writes it through PATCH /api/v1/subscribers/{id};
 * mobile's frequency-caps screen is the WORKSPACE caps and never touched the
 * per-person axis, so a "stop emailing me so much" taken on a phone call
 * could not be honored without a desk.
 *
 * The wire vocabulary mirrors the server exactly (types.go:1047-1073 +
 * migration 0180's CHECK): frequency_preference ∈ default|weekly|monthly|
 * paused; `pause_days` (1..365) is the vacation-mode convenience that pins
 * the preference to 'paused' server-side; `clear_paused_until` drops the
 * expiry. `paused_until` IN THE FUTURE excludes the subscriber from queue
 * fill regardless of the named preference, so the summary treats it as
 * paused — reporting "Weekly" about someone no send will reach would be a
 * lie in the reassuring direction.
 *
 * Platform-free so every rule runs in the node vitest suite; `lib/format` is
 * itself import-free, so the shared date vocabulary comes at no cost here.
 */
import { date } from "@/lib/format";

export interface FrequencyOption {
  value: "default" | "weekly" | "monthly" | "paused";
  label: string;
  hint: string;
}

/** Mirrors desktop's OPTIONS verbatim. */
export const FREQUENCY_OPTIONS: readonly FrequencyOption[] = [
  { value: "default", label: "Default", hint: "No subscriber-level cap" },
  { value: "weekly", label: "Weekly", hint: "At most one send per week" },
  { value: "monthly", label: "Monthly", hint: "At most one send per month" },
  {
    value: "paused",
    label: "Paused",
    hint: "Excluded from all sends until reactivated",
  },
];

/** The vacation presets desktop offers, thumb-sized subset. */
export const PAUSE_PRESET_DAYS = [7, 30, 90] as const;

export interface FrequencyState {
  /** The stored preference; "default" when the row never set one. */
  preference: "default" | "weekly" | "monthly" | "paused";
  /** ISO auto-reactivation timestamp, or null. */
  pausedUntil: string | null;
}

/** Read the two SUB-132 fields off the (untyped) subscriber detail row. */
export function frequencyStateFromSubscriber(row: unknown): FrequencyState {
  const rec =
    row && typeof row === "object" ? (row as Record<string, unknown>) : {};
  const raw =
    typeof rec.frequency_preference === "string"
      ? rec.frequency_preference
      : "";
  const preference = FREQUENCY_OPTIONS.some((o) => o.value === raw)
    ? (raw as FrequencyState["preference"])
    : "default";
  const pausedUntil =
    typeof rec.paused_until === "string" && rec.paused_until
      ? rec.paused_until
      : null;
  return { preference, pausedUntil };
}

/** True when a future paused_until excludes this person from sends NOW. */
export function frequencyPauseActive(
  state: FrequencyState,
  now: number = Date.now(),
): boolean {
  if (state.preference === "paused") return true;
  if (!state.pausedUntil) return false;
  const t = Date.parse(state.pausedUntil);
  return Number.isFinite(t) && t > now;
}

/** One printed sentence about what the sender will actually do. */
export function frequencySummary(
  state: FrequencyState,
  now: number = Date.now(),
): string {
  if (frequencyPauseActive(state, now)) {
    const t = state.pausedUntil ? Date.parse(state.pausedUntil) : NaN;
    return Number.isFinite(t) && t > now
      ? `Paused — excluded from every send until ${date(t)}.`
      : "Paused indefinitely — excluded from every send until reactivated.";
  }
  if (state.preference === "weekly") {
    return "Capped at one send per week, on top of workspace caps.";
  }
  if (state.preference === "monthly") {
    return "Capped at one send per month, on top of workspace caps.";
  }
  return "No personal cap — workspace frequency caps still apply.";
}

/** PATCH body for choosing a cadence — desktop's setPreference, key for key. */
export function buildFrequencyPreferenceBody(
  value: FrequencyOption["value"],
): Record<string, unknown> {
  return { frequency_preference: value };
}

/**
 * PATCH body for "pause for N days", or null outside the server's 1..365
 * bound (handlers.go:1287 422s; refusing locally beats a round-trip that was
 * always going to fail).
 */
export function buildPauseDaysBody(
  days: number,
): Record<string, unknown> | null {
  if (!Number.isInteger(days) || days < 1 || days > 365) return null;
  return { pause_days: days };
}

/** PATCH body that drops the auto-reactivation expiry. */
export function buildClearPauseBody(): Record<string, unknown> {
  return { clear_paused_until: true };
}
