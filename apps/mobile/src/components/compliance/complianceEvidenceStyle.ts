/**
 * complianceEvidenceStyle — the one card/note style the Compliance screen's
 * evidence panels share, so a third copy of the border-radius block never
 * drifts from the first two.
 */
import type { TextStyle, ViewStyle } from "react-native";

import { useTheme } from "@/lib/theme";
import { FONT } from "@/lib/fonts";
import { typeStyle } from "@/lib/typeScale";

export function useComplianceCardStyle(): {
  card: ViewStyle;
  note: TextStyle;
} {
  const { t } = useTheme();
  return {
    card: {
      backgroundColor: t.surface,
      borderColor: t.border,
      borderWidth: 1,
      borderRadius: 12,
      padding: 12,
      marginBottom: 8,
      gap: 2,
    },
    note: {
      color: t.fgSubtle,
      ...typeStyle("caption"),
      fontFamily: FONT.regular,
    },
  };
}
