/**
 * DomainReputationTrend — the 14-day per-domain reputation trend behind the
 * snapshot grade the domains screen already shows.
 *
 * Rendered only inside an EXPANDED domain row (the hook is armed by that
 * expansion), so the list never fans out one history request per row. Failure
 * is its own sentence — a failed trend read must never imply "no history".
 */
import { View } from "react-native";

import { OpsCardBody } from "@/components/deliverability/OpsCard";
import { useCustomDomainReputationHistory } from "@/hooks/useCustomDomainReputation";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { reputationSparkBars } from "@/lib/deliverabilityOpsView";
import { useTheme } from "@/lib/theme";

const BAR_WIDTH = 10;
const BAR_HEIGHT = 36;

export function DomainReputationTrend({
  domain,
  armed,
}: {
  domain: string;
  armed: boolean;
}) {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const query = useCustomDomainReputationHistory(domain, armed);
  const offline = !gate.enabled;

  if (!armed) return null;
  if (offline) {
    return <OpsCardBody>The reputation trend can&apos;t be read offline.</OpsCardBody>;
  }
  if (query.isError) {
    return (
      <OpsCardBody role="alert">
        The reputation trend couldn&apos;t be loaded.
      </OpsCardBody>
    );
  }
  const points = Array.isArray(query.data) ? query.data : [];
  if (query.isPending) {
    return <OpsCardBody>Loading the 14-day reputation trend…</OpsCardBody>;
  }
  if (points.length === 0) {
    return (
      <OpsCardBody>
        No sends in the last 14 days, so there is no reputation trend yet.
      </OpsCardBody>
    );
  }

  const bars = reputationSparkBars(points);
  const first = points[0];
  const last = points[points.length - 1];
  const toneColor = (tone: string) =>
    tone === "success" ? t.success : tone === "warning" ? t.warning : t.danger;

  return (
    <View style={{ gap: 6 }}>
      <View
        accessible
        accessibilityLabel={`Reputation trend for ${domain}: ${points.length} days, from ${Math.round(first?.score ?? 0)} to ${Math.round(last?.score ?? 0)}`}
        style={{
          flexDirection: "row",
          alignItems: "flex-end",
          gap: 3,
          height: BAR_HEIGHT,
        }}
      >
        {bars.map((bar, index) => (
          <View
            key={points[index]?.day ?? index}
            style={{
              width: BAR_WIDTH,
              height: Math.max(2, Math.round(bar.height * BAR_HEIGHT)),
              borderRadius: 2,
              backgroundColor: toneColor(bar.tone),
            }}
          />
        ))}
      </View>
      <OpsCardBody>
        {`Daily reputation score, oldest first · latest ${Math.round(last?.score ?? 0)}${last && last.complaintRatePct > 0 ? ` · complaint rate ${last.complaintRatePct.toFixed(2)}%` : ""}`}
      </OpsCardBody>
    </View>
  );
}
