/**
 * DeliveryRow — one webhook delivery attempt, with replay.
 *
 * "Did this event actually reach the receiver, and can I send it again?" is the
 * whole reason an operator opens this screen from bed. The row therefore leads
 * with the event type and the verdict, and puts the failure reason (status code
 * plus the receiver's error) where the eye lands next.
 *
 * Replay is a swipe action rather than a button so it cannot be hit by accident
 * while scrolling a failure feed; `SwipeableRow` publishes it as an
 * accessibilityAction too, so it is not gesture-only.
 */
import { Text, View } from "react-native";

import { Card } from "@/components/Card";
import { Pill, type PillTone } from "@/components/Pill";
import { SwipeableRow } from "@/components/SwipeableRow";
import type { OutboundDelivery } from "@/hooks/useOutboundWebhooks";
import { FONT } from "@/lib/fonts";
import { dateTime, num, relativeTime } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

function statusTone(status: string): PillTone {
  if (status === "delivered") return "success";
  if (status === "pending") return "info";
  if (status === "skipped") return "neutral";
  return "danger";
}

/** In-flight deliveries cannot be replayed — the server 409s on them. */
export function isReplayable(delivery: OutboundDelivery): boolean {
  return delivery.status !== "pending";
}

export interface DeliveryRowProps {
  delivery: OutboundDelivery;
  onReplay: (delivery: OutboundDelivery) => void;
}

export function DeliveryRow({ delivery, onReplay }: DeliveryRowProps) {
  const { t } = useTheme();
  const when = delivery.delivered_at ?? delivery.created_at;
  const replayable = isReplayable(delivery);
  const spoken = `${delivery.event_type}, ${delivery.status}${
    delivery.last_status_code ? `, HTTP ${delivery.last_status_code}` : ""
  }, ${dateTime(when)}. ${num(delivery.attempt_count)} attempts.`;

  const body = (
    <View style={{ marginBottom: 8 }}>
      <Card>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <Text
            {...typeCap("callout")}
            style={{
              color: t.fg,
              ...typeStyle("callout"),
              fontFamily: FONT.semibold,
              flex: 1,
            }}
            numberOfLines={1}
          >
            {delivery.event_type}
          </Text>
          <Pill label={delivery.status} tone={statusTone(delivery.status)} />
        </View>

        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
            marginTop: 6,
            fontVariant: ["tabular-nums"],
          }}
        >
          {relativeTime(when)} ·{" "}
          {delivery.attempt_count === 1
            ? "1 attempt"
            : `${num(delivery.attempt_count)} attempts`}
          {delivery.last_status_code ? ` · HTTP ${delivery.last_status_code}` : ""}
        </Text>

        {delivery.last_error ? (
          <Text
            {...typeCap("label")}
            style={{
              color: t.danger,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
              marginTop: 6,
            }}
            numberOfLines={3}
          >
            {delivery.last_error}
          </Text>
        ) : null}

        {delivery.next_attempt_at ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgMuted,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              marginTop: 6,
            }}
          >
            Next retry {relativeTime(delivery.next_attempt_at)}
          </Text>
        ) : null}
      </Card>
    </View>
  );

  if (!replayable) {
    return (
      <View accessible accessibilityLabel={`${spoken} Still in flight.`}>
        {body}
      </View>
    );
  }

  return (
    <SwipeableRow
      right={[
        {
          label: "Replay",
          kind: "primary",
          onPress: () => onReplay(delivery),
        },
      ]}
      accessibilityLabel={spoken}
    >
      {body}
    </SwipeableRow>
  );
}
