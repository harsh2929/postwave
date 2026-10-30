/**
 * ResumeCard — "Continue where you left off", phone side.
 *
 * The phone is usually the device you pick up SECOND, so this is the surface a
 * cross-device cursor was for — and the one that never read it. It offers one
 * tap back to whatever the user was last looking at on any of their devices.
 *
 * Self-gating, like ActiveSendStrip: renders nothing when there is no cursor,
 * when the user is signed out, or when the reference points at an entity this
 * app has no screen for. A fresh session and a failing endpoint therefore both
 * look like an ordinary dashboard rather than an empty box — the failure is
 * reported to telemetry instead of drawn on screen (see hooks/useActivityCursor).
 *
 * It names the entity TYPE ("Campaign · 12m ago"), never a title: the server
 * stores an id reference and no content, and showing a name would imply it
 * keeps something it deliberately does not.
 */
import { router } from "expo-router";
import { Pressable, Text, View } from "react-native";

import { resumeRoute, resumeTypeLabel } from "@/api/activityCursor";
import { useResumeCursor } from "@/hooks/useActivityCursor";
import { forwardChevron } from "@/lib/direction";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap } from "@/lib/typeScale";

/** Coarse "how long ago" — enough for a continuity hint, no clock precision. */
function viewedAgo(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const mins = Math.floor((Date.now() - at) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function ResumeCard() {
  const { t } = useTheme();
  const { data: cursor } = useResumeCursor();

  const href = cursor ? resumeRoute(cursor) : null;
  if (!cursor || !href) return null;

  const label = resumeTypeLabel(cursor);
  const ago = viewedAgo(cursor.viewed_at);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Continue where you left off: ${label}${
        ago ? `, viewed ${ago}` : ""
      }`}
      testID="resume-card"
      onPress={() => {
        haptics.tap();
        router.push(href as never);
      }}
      // Static style object: a function-style `style={({pressed}) => …}` on a
      // Pressable silently drops layout under NativeWind v4 in this app (see
      // scripts/fix-pressable-style.mjs), so pressed state is not expressed here.
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.surfaceElevated,
        borderRadius: 12,
        paddingVertical: 12,
        paddingHorizontal: 14,
        marginBottom: 12,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text
          style={{
            fontFamily: FONT.medium,
            fontSize: 14,
            color: t.fg,
          }}
          {...typeCap("body")}
        >
          Continue where you left off
        </Text>
        <Text
          style={{ fontFamily: FONT.regular, fontSize: 12, color: t.fgMuted }}
          {...typeCap("caption")}
          numberOfLines={1}
        >
          {label}
          {ago ? ` · ${ago}` : ""}
        </Text>
      </View>
      <Text
        aria-hidden
        style={{ fontFamily: FONT.regular, fontSize: 16, color: t.fgMuted }}
        {...typeCap("body")}
      >
        {forwardChevron()}
      </Text>
    </Pressable>
  );
}
