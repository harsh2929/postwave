/**
 * SmsInboxParts — the inbox screen's stateless fragments.
 *
 * Moved out of `app/(tabs)/sms/index.tsx` unchanged when search, bulk
 * selection, and the reply-hold banner pushed that screen past the 450-line
 * source budget. The screen keeps every hook; these keep only paint.
 */
import { Pressable, Text } from "react-native";

import { haptics } from "@/lib/haptics";

import { FONT } from "@/lib/fonts";
import { dateTime } from "@/lib/format";
import type {
  SmsConversationFilter,
  SmsConversationStatus,
} from "@/lib/smsConversation";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function FreshnessLine({
  online,
  fetching,
  refreshFailed,
  restartRequired,
  snapshotAt,
  partial,
}: {
  online: boolean;
  fetching: boolean;
  refreshFailed: boolean;
  restartRequired: boolean;
  snapshotAt: string | null;
  partial: boolean;
}) {
  const { t } = useTheme();
  const text = !online
    ? `Offline · showing the last verified page set${snapshotAt ? ` · response cutoff ${dateTime(snapshotAt)}` : ""}`
    : refreshFailed && snapshotAt
      ? `Automatic refresh failed · showing the last verified page set · response cutoff ${dateTime(snapshotAt)}`
      : restartRequired
        ? `Loaded conversation history preserved · automatic refresh paused · pull to refresh to restart at the latest response cutoff${snapshotAt ? ` · current cutoff ${dateTime(snapshotAt)}` : ""}`
        : fetching
          ? "Restarting at the latest response cutoff…"
          : snapshotAt
            ? `Response cutoff ${dateTime(snapshotAt)}${partial ? " · more conversations are available" : " · no continuation returned for this filter; newer writes may still exist"}`
            : "Waiting for a verified response…";
  return (
    <Text
      accessibilityLiveRegion="polite"
      {...typeCap("caption")}
      style={{
        color: !online ? t.warning : t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.medium,
      }}
    >
      {text}
    </Text>
  );
}

export function LoadMoreButton({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={{ minHeight: 44, alignItems: "center", justifyContent: "center" }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: t.accent,
          ...typeStyle("control"),
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function emptyTitle(
  filter: SmsConversationFilter,
  status: SmsConversationStatus,
): string {
  if (filter === "unread") return "Nothing unread in this lifecycle";
  if (filter === "unknown") return "No unknown senders in this lifecycle";
  if (status === "snoozed") return "No snoozed conversations";
  if (status === "archived") return "No archived conversations";
  return "No conversations returned for this response cutoff";
}

/** The inbox header's Export affordance (audited CSV → share sheet). */
export function SmsExportHeaderButton({ onPress }: { onPress: () => void }) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel="Export conversations as CSV"
      hitSlop={8}
      style={{ minHeight: 44, justifyContent: "center" }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: t.accent,
          ...typeStyle("control"),
          fontFamily: FONT.semibold,
        }}
      >
        Export
      </Text>
    </Pressable>
  );
}
