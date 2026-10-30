import { Text, View } from "react-native";

import { Card } from "@/components/Card";
import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import {
  safeSmsDisplayText,
  type SmsConversationContext,
} from "@/lib/smsConversation";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SmsThreadContextCard({
  context,
  loading,
  failed,
}: {
  context: SmsConversationContext | undefined;
  loading: boolean;
  failed: boolean;
}) {
  const { t } = useTheme();
  if (loading && !context) {
    return <ContextShell text="Checking consent, suppression, and eligible lists…" />;
  }
  if (failed || !context) {
    return (
      <ContextShell
        alert
        text="Consent and suppression could not be verified. Reply is locked; message history remains readable."
      />
    );
  }
  const consentTone =
    context.consentStatus === "opted_in"
      ? "success"
      : context.consentStatus === "pending"
        ? "warning"
        : "danger";
  return (
    <Card style={{ marginBottom: 12, gap: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Pill label={context.consentStatus.replace("_", " ")} tone={consentTone} />
        {context.suppressed ? (
          <Pill label="suppressed" tone="danger" />
        ) : (
          <Pill label="not suppressed" tone="success" />
        )}
      </View>
      <Text
        {...typeCap("bodySmall")}
        style={{ color: t.fg, ...typeStyle("bodySmall"), fontFamily: FONT.medium }}
      >
        {context.identityAmbiguous
          ? "Multiple subscriber identities — no email selected"
          : context.subscriberEmail
            ? safeSmsDisplayText(context.subscriberEmail, 320)
            : "No linked subscriber email"}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{ color: t.fgMuted, ...typeStyle("caption"), fontFamily: FONT.regular }}
      >
        {context.hasInboundThread
          ? "Verified inbound thread"
          : "No verified inbound thread"}
        {` · ${plural(context.eligibleLists.length, "currently opted-in list")}`}
        {context.suppressionReason
          ? ` · Suppression: ${safeSmsDisplayText(context.suppressionReason, 128)}`
          : ""}
        {!context.replyDispatchAvailable ? " · Dispatch unavailable" : ""}
      </Text>
    </Card>
  );
}

function ContextShell({ text, alert = false }: { text: string; alert?: boolean }) {
  const { t } = useTheme();
  return (
    <Card
      {...(alert ? { accessibilityRole: "alert" as const } : {})}
      style={{ marginBottom: 12 }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: alert ? t.danger : t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.medium,
        }}
      >
        {text}
      </Text>
    </Card>
  );
}
