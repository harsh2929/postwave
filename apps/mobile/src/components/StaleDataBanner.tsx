/**
 * StaleDataBanner — a slim inline notice for the stale-while-error case:
 * a background refetch failed but we still have the last successful data on
 * screen. Showing the full-bleed ErrorState here would wrongly imply total
 * failure (and stack a big card on top of perfectly good rows), so screens
 * render this thin warning strip above the list instead — "showing the last
 * loaded copy, tap to retry" — and keep the cached content visible.
 *
 *   {q.isError && rows.length > 0 ? (
 *     <StaleDataBanner onRetry={() => void q.refetch()} />
 *   ) : null}
 */
import { Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface StaleDataBannerProps {
  /** Retry handler (typically a query's refetch). */
  onRetry?: () => void;
  /** Optional override for the lead message. */
  message?: string;
  /**
   * Optional override for the spoken label. The default asserts that a
   * refresh FAILED, which is wrong for the offline-with-cached-rows case
   * (nothing failed — no request was made), and a screen reader must not be
   * told a different story from the one on screen. Sighted callers passing
   * only `message` keep the default.
   */
  accessibilityLabel?: string;
}

function withAlpha(hex: string, alpha: number): string {
  if (!hex.startsWith("#") || hex.length !== 7) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function StaleDataBanner({
  onRetry,
  message,
  accessibilityLabel,
}: StaleDataBannerProps) {
  const { t } = useTheme();
  return (
    <View
      accessibilityRole="alert"
      accessibilityLabel={
        accessibilityLabel ??
        "Showing previously loaded data; latest refresh failed"
      }
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        backgroundColor: withAlpha(t.warning, 0.14),
        borderColor: withAlpha(t.warning, 0.35),
        borderWidth: 1,
        borderRadius: 12,
        paddingVertical: 10,
        paddingHorizontal: 12,
        marginBottom: 12,
      }}
    >
      <Text
        {...typeCap("label")}
        style={{
          flex: 1,
          color: t.warning,
          ...typeStyle("label"),
          fontFamily: FONT.medium,
        }}
      >
        {message ?? "Couldn’t refresh — showing the last loaded copy."}
      </Text>
      {onRetry ? (
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Retry"
          hitSlop={8}
          style={{ opacity: 1}}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: t.warning,
              ...typeStyle("label"),
              fontFamily: FONT.bold,
              textDecorationLine: "underline",
            }}
          >
            Retry
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
