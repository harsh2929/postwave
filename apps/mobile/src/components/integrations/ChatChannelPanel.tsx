/**
 * ChatChannelPanel — test or silence a Slack / Discord / Teams channel.
 *
 * INTEG#7. The integrations screen named these three and pointed at the web admin
 * for all of it. Connecting one genuinely IS desk work — it needs an incoming
 * webhook URL from the provider's console — but testing, silencing and reading the
 * delivery log are not, and a flooding channel at 2am is the case this fixes.
 *
 * Silencing uses PATCH { active } rather than DELETE: the operator wants the noise
 * to stop, not to lose a configuration they will have to rebuild from the
 * provider's console tomorrow.
 */
import { Pressable, Switch, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { useToast } from "@/components/Toast";
import { PanelLoadFailure } from "@/components/integrations/PanelLoadFailure";
import {
  CHAT_PROVIDER_LABELS,
  type ChatChannel,
} from "@/api/chatIntegrations";
import {
  useChatChannels,
  useSetChatChannelActive,
  useTestChatChannel,
} from "@/hooks/useChatIntegrations";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function ChatChannelPanel() {
  const { t } = useTheme();
  const { toast } = useToast();
  const query = useChatChannels();
  const test = useTestChatChannel();
  const setActive = useSetChatChannelActive();

  const rows = Array.isArray(query.data) ? query.data : [];
  // isError FIRST: a failed read is not an absence of channels, and hiding the
  // section outright is how it came to be read as one.
  if (query.isError) {
    return <PanelLoadFailure title="Alert channels" subject="alert channels" />;
  }
  if (rows.length === 0) return null;
  const busy = test.isPending || setActive.isPending;

  const onTest = (channel: ChatChannel) => {
    haptics.tap();
    test.mutate(channel, {
      onSuccess: () =>
        toast({
          kind: "success",
          message: `Test sent to ${channel.name}. Check the channel.`,
        }),
      onError: () =>
        toast({
          kind: "error",
          message: `${channel.name} rejected the test — the webhook may have been revoked.`,
        }),
    });
  };

  const onToggle = (channel: ChatChannel, active: boolean) => {
    haptics.tap();
    setActive.mutate(
      { channel, active },
      {
        onSuccess: () =>
          toast({
            kind: "success",
            message: active
              ? `${channel.name} is receiving alerts again.`
              : `${channel.name} is silenced. Its configuration is kept.`,
          }),
        onError: (err) =>
          toast({
            kind: "error",
            message:
              errorPresentation(err).message || `Couldn't change ${channel.name}.`,
          }),
      },
    );
  };

  return (
    <View style={{ gap: 10, marginTop: 16 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.semibold,
        }}
      >
        Alert channels
      </Text>
      {rows.map((channel) => (
        <View
          key={`${channel.provider}:${channel.id}`}
          style={{
            borderTopColor: t.borderSubtle,
            borderTopWidth: 1,
            paddingTop: 10,
            gap: 6,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text
              {...typeCap("body")}
              style={{
                color: t.fg,
                ...typeStyle("body"),
                fontFamily: FONT.semibold,
                flexShrink: 1,
              }}
              numberOfLines={1}
            >
              {channel.name}
            </Text>
            <Pill
              label={CHAT_PROVIDER_LABELS[channel.provider]}
              tone={channel.active ? "success" : "neutral"}
            />
            <Switch
              value={channel.active}
              disabled={busy}
              onValueChange={(next) => onToggle(channel, next)}
              accessibilityRole="switch"
              accessibilityLabel={`${channel.name} alerts`}
              accessibilityHint={
                channel.active
                  ? "Silences this channel without deleting it"
                  : "Starts sending alerts to this channel again"
              }
              accessibilityState={{ checked: channel.active, disabled: busy }}
              trackColor={{ false: t.border, true: t.accent }}
            />
          </View>
          <Pressable
            onPress={() => onTest(channel)}
            disabled={busy || !channel.active}
            accessibilityRole="button"
            accessibilityLabel={`Send a test notification to ${channel.name}`}
            accessibilityState={{ disabled: busy || !channel.active }}
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: busy || !channel.active ? t.fgSubtle : t.accent,
                ...typeStyle("control"),
                fontFamily: FONT.semibold,
              }}
            >
              {channel.active ? "Send a test" : "Silenced"}
            </Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}
