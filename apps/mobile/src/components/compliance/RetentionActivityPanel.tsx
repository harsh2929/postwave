/**
 * RetentionActivityPanel — proof that retention sweeps actually ran.
 *
 * Desktop's Compliance › RetentionActivityPanel, translated. Each row is one
 * batch the trim worker deleted, pinned to the Merkle root snapshot taken
 * before the delete, so "did our retention policy execute?" can be answered
 * from the road — including the honest empty answer, which is a sentence
 * about legal holds and fresh tenants, never an error.
 *
 * Read-only by design. NativeWind v4: static style objects only.
 */
import { Text, View } from "react-native";

import { QueryStates } from "@/components/QueryStates";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import { useComplianceCardStyle } from "@/components/compliance/complianceEvidenceStyle";
import { useRetentionActivity } from "@/hooks/useComplianceEvidence";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  RETENTION_EMPTY_COPY,
  retentionHeadline,
  shortRootHash,
  type RetentionPurgeEvent,
} from "@/lib/complianceEvidence";
import { dateTime, plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Rows rendered on the phone; the endpoint returns up to 100. */
const RENDER_CAP = 5;

export function RetentionActivityPanel({ allowed }: { allowed: boolean }) {
  const gate = useOnlineQueryGate();
  const query = useRetentionActivity(allowed);
  const { t } = useTheme();
  const styles = useComplianceCardStyle();

  if (!allowed) return null;
  const activity = query.data;
  const rows = activity?.events ?? [];
  const hidden = Math.max(0, rows.length - RENDER_CAP);

  return (
    <View style={{ marginTop: 16 }}>
      <SectionLabel
        topMargin={0}
        subtitle="Each row is one purge batch, pinned to the Merkle root recorded before the delete."
      >
        Retention activity
      </SectionLabel>
      <QueryStates
        query={query}
        gate={gate}
        isEmpty={rows.length === 0}
        offlineMessage="Retention evidence needs a connection. Reconnect and pull to refresh."
        skeleton={
          <SkeletonList rows={3} lines={2} label="Loading retention activity" />
        }
        empty={{
          title: "No purge batches recorded",
          description: RETENTION_EMPTY_COPY,
        }}
      >
        {activity ? (
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.medium,
              marginBottom: 8,
            }}
          >
            {retentionHeadline(activity)}
          </Text>
        ) : null}
        {rows.slice(0, RENDER_CAP).map((event) => (
          <PurgeRow key={event.id} event={event} />
        ))}
        {hidden > 0 ? (
          <Text {...typeCap("caption")} style={styles.note}>
            {`+${hidden} older batch${hidden === 1 ? "" : "es"} not shown — the full trail is on the web admin.`}
          </Text>
        ) : null}
      </QueryStates>
    </View>
  );
}

function PurgeRow({ event }: { event: RetentionPurgeEvent }) {
  const { t } = useTheme();
  const styles = useComplianceCardStyle();
  return (
    <View
      style={styles.card}
      accessible
      accessibilityLabel={`Purge batch: ${plural(event.deletedCount, "row")} deleted under a ${event.retentionDays}-day retention window`}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.medium,
        }}
      >
        {`${plural(event.deletedCount, "row")} purged · ${event.retentionDays}-day window`}
      </Text>
      <Text {...typeCap("caption")} style={styles.note}>
        {`${event.action || "audit.retention.purge"} · ${dateTime(event.at)}`}
      </Text>
      {event.beforeRootHash ? (
        <Text {...typeCap("caption")} style={styles.note}>
          {`root before: ${shortRootHash(event.beforeRootHash)}`}
        </Text>
      ) : null}
    </View>
  );
}
