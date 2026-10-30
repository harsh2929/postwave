/**
 * Plan & usage — what plan am I on, how much of it have I used, am I about to
 * blow a cap, where are my invoices, and how do I fix my card.
 *
 * This is the screen people open when sending stops, so it is built for that
 * moment: a real error state with a Retry (the query used to swallow every
 * failure and render a dead end), pull-to-refresh (the numbers can be a minute
 * stale), the send-cap projection the endpoint already returns, a send-volume
 * trend, and a one-tap hand-off to the Stripe portal instead of the old
 * "visit Billing on the web app" cul-de-sac.
 *
 * Scope note: checkout and plan CHANGES stay out of the app. The portal link is
 * an out-of-app management hand-off, never an in-app purchase path.
 *
 * NativeWind v4 gotcha: every Pressable here uses a STATIC style object, never
 * the function form `style={({pressed}) => …}` (which NativeWind v4 silently
 * drops, taking the layout with it).
 */
import * as Linking from "expo-linking";
import { router } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  createBillingPortalSession,
  fetchPlanSummary,
  fetchUsage,
  listInvoices,
  type UsageWindow,
} from "@/api/billing";
import { ApiUsageSection } from "@/components/billing/ApiUsageSection";
import { InvoiceSection } from "@/components/billing/InvoiceSection";
import { SpendControlsCard } from "@/components/billing/SpendControlsCard";
import { UsageBar } from "@/components/billing/UsageBar";
import { UsageTrend } from "@/components/billing/UsageTrend";
import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Skeleton, SkeletonGroup } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { projectionCopy, safeBillingRedirectURL } from "@/lib/billingNormalize";
import { trackCommerceAction } from "@/lib/commerceTelemetry";
import { FONT } from "@/lib/fonts";
import { date, EMDASH } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { useAuthStore } from "@/store/auth";
import { typeCap, typeStyle } from "@/lib/typeScale";

export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

const MONTHLY_SENDS = "monthly_sends";

