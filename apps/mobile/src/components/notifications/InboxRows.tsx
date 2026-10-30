/**
 * Inbox rows — the notification row and the inbox's empty/error/loading ladder.
 *
 * Split out of app/(tabs)/notifications.tsx so the screen stays under the
 * source budget while the inbox keeps its five-state ladder: an error is NEVER
 * rendered as "you're all caught up" (that would tell the user their inbox is
 * clear when the app simply could not ask), offline is its own message, the
 * first load is a skeleton, and only a SETTLED empty result says the inbox is
 * empty.
 *
 * NativeWind v4 gotcha: the row Pressable takes a STATIC style object.
 */
import { Pressable, Text, View } from "react-native";

import { type MobileNotification } from "@/api/notifications";
import { ErrorState } from "@/components/ErrorState";
import { SkeletonList } from "@/components/Skeleton";
import { type NotificationFilter } from "@/hooks/useNotificationFeed";
import { FONT } from "@/lib/fonts";
import { dateTime, relativeTime } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/**
 * A day boundary in the feed.
 *
 * `accessibilityRole="header"` is the load-bearing part: it puts the day into
 * VoiceOver's rotor, so a screen-reader user can jump from "Today" to
 * "Yesterday" instead of swiping through every row in between.
 */
export function InboxDayHeader({ title }: { title: string }) {
  const { t } = useTheme();
  return (
    <Text
      accessibilityRole="header"
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        fontFamily: FONT.bold,
        ...typeStyle("caption"),
        textTransform: "uppercase",
        letterSpacing: 0.6,
        marginTop: 10,
        marginBottom: 8,
      }}
    >
      {title}
    </Text>
  );
}

export function NotificationRow({
  item,
  onPress,
}: {
  item: MobileNotification;
  onPress: () => void;
}) {
  const { t } = useTheme();
  const unread = !item.read_at;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      // The dot is the ONLY unread signal, and a colour with no text is
      // invisible to a screen reader and to colour-blind users alike.
      accessibilityLabel={`${unread ? "Unread. " : ""}${item.title}`}
      accessibilityHint={item.body}
      style={{
        flexDirection: "row",
        gap: 10,
        backgroundColor: t.surface,
        borderColor: t.border,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 14,
        paddingVertical: 12,
        // A DECLARED tap-target floor (LOVE#74). The row cleared 44pt only
        // because of the font sizes it happens to render today: 12pt of
        // padding around a 15pt title. Drop Dynamic Type to its smallest
        // step, or reduce the row to a single short line, and it silently
        // fell under the threshold with nothing enforcing it.
        minHeight: 60,
        marginBottom: 8,
      }}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          marginTop: 6,
          backgroundColor: unread ? t.accent : "transparent",
        }}
      />
      <View style={{ flex: 1 }}>
        <Text
          numberOfLines={2}
          {...typeCap("body")}
          style={{
            color: t.fg,
            fontFamily: unread ? FONT.semibold : FONT.medium,
            ...typeStyle("body"),
          }}
        >
          {item.title}
        </Text>
        {item.body ? (
          <Text
            numberOfLines={2}
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              fontFamily: FONT.regular,
              ...typeStyle("bodySmall"),
              marginTop: 2,
            }}
          >
            {item.body}
          </Text>
        ) : null}
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            fontFamily: FONT.regular,
            ...typeStyle("label"),
            marginTop: 4,
          }}
        >
          {/* Relative AND absolute: "96d ago" made the reader do arithmetic
              a date does for them. */}
          {relativeTime(item.created_at)} · {dateTime(item.created_at)}
        </Text>
      </View>
    </Pressable>
  );
}

export function InboxEmpty({
  gateEnabled,
  isError,
  error,
  isLoading,
  filter,
  onRetry,
}: {
  gateEnabled: boolean;
  isError: boolean;
  error: unknown;
  isLoading: boolean;
  filter: NotificationFilter;
  onRetry: () => void;
}) {
  const { t } = useTheme();
  // An error is NEVER "you're all caught up" — that would tell the user their
  // inbox is clear when the app simply couldn't ask.
  if (isError) {
    return (
      <View style={{ paddingTop: 24 }}>
        {/* Status-aware copy: a 401 says "sign in again" and drops the retry
            button instead of offering one that can never succeed. */}
        <ErrorState error={error} onRetry={onRetry} />
      </View>
    );
  }
  if (!gateEnabled) {
    return (
      <View style={{ paddingTop: 24 }}>
        <ErrorState message="Notifications need a connection — reconnect to load your feed." />
      </View>
    );
  }
  if (isLoading) {
    return (
      <View style={{ paddingTop: 8 }}>
        <SkeletonList rows={6} label="Loading notifications" />
      </View>
    );
  }
  return (
    <Text
      {...typeCap("callout")}
      style={{
        color: t.fgSubtle,
        fontFamily: FONT.regular,
        ...typeStyle("callout"),
        textAlign: "center",
        paddingVertical: 48,
      }}
    >
      {filter === "unread"
        ? "Nothing unread."
        : "You're all caught up."}
    </Text>
  );
}
