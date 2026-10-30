/**
 * The non-content chrome of the subscriber profile: the offline banner, the
 * cached-session notice, the first-load skeleton and the hard-error state.
 *
 * Lifted out of the route file so the screen reads as composition rather
 * than a 400-line function.
 */
import { Text, View } from "react-native";

import {
  CachedSessionNotice,
  type CachedSessionNoticeContent,
} from "@/components/CachedSessionNotice";
import { ErrorState } from "@/components/ErrorState";
import { SkeletonDetail } from "@/components/Skeleton";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SubscriberDetailChrome({
  isOnline,
  gateNotice,
  hasData,
  isLoading,
  isError,
  error,
  onRetry,
}: {
  isOnline: boolean;
  gateNotice: CachedSessionNoticeContent | null;
  hasData: boolean;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const { t } = useTheme();
  return (
    <>
      {!isOnline ? (
        <View
          accessibilityRole="alert"
          style={{
            backgroundColor: `${t.warning}1a`,
            borderColor: t.warning,
            borderWidth: 1,
            borderRadius: 12,
            paddingVertical: 8,
            paddingHorizontal: 12,
            marginBottom: 12,
          }}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: t.warning,
              ...typeStyle("label"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            Offline — showing the last cached snapshot.
          </Text>
        </View>
      ) : null}

      {gateNotice ? (
        <CachedSessionNotice
          notice={gateNotice}
          variant={hasData ? "stale" : "blocked"}
          style={{ marginBottom: 12 }}
        />
      ) : null}

      {/* Content-shaped first load; a background refetch keeps the profile
          the user is already reading. */}
      {isLoading && !hasData ? <SkeletonDetail sections={3} /> : null}
      {isError && !hasData ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : null}
    </>
  );
}
