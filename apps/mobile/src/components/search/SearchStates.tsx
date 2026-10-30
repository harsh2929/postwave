/**
 * components/search/SearchStates.tsx — the non-result states of the search
 * screen: trouble, empty, and the footer caveat.
 *
 * The REACT half of the split whose pure half is `lib/searchScreenCopy.ts`.
 * These three lived at the bottom of `app/(tabs)/search.tsx`, which is a
 * launcher, a query owner and a SectionList host all at once; three
 * presentational components with no state of their own were the part of it
 * that had no reason to be there, and moving them is what puts the screen back
 * under its file budget.
 *
 * The LADDER ORDER inside each is the behaviour, not the styling: an error is
 * never an empty state, and offline is its own message because nothing is
 * broken — the device just can't ask.
 */
import { Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { SkeletonList } from "@/components/Skeleton";
import { FONT } from "@/lib/fonts";
import {
  searchEmptyCopy,
  searchFooterNotice,
  SEARCH_OFFLINE_NOTICE,
} from "@/lib/searchScreenCopy";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/**
 * The two states that must be stated whether or not the local palette
 * matched: the server search FAILED, or it was never asked because the gate is
 * closed. Rendered above the sections when there are any, and reused by
 * SearchEmpty so the two paths cannot drift apart.
 */
export function SearchTrouble({
  gateEnabled,
  searching,
  isError,
  error,
  onRetry,
}: {
  gateEnabled: boolean;
  searching: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  if (!searching) return null;
  if (isError) {
    return (
      <View style={{ paddingTop: 12, paddingBottom: 4 }}>
        {/* The error is handed over so a 401/403 gets its own copy and loses
            the Retry button that could never succeed (lib/errorCopy). */}
        <ErrorState error={error} onRetry={onRetry} compact />
      </View>
    );
  }
  if (!gateEnabled) {
    return (
      <View style={{ paddingTop: 12, paddingBottom: 4 }}>
        <ErrorState compact message={SEARCH_OFFLINE_NOTICE} />
      </View>
    );
  }
  return null;
}

export function SearchEmpty({
  gateEnabled,
  searching,
  isError,
  error,
  isLoading,
  onRetry,
}: {
  gateEnabled: boolean;
  searching: boolean;
  isError: boolean;
  error: unknown;
  isLoading: boolean;
  onRetry: () => void;
}) {
  const { t } = useTheme();
  // Ladder order matters: an error is NEVER an empty state, and offline is its
  // own message because nothing is broken — the device just can't ask.
  if (searching && isError) {
    return (
      <View style={{ paddingTop: 24 }}>
        <ErrorState error={error} onRetry={onRetry} />
      </View>
    );
  }
  if (searching && !gateEnabled) {
    return (
      <View style={{ paddingTop: 24 }}>
        <ErrorState message={SEARCH_OFFLINE_NOTICE} />
      </View>
    );
  }
  if (searching && isLoading) {
    return (
      <View style={{ paddingTop: 12 }}>
        <SkeletonList rows={4} label="Searching" />
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
        paddingVertical: 40,
      }}
    >
      {searchEmptyCopy(searching)}
    </Text>
  );
}

export function SearchFooter({
  partial,
  truncated,
  visible,
}: {
  partial: boolean;
  truncated: boolean;
  visible: boolean;
}) {
  const { t } = useTheme();
  const message = visible ? searchFooterNotice(partial, truncated) : null;
  if (!message) return null;
  return (
    <Text
      accessibilityRole="text"
      {...typeCap("label")}
      style={{
        color: t.fgSubtle,
        fontFamily: FONT.regular,
        ...typeStyle("label"),
        textAlign: "center",
        paddingTop: 12,
        paddingHorizontal: 8,
      }}
    >
      {message}
    </Text>
  );
}
