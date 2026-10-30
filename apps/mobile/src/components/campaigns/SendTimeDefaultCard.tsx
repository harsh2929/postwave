/**
 * SendTimeDefaultCard — the workspace default: send-time optimization on or
 * off for NEW campaigns.
 *
 * Desktop flips this on its SendTime page (useSendTimeWorkspaceSetting); the
 * phone screen was "a read surface with no writes on it", so an admin looking
 * at the very evidence that should drive the decision could not act on it.
 *
 * GET/PUT /api/v1/settings/send-time-optimization are BOTH admin — the same
 * floor the hosting screen already enforces, so this card is only ever
 * rendered to a session that can use it.
 */
import { Switch, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { useToast } from "@/components/Toast";
import {
  useSendTimeDefault,
  useSendTimeDefaultWrite,
} from "@/hooks/useCampaignSendTimeDefault";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SendTimeDefaultCard() {
  const { t } = useTheme();
  const { toast } = useToast();
  const setting = useSendTimeDefault({ enabled: true });
  const write = useSendTimeDefaultWrite();
  const value = setting.data;

  const onToggle = (next: boolean) => {
    if (write.isPending) return;
    haptics.tap();
    write.mutate(next, {
      onSuccess: () =>
        toast({
          kind: "success",
          message: next
            ? "New campaigns will default to send-time optimization."
            : "New campaigns will default to sending immediately.",
        }),
      onError: (err: unknown) =>
        toast({
          kind: "error",
          message: campaignErrorMessage(err, "Couldn't change the default."),
        }),
    });
  };

  return (
    <Card style={{ gap: 8 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Text
          {...typeCap("callout")}
          accessibilityRole="header"
          style={{
            color: t.fg,
            ...typeStyle("callout"),
            fontFamily: FONT.semibold,
            flexShrink: 1,
          }}
        >
          Optimize send times by default
        </Text>
        <Switch
          value={value === true}
          onValueChange={onToggle}
          disabled={write.isPending || setting.isLoading || value === null}
          accessibilityLabel="Send-time optimization default for new campaigns"
        />
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {setting.isLoading
          ? "Reading the current workspace default…"
          : value === null && !setting.isLoading
            ? "The workspace default couldn't be read, so the switch is held until it can."
            : "Applies to campaigns created from now on; existing campaigns keep whatever they were scheduled with."}
      </Text>
    </Card>
  );
}
