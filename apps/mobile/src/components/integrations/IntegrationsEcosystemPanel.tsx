/**
 * IntegrationsEcosystemPanel — coverage, readiness and curated stacks.
 *
 * THE GAP. The desktop's integrations page carries three ecosystem-level
 * reports (useIntegrationsCatalogController.ts:152-154, rendered by
 * IntegrationCoveragePanels.tsx) and mobile had none of them, so "how much of
 * the ecosystem do we cover, and may we say so publicly" was a desk-only
 * question. The register's own note is that the value of this on a phone is
 * modest — which is why it is folded away, fetches nothing until opened, and
 * fetches ONE report rather than three.
 *
 * WHAT EACH ANSWERS:
 *   Coverage  — how many catalog entries and native connectors exist against
 *               the release targets, per category, with the priority gaps.
 *   Readiness — the release GATE: does the public parity claim hold, which
 *               checks fail, what the server recommends doing about it.
 *   Stacks    — the curated customer stacks and how much of each is covered.
 *
 * These are release-scoped reports, not workspace metrics: they describe the
 * PRODUCT's integration coverage, not what this tenant has connected. The
 * subtitle says so, because a "12 of 23 covered" read as "your workspace" is
 * the obvious wrong reading.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { QueryStates } from "@/components/QueryStates";
import { SectionLabel } from "@/components/SectionLabel";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SkeletonList } from "@/components/Skeleton";
import {
  CoverageReportBody,
  ReadinessReportBody,
  StacksReportBody,
} from "@/components/integrations/IntegrationsEcosystemRows";
import {
  useIntegrationsCoverage,
  useIntegrationsReadiness,
  useIntegrationsStacks,
} from "@/hooks/useIntegrationsEcosystem";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

type EcosystemTab = "coverage" | "readiness" | "stacks";

const TABS: ReadonlyArray<{ value: EcosystemTab; label: string }> = [
  { value: "coverage", label: "Coverage" },
  { value: "readiness", label: "Readiness" },
  { value: "stacks", label: "Stacks" },
];

export function IntegrationsEcosystemPanel() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<EcosystemTab>("coverage");

  const mayRead = canAccessMinimumRole("admin", gate.effectiveRole);
  const open = expanded && mayRead;

  // One report at a time: each hook is `wanted` only while its tab is showing.
  const coverage = useIntegrationsCoverage(open && tab === "coverage");
  const readiness = useIntegrationsReadiness(open && tab === "readiness");
  const stacks = useIntegrationsStacks(open && tab === "stacks");

  const linkStyle = {
    color: t.accent,
    ...typeStyle("callout"),
    fontFamily: FONT.semibold,
  } as const;

  const captionStyle = {
    color: t.fgMuted,
    ...typeStyle("caption"),
    fontFamily: FONT.regular,
  } as const;

  if (!mayRead) {
    return (
      <>
        <SectionLabel topMargin={24}>Ecosystem reports</SectionLabel>
        <Text {...typeCap("caption")} style={captionStyle}>
          Coverage, readiness and stack reports need an owner or admin session.
        </Text>
      </>
    );
  }

  const active =
    tab === "coverage" ? coverage : tab === "readiness" ? readiness : stacks;
  const isEmpty =
    tab === "coverage"
      ? coverage.data === undefined
      : tab === "readiness"
        ? readiness.data === undefined
        : stacks.data === undefined;

  return (
    <>
      <SectionLabel
        topMargin={24}
        subtitle="How much of the integration ecosystem Moosewave covers, and whether the public parity claim currently holds. These describe the product, not this workspace."
        right={
          <Pressable
            onPress={() => setExpanded((current) => !current)}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={
              expanded ? "Hide the ecosystem reports" : "Open the ecosystem reports"
            }
            hitSlop={8}
            style={{ minHeight: 44, justifyContent: "center", paddingStart: 12 }}
          >
            <Text {...typeCap("callout")} style={linkStyle}>
              {expanded ? "Hide" : "Open"}
            </Text>
          </Pressable>
        }
      >
        Ecosystem reports
      </SectionLabel>

      {expanded ? (
        <View style={{ gap: 8 }}>
          <SegmentedControl
            options={TABS}
            value={tab}
            onChange={setTab}
            accessibilityLabel="Ecosystem report"
          />
          <QueryStates
            query={active}
            gate={gate}
            isEmpty={isEmpty}
            offlineMessage="Ecosystem reports need a connection. Reconnect and pull to refresh — an unread report is not a coverage of zero."
            skeleton={
              <SkeletonList rows={4} lines={2} label="Loading the ecosystem report" />
            }
            empty={{
              title: "The report came back empty",
              description:
                "The server returned no report body. That is a server-side result, not a coverage verdict.",
            }}
          >
            {tab === "coverage" && coverage.data ? (
              <CoverageReportBody view={coverage.data} />
            ) : null}
            {tab === "readiness" && readiness.data ? (
              <ReadinessReportBody view={readiness.data} />
            ) : null}
            {tab === "stacks" && stacks.data ? (
              <StacksReportBody view={stacks.data} />
            ) : null}
          </QueryStates>
        </View>
      ) : null}
    </>
  );
}
