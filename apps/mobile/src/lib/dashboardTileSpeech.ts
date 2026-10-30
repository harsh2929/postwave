/**
 * lib/dashboardTileSpeech.ts — the sentence VoiceOver reads for one stat tile.
 *
 * It used to be a nested template literal inside the grid's JSX that glued
 * `", " + delta` and `". Unusual. " + reason` into the middle of an English
 * sentence. That is untranslatable by construction: the commas, the clause
 * ORDER and the position of the anomaly are all decisions a translator has to
 * be able to make, and none of them existed as text anywhere — they were
 * control flow. So the four possible shapes (anomaly × movement) are four
 * WHOLE frames in `lib/messagesEn`, and this picks between them.
 *
 * The English frames announce the anomaly FIRST after the value, before the
 * movement and the destination: a bounce spike is the reason to stop on this
 * tile, and burying it at the end means a VoiceOver user hears it last or
 * swipes past it. A translation is free to disagree — that is the point, and
 * `lib/dashboardMessages.test.ts` proves it by reordering every clause.
 *
 * Import-free of react-native/expo on purpose (its only import is `lib/i18n`,
 * whose only import is `lib/format`), so the rule is unit-tested under node.
 * The tile MODEL it reads lives in components/dashboard/statTiles.ts, which
 * cannot be loaded there — hence the structural type below rather than an
 * import of `Tile`.
 */
import { msg } from "@/lib/i18n";

/** The slice of a stat tile that reaches the spoken sentence. */
export interface SpokenTile {
  /** The tile's own name, e.g. "Bounce rate". */
  label: string;
  /**
   * The EXACT figure, not the compacted one printed on the tile. An unmeasured
   * value arrives as the "not reported" message, never as "0".
   */
  spoken: string;
  /** Where tapping the tile goes, e.g. "Open analytics". */
  destination: string;
  /** Movement against the previous window, already rendered. */
  delta?: { text: string } | null | undefined;
  anomaly?: boolean | undefined;
  anomalyReason?: string | undefined;
}

export function tileSpokenSentence(tile: SpokenTile): string {
  const base = {
    label: tile.label,
    value: tile.spoken,
    destination: tile.destination,
  };
  // An anomaly flag with no reason still changes the sentence — the badge is
  // on screen, so silence about it would leave a VoiceOver user with strictly
  // less than a sighted one. It degrades to the anomaly frame with an empty
  // reason rather than to the plain frame.
  const reason = tile.anomaly ? (tile.anomalyReason ?? "") : null;
  const delta = tile.delta?.text ?? null;
  if (reason !== null && delta !== null) {
    return msg("dashboard.tile.a11y.anomalyDelta", { ...base, reason, delta });
  }
  if (reason !== null) return msg("dashboard.tile.a11y.anomaly", { ...base, reason });
  if (delta !== null) return msg("dashboard.tile.a11y.delta", { ...base, delta });
  return msg("dashboard.tile.a11y", base);
}
