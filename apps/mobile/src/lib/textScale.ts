/**
 * textScale — the app's Dynamic Type ceiling for DENSE tabular text.
 *
 * React Native scales every `Text` with the OS text-size setting, which is
 * correct for prose and destructive for a metadata row that already carries
 * two pills and a timestamp on a 375pt-wide phone: at the largest accessibility
 * sizes a `numberOfLines={1}` timestamp truncates to nothing, so the user who
 * turned the text UP to read it sees less than before.
 *
 * Rules for using it:
 *  - Apply to TABULAR / metadata text only (counts, timestamps, pill rows).
 *  - NEVER apply it to body copy, empty-state descriptions, field labels or
 *    error text; those must scale all the way.
 *
 * ── WHAT WAS REMOVED, AND WHY (GATE#6) ─────────────────────────────────────
 * This module used to say it "promotes" a local ceiling from
 * `app/(tabs)/voice.tsx` — that file no longer defines one, so the sentence was
 * describing a lineage that had been refactored away and pointed a reader at a
 * file with nothing to find.
 *
 * It also exported `METADATA_STACK_FONT_SCALE` and `shouldStackMetadata` as "the
 * shared threshold" for stacking a metadata row vertically. Nothing ever called
 * them: the only surviving mention was a comment in typeScale.ts citing their
 * fail-safe as precedent. A stated rule with no enforcement and no caller is worse
 * than no rule, because it reads as settled practice — `maxLinesAtScale` is what
 * the app actually does about large text, and it is real.
 */

/** The app-wide Dynamic Type ceiling for dense tabular text. */
export const MAX_TEXT_SCALE = 1.6;
