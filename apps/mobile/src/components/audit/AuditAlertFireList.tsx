/**
 * AuditAlertFireList — the last N delivery attempts for one alert rule.
 *
 * WHY THIS IS NOT A PLAIN `.map()` OVER AN ARRAY. An empty array from
 * `GET /{id}/fires` means "this rule has never fired". An array that has not
 * arrived yet — or whose fetch failed — means nothing at all. On a detection
 * surface those two render identically if you only check `length === 0`, and
 * the mistake reads as an all-clear. So this component takes `loading` and
 * `failed` explicitly and refuses to say "no deliveries" until it knows.
 *
 * DELIVERY STATE IS NEVER COLOUR-ALONE: each attempt carries the word
 * "Delivered" or "Failed", and a failed attempt shows the server's own
 * `delivery_error` string rather than a generic line — that text is what an
 * operator pastes into a ticket.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { AUDIT_ALERT_FIRES_CAP } from "@/api/auditAlerts";
import type { AuditAlertFire } from "@/lib/auditAlertRules";
import { EMDASH, dateTime, num, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface AuditAlertFireListProps {
  fires: readonly AuditAlertFire[];
  loading: boolean;
  failed: boolean;
  now: number;
}

export function AuditAlertFireList({
  fires,
  loading,
  failed,
  now,
}: AuditAlertFireListProps) {
  const { t } = useTheme();

  if (failed) {
    return (
      <Note
        tone="danger"
        text="The delivery history couldn't be loaded. Pull to refresh the list and reopen this rule."
      />
    );
  }
  if (loading) {
    return <Note tone="muted" text="Checking recent deliveries…" />;
  }
  if (fires.length === 0) {
    return (
      <Note
        tone="muted"
        text="No deliveries recorded. This rule has not fired since it was created."
      />
    );
  }

  return (
    <View style={{ gap: 8 }}>
      {fires.map((fire) => (
        <View
          key={fire.id}
          accessible
          accessibilityLabel={`${
            fire.delivered ? "Delivered" : "Failed"
          } ${relativeTime(fire.firedAt, { now })}${
            fire.auditId === null ? "" : `, audit event ${fire.auditId}`
          }${fire.deliveryError ? `. ${fire.deliveryError}` : ""}`}
          style={{
            backgroundColor: t.bgSubtle,
            borderColor: t.borderSubtle,
            borderWidth: 1,
            borderRadius: 12,
            paddingHorizontal: 12,
            paddingVertical: 10,
            gap: 4,
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
            <Pill
              label={fire.delivered ? "Delivered" : "Failed"}
              tone={fire.delivered ? "success" : "danger"}
            />
            <Text
              {...typeCap("numeric")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("numeric"),
                fontFamily: FONT.regular,
                flexShrink: 1,
              }}
            >
              {fire.firedAt ? dateTime(fire.firedAt) : EMDASH}
            </Text>
          </View>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            {fire.auditId === null
              ? `Audit event ${EMDASH}`
              : `Audit event ${num(fire.auditId)}`}
          </Text>
          {fire.deliveryError ? (
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.danger,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              {fire.deliveryError}
            </Text>
          ) : null}
        </View>
      ))}
      {fires.length >= AUDIT_ALERT_FIRES_CAP ? (
        <Note
          tone="muted"
          text={`Showing the ${AUDIT_ALERT_FIRES_CAP} most recent deliveries — the server caps this history and offers no further pages.`}
        />
      ) : null}
    </View>
  );
}

function Note({ text, tone }: { text: string; tone: "muted" | "danger" }) {
  const { t } = useTheme();
  return (
    <Text
      accessibilityLiveRegion="polite"
      {...typeCap("bodySmall")}
      style={{
        color: tone === "danger" ? t.danger : t.fgMuted,
        ...typeStyle("bodySmall"),
        fontFamily: FONT.regular,
      }}
    >
      {text}
    </Text>
  );
}
