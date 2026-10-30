/**
 * AuthChecksCard — the SPF/DKIM/DMARC/BIMI/PTR matrix, per sending domain.
 *
 * Post-send evidence from the proxied auth-checks service: one row per
 * resolved sending domain, five verdict cells each. Admin-scoped (the proxy
 * mounts at ScopeAdmin), so the card mounts only for admins. ARMED by a
 * press — the read walks DNS behind the proxy and only matters when the
 * operator asks. A 502/503 answer means "not configured on this deployment",
 * a different sentence from a failure.
 */
import { useState } from "react";
import { Text, View } from "react-native";

import {
  OpsAction,
  OpsCard,
  OpsCardBody,
  OpsCardTitle,
} from "@/components/deliverability/OpsCard";
import { Pill } from "@/components/Pill";
import { isServiceUnavailable } from "@/api/deliverabilityEvidence";
import { AUTH_CHECK_KEYS } from "@/api/deliverabilityEvidence";
import { useAuthChecks } from "@/hooks/useDeliverabilityEvidence";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isAdminRole } from "@/lib/campaignAccess";
import {
  authStatus,
  authStatusTone,
  authWorstStatus,
} from "@/lib/deliverabilityOpsView";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

function pillTone(
  tone: ReturnType<typeof authStatusTone>,
): "neutral" | "success" | "warning" | "danger" | "info" {
  return tone === "neutral" ? "neutral" : tone;
}

export function AuthChecksCard() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const [armed, setArmed] = useState(false);
  const query = useAuthChecks(armed);

  // ANY /api/v1/auth-checks is admin-floor; omit the surface below that.
  if (!isAdminRole(gate.effectiveRole)) return null;
  const offline = !gate.enabled;

  const rows = Array.isArray(query.data) ? query.data : [];

  return (
    <OpsCard>
      <OpsCardTitle>Authentication checks</OpsCardTitle>
      {!armed ? (
        <>
          <OpsCardBody>
            SPF, DKIM, DMARC, BIMI and PTR verdicts for every resolved sending
            domain.
          </OpsCardBody>
          {offline ? (
            <OpsCardBody>The checks run server-side and need a connection.</OpsCardBody>
          ) : (
            <OpsAction label="Run checks" onPress={() => setArmed(true)} />
          )}
        </>
      ) : query.isError ? (
        <OpsCardBody role="alert">
          {isServiceUnavailable(query.error)
            ? "The auth-check service isn't configured on this deployment."
            : "Authentication checks couldn't be loaded."}
        </OpsCardBody>
      ) : !query.data ? (
        <OpsCardBody>Checking DNS for your sending domains…</OpsCardBody>
      ) : rows.length === 0 ? (
        <OpsCardBody>
          No resolved sending domains to check — verify a domain first.
        </OpsCardBody>
      ) : (
        rows.map((row) => {
          const worst = authWorstStatus(row);
          return (
            <View
              key={row.domain}
              accessible
              accessibilityLabel={`${row.domain}: ${AUTH_CHECK_KEYS.map(
                (key) => `${key.toUpperCase()} ${authStatus(row.checks[key].status)}`,
              ).join(", ")}`}
              style={{
                borderTopColor: t.borderSubtle,
                borderTopWidth: 1,
                paddingTop: 8,
                gap: 6,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text
                  {...typeCap("bodySmall")}
                  style={{
                    color: t.fg,
                    ...typeStyle("bodySmall"),
                    fontFamily: FONT.medium,
                    flexShrink: 1,
                  }}
                  numberOfLines={1}
                >
                  {row.domain}
                </Text>
                <Pill label={worst} tone={pillTone(authStatusTone(worst))} />
              </View>
              <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                {AUTH_CHECK_KEYS.map((key) => {
                  const status = authStatus(row.checks[key].status);
                  return (
                    <Pill
                      key={key}
                      label={`${key.toUpperCase()} ${status === "unknown" ? "—" : status}`}
                      tone={pillTone(authStatusTone(status))}
                    />
                  );
                })}
              </View>
            </View>
          );
        })
      )}
    </OpsCard>
  );
}
