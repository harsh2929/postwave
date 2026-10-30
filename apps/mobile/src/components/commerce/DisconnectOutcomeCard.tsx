/**
 * DisconnectOutcomeCard — what the server said it did, and did not do, when a
 * store was disconnected.
 *
 * The desktop shows this as a modal (IntegrationsTab.tsx DisconnectOutcomeModal).
 * On the phone it is an inline card at the top of the connections list, so it
 * survives the list refetch that the disconnect triggers and can be read
 * alongside the row it describes.
 *
 * EVERY SENTENCE IN THE THREE LISTS IS SERVER-AUTHORED — `postwave_effects`,
 * `provider_console_actions`, `provider_cleanup_evidence` (types.go:87-89) —
 * and rendered verbatim. The console actions in particular are the steps an
 * operator still has to carry out by hand in Shopify/Stripe/etc.; paraphrasing
 * them would be the app editing a checklist it did not write. The two cleanup
 * statuses are shown as the server's own words for the same reason.
 *
 * NativeWind v4: static style objects only.
 */
import { Pressable, Text, View } from "react-native";

import {
  disconnectCleanupComplete,
  disconnectOutcomeHeadline,
  type DisconnectOutcome,
} from "@/lib/commerceConnection";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface DisconnectOutcomeCardProps {
  storeName: string;
  outcome: DisconnectOutcome;
  onDismiss: () => void;
}

export function DisconnectOutcomeCard({
  storeName,
  outcome,
  onDismiss,
}: DisconnectOutcomeCardProps) {
  const { t } = useTheme();
  const complete = disconnectCleanupComplete(outcome);
  const providerLabel = outcome.provider || "the provider";

  return (
    <View
      accessibilityRole="summary"
      accessibilityLabel={`${storeName} disconnected. ${disconnectOutcomeHeadline(outcome)}`}
      style={{
        backgroundColor: t.surface,
        borderColor: complete ? t.success : t.danger,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 12,
        gap: 8,
      }}
    >
      <Text
        accessibilityRole="header"
        {...typeCap("body")}
        style={{
          color: t.fg,
          ...typeStyle("body"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {storeName} disconnected
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {disconnectOutcomeHeadline(outcome)}
      </Text>

      {outcome.webhookCleanupStatus || outcome.credentialCleanupStatus ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {`Webhooks: ${outcome.webhookCleanupStatus || "not reported"} · Credentials: ${
            outcome.credentialCleanupStatus || "not reported"
          }`}
        </Text>
      ) : null}

      <SentenceList title="What Moosewave did" lines={outcome.postwaveEffects} />
      <SentenceList
        title={`Still to do in ${providerLabel}`}
        lines={outcome.providerConsoleActions}
        emphasis
      />
      <SentenceList title="Evidence" lines={outcome.providerCleanupEvidence} />

      <Pressable
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel={`Dismiss the ${storeName} disconnect summary`}
        style={{
          marginTop: 4,
          minHeight: 44,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 10,
          borderWidth: 1,
          borderColor: t.border,
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.accent,
            ...typeStyle("callout"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          Done
        </Text>
      </Pressable>
    </View>
  );
}

function SentenceList({
  title,
  lines,
  emphasis,
}: {
  title: string;
  lines: readonly string[];
  emphasis?: boolean | undefined;
}) {
  const { t } = useTheme();
  if (lines.length === 0) return null;
  return (
    <View style={{ gap: 2 }}>
      <Text
        {...typeCap("caption")}
        style={{
          color: emphasis ? t.danger : t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.semibold,
          textTransform: "uppercase",
          letterSpacing: 0.4,
        }}
      >
        {title}
      </Text>
      {lines.map((line) => (
        <Text
          key={line}
          selectable
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {`• ${line}`}
        </Text>
      ))}
    </View>
  );
}
