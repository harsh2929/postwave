/**
 * lib/abSettings.ts — the A/B test's own configuration, as a pure reading.
 *
 * Mobile could READ an A/B result and could do nothing about it: the winner
 * metric, the evaluation window and the winner-recipients share were all
 * unreachable, and there was no way to force an evaluation pass. So an
 * operator watching a test converge on a phone had to find a desk to act.
 *
 * The three knobs and their bounds mirror the Go validator exactly
 * (apps/api/internal/abtests/handlers.go SetSettings):
 *   winner_metric            open_rate | click_rate | reply_rate  (400 otherwise)
 *   evaluation_window_hours  <= 0 is coerced server-side to 24
 *   winner_recipients_pct    0..100 inclusive (400 otherwise)
 *
 * Validating here means a bad value is refused before the round trip, and the
 * bounds are asserted by a test rather than by a comment.
 */

export type ABWinnerMetric = "open_rate" | "click_rate" | "reply_rate";

export const AB_WINNER_METRICS: readonly {
  value: ABWinnerMetric;
  label: string;
}[] = [
  { value: "open_rate", label: "Open rate" },
  { value: "click_rate", label: "Click rate" },
  { value: "reply_rate", label: "Reply rate" },
];

/** Windows offered on the phone. Any positive integer is legal server-side. */
export const AB_EVALUATION_WINDOWS: readonly number[] = [4, 12, 24, 48, 72];

/** Shares of the audience the winner is shipped to. */
export const AB_WINNER_PCTS: readonly number[] = [0, 25, 50, 75, 100];

export interface ABSettingsWire {
  campaign_id?: string;
  winner_metric?: string;
  evaluation_window_hours?: number;
  winner_recipients_pct?: number;
  winner_decided_at?: string | null;
  winning_variant_id?: string | null;
}

export interface ABSettingsDraft {
  winnerMetric: ABWinnerMetric;
  evaluationWindowHours: number;
  winnerRecipientsPct: number;
}

/** The server's defaults, used when no settings row exists yet. */
export const AB_SETTINGS_DEFAULT: ABSettingsDraft = {
  winnerMetric: "open_rate",
  evaluationWindowHours: 24,
  winnerRecipientsPct: 100,
};

function isMetric(value: unknown): value is ABWinnerMetric {
  return (
    value === "open_rate" || value === "click_rate" || value === "reply_rate"
  );
}

export function abSettingsFrom(
  wire: ABSettingsWire | null | undefined,
): ABSettingsDraft {
  const window = Number(wire?.evaluation_window_hours);
  const pct = Number(wire?.winner_recipients_pct);
  return {
    winnerMetric: isMetric(wire?.winner_metric)
      ? wire.winner_metric
      : AB_SETTINGS_DEFAULT.winnerMetric,
    evaluationWindowHours:
      Number.isFinite(window) && window > 0
        ? window
        : AB_SETTINGS_DEFAULT.evaluationWindowHours,
    winnerRecipientsPct:
      Number.isFinite(pct) && pct >= 0 && pct <= 100
        ? pct
        : AB_SETTINGS_DEFAULT.winnerRecipientsPct,
  };
}

/** The exact request body the Go handler accepts. */
export interface ABSettingsPayload {
  winner_metric: ABWinnerMetric;
  evaluation_window_hours: number;
  winner_recipients_pct: number;
}

export function abSettingsPayload(draft: ABSettingsDraft): ABSettingsPayload {
  return {
    winner_metric: draft.winnerMetric,
    evaluation_window_hours: draft.evaluationWindowHours,
    winner_recipients_pct: draft.winnerRecipientsPct,
  };
}

/** Why the settings are invalid, or null. Mirrors the Go 400 branches. */
export function abSettingsError(draft: ABSettingsDraft): string | null {
  if (!isMetric(draft.winnerMetric)) {
    return "Pick a winner metric: open rate, click rate or reply rate.";
  }
  if (
    !Number.isFinite(draft.evaluationWindowHours) ||
    draft.evaluationWindowHours <= 0
  ) {
    return "The evaluation window must be at least one hour.";
  }
  if (
    !Number.isFinite(draft.winnerRecipientsPct) ||
    draft.winnerRecipientsPct < 0 ||
    draft.winnerRecipientsPct > 100
  ) {
    return "The winner share must be between 0% and 100%.";
  }
  return null;
}

/** One sentence describing what the current settings will do. */
export function abSettingsCaption(draft: ABSettingsDraft): string {
  const metric =
    AB_WINNER_METRICS.find((m) => m.value === draft.winnerMetric)?.label ??
    "Open rate";
  const share =
    draft.winnerRecipientsPct <= 0
      ? "no further recipients"
      : draft.winnerRecipientsPct >= 100
        ? "the whole remaining audience"
        : `${draft.winnerRecipientsPct}% of the remaining audience`;
  return `After ${draft.evaluationWindowHours}h, the arm with the best ${metric.toLowerCase()} is sent to ${share}.`;
}

export interface ABDecisionWire {
  winner_decided_at?: string | null;
  winning_variant_id?: string | null;
}

/** True once the server has actually picked a winner. */
export function abWinnerDecided(
  wire: ABDecisionWire | null | undefined,
): boolean {
  return Boolean(wire?.winner_decided_at) || Boolean(wire?.winning_variant_id);
}
