/**
 * ProductEventsScreen — "which product events is this workspace actually
 * receiving, and has any of them stopped?"
 *
 * WHY THIS EXISTS ON A PHONE. `apps/api/internal/track` is the ingest spine
 * behind every product_event trigger, every commerce lifecycle flow and the
 * revenue bridge — and mobile referenced none of it (`grep -rl 'api/v1/track'`
 * over apps/mobile returned nothing before this file). The desktop's Track page
 * is 2,091 lines including a live tail and an event composer; neither of those
 * ports. What DOES port is the one question asked away from a desk: the
 * integration went live an hour ago — is it sending, and did anything that used
 * to send stop?
 *
 * A MONITOR, NOT AN ADMIN CONSOLE. Two capabilities the API offers are
 * deliberately absent:
 *
 *   - THE LIVE TAIL. `GET /api/v1/track/stream` is SSE (track/handlers.go:95).
 *     Absent by CHOICE, not by limitation — the previous note here claimed the
 *     app could not consume SSE at all, which was never true in this binary:
 *     the event bus has streamed through `expo/fetch` on every launch, and the
 *     audit tail now opens a stream of its own. What is true is that this
 *     screen is a MONITOR: you open it to ask "is it sending, and did anything
 *     stop?", read three bounded answers, and close it. A tail you watch scroll
 *     is a different product, and it costs a socket held warm on a phone radio
 *     for as long as it is open.
 *   - THE COMPOSER. `POST /api/v1/track` is mounted behind `ScopeAdmin`
 *     (handlers.go:90) and a successful write fans out to live automations,
 *     flow runs and attributed revenue (handlers.go:83-88). Hand-authoring a
 *     fixture event is a developer-bench task on a keyboard, and firing real
 *     automations from a phone by accident is the failure mode.
 *
 * AUTHORIZATION. All three reads are scope-gated, not role-gated, and both
 * scopes involved (`read:reports`, `read:subscribers`) are in `readOnlyScopes`
 * (apikeys/middleware.go:331-336), so `requireAdminRoleForScopes` returns false
 * and the session path never reaches a role check (middleware.go:211-221). Any
 * role — viewer included — can open this screen and see everything on it. There
 * is therefore no role notice here; the one permission split that does exist is
 * per-panel and lives in `ProductEventSamplePanel`.
 *
 * THE HONESTY THIS SCREEN IS BUILT AROUND: a stale event must read as stale,
 * never as zero, and an event that stopped before the window must read as
 * ABSENT rather than as healthy. Both are enforced in `lib/productEventHealth`
 * and asserted in its node tests.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/ScreenHeader";
import { SectionLabel } from "@/components/SectionLabel";
import { SegmentedControl } from "@/components/SegmentedControl";
import { QueryStates } from "@/components/QueryStates";
import { SkeletonList } from "@/components/Skeleton";
import { ProductEventActivityCard } from "@/components/product-events/ProductEventActivityCard";
import { ProductEventCatalogSection } from "@/components/product-events/ProductEventCatalogSection";
import { ProductEventExportAction } from "@/components/product-events/ProductEventExportAction";
import {
  DEFAULT_PRODUCT_EVENT_WINDOW,
  PRODUCT_EVENT_WINDOWS,
  type ProductEventWindow,
} from "@/api/productEvents";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  useProductEventCatalog,
  useProductEventSample,
  useProductEventStats,
} from "@/hooks/useProductEvents";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { plural } from "@/lib/format";
import { goBackOrMore } from "@/lib/nav";
import {
  silentEventCount,
  type ProductEventOrder,
} from "@/lib/productEventHealth";
import { useTheme } from "@/lib/theme";

const WINDOW_OPTIONS = PRODUCT_EVENT_WINDOWS.map((days) => ({
  value: String(days) as `${ProductEventWindow}`,
  label: `${days}d`,
  accessibilityLabel: `Last ${plural(days, "day")}`,
}));

export function ProductEventsScreen() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  useScreenViewed("product-events");

  const [windowDays, setWindowDays] = useState<ProductEventWindow>(
    DEFAULT_PRODUCT_EVENT_WINDOW,
  );
  const [order, setOrder] = useState<ProductEventOrder>("attention");
  const [query, setQuery] = useState("");
  const [expandedName, setExpandedName] = useState<string | null>(null);

  const stats = useProductEventStats(windowDays);
  const catalog = useProductEventCatalog(windowDays);
  const sample = useProductEventSample(expandedName);

  // All three, so a pull refreshes everything on screen. Leaving the sample out
  // would pin the one list whose entire job is to be current — the rows an
  // engineer is watching while a deploy rolls out.
  const refresh = useManualRefresh(
    [stats.refetch, catalog.refetch, sample.refetch],
    { enabled: gate.enabled },
  );

  const onWindowChange = useCallback((next: string) => {
    const parsed = Number(next) as ProductEventWindow;
    setWindowDays(parsed);
    // The open row's sample is unaffected by the window (that route takes no
    // days parameter), so it deliberately stays open — collapsing it would
    // throw away the reader's place for a change that did not touch it.
  }, []);

  const onToggleRow = useCallback((eventName: string) => {
    setExpandedName((current) => (current === eventName ? null : eventName));
  }, []);

  const rows = catalog.data?.items ?? [];
  const silent = silentEventCount(rows, catalog.data?.asOf ?? "");
  const subtitle =
    catalog.data !== undefined && rows.length > 0
      ? `${plural(rows.length, "event")} · ${silent} silent`
      : undefined;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Product events"
        {...(subtitle ? { subtitle } : {})}
        onBack={goBackOrMore}
        // The feed's only way off the phone. It exports the WINDOW on screen,
        // so it moves with the control below rather than fixing its own range.
        right={<ProductEventExportAction days={windowDays} />}
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
        <SegmentedControl
          options={WINDOW_OPTIONS}
          value={String(windowDays) as `${ProductEventWindow}`}
          onChange={onWindowChange}
          accessibilityLabel="Reporting window"
        />

        <View style={{ marginTop: 14 }}>
          <SectionLabel topMargin={0}>Activity</SectionLabel>
          <QueryStates
            query={stats}
            gate={gate}
            isEmpty={!stats.data}
            offlineMessage="Reconnect to read ingest volume."
            skeleton={<SkeletonList rows={2} lines={2} label="Loading activity" />}
            empty={{
              title: "No activity yet",
              description:
                "Nothing has been tracked for this workspace in the selected window.",
            }}
          >
            {stats.data ? (
              <ProductEventActivityCard stats={stats.data} />
            ) : null}
          </QueryStates>
        </View>

        {/* Sibling of the activity block, never a child of it. The totals and
            the catalogue are two independent reads, and nesting them would let
            one failing query hide the other — the totals are exactly what stays
            plausible while an individual event has stopped, so losing the
            catalogue is losing the evidence. */}
        <ProductEventCatalogSection
          catalog={catalog}
          sample={sample}
          gate={gate}
          order={order}
          onOrderChange={setOrder}
          query={query}
          onQueryChange={setQuery}
          expandedName={expandedName}
          onToggleRow={onToggleRow}
        />
      </ScrollView>
    </SafeAreaView>
  );
}
