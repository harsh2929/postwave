/**
 * ConversionsScreen — "did revenue land, and which campaign earned it".
 *
 * WHY THIS IS THE ONLY CONVERSION SURFACE ON A PHONE. The desktop's
 * `apps/desktop/src/components/track/ConversionsSection.tsx` is a tracking
 * console: a cursor-paged raw conversion feed, plus creating and revoking the
 * public site key that a tenant's JavaScript ships. Key management is
 * credential authoring — the create call returns the plaintext key exactly once
 * — and stays on the desk. The raw feed carries `subscriber_email` on every
 * row; a phone screen is glanceable from across a table and this app has no
 * reason to put a recipient-identified purchase log on one. What ports is the
 * money question, and the aggregates answer it without naming a single person.
 *
 * ROLE. Viewer, and this one is not a trap: `conversions.Mount`
 * (apps/api/internal/conversions/attribution.go:704-713) guards both reads with
 * `RequireScope(ScopeReadReports)`, which is in `readOnlyScopes`
 * (apps/api/internal/apikeys/middleware.go:332-337) and therefore admits any
 * session role, and the routeauth manifest rows for both paths are
 * `session_minimum_role: viewer` with `review_status: reviewed` — a checked row,
 * not a fail-closed default. Both guards agree, so the screen does not pre-empt
 * anything. A live 403 is still its own state, because a session's scopes can
 * narrow while the app is open.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { useCallback, useMemo, useState } from "react";
import { IngestSecretsPanel } from "@/components/conversions/IngestSecretsPanel";
import { TrackingKeysPanel } from "@/components/conversions/TrackingKeysPanel";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { isConversionAccessDenied } from "@/api/conversionAttribution";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { QueryStates } from "@/components/QueryStates";
import { RoleGateNotice } from "@/components/RoleGateNotice";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SectionLabel } from "@/components/SectionLabel";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SkeletonList } from "@/components/Skeleton";
import {
  campaignRowKey,
  CampaignRevenueRow,
} from "@/components/conversions/CampaignRevenueRow";
import { AttributionVerdictCard } from "@/components/conversions/AttributionVerdictCard";
import { ProvenanceCard } from "@/components/conversions/ProvenanceCard";
import { RevenueTrendCard } from "@/components/conversions/RevenueTrendCard";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import {
  useAttributionTimeseries,
  useCampaignAttribution,
} from "@/hooks/useConversionAttribution";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  attributionVerdict,
  excludedCurrencyNotice,
  rollupNotice,
} from "@/lib/attributionVerdict";
import {
  attributionWindowFromKey,
  type AttributionWindowKey,
} from "@/lib/conversionAttribution";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function ConversionsScreen() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  useScreenViewed("conversions");

  const [windowKey, setWindowKey] = useState<AttributionWindowKey>("30");
  const days = attributionWindowFromKey(windowKey);
  const attribution = useCampaignAttribution(days);
  const timeseries = useAttributionTimeseries(days);

  const data = attribution.data ?? null;
  const items = useMemo(
    () => (data ? [...data.items] : []),
    [data],
  );

  const refresh = useManualRefresh(
    [attribution.refetch, timeseries.refetch],
    { enabled: gate.enabled },
  );

  const onDays = useCallback(
    (next: AttributionWindowKey) => setWindowKey(next),
    [],
  );

  const verdict = useMemo(
    () => attributionVerdict(data, days),
    [data, days],
  );
  const accessDenied =
    isConversionAccessDenied(attribution.error) ||
    isConversionAccessDenied(timeseries.error);

  const excluded = data ? excludedCurrencyNotice(data) : null;
  const rollup = data ? rollupNotice(data) : null;

  const subtitle = data
    ? `${plural(data.provenance.total, "conversion")} · last ${days} days`
    : undefined;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Conversions"
        {...(subtitle ? { subtitle } : {})}
        onBack={goBackOrMore}
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            enabled={gate.enabled}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
      >
        {accessDenied ? (
          <RoleGateNotice
            title="This session cannot read reports"
            body="Both attribution routes admit any workspace role, so this is not an admin wall — the session itself is missing the read:reports permission. Sign in again, or ask an owner to check the role's granted scopes."
            live
          />
        ) : (
          <>
            <MobileScopeNotice
              title="Monitor only"
              body="Site keys and the raw conversion feed stay on the web admin — the feed identifies recipients by email, and this screen deliberately never requests it."
            />

            <SegmentedControl<AttributionWindowKey>
              options={[
                { value: "7", label: "7 days", accessibilityLabel: "Last 7 days" },
                { value: "30", label: "30 days", accessibilityLabel: "Last 30 days" },
                { value: "90", label: "90 days", accessibilityLabel: "Last 90 days" },
              ]}
              value={windowKey}
              onChange={onDays}
              accessibilityLabel="Window"
            />

            <View style={{ height: 12 }} />
            <QueryStates
              query={attribution}
              gate={gate}
              isEmpty={data === null}
              offlineMessage="Attributed revenue needs a connection. Reconnect and pull to refresh — this is not the same as nothing having converted."
              skeleton={
                <SkeletonList rows={2} lines={4} label="Loading attributed revenue" />
              }
              empty={{
                title: "No reading yet",
                description: `Nothing came back for the last ${days} days.`,
              }}
            >
              <AttributionVerdictCard verdict={verdict} data={data} />
              {excluded ? <Note text={excluded} /> : null}
              {data ? <ProvenanceCard provenance={data.provenance} /> : null}
            </QueryStates>

            {timeseries.data && !timeseries.isError ? (
              <RevenueTrendCard series={timeseries.data} />
            ) : null}

            <SectionLabel
              {...(rollup ? { subtitle: rollup } : {})}
            >
              Revenue by campaign
            </SectionLabel>
            <QueryStates
              query={attribution}
              gate={gate}
              isEmpty={items.length === 0}
              offlineMessage="The campaign breakdown needs a connection. Reconnect and pull to refresh."
              skeleton={
                <SkeletonList rows={4} lines={2} label="Loading campaign revenue" />
              }
              empty={{
                title: "No conversion is tied to a campaign",
                description:
                  "Nothing in this window arrived with a campaign id, and nothing matched a click in the 7-day last-touch window. Conversions with no campaign are counted in the totals above.",
              }}
            >
              {items.map((item, index) => (
                <CampaignRevenueRow
                  key={campaignRowKey(item, index)}
                  item={item}
                  currency={data?.currency ?? ""}
                />
              ))}
            </QueryStates>
            {/* Revoking a leaked key is the urgent half; issuing stays on the
                web or desktop admin, where the once-shown value can be captured. Both
                key families get the verb: the HMAC ingest secrets and the
                public site keys the tenant's own pages ship. */}
            <IngestSecretsPanel />
            <TrackingKeysPanel />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Note({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("label")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("label"),
        marginBottom: 8,
        fontFamily: FONT.regular,
      }}
    >
      {text}
    </Text>
  );
}
