/**
 * lib/campaignGoal.ts — set the conversion goal a report attributes against.
 *
 * Mobile could READ the goal (lib/campaignInsights readGoalResults) but not
 * set or correct it; desktop edits `goal_event` + `goal_window_hours` through
 * the same PATCH /api/v1/campaigns/{id} the identity sheet uses
 * (CampaignDetailEditor.tsx:167-208). Both fields are pointer-decoded server
 * side and deliberately NOT frozen once dispatched (authoring_input.go:170 —
 * they change what the report measures, not what is delivered), so correcting
 * a goal after the send is a legal, meaningful act.
 *
 * Desktop's window rule is mirrored exactly: with an event set the window
 * defaults to 24; clearing the event sends window 0.
 */

export const GOAL_WINDOW_OPTIONS: readonly { hours: number; label: string }[] =
  [
    { hours: 1, label: "1 hour" },
    { hours: 24, label: "24 hours" },
    { hours: 168, label: "7 days" },
    { hours: 720, label: "30 days" },
  ];

export interface CampaignGoalDraft {
  event: string;
  windowHours: number;
}

export function campaignGoalDraft(
  campaign:
    | { goal_event?: unknown; goal_window_hours?: unknown }
    | null
    | undefined,
): CampaignGoalDraft {
  const event =
    typeof campaign?.goal_event === "string" ? campaign.goal_event.trim() : "";
  const raw = campaign?.goal_window_hours;
  const windowHours =
    typeof raw === "number" && GOAL_WINDOW_OPTIONS.some((o) => o.hours === raw)
      ? raw
      : 24;
  return { event, windowHours };
}

/** Wire body for the goal half of the PATCH, or null when nothing changed. */
export function campaignGoalPatch(
  original: CampaignGoalDraft,
  next: CampaignGoalDraft,
): { goal_event: string; goal_window_hours: number } | null {
  const event = next.event.trim();
  const windowHours = event ? next.windowHours || 24 : 0;
  const originalWindow = original.event ? original.windowHours || 24 : 0;
  if (event === original.event.trim() && windowHours === originalWindow) {
    return null;
  }
  return { goal_event: event, goal_window_hours: windowHours };
}

/** Loose event-key check so a typo explains itself before the round trip. */
export function goalEventProblem(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null;
  if (value.length > 96) return "Event keys are at most 96 characters.";
  if (/\s/.test(value)) {
    return "Event keys have no spaces — e.g. checkout.complete.";
  }
  return null;
}
