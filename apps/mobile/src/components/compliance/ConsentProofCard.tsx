/**
 * ConsentProofCard — how much capturable consent proof is on hand, by source.
 *
 * Desktop's ConsentProofPanel over `consent_proof_summary`, the field
 * lib/privacyPosture deliberately drops for the Settings posture line. Here
 * it is the point: if a regulator asks "show me form-captured consent", this
 * is the count the workspace can answer with.
 *
 * `rows === null` means the server did not include the field (older
 * deployment) — the card says nothing rather than claiming zero proof.
 */
import { Text, View } from "react-native";

import { useComplianceCardStyle } from "@/components/compliance/complianceEvidenceStyle";
import {
  consentProofTotal,
  type ConsentProofRow,
} from "@/lib/privacyPortalOps";
import { plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function ConsentProofCard({
  rows,
}: {
  rows: ConsentProofRow[] | null;
}) {
  const { t } = useTheme();
  const styles = useComplianceCardStyle();
  if (rows === null) return null;

  return (
    <View
      style={styles.card}
      accessible
      accessibilityLabel={`Consent proof: ${plural(consentProofTotal(rows), "receipt")} on record`}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.medium,
        }}
      >
        {rows.length === 0
          ? "No consent proof recorded"
          : `${plural(consentProofTotal(rows), "consent receipt")} on record`}
      </Text>
      {rows.length === 0 ? (
        <Text {...typeCap("caption")} style={styles.note}>
          No capturable consent receipts yet. Proof accrues as forms, imports
          and API writes record their source.
        </Text>
      ) : (
        rows.map((row) => (
          <Text key={row.source} {...typeCap("caption")} style={styles.note}>
            {`${row.source}: ${plural(row.count, "receipt")}`}
          </Text>
        ))
      )}
    </View>
  );
}
