/**
 * OutboundWebhookRow — one outbound endpoint in the Settings list.
 *
 * Freshness leads, because "is this thing still delivering?" is the question
 * the row exists to answer and both timestamps (`last_succeeded_at`,
 * `last_failed_at`) were already in memory and rendered nowhere. When the most
 * recent event is a FAILURE the line switches to the warning colour AND says
 * "failure", so the state is never carried by colour alone.
 *
 * The inactive state used to be a bare "paused" Pill, which made an endpoint
 * the SERVER auto-disabled after repeated failures indistinguishable from one
 * a human paused deliberately. It now states the consequence and names the
 * screen that can undo it.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { type OutboundWebhook } from "@/api/settings";
import { FONT } from "@/lib/fonts";
import { webhookFreshness } from "@/lib/outboundWebhookFreshness";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface OutboundWebhookRowProps {
  webhook: OutboundWebhook;
  testing: boolean;
  deleting: boolean;
  /** A rotate against THIS endpoint is in flight. */
  rotating: boolean;
  onTest: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onRotate: () => void;
}

export function OutboundWebhookRow({
  webhook: w,
  testing,
  deleting,
  rotating,
  onTest,
  onDelete,
  onEdit,
  onRotate,
}: OutboundWebhookRowProps) {
  const { t } = useTheme();
  const freshness = webhookFreshness(w);

  return (
    <View
      accessible={false}
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          marginBottom: 4,
        }}
      >
        <Text
          style={{
            color: t.fg,
            ...typeStyle("callout"),
            fontWeight: "600",
            flex: 1,
            fontFamily: FONT.semibold,
          }}
          numberOfLines={1}
          {...typeCap("callout")}
        >
          {w.description || w.url}
        </Text>
        <Pill
          label={w.active ? "active" : "not delivering"}
          tone={w.active ? "success" : "warning"}
        />
      </View>

      <Text
        // A monospace destination URL the user copies: it never reflows, so
        // it takes the dense `mono` ceiling rather than a prose one.
        {...typeCap("mono")}
        style={{
          color: t.fgMuted,
          ...typeStyle("mono"),
          fontFamily: "Menlo",
        }}
        numberOfLines={1}
        selectable
      >
        {w.url}
      </Text>

      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 4,
          marginTop: 8,
        }}
      >
        {w.events.map((ev) => (
          <Pill key={ev} label={ev} tone="neutral" />
        ))}
      </View>

      <Text
        accessibilityLabel={freshness.spoken}
        style={{
          color: freshness.failed ? t.warning : t.fgSubtle,
          ...typeStyle("caption"),
          marginTop: 8,
          fontFamily: FONT.regular,
        }}
        {...typeCap("caption")}
      >
        {freshness.text}
      </Text>

      {!w.active ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.warning,
            ...typeStyle("caption"),
            marginTop: 4,
            fontFamily: FONT.regular,
          }}
        >
          Events are not being enqueued for this endpoint. Re-enable or resume
          it from the Webhooks screen.
        </Text>
      ) : null}

      <View
        style={{ flexDirection: "row", gap: 8, marginTop: 10, flexWrap: "wrap" }}
      >
        <RowButton
          label={testing ? "Testing…" : "Test"}
          a11y={`Send a test event to ${w.description || w.url}`}
          onPress={onTest}
          disabled={testing}
          tone="neutral"
        />
        <RowButton
          label="Edit"
          a11y={`Edit the destination and event subscriptions of ${w.description || w.url}`}
          onPress={onEdit}
          disabled={false}
          tone="neutral"
        />
        <RowButton
          label={rotating ? "Rotating…" : "Rotate key"}
          a11y={`Rotate the signing key for ${w.description || w.url}`}
          onPress={onRotate}
          disabled={rotating}
          tone="neutral"
        />
        <RowButton
          label="Delete"
          a11y={`Delete the webhook ${w.description || w.url}`}
          onPress={onDelete}
          disabled={deleting}
          tone="danger"
        />
      </View>
    </View>
  );
}

function RowButton({
  label,
  a11y,
  onPress,
  disabled,
  tone,
}: {
  label: string;
  a11y: string;
  onPress: () => void;
  disabled: boolean;
  tone: "neutral" | "danger";
}) {
  const { t } = useTheme();
  const danger = tone === "danger";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled }}
      style={{
        paddingHorizontal: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: danger ? t.danger : t.border,
        backgroundColor: danger ? "transparent" : t.bgSubtle,
        opacity: disabled ? 0.6 : 1,
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        style={{
          color: danger ? t.danger : t.fg,
          ...typeStyle("badge"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
        {...typeCap("badge")}
      >
        {label}
      </Text>
    </Pressable>
  );
}
