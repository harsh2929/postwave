/**
 * segmentDecay — the pure half of the decay radar: how one anomaly is named
 * and described.
 *
 * Split from the card so the two rules worth pinning are testable without a
 * native transform:
 *
 *  1. AN UNKNOWN KIND IS STILL SHOWN. The server's vocabulary has grown once
 *     already (`definition_changed` arrived after the first three). A card
 *     that renders only the kinds it recognises would silently hide the newest
 *     class of alert — the exact failure this feature exists to prevent.
 *  2. A MISSING COUNT IS NOT ZERO. `prior_count`/`new_count` are integers on
 *     the wire, but the card must never say "0 members" about a number it
 *     did not receive. Absent counts drop out of the sentence entirely.
 */
import { transitionLabel } from "@/lib/direction";
import { num, plural } from "@/lib/format";

export type DecayTone = "danger" | "warning" | "info";

export interface DecayKindPresentation {
  label: string;
  tone: DecayTone;
}

const KINDS: Record<string, DecayKindPresentation> = {
  size_cliff: { label: "Size cliff", tone: "danger" },
  zero_match: { label: "Matches nobody", tone: "danger" },
  everyone_match: { label: "Matches everyone", tone: "warning" },
  definition_changed: { label: "Definition changed", tone: "info" },
};

/**
 * Title-case an unrecognised `snake_case` kind so a new server anomaly still
 * reads as a label rather than as a database value.
 */
function humanizeKind(kind: string): string {
  const words = kind.replace(/[_-]+/gu, " ").trim();
  if (!words) return "Anomaly";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function decayKindPresentation(kind: string): DecayKindPresentation {
  const known = KINDS[kind];
  if (known) return known;
  return { label: humanizeKind(kind), tone: "warning" };
}

/**
 * The sentence under the label: what actually happened to the audience.
 *
 * Returns "" when the server sent neither count — better nothing than a
 * fabricated transition.
 */
export function decayChangeSentence(event: {
  priorCount: number | null;
  newCount: number | null;
  leaverCount: number | null;
  entrantCount: number | null;
}): string {
  const { priorCount, newCount } = event;
  const parts: string[] = [];
  if (priorCount != null && newCount != null) {
    // `transitionLabel`, not a literal arrow: a baked-in "→" points the wrong
    // way once the layout mirrors (src/lib/direction.consistency.test.ts).
    parts.push(`${transitionLabel(num(priorCount), num(newCount))} members`);
  } else if (newCount != null) {
    parts.push(plural(newCount, "member"));
  } else if (priorCount != null) {
    parts.push(`was ${plural(priorCount, "member")}`);
  }
  const movement: string[] = [];
  if (event.leaverCount != null && event.leaverCount > 0) {
    movement.push(`${num(event.leaverCount)} left`);
  }
  if (event.entrantCount != null && event.entrantCount > 0) {
    movement.push(`${num(event.entrantCount)} entered`);
  }
  if (movement.length > 0) parts.push(movement.join(", "));
  return parts.join(" · ");
}
