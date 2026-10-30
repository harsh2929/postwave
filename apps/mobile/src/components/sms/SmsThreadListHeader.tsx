/**
 * SmsThreadListHeader — everything above the first message bubble.
 *
 * Lifted out of `app/(tabs)/sms/[phone].tsx` so the screen function stays
 * readable: consent/suppression context, the freshness line, and the
 * load-older control are one visual block with no state of their own, and the
 * screen keeps the hooks. The freshness SENTENCE is chosen by the pure
 * `smsThreadFreshnessText` in `@/lib/smsThreadCopy`, which is where that rule
 * is unit-tested; this file only paints it.
 */
import { Pressable, Text, View } from "react-native";

import { SmsThreadContextCard } from "@/components/sms/SmsThreadContextCard";
import { FONT } from "@/lib/fonts";
import type { SmsConversationContext } from "@/lib/smsConversation";
import { smsThreadFreshnessText } from "@/lib/smsThreadCopy";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SmsThreadListHeader({
  context,
  contextLoading,
  contextFailed,
  online,
  fetching,
  refreshFailed,
  restartRequired,
  snapshotAt,
  partial,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  meta,
}: {
  context: SmsConversationContext | undefined;
  contextLoading: boolean;
  contextFailed: boolean;
  online: boolean;
  fetching: boolean;
  refreshFailed: boolean;
  restartRequired: boolean;
  snapshotAt: string | null;
  partial: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  /** Operator metadata block (tags / note / activity), owned by the screen. */
  meta?: React.ReactNode;
}) {
  const { t } = useTheme();
  return (
    <View>
      <SmsThreadContextCard
        context={context}
        loading={contextLoading}
        failed={contextFailed}
      />
      {meta ?? null}
      <Text
        accessibilityLiveRegion="polite"
        {...typeCap("caption")}
        style={{
          color: !online ? t.warning : t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.medium,
          marginBottom: 8,
        }}
      >
        {smsThreadFreshnessText({
          online,
          fetching,
          refreshFailed,
          restartRequired,
          snapshotAt,
          partial,
        })}
      </Text>
      {hasOlder ? (
        <Pressable
          onPress={onLoadOlder}
          disabled={loadingOlder}
          accessibilityRole="button"
          accessibilityState={{ disabled: loadingOlder }}
          style={{
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: t.accent,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            {loadingOlder ? "Loading…" : "Load older messages"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
