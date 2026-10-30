/**
 * AttestationLedger — who signed what, and when.
 *
 * THIS IS THE PART A PHONE IS ACTUALLY GOOD FOR. "SOC 2 renewed on 3 June by
 * dana@ with hash 9f2c…" is the sentence somebody needs in a meeting, and it
 * is the one thing on the whole surface that a desktop is not required for.
 *
 * AN EMPTY LEDGER IS NOT "NOTHING HAPPENED". Three different things produce
 * zero rows and they are different facts:
 *   - the framework has never been attested, so there is nothing to record;
 *   - the framework HAS an attestation but its events predate this table
 *     (migration 0193 created it after the HIPAA-only flow);
 *   - the read failed, which `QueryStates` owns and never renders as empty.
 * The empty copy names the first two rather than implying a clean history.
 *
 * A FULL PAGE IS A TRUNCATION, NOT A TOTAL. The server caps the ledger at 500
 * rows (`ORDER BY at DESC LIMIT 500`, compliance.go:467), so a page of exactly
 * 500 says nothing about what came before it — and the notice says so rather
 * than letting "500 entries" read as the complete history.
 */
import { Text, View } from "react-native";

import { QueryStates } from "@/components/QueryStates";
import type { QueryLike } from "@/components/QueryStates";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { eventVerb } from "@/lib/complianceLabels";
import {
  COMPLIANCE_EVENTS_LIMIT,
  ledgerMayBeTruncated,
  type ComplianceEvent,
} from "@/lib/compliancePrograms";
import { EMDASH, dateTime, plural, truncateMiddle } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface AttestationLedgerProps {
  query: QueryLike & { data?: ComplianceEvent[] | undefined };
  gate: Pick<OnlineQueryGate, "enabled">;
  /** Shown in the empty copy so it can name the framework it is silent about. */
  frameworkShort: string;
}

function spokenFor(event: ComplianceEvent): string {
  const when = dateTime(event.at, "at a time that was not recorded");
  const who = event.signedByEmail || "an unrecorded signer";
  const counter = event.counterSignedBy
    ? `, countersigned by ${event.counterSignedBy}`
    : "";
  const hash = event.documentSha256
    ? `. Document hash ${event.documentSha256}`
    : ". No document hash was recorded for this entry";
  const notes = event.notes ? `. ${event.notes}` : "";
  return `${eventVerb(event.eventType)} ${when} by ${who}${counter}${hash}${notes}.`;
}

export function AttestationLedger({
  query,
  gate,
  frameworkShort,
}: AttestationLedgerProps) {
  const { t } = useTheme();
  const rows = Array.isArray(query.data) ? query.data : [];
  const truncated = ledgerMayBeTruncated(rows.length);

  return (
    <View style={{ marginTop: 8 }}>
      <SectionLabel
        {...(rows.length > 0
          ? {
              subtitle: truncated
                ? `The newest ${COMPLIANCE_EVENTS_LIMIT} entries — the server caps the ledger, so older ones are not shown.`
                : plural(rows.length, "entry", "entries"),
            }
          : {})}
      >
        Attestation history
      </SectionLabel>
      <QueryStates
        query={query}
        gate={gate}
        isEmpty={rows.length === 0}
        offlineMessage="Reconnect to read this framework's history. This is not the same as it having none."
        skeleton={
          <SkeletonList rows={3} lines={2} label="Loading attestation history" />
        }
        empty={{
          title: "No entries recorded",
          description: `Nothing has been attested, renewed or withdrawn for ${frameworkShort} since this ledger started. An attestation made before the ledger existed would not appear here.`,
        }}
      >
        {rows.map((event, index) => (
          <View
            key={event.id || `${event.at}-${index}`}
            accessible
            accessibilityLabel={spokenFor(event)}
            style={{
              backgroundColor: t.surface,
              borderColor: t.borderSubtle,
              borderWidth: 1,
              borderRadius: 12,
              padding: 12,
              marginBottom: 8,
              gap: 4,
            }}
          >
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            >
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fg,
                  ...typeStyle("bodySmall"),
                  fontWeight: "600",
                  flex: 1,
                  fontFamily: FONT.semibold,
                }}
                numberOfLines={1}
              >
                {eventVerb(event.eventType)}
                {event.signedByEmail ? ` by ${event.signedByEmail}` : ""}
              </Text>
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                }}
              >
                {dateTime(event.at, EMDASH)}
              </Text>
            </View>
            <Text
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              {event.documentSha256
                ? `hash ${truncateMiddle(event.documentSha256, 20)}`
                : "no document hash recorded"}
              {event.counterSignedBy
                ? ` · countersigned by ${event.counterSignedBy}`
                : ""}
            </Text>
            {event.notes ? (
              <Text
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                {...typeCap("bodySmall")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.regular,
                }}
              >
                {event.notes}
              </Text>
            ) : null}
          </View>
        ))}
      </QueryStates>
    </View>
  );
}
