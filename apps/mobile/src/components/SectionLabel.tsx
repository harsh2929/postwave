/**
 * SectionLabel — the small uppercase label that introduces a section
 * (e.g. "RECENT CAMPAIGNS", "ACCOUNT").
 *
 * The single source of truth for the 11px / 600 / letter-spacing-0.6 heading.
 * The `subtitle` and `compact` props exist so the Settings screen's
 * `SectionHeader` (its own 11/600/0.6 copy with a tighter rhythm) and the More
 * screen's local factory could both fold into this component instead of
 * remaining three near-miss definitions of the same thing. Geometry comes from
 * lib/shellStyleTokens so the values are unit-testable in the node env.
 */
import { Text, View } from "react-native";
import type { ReactNode } from "react";

import { FONT } from "@/lib/fonts";
import {
  SECTION_LABEL_RHYTHM,
  SECTION_LABEL_RHYTHM_COMPACT,
  SECTION_LABEL_TEXT,
} from "@/lib/shellStyleTokens";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

interface SectionLabelProps {
  children: ReactNode;
  /** Optional right-side slot (e.g. a "see all" link). */
  right?: ReactNode;
  /** Optional muted line under the label, explaining the group. */
  subtitle?: string | undefined;
  /** Tighter rhythm for dense stacks (Settings renders 14 of these). */
  compact?: boolean;
  /** Top margin override. Defaults to the shared rhythm; pass 0 for the very
   *  first section on a screen. */
  topMargin?: number;
}

export function SectionLabel({
  children,
  right,
  subtitle,
  compact = false,
  topMargin,
}: SectionLabelProps) {
  const { t } = useTheme();
  const rhythm = compact ? SECTION_LABEL_RHYTHM_COMPACT : SECTION_LABEL_RHYTHM;
  return (
    <View
      style={{
        marginTop: topMargin ?? rhythm.marginTop,
        marginBottom: rhythm.marginBottom,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Text
          // Without this the label is plain text, so VoiceOver's rotor has no
          // headings to jump between and a long screen (the analytics stack is
          // five sections) can only be traversed element by element.
          accessibilityRole="header"
          // A section heading is PROSE, not chrome: it sits on its own row with
          // no numberOfLines, so it wraps rather than clips and earns the loose
          // caption ceiling. `caption` and SECTION_LABEL_TEXT agree on 11pt;
          // the token still owns weight/tracking/case, the role adds leading
          // and the Dynamic Type ceiling.
          {...typeCap("caption")}
          style={{
            ...typeStyle("caption"),
            ...SECTION_LABEL_TEXT,
            color: t.fgMuted,
            fontFamily: FONT.semibold,
          }}
        >
          {children}
        </Text>
        {right}
      </View>
      {subtitle ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            marginTop: 2,
            fontFamily: FONT.regular,
          }}
        >
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}
