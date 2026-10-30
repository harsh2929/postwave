/**
 * FeedbackTrailCard — "why exactly is this address blocked?"
 *
 * The raw ESP feedback trail for one recipient: every bounce with its class
 * and every complaint with its source, straight from the ingestion tables.
 * POST-with-body by design (the address must never enter URLs or request
 * logs), admin-scoped, and PRESS-DRIVEN — the lookup is a mutation so the
 * result is never revived from a cache keyed by someone's address.
 *
 * The card MOUNTS only for admins: below admin there is no input pretending
 * to work. Empty result is a REAL answer ("no recorded feedback"), distinct
 * from a failed lookup.
 */
import { useState } from "react";
import { Text, View } from "react-native";

import {
  OpsAction,
  OpsCard,
  OpsCardBody,
  OpsCardTitle,
  OpsTextInput,
} from "@/components/deliverability/OpsCard";
import { useFeedbackHistoryLookup } from "@/hooks/useDeliverabilityEvidence";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isAdminRole } from "@/lib/campaignAccess";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function FeedbackTrailCard() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const [email, setEmail] = useState("");
  const lookup = useFeedbackHistoryLookup();

  // Admin-only surface: omit entirely rather than render a dead input.
  if (!isAdminRole(gate.effectiveRole)) return null;
  const offline = !gate.enabled;
  const valid = EMAIL_RE.test(email.trim());

  const rows = lookup.data
    ? [
        ...lookup.data.bounces.map((bounce) => ({
          key: `b-${bounce.id}`,
          label: `Bounce · ${bounce.bounceType || "unclassified"}`,
          esp: bounce.esp,
          at: bounce.receivedAt,
        })),
        ...lookup.data.complaints.map((complaint) => ({
          key: `c-${complaint.id}`,
          label: `Complaint · ${complaint.complaintType || "abuse"}`,
          esp: complaint.esp,
          at: complaint.receivedAt,
        })),
      ]
    : [];

  return (
    <OpsCard>
      <OpsCardTitle>Feedback trail</OpsCardTitle>
      <OpsCardBody>
        Look up one recipient&apos;s raw bounce and complaint history — the reason
        behind a suppression.
      </OpsCardBody>
      {offline ? (
        <OpsCardBody>The trail lives server-side and can&apos;t be read offline.</OpsCardBody>
      ) : (
        <>
          <OpsTextInput
            value={email}
            onChangeText={setEmail}
            placeholder="person@example.com"
            accessibilityLabel="Recipient address to look up"
            keyboardType="email-address"
          />
          <OpsAction
            label={lookup.isPending ? "Looking up…" : "Look up trail"}
            onPress={() => {
              haptics.tap();
              lookup.mutate(email.trim());
            }}
            disabled={!valid || lookup.isPending}
          />
        </>
      )}
      {lookup.isError ? (
        <OpsCardBody role="alert">
          {errorPresentation(lookup.error).message ||
            "The feedback trail couldn't be loaded."}
        </OpsCardBody>
      ) : null}
      {lookup.data && rows.length === 0 ? (
        <OpsCardBody>
          No recorded bounces or complaints for that address — whatever blocks
          it isn&apos;t ESP feedback.
        </OpsCardBody>
      ) : null}
      {rows.map((row) => (
        <View
          key={row.key}
          accessible
          accessibilityLabel={`${row.label}${row.esp ? ` via ${row.esp}` : ""}, ${relativeTime(row.at)}`}
          style={{
            borderTopColor: t.borderSubtle,
            borderTopWidth: 1,
            paddingTop: 8,
            gap: 2,
          }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.medium,
            }}
          >
            {row.label}
          </Text>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            {`${row.esp || "unknown ESP"} · ${relativeTime(row.at)}`}
          </Text>
        </View>
      ))}
    </OpsCard>
  );
}
