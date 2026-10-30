/**
 * Audit tab — the investigation surface, not a recent-events ticker.
 *
 * What changed the character of this screen:
 *
 *   - IT IS NO LONGER CAPPED AT 100. The server has always returned a
 *     `nextCursor`; the screen pages on it, so an incident two hours old on a
 *     busy tenant is reachable from a phone instead of being silently off the
 *     end of the list.
 *   - NARROWING IS HONEST. The time window (and single-value actor chips)
 *     are pushed to the server; the search box, the Destructive toggle and
 *     the Security lens are client-side over what is loaded, and the copy
 *     says which is which.
 *   - INVESTIGATIONS ARE NAMEABLE AND RECALLABLE. Saved views are the same
 *     server rows desktop writes, so an on-call operator stops re-specifying
 *     the same filter set and can open a view a colleague saved at a desk.
 *   - IT CAN TELL YOU IT IS BEHIND. Desktop's SSE tail prepends rows; here
 *     the same stream only wakes a bounded probe that COUNTS what has
 *     arrived and waits to be asked — see lib/auditTail for why.
 *   - PERMISSION IS ANSWERED, NOT GUESSED. GET /api/v1/audit sits behind the
 *     audit:read scope; `/api/v1/audit/my-scopes` is deliberately ungated, so
 *     a user without the scope gets an explanation instead of a bare 403.
 *   - PROVENANCE IS VISIBLE. Redaction, legal hold, encrypted metadata, UEBA
 *     risk and the Merkle checkpoint all surface.
 *
 * Filter state, derived rows and the tail live in hooks/useAuditScreen; the
 * saved-view verbs live in hooks/useAuditViewLibrary. This file is the
 * composition.
 */
import { useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { FlatList, type ListRenderItem, RefreshControl, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { AuditExportButton } from "@/components/audit/AuditExportSheet";
import { AuditFilterBar } from "@/components/audit/AuditFilterBar";
import {
  AuditGovernanceSheet,
  AuditGovernanceStrip,
} from "@/components/audit/AuditGovernanceSheet";
import { AuditInvestigationsButton } from "@/components/audit/AuditInvestigationsSheet";
import {
  AuditDayHeader,
  AuditListFooter,
} from "@/components/audit/AuditListParts";
import { AuditNlqButton } from "@/components/audit/AuditNlqSheet";
import {
  AuditListEmpty,
  AuditListHeader,
} from "@/components/audit/AuditListStates";
import { AuditRowCard } from "@/components/audit/AuditRowCard";
import { AuditSavedViewsBar } from "@/components/audit/AuditSavedViewsBar";
import { AuditScreenOverlays } from "@/components/audit/AuditScreenOverlays";
import {
  hasAuditPiiScope,
  hasAuditReadScope,
  useAuditScopes,
  type AuditRow,
} from "@/hooks/useAudit";
import { useAuditExportController } from "@/hooks/useAuditExport";
import { useAuditInvestigations } from "@/hooks/useAuditInvestigations";
import { useAuditNlqController } from "@/hooks/useAuditNlq";
import { useAuditAccessRequests } from "@/hooks/useAuditGovernance";
import { useAuditSavedViews } from "@/hooks/useAuditSavedViews";
import { auditExportInputFromScreen, useAuditScreen } from "@/hooks/useAuditScreen";
import { useAuditViewLibrary } from "@/hooks/useAuditViewLibrary";
import { useInvestigationReview } from "@/hooks/useInvestigationReview";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  countAuditAdvancedFilters,
  describeAuditAdvancedFilters,
} from "@/lib/auditAdvancedFilters";
import {
  auditUnmaskAccess,
  retentionOverrideAccess,
} from "@/lib/auditForensics";
import { accessRequestsBannerLine } from "@/lib/auditGovernance";
import { savedViewWriteAccess } from "@/lib/auditSavedViewPolicy";
import { useAuthStore } from "@/store/auth";
import type { AuditListItem } from "@/lib/auditGrouping";
import { isInvestigationDecidable } from "@/lib/auditInvestigations";
import { relativeTime } from "@/lib/format";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";

/** A malformed audit payload degrades this screen, not the whole app. */
export { AppErrorBoundary as ErrorBoundary };

export default function Audit() {
  const { t } = useTheme();
  useScreenViewed("audit");
  const { toast } = useToast();
  const confirm = useConfirm();
  const [openRow, setOpenRow] = useState<AuditRow | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [investigationsOpen, setInvestigationsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [governanceOpen, setGovernanceOpen] = useState(false);
  // null = closed; { seed } = open, optionally pre-filled from a row's own
  // correlation id. Opening a trace CLOSES the detail sheet first — stacking
  // two pageSheet modals is exactly the iOS presentation fight to avoid.
  const [chain, setChain] = useState<{ seed: string | null } | null>(null);

  const authMode = useAuthStore((state) => state.mode);
  const scopes = useAuditScopes();
  const canRead = hasAuditReadScope(scopes.data);
  const canReadPii = hasAuditPiiScope(scopes.data);

  // `?lens=security` — Settings' recent-security-activity card hands off here
  // (AUTH#8b), and it must land on the SAME set it was showing rather than on
  // the unfiltered log with the user left to rebuild the filter.
  const { lens } = useLocalSearchParams<{ lens?: string }>();
  const screen = useAuditScreen(
    lens === "security" ? { securityOnly: true } : undefined,
  );
  const { audit, gate, view, tail } = screen;

  // READING saved views sits behind the same audit:read scope as the log
  // itself (server/audit_operations.go:43-46), so the LIST is gated on the
  // scope answer rather than on a role — and never requested while it is
  // unknown. WRITING is a different permission: routeauth's manifest puts
  // `session_minimum_role: admin` on POST/PATCH/DELETE, which the mount-site
  // wrapper does not express. See lib/auditSavedViewPolicy for the trace.
  const savedViews = useAuditSavedViews(canRead === true);
  const viewWrites = savedViewWriteAccess({ scopes: scopes.data, mode: authMode });

  // ASKING is not READING. POST /api/v1/audit/nlq carries routeauth's
  // `session_minimum_role: admin` + `audit:execute_actions` row — stricter
  // than the mount-site audit:read wrapper, and the same floor as a saved-view
  // write — so the controller withholds the control until that floor is met.
  const nlq = useAuditNlqController<AuditRow>({
    scopes: scopes.data,
    mode: authMode,
  });
  const library = useAuditViewLibrary({
    view,
    views: savedViews.data ?? [],
    applyView: screen.applyView,
    confirm,
    toast,
  });

  // READING is the audit:read scope; DECIDING is apikeys.ScopeAdmin, which the
  // session branch of RequireScope resolves to owner|admin. Two gates, one
  // screen — an auditor without admin sees the queue and no buttons.
  const investigations = useAuditInvestigations(canRead === true);
  const review = useInvestigationReview({ confirm, toast });
  // Admin awareness read: "a teammate is waiting on audit access". Enabled
  // strictly on the admin verdict — the route 403s everyone else.
  const accessRequests = useAuditAccessRequests(scopes.data?.isAdmin === true);
  // Array.isArray, not a truthy test: the endpoint answers
  // `{investigations: [...]}` and only `normalizeInvestigationList` unwraps
  // it, so a restored persisted cache written by a different shape reached
  // `.filter` and took the whole compliance surface down. `null` is also the
  // right answer for a payload we cannot read — the badge then says nothing
  // rather than claiming an empty queue.
  const investigationRows = Array.isArray(investigations.data)
    ? investigations.data
    : null;
  const pendingInvestigations = investigationRows
    ? investigationRows.filter(isInvestigationDecidable).length
    : null;

  const keyExtractor = useCallback((item: AuditListItem<AuditRow>) => item.key, []);
  const renderItem = useCallback<ListRenderItem<AuditListItem<AuditRow>>>(
    ({ item }) =>
      item.kind === "day" ? (
        <AuditDayHeader label={item.label} count={item.count} />
      ) : (
        <AuditRowCard
          row={item.row}
          {...(item.row.id != null && screen.risks.has(item.row.id)
            ? { anomaly: screen.risks.get(item.row.id) }
            : {})}
          timeOnly
          onOpen={setOpenRow}
        />
      ),
    [screen.risks],
  );

  const onEndReached = useCallback(() => {
    if (audit.hasNextPage && !audit.isFetchingNextPage) {
      void audit.fetchNextPage();
    }
  }, [audit]);

  const firstLoad = audit.isLoading && screen.allRows.length === 0;
  const freshness =
    (audit.dataUpdatedAt && relativeTime(audit.dataUpdatedAt, { fallback: "" })) ||
    null;

  // EXPORT. Window/actor/advanced facets are real server facets of the job
  // (auditExportInputFromScreen keeps the CSV from diverging from the screen);
  // `isAdmin` gates the recurring-schedule writes (routeauth floor: admin).
  const exports = useAuditExportController(
    exportOpen,
    auditExportInputFromScreen(screen),
    { isAdmin: scopes.data?.isAdmin === true },
  );

  // The per-event writes (reveal sealed metadata, retention hold) and the
  // press-driven forensic reads mount only here — the NLQ sheet's re-use of
  // the same detail stays display-only over its narrower projection.
  const investigationContext = {
    isAdmin: scopes.data?.isAdmin === true,
    online: gate.enabled,
    onTrace: (requestId: string) => {
      setOpenRow(null);
      setChain({ seed: requestId });
    },
    unmaskAccess: auditUnmaskAccess({
      scopes: scopes.data,
      mode: authMode,
      online: gate.enabled,
    }),
    retentionAccess: retentionOverrideAccess({
      scopes: scopes.data,
      mode: authMode,
      online: gate.enabled,
    }),
  };

  // canRead is null while the scope answer is in flight — never render a
  // permission verdict that has not arrived.
  if (canRead === false) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
        <ScreenHeader title="Audit log" onBack={goBackOrMore} />
        <View style={{ padding: 16 }}>
          <MobileScopeNotice
            title="Audit log needs the audit:read scope"
            body="Your account can sign in but is not permitted to read this workspace's audit history. A workspace admin can grant the audit:read scope."
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Audit log"
        onBack={goBackOrMore}
        right={
          <AuditHeaderActions
            showNlq={nlq.access.allowed}
            onOpenNlq={nlq.openSheet}
            pendingInvestigations={pendingInvestigations}
            onOpenInvestigations={() => setInvestigationsOpen(true)}
            exportBusy={exports.starting}
            onOpenExport={() => setExportOpen(true)}
          />
        }
      />
      <AuditSavedViewsBar
        canManage={viewWrites.allowed}
        manageNotice={viewWrites.known ? viewWrites.notice : null}
        views={Array.isArray(savedViews.data) ? savedViews.data : []}
        loading={savedViews.isLoading}
        failed={savedViews.isError}
        current={view}
        onApply={library.apply}
        onSave={library.openSave}
        onDelete={library.destroy}
        busy={library.busy || !gate.enabled}
      />
      <AuditFilterBar
        query={view.query}
        onQueryChange={(query) => screen.patchView({ query })}
        actor={view.actor}
        onActorChange={(actor) => screen.patchView({ actor })}
        windowKey={view.windowKey}
        onWindowChange={(windowKey) => screen.patchView({ windowKey })}
        destructiveOnly={view.destructiveOnly}
        onDestructiveChange={(destructiveOnly) =>
          screen.patchView({ destructiveOnly })
        }
        securityOnly={view.securityOnly}
        onSecurityChange={(securityOnly) => screen.patchView({ securityOnly })}
        liveTail={screen.liveTail}
        onLiveTailChange={screen.setLiveTail}
        advancedCount={countAuditAdvancedFilters(screen.advanced)}
        advancedDescription={describeAuditAdvancedFilters(screen.advanced)}
        onOpenAdvanced={() => setAdvancedOpen(true)}
        onOpenTrace={() => setChain({ seed: null })}
        shownCount={screen.filtered.length}
        loadedCount={screen.allRows.length}
        hasMore={Boolean(audit.hasNextPage)}
        freshness={freshness}
      />
      <FlatList
        {...MOBILE_LIST_PERF_PROPS}
        data={screen.items}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        contentContainerStyle={{ padding: 16, paddingTop: 4, paddingBottom: 32 }}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.6}
        refreshControl={
          <RefreshControl
            refreshing={screen.refresh.refreshing}
            onRefresh={screen.refresh.onRefresh}
            enabled={gate.enabled}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        ListHeaderComponent={
          <View>
            <AuditGovernanceStrip
              bannerLine={accessRequestsBannerLine(accessRequests.data)}
              onOpen={() => setGovernanceOpen(true)}
            />
            <AuditListHeader
              firstLoad={firstLoad}
              online={gate.enabled}
              loadedCount={screen.allRows.length}
              listErrored={audit.isError}
              onRetry={() => void audit.refetch()}
              tail={tail}
              onLoadNew={screen.refresh.onRefresh}
              activity={screen.activity}
              activityLoading={screen.stats.isLoading}
              checkpoint={screen.checkpoint.data ?? null}
              checkpointLoading={screen.checkpoint.isLoading}
            />
          </View>
        }
        ListFooterComponent={
          <AuditListFooter
            fetching={audit.isFetchingNextPage}
            hasMore={Boolean(audit.hasNextPage)}
            loaded={screen.allRows.length}
            error={audit.isError && screen.allRows.length > 0}
            onRetry={() => void audit.fetchNextPage()}
          />
        }
        ListEmptyComponent={
          <AuditListEmpty
            firstLoad={firstLoad}
            errored={audit.isError}
            error={audit.error}
            onRetry={() => void audit.refetch()}
            narrowed={screen.isNarrowed}
          />
        }
      />
      <AuditScreenOverlays
        library={library}
        exports={exports}
        exportOpen={exportOpen}
        onCloseExport={() => setExportOpen(false)}
        investigationsOpen={investigationsOpen}
        onCloseInvestigations={() => setInvestigationsOpen(false)}
        investigations={investigations}
        investigationRows={investigationRows}
        canDecideInvestigations={scopes.data?.isAdmin === true}
        review={review}
        nlq={nlq}
        online={gate.enabled}
        canReadPii={canReadPii}
        advancedOpen={advancedOpen}
        advanced={screen.advanced}
        onApplyAdvanced={screen.setAdvanced}
        onCloseAdvanced={() => setAdvancedOpen(false)}
        chain={chain}
        onCloseChain={() => setChain(null)}
        openRow={openRow}
        openRowAnomaly={
          openRow?.id != null ? screen.risks.get(openRow.id) : undefined
        }
        investigationContext={investigationContext}
        onCloseRow={() => setOpenRow(null)}
      />
      <AuditGovernanceSheet
        visible={governanceOpen}
        onClose={() => setGovernanceOpen(false)}
        scopes={scopes.data ?? null}
        mode={authMode}
        online={gate.enabled}
        isAdmin={scopes.data?.isAdmin === true}
        accessRequests={accessRequests.data ?? undefined}
        accessRequestsFailed={accessRequests.isError}
      />
    </SafeAreaView>
  );
}

/** The header's three verbs, extracted to keep Audit inside its budget. */
function AuditHeaderActions({
  showNlq,
  onOpenNlq,
  pendingInvestigations,
  onOpenInvestigations,
  exportBusy,
  onOpenExport,
}: {
  showNlq: boolean;
  onOpenNlq: () => void;
  pendingInvestigations: number | null;
  onOpenInvestigations: () => void;
  exportBusy: boolean;
  onOpenExport: () => void;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      {showNlq ? <AuditNlqButton onPress={onOpenNlq} /> : null}
      <AuditInvestigationsButton
        onPress={onOpenInvestigations}
        pending={pendingInvestigations}
      />
      <AuditExportButton onPress={onOpenExport} busy={exportBusy} />
    </View>
  );
}
