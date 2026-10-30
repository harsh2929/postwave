/**
 * lib/campaignAudienceMode.ts — dynamic vs static audience, and the freeze.
 *
 * Server contract (re-verified 2026-08-28):
 *   - `audience_mode` rides PATCH /api/v1/campaigns/{id} as a pointer field
 *     (authoring_input.go:103) — absent leaves it alone.
 *   - POST /api/v1/campaigns/{id}/audience/freeze (audience_freeze.go:34)
 *     snapshots the segment membership NOW, stamps audience_mode='static',
 *     and answers {ok, frozen_members}. It 422s with `freeze_requires_segment`
 *     for a workspace-wide campaign — a real product rule, not a failure.
 *
 * Both writes are ONLINE-ONLY on purpose. "Freeze the audience NOW" is a
 * time-anchored act — replaying it from an outbox hours later would snapshot a
 * different membership than the operator looked at when they pressed the
 * button. The mode flip travels with the same mutation family for the same
 * reason: flipping to static usually precedes an immediate freeze.
 */

export type CampaignAudienceMode = "dynamic" | "static";

export function campaignAudienceMode(
  campaign: { audience_mode?: unknown } | null | undefined,
): CampaignAudienceMode {
  return campaign?.audience_mode === "static" ? "static" : "dynamic";
}

export const AUDIENCE_MODE_OPTIONS: readonly {
  value: CampaignAudienceMode;
  label: string;
}[] = [
  { value: "dynamic", label: "Dynamic" },
  { value: "static", label: "Static" },
];

/** Mirrors desktop's help copy under the mode select. */
export function audienceModeHelp(mode: CampaignAudienceMode): string {
  return mode === "static"
    ? "Static freezes a snapshot of today's membership — the send goes to exactly that list."
    : "Dynamic re-evaluates the audience when the campaign sends, so joiners and leavers are picked up.";
}

export function readFreezeResult(data: unknown): { frozenMembers: number } {
  const n =
    data && typeof data === "object"
      ? (data as { frozen_members?: unknown }).frozen_members
      : undefined;
  return { frozenMembers: typeof n === "number" && n >= 0 ? n : 0 };
}

/** The two 422s carry product rules and must not read as generic failures. */
export function freezeErrorMessage(
  code: string | undefined,
  fallback: string,
): string {
  if (code === "freeze_requires_segment") {
    return "A static snapshot needs a segment audience. This campaign sends workspace-wide, so there is no membership to freeze.";
  }
  if (code === "segment_not_found") {
    return "This campaign's segment no longer exists, so its membership can't be frozen.";
  }
  return fallback;
}
