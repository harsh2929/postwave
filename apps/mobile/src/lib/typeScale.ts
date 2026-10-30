/**
 * lib/typeScale.ts — the app's Dynamic Type contract, in ONE place.
 *
 * THE PROBLEM THIS REPLACES. Type in this app was ~14 hardcoded pixel sizes
 * (11 / 11.5 / 12 / 12.5 / 13 / 13.5 / 14 / 15 / 16 / 17 / 18 / 20 / 24 / 30)
 * scattered across every component, and the Dynamic Type ceiling was a
 * hand-picked magic number per call site — 1.3 here, 1.4 there, 1.6 and 1.8
 * elsewhere, with most `Text` nodes carrying no ceiling at all. That is two
 * separate decisions (how big is this text / how far may the user grow it)
 * taken independently, hundreds of times, by whoever wrote the screen.
 *
 * THE MODEL. A role names a piece of text by its JOB, and carries all three
 * numbers together:
 *
 *    fontSize + lineHeight + maxFontSizeMultiplier
 *
 * The multiplier is the part that is easy to get wrong. React Native scales
 * every `Text` by the OS text-size setting, and at the largest accessibility
 * sizes that multiplier is roughly 3x. Body copy SHOULD go most of that way —
 * the user asked for bigger text and prose reflows to accommodate it. A 30pt
 * dashboard figure inside a stat tile must NOT: at 3x it is 90pt, and the tile
 * (and the two-column grid it lives in) is destroyed. So the scale has two
 * families:
 *
 *  - PROSE roles reflow. They get generous ceilings, and the ceiling gets
 *    LOOSER as the base size gets smaller — an 11pt caption at 2.1x is 23pt and
 *    perfectly happy, while a 24pt screen title at 2.1x is 50pt and is not.
 *    That inverse relationship is asserted in the colocated test.
 *  - DENSE roles live in geometry that cannot reflow: a stat tile, a status
 *    pill with a `maxWidth`, a tabular figure sharing a row with two others.
 *    Every dense ceiling is at or below the TIGHTEST prose ceiling, and at or
 *    below `MAX_TEXT_SCALE` from ./textScale, the app-wide dense
 *    ceiling expressed as a bare number for call sites that pre-date this file.
 *
 * The two modules are complements, not rivals: `textScale` answers "how far may
 * dense text grow, and when should a metadata row stack instead"; this one
 * answers "what IS this text, and therefore how big is it and how far may it
 * grow". New code should reach for a role here.
 *
 * DELIBERATELY IMPORT-FREE. No react-native, no theme, no `./connectivity`.
 * That is what makes it testable in the node vitest environment, for the same
 * reason `approvalPolicy`, `chartScale`, `feedbackPolicy` and `shellStyleTokens`
 * are pure. Colour and font family still come from the runtime theme and
 * `lib/fonts` at the point of use; only the type metrics live here.
 */

/**
 * `prose` reflows and may grow a long way; `dense` is pinned inside geometry
 * that cannot grow with it.
 */
export type TypeDensity = "prose" | "dense";

export interface TypeRoleSpec {
  /** Base size at the OS default text setting. */
  readonly fontSize: number;
  /** Always >= fontSize. RN scales leading with the font, so this is a ratio. */
  readonly lineHeight: number;
  /** Hard ceiling on the OS text-size multiplier for this role. */
  readonly maxFontSizeMultiplier: number;
  readonly density: TypeDensity;
}

