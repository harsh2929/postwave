/**
 * More-screen shared styles. Extracted so the screen, the workspace identity
 * card and the row list use ONE card radius and ONE section-label rhythm —
 * the shell previously carried three near-miss variants of each.
 */
import { FONT } from "@/lib/fonts";
import { CARD_GEOMETRY, SECTION_LABEL_TEXT } from "@/lib/shellStyleTokens";
import { useTheme } from "@/lib/theme";

type ThemeTokens = ReturnType<typeof useTheme>["t"];

/** Same geometry as <Card>; only the screen-edge margins are local. */
export const cardOuter = (t: ThemeTokens) => ({
  marginHorizontal: 12,
  marginBottom: 24,
  ...CARD_GEOMETRY.default,
  backgroundColor: t.surface,
  borderWidth: 1,
  borderColor: t.borderSubtle,
});

/**
 * Same typography as <SectionLabel>; only the rhythm is local, because these
 * labels sit INSIDE a card rather than between sections.
 */
export const sectionLabel = (t: ThemeTokens) =>
  ({
    ...SECTION_LABEL_TEXT,
    color: t.fgSubtle,
    fontFamily: FONT.semibold,
    marginBottom: 4,
  }) as const;

export const iconTile = (t: ThemeTokens) => ({
  width: 36,
  height: 36,
  borderRadius: 8,
  backgroundColor: t.bgSubtle,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  marginEnd: 12,
});
