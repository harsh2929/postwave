/**
 * direction — which way "forward" points, in ONE place.
 *
 * THE DEFECT THIS FIXES. React Native mirrors LAYOUT under an RTL locale
 * (`flexDirection: row` reverses, `start`/`end` swap) but it cannot mirror a
 * glyph that is baked into a STRING. The audit found three shapes of that:
 *
 *   - a transition arrow inside rendered copy — `"enabled → blocklisted"` in
 *     the subscriber history card, the audit diff line, the DMARC window
 *     label. Mirrored layout puts the "after" value on the LEFT while the
 *     arrow still points right, so the sentence reads backwards;
 *   - a breadcrumb separator — `segmentAst`'s `" › "` join;
 *   - a chevron drawn as a rotated border, which `ScreenHeader` already
 *     handles via `I18nManager.isRTL` and is the model this module follows.
 *
 * WHY A MODULE-LEVEL FLAG RATHER THAN READING `I18nManager` HERE. The strings
 * above are produced by PURE modules (`subscriberRecordHistory`, `segmentAst`,
 * `dmarcView`, `auditDiff`) whose whole value is that they are unit-tested in
 * the node environment — importing react-native would end that. So this module
 * is import-free and the app publishes the platform's answer into it once at
 * startup, exactly as `lib/format` does for the locale:
 *
 *     setLayoutDirection(I18nManager.isRTL)   // useAppBootstrap
 *
 * Default LTR. An app that never calls the setter behaves exactly as it did
 * before, which is the correct failure mode: a wrong-way arrow is worse than a
 * conservative one.
 */

let rtl = false;

/**
 * Publish the platform's layout direction. Call once at startup with
 * `I18nManager.isRTL`; safe to call again if the app ever supports switching
 * direction without a reload.
 */
export function setLayoutDirection(isRTL: boolean): void {
  rtl = isRTL === true;
}

/** True when the app is laid out right-to-left. */
export function isRTLLayout(): boolean {
  return rtl;
}

/**
 * The arrow that means "becomes" / "goes to", pointing the way reading
 * travels: `→` in LTR, `←` in RTL.
 */
export function forwardArrow(): string {
  return rtl ? "←" : "→";
}

/**
 * The breadcrumb / drill-in separator: `›` in LTR, `‹` in RTL. Use for a
 * PATH between two names, not as a decorative bullet.
 */
export function forwardChevron(): string {
  return rtl ? "‹" : "›";
}

/**
 * `"enabled → blocklisted"`, with the arrow pointing the right way.
 *
 * Both sides are rendered as given; only the connector flips. Callers that
 * have no "from" should render `to` on its own rather than passing an empty
 * string — "→ blocklisted" reads as a truncated sentence.
 */
export function transitionLabel(from: string, to: string): string {
  return `${from} ${forwardArrow()} ${to}`;
}

/** Join path segments with the direction-correct chevron. */
export function pathLabel(segments: readonly string[]): string {
  return segments.join(` ${forwardChevron()} `);
}