const ROLES = {
  // ---- PROSE ladder, largest to smallest -------------------------------
  /** Screen title (ScreenHeader). */
  display: {
    fontSize: 24,
    lineHeight: 29,
    maxFontSizeMultiplier: 1.4,
    density: "prose",
  },
  /** Sheet / modal title. */
  title: {
    fontSize: 20,
    lineHeight: 26,
    maxFontSizeMultiplier: 1.5,
    density: "prose",
  },
  /** Card and empty-state headline. */
  heading: {
    fontSize: 17,
    lineHeight: 23,
    maxFontSizeMultiplier: 1.6,
    density: "prose",
  },
  /** The app's reading size: list row titles, inputs, primary copy. */
  body: {
    fontSize: 15,
    lineHeight: 21,
    maxFontSizeMultiplier: 1.8,
    density: "prose",
  },
  /** One step under body: control labels, toast copy, sheet messages. */
  callout: {
    fontSize: 14,
    lineHeight: 19,
    maxFontSizeMultiplier: 1.9,
    density: "prose",
  },
  /** Secondary copy: subtitles, descriptions, hints. */
  bodySmall: {
    fontSize: 13,
    lineHeight: 18,
    maxFontSizeMultiplier: 2,
    density: "prose",
  },
  /** Small supporting text that still wraps: banners, field sublabels. */
  label: {
    fontSize: 12,
    lineHeight: 17,
    maxFontSizeMultiplier: 2.1,
    density: "prose",
  },
  /** The smallest prose step: uppercase section headings, footnotes. */
  caption: {
    fontSize: 11,
    lineHeight: 15,
    maxFontSizeMultiplier: 2.1,
    density: "prose",
  },

  // ---- DENSE roles: pinned geometry ------------------------------------
  /**
   * The hero number in a stat tile. The tightest ceiling in the scale: the
   * tile is one cell of a fixed two-column grid, so this is the one role where
   * unbounded growth breaks the PAGE and not just the element.
   */
  figure: {
    fontSize: 30,
    lineHeight: 34,
    maxFontSizeMultiplier: 1.25,
    density: "dense",
  },
  /**
   * The label of a compact control that shares a row with its siblings — a
   * segmented control's segments, a toolbar button. It is a control label, so
   * it reads like body copy, but it cannot reflow: the segments divide one
   * row's width between them.
   */
  control: {
    fontSize: 13,
    lineHeight: 18,
    maxFontSizeMultiplier: 1.4,
    density: "dense",
  },
  /** Tabular figures sharing a row: deltas, counts, timestamps. */
  numeric: {
    fontSize: 12,
    lineHeight: 16,
    maxFontSizeMultiplier: 1.4,
    density: "dense",
  },
  /** IDs, keys, signing secrets — content the user copies, never reflows. */
  mono: {
    fontSize: 13,
    lineHeight: 19,
    maxFontSizeMultiplier: 1.4,
    density: "dense",
  },
  /**
   * Status pill / chip label at the standard size. Shares its step with
   * `numeric` today; they are separate roles because a pill and a figure are
   * separate decisions and either may move without the other.
   */
  badge: {
    fontSize: 12,
    lineHeight: 16,
    maxFontSizeMultiplier: 1.4,
    density: "dense",
  },
  /** The compact pill, the uppercase tile label, the count bubble. */
  badgeSmall: {
    fontSize: 11,
    lineHeight: 15,
    maxFontSizeMultiplier: 1.4,
    density: "dense",
  },
  /**
   * The tab bar label. The tightest chrome ceiling in the scale, because the
   * tab bar is the one surface where growing text pushes the ICON out of a bar
   * whose height is computed once — see `tabBarHeightFor`, which derives that
   * height from this role instead of leaving it a literal.
   */
  tabLabel: {
    fontSize: 11,
    lineHeight: 13,
    maxFontSizeMultiplier: 1.3,
    density: "dense",
  },
} as const;

export type TypeRole = keyof typeof ROLES;

/** The full scale. Prefer the `typeStyle` / `typeCap` helpers at call sites. */
export const TYPE: Readonly<Record<TypeRole, TypeRoleSpec>> = ROLES;

/**
 * The prose ladder in order, LARGEST first. The ordering is load-bearing: the
 * test asserts sizes strictly decrease while ceilings never decrease, which is
 * the invariant that stops someone adding a 28pt role with a 2x ceiling.
 */
export const PROSE_LADDER: readonly TypeRole[] = [
  "display",
  "title",
  "heading",
  "body",
  "callout",
  "bodySmall",
  "label",
  "caption",
];

/** Roles whose container cannot reflow. */
export const DENSE_ROLES: readonly TypeRole[] = [
  "figure",
  "control",
  "numeric",
  "mono",
  "badge",
  "badgeSmall",
  "tabLabel",
];

/**
 * No role may exceed this. It exists so "body copy scales freely" still means
 * something FINITE — an uncapped `Text` is how a single label pushes a button
 * label off its own button at the largest accessibility size.
 */
export const MAX_ROLE_SCALE = 2.2;

const STYLES = buildStyles();
const CAPS = buildCaps();

