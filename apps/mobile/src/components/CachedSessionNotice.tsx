import { Text, View, type StyleProp, type ViewStyle } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export type CachedSessionSurface =
  | "dashboard"
  | "campaigns"
  | "sequences"
  | "sequence"
  | "abResults"
  | "subscribers"
  | "subscriber"
  | "sessions";

export type CachedSessionNoticeContent = {
  title: string;
  description: string;
  staleMessage: string;
};

const SURFACE_COPY: Record<CachedSessionSurface, CachedSessionNoticeContent> = {
  dashboard: {
    title: "Reconnect to load dashboard",
    description:
      "This cached session has not been validated online yet. Reconnect before refreshing dashboard metrics.",
    staleMessage:
      "Reconnect before refreshing dashboard metrics. Showing the last loaded results.",
  },
  campaigns: {
    title: "Reconnect to load campaigns",
    description:
      "This cached session has not been validated online yet. Reconnect before loading campaigns.",
    staleMessage:
      "Reconnect before refreshing campaigns. Showing the last loaded results.",
  },
  sequences: {
    title: "Reconnect to load sequences",
    description:
      "This cached session has not been validated online yet. Reconnect before loading sequences.",
    staleMessage:
      "Reconnect before refreshing sequences. Showing the last loaded results.",
  },
  sequence: {
    title: "Reconnect to load sequence",
    description:
      "This cached session has not been validated online yet. Reconnect before loading this sequence.",
    staleMessage:
      "Reconnect before refreshing this sequence. Showing the last loaded builder state.",
  },
  abResults: {
    title: "Reconnect to load A/B results",
    description:
      "This cached session has not been validated online yet. Reconnect before loading A/B results.",
    staleMessage:
      "Reconnect before refreshing A/B results. Showing the last loaded results.",
  },
  subscribers: {
    title: "Reconnect to load subscribers",
    description:
      "This cached session has not been validated online yet. Reconnect before loading subscribers.",
    staleMessage:
      "Reconnect before refreshing subscribers. Showing the last loaded results.",
  },
  subscriber: {
    title: "Reconnect to load subscriber",
    description:
      "This cached session has not been validated online yet. Reconnect before loading this subscriber.",
    staleMessage:
      "Reconnect before refreshing this subscriber. Showing the last loaded snapshot.",
  },
  // Sessions are deliberately never cached: a stale list on a security screen
  // would show devices that are already gone, or hide one that is not.
  sessions: {
    title: "Reconnect to review devices",
    description:
      "Active sessions are never cached. Reconnect to see where your account is signed in and to sign devices out.",
    staleMessage:
      "Reconnect to review your active devices. Signing a device out needs a live connection.",
  },
};

export function cachedSessionNotice({
  gateEnabled,
  hasTenant,
  surface,
}: {
  gateEnabled: boolean;
  hasTenant: boolean;
  surface: CachedSessionSurface;
}): CachedSessionNoticeContent | null {
  if (gateEnabled) return null;
  if (!hasTenant) {
    return {
      title: "Reconnect your workspace",
      description:
        "This screen needs an authenticated workspace before it can refresh.",
      staleMessage:
        "Reconnect your workspace before refreshing. Showing anything already cached.",
    };
  }
  return SURFACE_COPY[surface];
}

export function CachedSessionNotice({
  notice,
  variant = "blocked",
  style,
}: {
  notice: CachedSessionNoticeContent;
  variant?: "blocked" | "stale";
  style?: StyleProp<ViewStyle>;
}) {
  const { t } = useTheme();
  const body = variant === "stale" ? notice.staleMessage : notice.description;
  return (
    <View
      accessibilityRole="alert"
      accessibilityLabel={`${notice.title}. ${body}`}
      style={[
        {
          backgroundColor: `${t.warning}1a`,
          borderColor: t.warning,
          borderWidth: 1,
          borderRadius: 12,
          paddingVertical: 10,
          paddingHorizontal: 12,
        },
        style,
      ]}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.warning,
          ...typeStyle("bodySmall"),
          fontWeight: "700",
          fontFamily: FONT.bold,
        }}
      >
        {notice.title}
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          marginTop: 4,
          fontFamily: FONT.regular,
        }}
      >
        {body}
      </Text>
    </View>
  );
}
