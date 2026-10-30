/**
 * lib/shellStyleTokens.ts — the shell's card and section-label geometry, in ONE
 * place.
 *
 * The shell carried three near-miss definitions of each. Section labels:
 * `SectionLabel.tsx` (11/600/0.6, 24 over / 10 under), `SettingsScreenPrimitives`
 * `SectionHeader` (11/600/0.6, 20 over / 8 under) and a local factory in
 * `more.tsx` (letterSpacing 0.5, 4 under). Cards: `Card.tsx` (radius 16,
 * padding 16), the settings `Card` (radius 16, padding 14) and `more.tsx`'s
 * `cardOuter` (radius 12). Nobody chose those differences; they accumulated —
 * and the shell is exactly where inconsistency is most visible, because a user
 * crosses all three surfaces in a single session.
 *
 * This module is deliberately IMPORT-FREE (no react-native, no theme) so the
 * values are unit-testable in the node vitest environment — the same reason
 * `approvalPolicy`, `chartScale` and `feedbackPolicy` are pure. Colour still
 * comes from the runtime theme at the point of use; only geometry lives here.
 */

/** Type-only mirrors of the react-native style unions we emit. */
type FontWeight = "600";
type TextTransform = "uppercase";

/**
 * Section-label typography. Uppercase 11px at 600 with generous tracking — the
 * app's established "this is a group heading" signal.
 */
export const SECTION_LABEL_TEXT = {
  fontSize: 11,
  fontWeight: "600" as FontWeight,
  letterSpacing: 0.6,
  textTransform: "uppercase" as TextTransform,
} as const;

/**
 * The label above a control INSIDE a card (a field, a chip row). Same family
 * as a section label, one notch tighter, and previously re-declared in four
 * settings components with two different letter-spacings.
 */
export const FIELD_LABEL_TEXT = {
  fontSize: 11,
  fontWeight: "600" as FontWeight,
  letterSpacing: 0.5,
  textTransform: "uppercase" as TextTransform,
} as const;

/** Vertical rhythm for a section label on a scrolling screen. */
export const SECTION_LABEL_RHYTHM = {
  marginTop: 24,
  marginBottom: 10,
} as const;

/**
 * Tighter rhythm for dense stacks (Settings renders 14 of these), so the
 * difference is a stated variant rather than an accident.
 */
export const SECTION_LABEL_RHYTHM_COMPACT = {
  marginTop: 20,
  marginBottom: 8,
} as const;

/** Card geometry. `compact` trims the padding for dense settings groups. */
export const CARD_GEOMETRY = {
  default: { borderRadius: 16, padding: 16 },
  compact: { borderRadius: 16, padding: 14 },
} as const;

export type CardVariant = keyof typeof CARD_GEOMETRY;

/** Every card in the shell shares one corner radius. */
export const CARD_RADIUS = CARD_GEOMETRY.default.borderRadius;

/**
 * Bottom padding for a screen's scroll container.
 *
 * Five screens carried five different values (24, 24, 24, 32, 32) that nobody
 * chose. This is the one value, and the comment is the answer to the obvious
 * follow-up question:
 *
 *   it is NOT derived from `useSafeAreaInsets().bottom`, on purpose.
 *
 * Every screen in the app renders inside the bottom-tab navigator, and the tab
 * bar already consumes the inset (`tabBarStyle.paddingBottom = bottomInset`,
 * lib/tabBarChrome.ts). The scroll view's content area therefore ENDS above the
 * tab bar, never under the home indicator — adding the inset again here would
 * open a second gap the same height as the first on exactly the devices that
 * can least afford it. What this constant buys is breathing room under the last
 * row, which is a typographic decision, not a safe-area one.
 */
export const SCREEN_SCROLL_PADDING_BOTTOM = 28;
