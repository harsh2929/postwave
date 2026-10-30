/**
 * LandingPageRow — one hosted page in the list.
 *
 * The row answers, before any tap: what is this page called, what is its public
 * slug, is it LIVE right now, and when was it last touched. It deliberately
 * does NOT claim a lead count. There is no cross-page rollup anywhere in the
 * API — leads come from `GET /{id}/leads`, one page at a time — and the
 * `metrics` column that looks like it would carry one is never written by any
 * writer in the repository. Printing "0 leads" from an empty `{}` would be a
 * manufactured zero on every row in the workspace. The count appears when you
 * open a page, from the request that can actually answer it.
 *
 * TIME IS SHOWN TWICE, DIFFERENTLY. Sighted users get the compacted relative
 * form ("2d ago"); the accessibility label carries the absolute date, because
 * the compaction is exactly what a screen-reader user cannot recover.
 *
 * NativeWind v4 gotcha: static Pressable style objects only — a function-style
 * `style={({pressed}) => …}` silently drops layout on this stack.
 */
import { memo } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { dateTime, relativeTime } from "@/lib/format";
import {
  landingStatusPresentation,
  publicLandingPath,
  type MobileLandingPage,
} from "@/lib/landingPages";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

export interface LandingPageRowProps {
  page: MobileLandingPage;
  onPress: (page: MobileLandingPage) => void;
  /** `Date.now()` from the screen's ticker so "2d ago" stays honest. */
  now: number;
}

function LandingPageRowImpl({ page, onPress, now }: LandingPageRowProps) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  const status = landingStatusPresentation(page.status);

  const name = page.name || "Untitled page";
  // The slug is what appears in the URL a colleague pastes into chat, so it is
  // shown as the path it actually becomes rather than as a bare word.
  const path = page.slug ? publicLandingPath(page.slug) : "";
  const updated = page.updatedAt
    ? `Updated ${relativeTime(page.updatedAt, { now })}`
    : "No update recorded";
  const updatedSpoken = page.updatedAt
    ? `Last updated ${dateTime(page.updatedAt)}.`
    : "No update time was recorded.";

  return (
    <Pressable
      onPress={() => onPress(page)}
      accessibilityRole="button"
      accessibilityLabel={`${name}. ${
        path ? `Public path ${path}. ` : "No public path yet. "
      }${status.label}. ${updatedSpoken}`}
      accessibilityHint="Opens the page's public link and the leads it has captured"
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        paddingHorizontal: 14,
        paddingVertical: 12,
        marginBottom: 10,
        gap: 6,
        // 44pt touch-target floor. The content already exceeds it; stating it
        // keeps a future compaction from dropping below.
        minHeight: 44,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          numberOfLines={maxLinesAtScale(2, fontScale)}
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
            flexShrink: 1,
          }}
        >
          {name}
        </Text>
        <Pill
          label={status.label}
          tone={status.tone}
          accessibilityLabel={
            status.live
              ? "Published: this page is served publicly and can capture leads."
              : `${status.label}: this page is not served publicly, so it cannot capture leads.`
          }
        />
      </View>

      <Text
        numberOfLines={maxLinesAtScale(1, fontScale)}
        {...typeCap("mono")}
        style={{
          color: t.fgMuted,
          ...typeStyle("mono"),
          // Same monospace family every other copyable identifier in the app
          // uses (OutboundWebhookRow, ScimTokenCard): the slug is a URL
          // fragment, and a proportional face makes an l/1/I mistake invisible.
          fontFamily: "Menlo",
        }}
      >
        {path || "No slug yet"}
      </Text>

      <Text
        numberOfLines={maxLinesAtScale(1, fontScale)}
        {...typeCap("bodySmall")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {updated}
      </Text>

      {page.domain ? (
        <Text
          numberOfLines={maxLinesAtScale(1, fontScale)}
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          Custom domain: {page.domain}
        </Text>
      ) : null}
    </Pressable>
  );
}

export const LandingPageRow = memo(LandingPageRowImpl);
