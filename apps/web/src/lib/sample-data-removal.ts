// SPDX-License-Identifier: AGPL-3.0-only
//
// DELETE /api/v1/onboarding/sample-data can stop short of removing everything:
// a sample segment that one of the operator's own campaigns (one that hasn't
// sent yet) still targets is kept, because deleting it would retarget that
// campaign at every subscriber. The response names what stayed and why.

/** A sample segment removal left in place, and the campaigns holding it. */
export interface KeptSampleSegment {
  id: string;
  name: string;
  campaigns: string[];
}

/** Response of DELETE /api/v1/onboarding/sample-data. */
export interface SampleDataRemoval {
  removed: boolean;
  /** Absent (or empty) when removal was complete. */
  kept_segments?: KeptSampleSegment[];
}

function quotedAnd(names: string[]): string {
  const quoted = names.map((n) => `"${n}"`);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/** Why removal stopped short, naming the segment and what to move. */
export function sampleSegmentsKeptMessage(kept: KeptSampleSegment[]): string {
  const first = kept[0];
  if (!first) return "Sample data removed.";
  const campaigns = Array.isArray(first.campaigns) ? first.campaigns : [];
  const heldBy =
    campaigns.length === 0
      ? "a campaign that hasn't sent yet still targets it"
      : campaigns.length === 1
        ? `your campaign ${quotedAnd(campaigns)} hasn't sent yet and still targets it`
        : `your campaigns ${quotedAnd(campaigns)} haven't sent yet and still target it`;
  const move =
    campaigns.length > 1 ? "Move those campaigns" : "Move that campaign";
  const others =
    kept.length === 2
      ? " One more sample segment stayed for the same reason."
      : kept.length > 2
        ? ` ${kept.length - 1} more sample segments stayed for the same reason.`
        : "";
  return `Sample data removed, except the sample segment "${first.name}": ${heldBy}. ${move} to another audience, then remove sample data again.${others}`;
}
