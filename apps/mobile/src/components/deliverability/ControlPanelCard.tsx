/**
 * ControlPanelCard — the sending-infrastructure read surface: domain setups,
 * click-tracking policy, IP-routing policy, inbox-test entitlements.
 *
 * Read-only ON PURPOSE: desktop's wired DeliverabilityControlPanel offers no
 * write either (the admin PUTs exist server-side with no client driver), and
 * mobile must not invent a lever desktop never shipped. Collapsed by default;
 * expanding is the press that starts the four reads. Each section owns its
 * own failure sentence — one dead read must not blank the other three.
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
import {
  useClickTrackingPolicy,
  useControlDomainSetups,
  useRoutingPolicy,
  useSendingEntitlement,
} from "@/hooks/useDeliverabilityControl";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import { num, relativeTime } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

function SectionLabel({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("label")}
      style={{
        color: t.fgMuted,
        ...typeStyle("label"),
        fontFamily: FONT.medium,
      }}
    >
      {children}
    </Text>
  );
}

export function ControlPanelCard() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const [armed, setArmed] = useState(false);

  const domains = useControlDomainSetups(armed);
  const clickTracking = useClickTrackingPolicy(armed);
  const routing = useRoutingPolicy(armed);
  const entitlement = useSendingEntitlement(armed);

  const offline = !gate.enabled;

  if (!armed) {
    return (
      <OpsCard>
        <OpsCardTitle>Sending infrastructure</OpsCardTitle>
        <OpsCardBody>
          Domain setups, click-tracking, IP routing and inbox-test allowances —
          the policy layer under every send.
        </OpsCardBody>
        {offline ? (
          <OpsCardBody>These policies can&apos;t be read offline.</OpsCardBody>
        ) : (
          <OpsAction label="Show infrastructure" onPress={() => setArmed(true)} />
        )}
      </OpsCard>
    );
  }

  const sectionBody = (
    isError: boolean,
    pending: boolean,
    failedText: string,
    line: string | null,
  ) =>
    offline ? (
      <OpsCardBody>Can&apos;t be read offline.</OpsCardBody>
    ) : isError ? (
      <OpsCardBody role="alert">{failedText}</OpsCardBody>
    ) : pending ? (
      <OpsCardBody>Loading…</OpsCardBody>
    ) : line ? (
      <OpsCardBody>{line}</OpsCardBody>
    ) : null;

  const ct = clickTracking.data;
  const rp = routing.data;
  const ent = entitlement.data;
  const setups = Array.isArray(domains.data) ? domains.data : [];

  return (
    <OpsCard>
      <OpsCardTitle>Sending infrastructure</OpsCardTitle>
      <OpsCardBody>
        Read-only here — changes to this layer are made where support can see
        them.
      </OpsCardBody>

      <SectionLabel>Domain setups</SectionLabel>
      {sectionBody(
        domains.isError,
        domains.isPending,
        "Domain setups couldn't be loaded.",
        setups.length === 0 ? "No managed domain setups." : null,
      )}
      {!offline && !domains.isError
        ? setups.slice(0, 5).map((setup) => (
            <View
              key={setup.domain}
              accessible
              accessibilityLabel={`${setup.domain}, ${setup.setupMode || "static DNS"}, ${setup.status || "unknown"}, SSL ${setup.sslStatus || "unknown"}`}
              style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            >
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fg,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.medium,
                  flex: 1,
                }}
                numberOfLines={1}
                ellipsizeMode="middle"
              >
                {setup.domain}
              </Text>
              <Pill
                label={setup.status || "unknown"}
                tone={setup.status === "active" ? "success" : "neutral"}
              />
            </View>
          ))
        : null}

      <SectionLabel>Click tracking</SectionLabel>
      {sectionBody(
        clickTracking.isError,
        clickTracking.isPending,
        "The click-tracking policy couldn't be loaded.",
        ct
          ? `${ct.trackingDomain || "No tracking domain"} · ${ct.status || "unknown"} · SSL ${ct.sslStatus || "unknown"}${
              ct.lastUntrackedCount !== null
                ? ` · last scan found ${num(ct.lastUntrackedCount)} untracked link${ct.lastUntrackedCount === 1 ? "" : "s"}`
                : ""
            }`
          : null,
      )}

      <SectionLabel>IP routing</SectionLabel>
      {sectionBody(
        routing.isError,
        routing.isPending,
        "The IP-routing policy couldn't be loaded.",
        rp
          ? `${rp.strategy || "default"} · ${Math.round(rp.effectiveDedicatedPercent)}% dedicated / ${Math.round(rp.effectiveSharedPercent)}% shared${rp.lastEvaluatedAt ? ` · evaluated ${relativeTime(rp.lastEvaluatedAt)}` : ""}`
          : null,
      )}

      <SectionLabel>Inbox-test allowance</SectionLabel>
      {sectionBody(
        entitlement.isError,
        entitlement.isPending,
        "Entitlements couldn't be loaded.",
        ent
          ? `${ent.planTier || "plan"} · ${num(ent.inboxTestsRemaining)} of ${num(ent.inboxTestsMonthly)} inbox tests left · ${num(ent.renderPreviewsRemaining)} of ${num(ent.renderPreviewsMonthly)} previews left`
          : null,
      )}
    </OpsCard>
  );
}
