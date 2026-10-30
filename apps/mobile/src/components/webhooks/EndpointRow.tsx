/**
 * EndpointRow — one outbound webhook subscription with its freshness and its
 * 24h health.
 *
 * Two gaps this closes.
 *
 * FRESHNESS WAS ON THE WIRE AND NEVER RENDERED. `last_succeeded_at` and
 * `last_failed_at` are both returned by GET /api/v1/outbound-webhooks and both
 * typed on the client — and neither appeared anywhere in the UI. "Has this
 * delivered anything since Tuesday?" was answerable from data already in
 * memory, and the screen answered it with silence.
 *
 * "PAUSED" MEANT TWO DIFFERENT THINGS. An endpoint a human paused and an
 * endpoint the delivery worker AUTO-DISABLED after repeated failures both
 * rendered the same neutral `paused` pill. They need opposite actions: resume
 * versus fix-the-receiver-then-re-enable. The 24h health rollup carries
 * `auto_disabled`, so an inactive row now says which it is and offers the
 * matching verb.
 */
import { Pressable, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { Pill } from "@/components/Pill";
import { EndpointExpandedPanel } from "@/components/webhooks/EndpointExpandedPanel";
import type { OutboundHealth, OutboundWebhook } from "@/hooks/useOutboundWebhooks";
import { FONT } from "@/lib/fonts";
import { dateTime, num, relativeTime, truncateMiddle } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface EndpointRowProps {
  webhook: OutboundWebhook;
  expanded: boolean;
  onToggle: () => void;
  health: OutboundHealth | undefined;
  healthLoading: boolean;
  busy: boolean;
  onPauseResume: () => void;
  onReEnable: () => void;
  /** Opens this endpoint's own delivery history. Omitted = no control. */
  onShowDeliveries?: (() => void) | undefined;
  /** Why the history control is inert (role), rendered beside it. */
  deliveriesBlockedReason?: string | null | undefined;
  /**
   * Selection mode. While `selecting`, the row stops expanding and becomes a
   * checkbox — a tap that opened the health panel while a bulk delete was
   * being assembled is exactly the misfire multi-select exists to avoid.
   */
  selecting?: boolean;
  selected?: boolean;
  onToggleSelect?: ((id: string) => void) | undefined;
  /** Long-press handler. Omitted when this session may not bulk-edit. */
  onBeginSelect?: ((id: string) => void) | undefined;
}

function freshness(webhook: OutboundWebhook): {
  text: string;
  spoken: string;
  failed: boolean;
} {
  const succeeded = webhook.last_succeeded_at ?? null;
  const failed = webhook.last_failed_at ?? null;
  const succeededAt = succeeded ? new Date(succeeded).getTime() : 0;
  const failedAt = failed ? new Date(failed).getTime() : 0;
  if (!succeededAt && !failedAt) {
    return { text: "No deliveries yet", spoken: "No deliveries yet", failed: false };
  }
  if (failedAt > succeededAt) {
    return {
      text: `Last failure ${relativeTime(failed)}`,
      spoken: `Last failure ${dateTime(failed)}`,
      failed: true,
    };
  }
  return {
    text: `Last delivered ${relativeTime(succeeded)}`,
    spoken: `Last delivered ${dateTime(succeeded)}`,
    failed: false,
  };
}

export function EndpointRow({
  webhook,
  expanded,
  onToggle,
  health,
  healthLoading,
  busy,
  onPauseResume,
  onReEnable,
  onShowDeliveries,
  deliveriesBlockedReason = null,
  selecting = false,
  selected = false,
  onToggleSelect,
  onBeginSelect,
}: EndpointRowProps) {
  const { t } = useTheme();
  const fresh = freshness(webhook);
  const autoDisabled = health?.auto_disabled === true;
  // Only claim "auto-disabled" once health has actually answered; until then an
  // inactive endpoint is described neutrally rather than guessed at.
  const stateLabel = webhook.active
    ? "active"
    : autoDisabled
      ? "auto-disabled"
      : "paused";
  const stateTone = webhook.active ? "success" : autoDisabled ? "danger" : "neutral";
  const title = webhook.description?.trim() || truncateMiddle(webhook.url, 42);

  return (
    <View style={{ marginBottom: 8 }}>
      <Card
        style={{
          padding: 0,
          overflow: "hidden",
          // Selection is carried by a border, a filled disc AND the
          // accessibilityState — never by tint alone.
          ...(selected ? { borderColor: t.accent, borderWidth: 2 } : {}),
        }}
      >
        <Pressable
          onPress={() => {
            haptics.tap();
            if (selecting) onToggleSelect?.(webhook.id);
            else onToggle();
          }}
          {...(selecting
            ? {
                accessibilityRole: "checkbox" as const,
                accessibilityState: { checked: selected },
                accessibilityLabel: `${title}, ${stateLabel}.`,
                accessibilityHint: selected
                  ? "Removes this webhook from the selection."
                  : "Adds this webhook to the selection.",
              }
            : {
                accessibilityRole: "button" as const,
                accessibilityState: { expanded },
                accessibilityLabel: `${title}, ${stateLabel}. ${fresh.spoken}. ${
                  expanded ? "Collapse" : "Expand"
                } for delivery health.`,
                ...(onBeginSelect
                  ? {
                      onLongPress: () => onBeginSelect(webhook.id),
                      delayLongPress: 350,
                      // A long press is invisible to VoiceOver, so it is
                      // republished as a rotor action.
                      accessibilityActions: [
                        { name: "select", label: "Select webhooks" },
                      ],
                      onAccessibilityAction: (event: {
                        nativeEvent: { actionName: string };
                      }) => {
                        if (event.nativeEvent.actionName === "select") {
                          onBeginSelect(webhook.id);
                        }
                      },
                    }
                  : {}),
              })}
          // Padding compensates for the thicker selected border so the row's
          // outer box is identical in both states.
          style={{ padding: selected ? 15 : 16, minHeight: 44 }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            {selecting ? (
              <View
                accessibilityElementsHidden
                importantForAccessibility="no"
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 10,
                  borderWidth: 2,
                  borderColor: selected ? t.accent : t.border,
                  backgroundColor: selected ? t.accent : "transparent",
                }}
              />
            ) : null}
            <Text
              {...typeCap("body")}
              style={{
                color: t.fg,
                ...typeStyle("body"),
                fontFamily: FONT.semibold,
                flex: 1,
              }}
              numberOfLines={1}
            >
              {title}
            </Text>
            <Pill label={stateLabel} tone={stateTone} />
          </View>

          <Text
            {...typeCap("numeric")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("numeric"),
              fontFamily: "Menlo",
              marginTop: 6,
            }}
            numberOfLines={1}
          >
            {truncateMiddle(webhook.url, 48)}
          </Text>

          <Text
            {...typeCap("label")}
            style={{
              color: fresh.failed ? t.warning : t.fgMuted,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
              marginTop: 6,
            }}
          >
            {fresh.text}
          </Text>

          {webhook.consecutive_failures > 0 ? (
            <Text
              {...typeCap("label")}
              style={{
                color: t.danger,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
                marginTop: 4,
              }}
            >
              {num(webhook.consecutive_failures)} consecutive failures
            </Text>
          ) : null}
        </Pressable>

        {expanded && !selecting ? (
          <EndpointExpandedPanel
            webhook={webhook}
            title={title}
            autoDisabled={autoDisabled}
            health={health}
            healthLoading={healthLoading}
            busy={busy}
            onPauseResume={onPauseResume}
            onReEnable={onReEnable}
            onShowDeliveries={onShowDeliveries}
            deliveriesBlockedReason={deliveriesBlockedReason}
          />
        ) : null}
      </Card>
    </View>
  );
}

