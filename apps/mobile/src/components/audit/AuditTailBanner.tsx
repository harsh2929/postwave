/**
 * AuditTailBanner — "N new events — tap to load".
 *
 * The mobile shape of desktop's live tail. It counts rather than inserts,
 * because a compliance log that reflows under the reader's thumb loses the
 * row they were reading; and it renders nothing at all when the tail is off
 * or nothing is new, so the screen does not carry a permanent empty strip.
 *
 * The spoken label is the full sentence rather than the compacted one — a
 * VoiceOver user gets "12 new audit events. Double tap to load them", not
 * a bare number they have to interpret.
 */
import { Pressable, Text } from "react-native";

import { FONT } from "@/lib/fonts";
import { auditTailLabel, type AuditTailState } from "@/lib/auditTail";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface AuditTailBannerProps {
  tail: AuditTailState;
  onLoad: () => void;
}

export function AuditTailBanner({ tail, onLoad }: AuditTailBannerProps) {
  const { t } = useTheme();
  const label = auditTailLabel(tail);
  if (!label) return null;
  const spokenCount = tail.atLeast
    ? `at least ${tail.count}`
    : `${tail.count}`;
  return (
    <Pressable
      onPress={onLoad}
      accessibilityRole="button"
      accessibilityLabel={`${spokenCount} new audit ${
        tail.count === 1 ? "event" : "events"
      }. Double tap to load them.`}
      style={{
        minHeight: 44,
        justifyContent: "center",
        alignItems: "center",
        borderRadius: 999,
        borderWidth: 1,
        borderColor: t.accent,
        backgroundColor: t.surface,
        paddingHorizontal: 14,
        paddingVertical: 8,
      }}
    >
      <Text
        {...typeCap("label")}
        style={{
          color: t.accent,
          ...typeStyle("label"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
