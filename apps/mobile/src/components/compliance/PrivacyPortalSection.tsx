/**
 * PrivacyPortalSection — the operator half of the privacy portal, on the
 * Compliance screen: regions matrix (add/remove), consent proof, and the
 * double opt-in pending queue (extend/cancel).
 *
 * Desktop renders these on PrivacyPortal.tsx; mobile's operator surface for
 * workspace-level privacy governance is this screen, already admin-floored —
 * matching every `/privacy/portal/*` route's manifest role, so nothing here
 * is ever offered to a session that cannot use it (`allowed` comes from the
 * screen's own canAccessMinimumRole check and gates the queries too).
 */
import { Text, View } from "react-native";

import { QueryStates } from "@/components/QueryStates";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import { ConsentProofCard } from "@/components/compliance/ConsentProofCard";
import { DoubleOptinQueueCard } from "@/components/compliance/DoubleOptinQueueCard";
import { RegionsMatrixCard } from "@/components/compliance/RegionsMatrixCard";
import { useComplianceCardStyle } from "@/components/compliance/complianceEvidenceStyle";
import {
  useDoubleOptinPending,
  usePrivacyPortalOverview,
} from "@/hooks/usePrivacyPortalOps";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { typeCap } from "@/lib/typeScale";

export function PrivacyPortalSection({ allowed }: { allowed: boolean }) {
  const gate = useOnlineQueryGate();
  const overview = usePrivacyPortalOverview(allowed);
  const pending = useDoubleOptinPending(allowed);
  const styles = useComplianceCardStyle();

  if (!allowed) return null;

  return (
    <View style={{ marginTop: 16 }}>
      <SectionLabel
        topMargin={0}
        subtitle="Which framework applies in which market, and the consent proof behind it."
      >
        Privacy regions
      </SectionLabel>
      <QueryStates
        query={overview}
        gate={gate}
        // The regions list legitimately starts empty; the add form below is
        // the point of the empty state, so nothing is "empty" here.
        isEmpty={false}
        offlineMessage="The privacy portal needs a connection. Reconnect and pull to refresh."
        skeleton={
          <SkeletonList rows={2} lines={2} label="Loading privacy regions" />
        }
      >
        <RegionsMatrixCard
          regions={
            Array.isArray(overview.data?.regions) ? overview.data.regions : []
          }
        />
        <View style={{ marginTop: 12 }}>
          <ConsentProofCard rows={overview.data?.consentProof ?? null} />
        </View>
      </QueryStates>

      <SectionLabel subtitle="Confirmations that were mailed but never clicked.">
        Pending double opt-ins
      </SectionLabel>
      <QueryStates
        query={pending}
        gate={gate}
        isEmpty={false}
        offlineMessage="The pending queue needs a connection."
        skeleton={
          <SkeletonList rows={2} lines={2} label="Loading pending opt-ins" />
        }
      >
        <DoubleOptinQueueCard
          rows={Array.isArray(pending.data?.rows) ? pending.data.rows : []}
          truncated={Boolean(pending.data?.nextCursor)}
          now={Date.now()}
        />
      </QueryStates>
      <Text {...typeCap("caption")} style={styles.note}>
        Region and opt-in changes apply immediately and never queue offline.
      </Text>
    </View>
  );
}