export default function BillingScreen() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const mode = useAuthStore((s) => s.mode);
  useScreenViewed("billing");

  // The four billing READS are viewer (openapi.x-required-scopes), which is why
  // this row carries no route floor — a viewer is entitled to see the plan and
  // usage. POST /api/v1/billing/portal is still ADMIN, so the portal button is
  // gated separately. Without this the floor removal would hand viewers a
  // button that can only 403 on tap, which is the exact trap the commerce and
  // approvals rows are documented against.
  const canManageBilling = canAccessMinimumRole(
    "admin",
    gate.effectiveRole,
    mode,
  );

  const [usageWindow, setUsageWindow] = useState<UsageWindow>(30);
  const [openingPortal, setOpeningPortal] = useState(false);

  const plan = useQuery({
    queryKey: ["billing", "plan-summary", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    queryFn: () => fetchPlanSummary(),
    staleTime: 60_000,
  });

  const usage = useQuery({
    queryKey: ["billing", "usage", gate.tenantId, usageWindow],
    enabled: gate.enabled && Boolean(gate.tenantId),
    queryFn: () => fetchUsage(usageWindow),
    staleTime: 5 * 60_000,
  });

  const invoices = useQuery({
    queryKey: ["billing", "invoices", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    queryFn: () => listInvoices(),
    staleTime: 5 * 60_000,
  });

  // LOVE#15: only a REAL pull spins the control. `isRefetching` also fires for
  // the refetch a foreground resume triggers (connectivity.ts bridges AppState
  // into TanStack's focusManager), so the spinner used to appear spontaneously
  // on a screen the reader had not touched.
  const refresh = useManualRefresh(
    [
      plan.refetch,
      usage.refetch,
      invoices.refetch,
      // The API usage & cost section owns its own reads; a pull refreshes
      // them by key prefix rather than reaching into the section.
      () => queryClient.invalidateQueries({ queryKey: ["billing", "api-usage"] }),
      () => queryClient.invalidateQueries({ queryKey: ["billing", "costs"] }),
    ],
    {
      enabled: gate.enabled,
    },
  );

  const openPortal = useCallback(async () => {
    if (openingPortal) return;
    setOpeningPortal(true);
    haptics.tap();
    try {
      const url = await createBillingPortalSession();
      const safe = safeBillingRedirectURL(url, gate.baseUrl);
      if (!safe) {
        haptics.error();
        // COMMERCE#58: a portal link the redirect allowlist rejects is a
        // hard dead end on the one screen people open when sending has
        // stopped, and it was previously silent outside the toast.
        trackCommerceAction("billing_portal", "refused");
        toast({
          kind: "error",
          message: "The billing portal returned a link we can't open safely.",
        });
        return;
      }
      await Linking.openURL(safe);
      trackCommerceAction("billing_portal", "success");
    } catch (err) {
      haptics.error();
      trackCommerceAction("billing_portal", "failure");
      toast({
        kind: "error",
        message:
          err instanceof Error && err.message
            ? err.message
            : "Couldn't open the billing portal.",
      });
    } finally {
      setOpeningPortal(false);
    }
  }, [gate.baseUrl, openingPortal, toast]);

  const summary = plan.data;
  const projection = projectionCopy(summary?.sends_projection);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Plan & usage"
        onBack={() => (router.canGoBack() ? router.back() : goBackOrMore())}
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
        <QueryStates
          query={plan}
          gate={gate}
          isEmpty={!summary}
          offlineMessage="Plan and usage need a connection — reconnect to see current numbers."
          skeleton={<PlanSkeleton />}
        >
          {summary ? (
            <>
              <PlanCard
                tier={summary.tier}
                periodEnd={summary.current_period_end}
              />

              <SectionTitle>Usage this period</SectionTitle>
              {summary.resources.length === 0 ? (
                <Text
                  {...typeCap("bodySmall")}
                  style={{
                    color: t.fgSubtle,
                    fontFamily: FONT.regular,
                    ...typeStyle("bodySmall"),
                    marginBottom: 16,
                  }}
                >
                  No metered resources on this plan.
                </Text>
              ) : (
                summary.resources.map((row) => (
                  <UsageBar
                    key={row.resource}
                    row={row}
                    {...(row.resource === MONTHLY_SENDS && projection
                      ? {
                          footnote: {
                            tone: projection.tone,
                            text: projection.text,
                          },
                        }
                      : {})}
                  />
                ))
              )}

              <SectionTitle>Send volume</SectionTitle>
              <UsageTrend
                points={Array.isArray(usage.data) ? usage.data : []}
                window={usageWindow}
                onWindowChange={setUsageWindow}
                loading={usage.isLoading}
                failed={usage.isError}
              />

              {/* Above the invoice list on purpose: invoices are what already
                  happened, and this is the control that changes what happens
                  next. An operator who opened this screen because the
                  projection alarmed them should reach the switch first. */}
              <SpendControlsCard />

              {/* `failed` is what stops a 500 on /billing/invoices from
                  rendering as an ABSENT section — indistinguishable from a
                  workspace that has never been billed, on the screen someone
                  opened specifically to find an invoice. `usage` above already
                  gets this treatment via its own `failed` prop; this read did
                  not, and silently disappeared instead. */}
              <InvoiceSection
                invoices={Array.isArray(invoices.data) ? invoices.data : []}
                baseUrl={gate.baseUrl}
                failed={invoices.isError}
                onRetry={() => void invoices.refetch()}
              />

              {/* Desktop's Settings › Usage, folded in here (P2.54): the
                  aggregates render inline and the itemized ledger opens as a
                  sheet. The section gates its own halves — /api-usage is
                  admin, /costs is viewer — so it is deliberately NOT inside
                  canManageBilling: a viewer is entitled to the cost totals. */}
              <ApiUsageSection />

              {/* HIDDEN, not disabled, below admin. POST /billing/portal is
                  admin-only, so for a viewer this control can only ever 403 —
                  and a disabled-looking button still reads as "you could do
                  this if you tried harder". The reads above stay visible
                  because a viewer is genuinely entitled to them. */}
              {canManageBilling ? (
                <>
                  <Pressable
                    onPress={() => void openPortal()}
                    disabled={openingPortal || !gate.enabled}
                    accessibilityRole="button"
                    accessibilityLabel="Manage plan and payment in the billing portal. Opens outside the app."
                    accessibilityState={{
                      disabled: openingPortal || !gate.enabled,
                    }}
                    style={{
                      marginTop: 24,
                      minHeight: 48,
                      borderRadius: 12,
                      borderWidth: 1,
                      borderColor: t.border,
                      backgroundColor: t.surface,
                      alignItems: "center",
                      justifyContent: "center",
                      paddingHorizontal: 16,
                      opacity: openingPortal || !gate.enabled ? 0.5 : 1,
                    }}
                  >
                    <Text
                      {...typeCap("callout")}
                      style={{
                        color: t.accent,
                        fontFamily: FONT.semibold,
                        ...typeStyle("callout"),
                      }}
                    >
                      {openingPortal ? "Opening…" : "Manage plan & payment"}
                    </Text>
                  </Pressable>
                  <Text
                    {...typeCap("label")}
                    style={{
                      color: t.fgSubtle,
                      fontFamily: FONT.regular,
                      ...typeStyle("label"),
                      marginTop: 8,
                    }}
                  >
                    Cards, plan changes and cancellation open in the secure
                    billing portal outside the app.
                  </Text>
                </>
              ) : null}
            </>
          ) : null}
        </QueryStates>
      </ScrollView>
    </SafeAreaView>
  );
}

