/**
 * SuppressionListFooter — the honest end of the suppression list.
 *
 * Two things sit below the last row, and they belong together because either
 * one alone is misleading:
 *
 *  - THE SCOPE NOTE. "Newest first" over what is LOADED is not "the newest
 *    record in the workspace". The sentence says so rather than letting the
 *    ordering imply an archive-wide guarantee it cannot make.
 *  - "LOAD MORE". The read has always accepted `page=`; until the archive was
 *    browsable the 51st-newest suppression could only be reached by guessing
 *    its exact address. `useSuppressionList` decides whether another page
 *    exists (it never offers one over an offline snapshot); this only renders
 *    the control.
 *
 * Lifted out of app/(tabs)/suppressions/index.tsx when the paging work pushed
 * that screen's component past the 300-line function budget. It is pure
 * presentation: every decision arrives as a prop.
 */
import { Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import type { ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface SuppressionListFooterProps {
  /** Empty string when the loaded rows ARE the whole result set. */
  scopeNote: string;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  t: ThemeTokens;
}

export function SuppressionListFooter({
  scopeNote,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  t,
}: SuppressionListFooterProps) {
  if (!scopeNote && !hasNextPage) return null;
  return (
    <View style={{ paddingTop: 12 }}>
      {scopeNote ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {scopeNote}
        </Text>
      ) : null}
      {hasNextPage ? (
        <Pressable
          onPress={onLoadMore}
          disabled={isFetchingNextPage}
          accessibilityRole="button"
          accessibilityLabel="Load more suppressions"
          accessibilityState={{
            disabled: isFetchingNextPage,
            busy: isFetchingNextPage,
          }}
          // NativeWind v4: a static style object. The function form
          // silently drops layout on Pressable.
          style={{
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: isFetchingNextPage ? t.fgSubtle : t.accent,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            {isFetchingNextPage ? "Loading…" : "Load more suppressions"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
