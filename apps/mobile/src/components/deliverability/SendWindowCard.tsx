/**
 * SendWindowCard — the enforcement tier, readable and flippable during an
 * incident.
 *
 * Desktop buries this in a 756-line composer modal. Full CRUD over a weekday
 * bitmap and an IANA timezone is genuinely not phone-shaped, and this card
 * does not attempt it. What IS phone-shaped is the incident question:
 *
 *     "Why won't this send go out — and can I unblock it from here?"
 *
 * So the card is a read plus one SegmentedControl over off / warn / block.
 * Everything else about the policy is shown but not editable, and the card
 * says as much rather than pretending the window itself is missing.
 *
 * The write is admin-scoped server-side, so a non-admin sees the tier as a
 * Pill instead of a control — a disabled segmented control that can only 403
 * is worse than no control at all.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { SegmentedControl } from "@/components/SegmentedControl";
import { FONT } from "@/lib/fonts";
import {
  SEND_WINDOW_TIERS,
  sendWindowSummary,
  type SendWindowPolicy,
  type SendWindowTier,
} from "@/lib/deliverabilityControls";
import type { SignalTone } from "@/lib/deliverabilitySignals";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

export interface SendWindowCardProps {
  policy: SendWindowPolicy | null | undefined;
  /** Non-null when the read failed or could not run. */
  unavailableReason: string | null;
  /** False for a non-admin session, or offline. */
  canEdit: boolean;
  saving: boolean;
  onChangeTier: (tier: SendWindowTier) => void;
}

function pillTone(
  tone: SignalTone,
): "neutral" | "success" | "warning" | "danger" | "info" {
  return tone === "neutral" ? "neutral" : tone;
}

export function SendWindowCard({
  policy,
  unavailableReason,
  canEdit,
  saving,
  onChangeTier,
}: SendWindowCardProps) {
  const { t } = useTheme();
  const summary = sendWindowSummary(policy);

  // No policy configured is a real, common, GOOD state — not an error and not
  // an empty card. Nothing is holding sends back, so say only that.
  const body = unavailableReason
    ? unavailableReason
    : policy === undefined
      ? "Loading the send-window policy…"
      : summary
        ? summary.effect
        : "No send-window policy — sends go out whenever they are scheduled.";

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 10,
        gap: 10,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.bold,
            letterSpacing: 0.6,
            textTransform: "uppercase",
          }}
        >
          Send window
        </Text>
        {summary ? (
          <Pill
            label={summary.tierLabel}
            tone={pillTone(summary.tone)}
            accessibilityLabel={`Enforcement is ${summary.tierLabel.toLowerCase()}`}
          />
        ) : null}
      </View>

      {summary ? (
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
            fontVariant: ["tabular-nums"],
          }}
        >
          {summary.windowLine}
        </Text>
      ) : null}

      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {body}
      </Text>

      {summary && canEdit ? (
        <View style={{ gap: 6, opacity: saving ? 0.6 : 1 }}>
          <SegmentedControl
            options={SEND_WINDOW_TIERS.map((tier) => ({
              value: tier.value,
              label: tier.label,
            }))}
            value={summary.tier}
            onChange={onChangeTier}
            accessibilityLabel="Send-window enforcement"
          />
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
            }}
          >
            {saving
              ? "Saving…"
              : "Changes the enforcement tier only. The window, timezone and days stay as they are."}
          </Text>
        </View>
      ) : null}
      {summary && !canEdit ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          Only an admin can change the enforcement tier.
        </Text>
      ) : null}
    </View>
  );
}