function SectionTitle({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <Text
      accessibilityRole="header"
      {...typeCap("heading")}
      style={{
        color: t.fg,
        fontFamily: FONT.semibold,
        ...typeStyle("heading"),
        marginBottom: 12,
        marginTop: 4,
      }}
    >
      {children}
    </Text>
  );
}

function PlanCard({
  tier,
  periodEnd,
}: {
  tier: string;
  periodEnd: string | undefined;
}) {
  const { t } = useTheme();
  const renews = periodEnd ? date(periodEnd) : null;
  return (
    <View
      accessible
      accessibilityLabel={`Current plan: ${tier || "unknown"}.${
        renews ? ` Renews ${renews}.` : ""
      }`}
      style={{
        backgroundColor: t.surface,
        borderColor: t.border,
        borderWidth: 1,
        borderRadius: 14,
        padding: 16,
        marginBottom: 20,
      }}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          fontFamily: FONT.regular,
          ...typeStyle("caption"),
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        Current plan
      </Text>
      <Text
        {...typeCap("display")}
        style={{
          color: t.fg,
          fontFamily: FONT.semibold,
          ...typeStyle("display"),
          marginTop: 4,
          textTransform: "capitalize",
        }}
      >
        {tier || EMDASH}
      </Text>
      {renews ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            fontFamily: FONT.regular,
            ...typeStyle("bodySmall"),
            marginTop: 4,
          }}
        >
          Renews {renews}
        </Text>
      ) : null}
    </View>
  );
}

/** Screen-shaped first-load placeholder: the plan card, then four bar rows. */
function PlanSkeleton() {
  return (
    <SkeletonGroup label="Loading your plan">
      <Skeleton height={96} radius={14} style={{ marginBottom: 20 }} />
      {/* Placeholder bars stand in for real lines of type, so their heights
          come from the same scale the real text does rather than a literal
          that silently disagrees with it after a role changes size. */}
      <Skeleton
        width="40%"
        height={typeStyle("heading").fontSize}
        style={{ marginBottom: 16 }}
      />
      <View style={{ gap: 18 }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <View key={i} style={{ gap: 8 }}>
            <Skeleton width="55%" height={typeStyle("body").fontSize} />
            <Skeleton height={8} radius={4} />
          </View>
        ))}
      </View>
    </SkeletonGroup>
  );
}
