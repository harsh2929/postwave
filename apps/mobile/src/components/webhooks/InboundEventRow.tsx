/**
 * InboundEventRow — one received webhook payload.
 *
 * What an operator is looking for, in order:
 *   1. did it verify?   — the difference between "the integration is wired
 *                          up" and "someone is POSTing garbage at my slug"
 *   2. when?             — relative for the eye, absolute for a screen reader
 *   3. what was in it?   — one collapsed line, expandable to the whole body
 *   4. can I re-fire it? — with the refusal explained when it cannot be
 *
 * The signature state is never carried by colour alone: the pill says
 * "verified" or "signature failed" in words, and its accessibilityLabel says
 * the whole sentence, because "failed" alone does not tell a screen-reader
 * user what failed or what it costs them.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { type InboundEvent } from "@/hooks/useInboundWebhookOps";
import { bytes, dateTime, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import {
  eventBodyBytes,
  eventBodyPreview,
  eventTypeFromHeaders,
  replayVerdict,
} from "@/lib/inboundEventPolicy";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface InboundEventRowProps {
  event: InboundEvent;
  /** This row's replay is in flight. */
  replaying: boolean;
  /** Any replay is in flight — disables the others so two can't race. */
  busy: boolean;
  onReplay: () => void;
  onCopyBody: () => void;
}

export function InboundEventRow({
  event,
  replaying,
  busy,
  onReplay,
  onCopyBody,
}: InboundEventRowProps) {
  const { t } = useTheme();
  const [expanded, setExpanded] = useState(false);

  const preview = eventBodyPreview(event.body);
  const size = eventBodyBytes(event.body);
  const verdict = replayVerdict({
    signatureValid: event.signatureValid,
    bodyRetained: Boolean(event.body),
  });
  const eventType = eventTypeFromHeaders(event.headers);
  const received = event.receivedAt ? new Date(event.receivedAt) : null;
  const receivedValid = received !== null && !Number.isNaN(received.getTime());

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: event.signatureValid ? t.borderSubtle : t.warning,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        gap: 8,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Text
          numberOfLines={1}
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.semibold,
            flex: 1,
          }}
        >
          {eventType ?? `Event ${event.id}`}
        </Text>
        <Pill
          label={event.signatureValid ? "verified" : "signature failed"}
          tone={event.signatureValid ? "success" : "warning"}
          accessibilityLabel={
            event.signatureValid
              ? "Signature verified: this payload was signed with your current secret."
              : "Signature failed: this payload was not signed with your secret and cannot be replayed."
          }
        />
      </View>

      <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
        <Text
          accessibilityLabel={
            receivedValid
              ? `Received ${dateTime(received)}`
              : "Arrival time is unknown for this event."
          }
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            fontVariant: ["tabular-nums"],
          }}
        >
          {receivedValid ? relativeTime(received) : "Time unknown"}
        </Text>
        {size !== null ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              fontVariant: ["tabular-nums"],
            }}
          >
            {bytes(size)}
          </Text>
        ) : null}
      </View>

      {preview ? (
        <Pressable
          onPress={() => setExpanded((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={
            expanded ? "Collapse the payload" : "Show the whole payload"
          }
          accessibilityState={{ expanded }}
          style={{
            backgroundColor: t.bgSubtle,
            borderRadius: 10,
            paddingHorizontal: 10,
            paddingVertical: 8,
            minHeight: 44,
            justifyContent: "center",
          }}
        >
          <Text
            selectable
            {...typeCap("mono")}
            style={{
              color: t.fgMuted,
              ...typeStyle("mono"),
              fontFamily: "Menlo",
            }}
            numberOfLines={expanded ? undefined : 2}
          >
            {expanded ? event.body : preview}
          </Text>
        </Pressable>
      ) : (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          The payload for this event is no longer retained.
        </Text>
      )}

      {!verdict.allowed ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.warning,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {verdict.reason}
        </Text>
      ) : null}

      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <EventButton
          label={replaying ? "Replaying…" : "Replay"}
          a11y={
            verdict.allowed
              ? `Replay event ${event.id} through your triggers`
              : `Replay is unavailable for event ${event.id}. ${verdict.reason}`
          }
          onPress={onReplay}
          disabled={!verdict.allowed || busy}
          tone="accent"
        />
        {preview ? (
          <EventButton
            label="Copy payload"
            a11y={`Copy the payload of event ${event.id} to the clipboard`}
            onPress={onCopyBody}
            disabled={false}
            tone="neutral"
          />
        ) : null}
      </View>
    </View>
  );
}

function EventButton({
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
  tone: "accent" | "neutral";
}) {
  const { t } = useTheme();
  const accent = tone === "accent";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled }}
      style={{
        paddingHorizontal: 14,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: accent ? t.accent : t.border,
        backgroundColor: accent ? "transparent" : t.bgSubtle,
        opacity: disabled ? 0.5 : 1,
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: accent ? t.accent : t.fg,
          ...typeStyle("control"),
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
