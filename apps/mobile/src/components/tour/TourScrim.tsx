/**
 * TourScrim — the tour's full-screen tap blocker, and its way out.
 *
 * The original rule, kept here with the code it governs:
 *
 *   "Full-screen tap-blocker behind everything. We DON'T dismiss on tap-out —
 *    the design calls for explicit Skip/Next/Back."
 *
 * That held as long as Skip/Next/Back were reachable. They were not. A
 * coach-mark anchored low on the Dashboard put the whole card — body copy and
 * both buttons — below the bottom edge of the screen, and a scrim that
 * swallows every tap turned a misplaced card into a trap with no exit but
 * force-quitting the app. The accessibility tree while it was up held three
 * elements, none of them a control.
 *
 * `@/lib/tourTooltipPlacement` fixes the placement. This is the BACKSTOP for
 * whatever placement bug comes next: a scrim tap dismisses the tour, and it
 * carries a button role and a label so the escape exists in the
 * accessibility tree too, not only under a sighted finger.
 *
 * Dismissal here means SKIP — the same call the card's own "Skip" button
 * makes. That is deliberate: skipping is the component's existing vocabulary
 * for "the person chose to stop", and it records the decision for the person
 * (server-side, shared across their devices) rather than quietly closing the
 * overlay and asking again on the next cold start.
 *
 * ONE SCRIM, INCLUDING THE HOLE. The spotlight cut-out is painted by four
 * `pointerEvents="none"` rects on top of this view, so a tap on the
 * highlighted element lands here too and skips the tour. That is the trade we
 * want: the alternative is a swallowed tap in the exact spot the copy invites
 * people to press ("Tap any card to drill in"), which is how the trap read to
 * the person who hit it. Taps on the card itself never reach here — it is a
 * sibling above this view, not an ancestor, so the responder chain stops
 * there.
 */
import { Pressable, StyleSheet } from "react-native";

interface TourScrimProps {
  /** Called on a scrim tap. Wired to the tour's `skip`. */
  onDismiss: () => void;
}

export function TourScrim({ onDismiss }: TourScrimProps) {
  return (
    <Pressable
      // Static style, never the `({ pressed }) => …` form: the function style
      // silently drops layout under NativeWind v4, and this view IS its layout.
      style={StyleSheet.absoluteFillObject}
      onPress={onDismiss}
      accessibilityRole="button"
      accessibilityLabel="Skip tour"
      accessibilityHint="Closes the product tour"
      testID="tour-scrim"
    />
  );
}
