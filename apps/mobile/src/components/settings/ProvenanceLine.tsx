/**
 * ProvenanceLine — the muted "Updated 2 hours ago" run under an admin card.
 *
 * Renders null when the server gave no usable timestamp, so a call site can
 * mount it unconditionally. See src/lib/settingsProvenance.ts for the rule
 * (including why it never guesses at an author it cannot prove).
 */
import { Text } from "react-native";

import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import { provenanceLabel } from "@/lib/settingsProvenance";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

export function ProvenanceLine({
  updatedAt,
  updatedByUserId,
}: {
  updatedAt?: string | null | undefined;
  updatedByUserId?: string | null | undefined;
}) {
  const { t } = useTheme();
  const currentUserId = useAuthStore((s) => s.session?.userId ?? null);
  const label = provenanceLabel(
    { updatedAt, updatedByUserId, currentUserId },
    relativeTime,
  );
  if (!label) return null;
  return (
    <Text
      accessibilityRole="text"
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        marginTop: 8,
        fontFamily: FONT.regular,
      }}
    >
      {label}
    </Text>
  );
}