/**
 * Spread into a `Text` STYLE: `style={{ ...typeStyle("body"), color: t.fg }}`.
 *
 * Returns a shared frozen object, so spreading it per render costs one object
 * copy rather than an allocation of the metrics themselves.
 */
export function typeStyle(role: TypeRole): {
  readonly fontSize: number;
  readonly lineHeight: number;
} {
  return STYLES[role];
}

/**
 * Spread onto a `Text` as PROPS: `<Text {...typeCap("body")} …>`.
 *
 * Separate from `typeStyle` because `maxFontSizeMultiplier` is a prop, not a
 * style — putting it in the style object silently does nothing.
 */
export function typeCap(role: TypeRole): {
  readonly maxFontSizeMultiplier: number;
} {
  return CAPS[role];
}

/**
 * Just the size. For `TextInput`, where an explicit `lineHeight` mis-centres
 * the caret and clips descenders on Android, and for `adjustsFontSizeToFit`
 * text, where a fixed leading fights the shrink-to-fit pass.
 */
export function fontSizeFor(role: TypeRole): number {
  return ROLES[role].fontSize;
}

/**
 * Device font scale at which single-line chrome should be allowed an extra
 * line instead of truncating. Below this a title fits; above it, capping the
 * multiplier alone still leaves "Deliverability settings" as "Deliverab…".
 */
export const MULTILINE_FONT_SCALE = 1.3;

/**
 * `numberOfLines` for text that is single-line at the default size and must
 * not truncate to nothing when the user raises the OS text size.
 *
 * Non-numeric / non-finite input means "assume the default size", because
 * `useWindowDimensions()` can report a partially-populated object on the first
 * frame.
 */
export function maxLinesAtScale(baseLines: number, fontScale: unknown): number {
  const base = Math.max(1, Math.trunc(baseLines));
  const scaled =
    typeof fontScale === "number" &&
    Number.isFinite(fontScale) &&
    fontScale >= MULTILINE_FONT_SCALE;
  return scaled ? base + 1 : base;
}

/**
 * Content height of the tab bar, EXCLUDING the bottom safe-area inset.
 *
 * The bar was a literal `60`, chosen when the label was a fixed 11pt. That
 * constant is only correct at one text size: raise the OS setting and the
 * label grows inside a bar that cannot, so the label clips or shoulders the
 * icon out. Deriving it from the `tabLabel` role means the two numbers can no
 * longer disagree — and the role's own 1.3x ceiling bounds the growth, so the
 * bar gains at most a few points rather than tracking a 3x accessibility size.
 *
 * Usage in the tab layout:
 *   height: tabBarHeightFor(fontScale) + insets.bottom
 *   tabBarLabelStyle: { ...typeStyle("tabLabel"), marginTop: 2 }
 *   // plus maxFontSizeMultiplier from typeCap("tabLabel")
 */
export const TAB_BAR_BASE_HEIGHT = 60;

export function tabBarHeightFor(fontScale: unknown): number {
  const spec = ROLES.tabLabel;
  const raw =
    typeof fontScale === "number" && Number.isFinite(fontScale) && fontScale > 1
      ? fontScale
      : 1;
  const effective = Math.min(raw, spec.maxFontSizeMultiplier);
  return TAB_BAR_BASE_HEIGHT + Math.round(spec.lineHeight * (effective - 1));
}

function buildStyles(): Record<
  TypeRole,
  { readonly fontSize: number; readonly lineHeight: number }
> {
  const out = {} as Record<
    TypeRole,
    { readonly fontSize: number; readonly lineHeight: number }
  >;
  for (const role of Object.keys(ROLES) as TypeRole[]) {
    const spec = ROLES[role];
    out[role] = Object.freeze({
      fontSize: spec.fontSize,
      lineHeight: spec.lineHeight,
    });
  }
  return out;
}

function buildCaps(): Record<
  TypeRole,
  { readonly maxFontSizeMultiplier: number }
> {
  const out = {} as Record<
    TypeRole,
    { readonly maxFontSizeMultiplier: number }
  >;
  for (const role of Object.keys(ROLES) as TypeRole[]) {
    out[role] = Object.freeze({
      maxFontSizeMultiplier: ROLES[role].maxFontSizeMultiplier,
    });
  }
  return out;
}
