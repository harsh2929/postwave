/**
 * Audit alerts — the detection roster for the audit log.
 *
 * `app/(tabs)/audit.tsx` shows what HAPPENED and `audit-sinks.tsx` shows where
 * the log is being STREAMED. Neither answers the question this screen exists
 * for: is anything actually watching, and would we be told? A complete alerting
 * subsystem ships server-side (`apps/api/internal/audit_alerts`: CRUD, a 30s
 * worker, six delivery channels, four operator kinds, per-fire audit) and had
 * zero mobile presence, so "did our export alert fire?" was a laptop question.
 *
 * WHAT THIS SCREEN DOES
 *
 *   READ every rule, ordered by what is broken rather than by when it was
 *   written; open one to see its recent DELIVERIES and the external INCIDENTS
 *   it opened; PAUSE or RESUME it; flip its Slack fan-out (`notify_slack`);
 *   CREATE a new rule (AuditAlertCreateSheet — every server validator is
 *   mirrored in lib/auditAlertCreate, and channel credentials are typed once,
 *   sent once, and can never be read back because the server redacts
 *   channel_config on every read); and DELETE one behind a typed confirm.
 *   The old "no create form to rebuild the rule with" objection to DELETE
 *   dissolved when the create sheet shipped; what stays true — and what the
 *   confirm says — is that the deleted rule's credential set is not
 *   recoverable from any client.
 *
 * Deliberately NOT here, each for a reason rather than for time:
 *   - EDIT of an existing rule's name/channel_config: the server redacts
 *     channel_config on every read, so an edit form could only present blank
 *     credential fields, and re-entering secrets blind is a mis-edit factory.
 *   - The `{jira,pagerduty,servicenow}/auth` routes: they are credential
 *     VERIFICATION posts, not a redirect/callback OAuth flow — there is no
 *     browser callback to trace, so expo-web-browser buys nothing. The
 *     configured channel is shown read-only and the copy says where setup lives.
 *
 * THIS SURFACE IS GATED ON SCOPES, NOT ON A ROLE FLOOR, and the difference is
 * load-bearing. The reads are `RequireScope(ScopeAuditRead)` and the writes are
 * `RequireScope(ScopeAuditConfigureSinks)` (audit_alerts.go:111-118) — there is
 * no `requireAdmin` in any handler here. So the read verdict comes from
 * `hasAuditReadScope` over `GET /api/v1/audit/my-scopes`, exactly as
 * `app/(tabs)/audit.tsx` does it, and the write verdict comes from
 * `auditAlertToggleAccess`, which models BOTH gates the server actually runs:
 * `routeauth.Middleware`'s generated manifest row (session_minimum_role admin /
 * api_key_scopes ["admin"]) and then the mount's scope check. See
 * lib/auditAlertPolicy for the full derivation.
 *
 * A NOTE ON THE EMPTY STATE, which is the whole reason a governance screen is
 * risky: "no alert rules" and "you may not see the alert rules" and "we could
 * not load the alert rules" are three different sentences, and only the first
 * is an all-clear. Each has its own branch below, and none of them is reachable
 * from a state where the answer is merely unknown.
 *
 * THE VERB IS PATCH, NOT PUT. `MountRoutes` registers no PUT at all.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useIsFocused } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { useConfirm } from "@/components/ConfirmSheet";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import {
  isPausedFirstFetch,
  QueryStates,
  type QueryLike,
} from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SkeletonList } from "@/components/Skeleton";
import { SwipeableRow } from "@/components/SwipeableRow";
import { useToast } from "@/components/Toast";
import { AuditAlertCreateSheet } from "@/components/audit/AuditAlertCreateSheet";
import { AuditAlertDetailSheet } from "@/components/audit/AuditAlertDetailSheet";
import { AuditAlertRow } from "@/components/audit/AuditAlertRow";
import { hasAuditReadScope, useAuditScopes } from "@/hooks/useAudit";
import { useAuditAlertActions } from "@/hooks/useAuditAlertActions";
import {
  useAuditAlertFires,
  useAuditAlertIncidents,
  useAuditAlertRules,
} from "@/hooks/useAuditAlerts";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useRefreshControl } from "@/hooks/useRefreshControl";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { ApprovalFreshnessLine } from "@/components/approvals/ApprovalFreshnessLine";
import { MINUTE_MS, useTickingNow } from "@/hooks/useTickingNow";
import { freshnessSentence } from "@/lib/auditGrouping";
import {
  AUDIT_ALERT_CONFIG_NOTICE,
  auditAlertCounts,
  auditAlertEmptyCopy,
  auditAlertReadCaveat,
  auditAlertToggleAccess,
  orderAuditAlertRules,
} from "@/lib/auditAlertPolicy";
import type { AuditAlertRule } from "@/lib/auditAlertRules";
import { EMDASH, num, plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

export { AppErrorBoundary as ErrorBoundary };

export default function AuditAlerts() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const online = useIsOnline();
  const { toast } = useToast();
  const confirm = useConfirm();
  useScreenViewed("audit-alerts");

  const mode = useAuthStore((s) => s.mode);
  const queriesEnabled = gate.enabled && Boolean(gate.tenantId);

  // The read verdict is the SCOPE answer, not a role floor: the list mount is
  // `RequireScope(ScopeAuditRead)` and no handler in the package calls
  // requireAdmin. `null` means the answer is still in flight — a verdict this
  // screen has not received is never rendered as one it has.
  const scopes = useAuditScopes();
  const canRead = hasAuditReadScope(scopes.data);
  const readCaveat = auditAlertReadCaveat({ scopes: scopes.data ?? null, mode });
  const access = auditAlertToggleAccess({
    scopes: scopes.data ?? null,
    mode,
    online: online && queriesEnabled,
  });

  const [openId, setOpenId] = useState<string | null>(null);

  const rules = useAuditAlertRules(canRead !== false);
  const fires = useAuditAlertFires(openId);
  const incidents = useAuditAlertIncidents(openId);
  const closeSheet = useCallback(() => setOpenId(null), []);
  // The write verbs — pause/resume, Slack fan-out, create, delete — live in
  // hooks/useAuditAlertActions with their confirms, haptics and toasts; the
  // screen keeps only which row is open.
  const actions = useAuditAlertActions({ confirm, toast, closeDetail: closeSheet });
  const refresh = useRefreshControl(rules);
  // "fired 3h ago" must not freeze at whatever it said on mount.
  // Expo Router keeps unfocused tabs MOUNTED, so an ungated 1 Hz clock
  // re-renders this screen once a second forever in the background.
  const focused = useIsFocused();
  /**
   * MINUTE RESOLUTION. Everything this screen renders the clock into is
   * relativeTime ("fired 3h ago") and a day-scale attention rule, so 59 of
   * every 60 ticks used to re-render the whole screen — and every row that
   * takes `now` as a prop — to repaint an identical string. Measured: 60
   * renders/min → 1.
   *
   * The cost is that a boundary lands on the wall-clock minute rather than
   * exactly 60s after the event; see useTickingNow for where that is NOT
   * acceptable.
   */
  const now = useTickingNow(focused, MINUTE_MS);

  const rows = useMemo(
    () => orderAuditAlertRules(rules.data ?? []),
    [rules.data],
  );
  const counts = useMemo(() => auditAlertCounts(rows, now), [rows, now]);
  const openRule = useMemo(
    () => rows.find((row) => row.id === openId) ?? null,
    [rows, openId],
  );

  // A failed fetch is never an empty list, and a query the gate never let run
  // is not a clean zero either: both make the counters unknowable, and an
  // unknown count on a detection roster renders as a dash, not as 0.
  const listFailed = rules.isError && rows.length === 0;
  // The scope read is part of "still loading": until it answers, the rule query
  // may not even have been allowed to start, and `isLoading: false` on a
  // never-enabled TanStack query would otherwise render as a clean empty list.
  const stillResolving = rules.isLoading || (canRead === null && scopes.isLoading);
  const countsUnknown =
    stillResolving ||
    listFailed ||
    rosterUnfetched(queriesEnabled, rules, rows.length);

  const openRow = useCallback((rule: AuditAlertRule) => setOpenId(rule.id), []);
  const keyExtractor = useCallback((rule: AuditAlertRule) => rule.id, []);

  // A REFUSAL IS NOT AN EMPTY ROSTER. `hasAuditReadScope` is false only once
  // my-scopes has answered, and the only honest thing to render then is the
  // refusal — "No alert rules" here would tell somebody who cannot see the
  // detections that there are none, which is the worst sentence this screen
  // could produce. `null` (still unknown) deliberately does NOT land here.
  if (canRead === false) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
        <ScreenHeader title="Audit alerts" onBack={goBackOrMore} />
        <View style={{ padding: 16 }}>
          <MobileScopeNotice
            title="Audit alerts need the audit:read scope"
            body="Your account can sign in but is not permitted to read this workspace's audit alert rules, so this screen cannot tell you whether anything is watching. A workspace admin can grant the audit:read scope."
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Audit alerts"
        subtitle={
          countsUnknown
            ? `${EMDASH} watching`
            : `${num(counts.enabled)} of ${plural(counts.total, "rule")} watching`
        }
        onBack={goBackOrMore}
        // The affordance is WITHHELD (not disabled) from anyone the server
        // would refuse — the house 403-reads-as-a-rule discipline.
        right={
          access.allowed ? (
            <NewRuleButton onPress={actions.openCreate} />
          ) : null
        }
      />

      <FlatList
        {...MOBILE_LIST_PERF_PROPS}
        data={rules.data === undefined ? [] : rows}
        keyExtractor={keyExtractor}
        contentContainerStyle={{
          padding: 16,
          paddingTop: 12,
          paddingBottom: 32,
          flexGrow: 1,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            enabled={queriesEnabled}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        ListHeaderComponent={
          <View>
            <MobileScopeNotice body={AUDIT_ALERT_CONFIG_NOTICE} />
            {readCaveat ? (
              <MobileScopeNotice
                title="This API key may be refused"
                body={readCaveat}
              />
            ) : null}
            {counts.failing > 0 && !countsUnknown ? (
              <Summary
                tone="danger"
                text={`${plural(counts.failing, "rule")} enabled but failing to deliver.`}
              />
            ) : null}
            {counts.quiet > 0 && !countsUnknown ? (
              // Ordering keeps failing rules at the top and never-fired ones at
              // the bottom of their band, which is right — but it also puts the
              // quiet ones where they are easiest to miss. This is the line
              // that stops "enabled" from reading as "working".
              <Summary
                tone="muted"
                text={`${plural(counts.quiet, "rule")} enabled but nothing has matched recently.`}
              />
            ) : null}
            {access.known && access.notice ? (
              <MobileScopeNotice
                title={
                  access.allowed ? "Heads up" : "Read-only for your permissions"
                }
                body={access.notice}
              />
            ) : null}
            {/* "Is this current?" — the question a detection roster owes its
                reader above every other. A screen resumed from background two
                hours later looks identical to one fetched a second ago, and on
                THIS screen the difference is whether "enabled and healthy"
                still holds. */}
            <ApprovalFreshnessLine
              sentence={freshnessSentence("Alert roster", rules.dataUpdatedAt, now)}
            />
          </View>
        }
        ListEmptyComponent={
          <QueryStates
            query={{
              isError: listFailed,
              isLoading: stillResolving,
              isPending: rules.isPending,
              isPaused: rules.isPaused,
              error: rules.error,
              refetch: rules.refetch,
            }}
            gate={{ enabled: queriesEnabled }}
            isEmpty={rows.length === 0}
            skeleton={<SkeletonList rows={4} lines={3} label="Loading alert rules" />}
            offlineMessage="Connect to your workspace to load the alert roster. A cached answer to 'is this detection watching right now' would be worse than none."
            empty={auditAlertEmptyCopy(access.allowed)}
          >
            {null}
          </QueryStates>
        }
        renderItem={({ item }) => {
          const row = (
            <AuditAlertRow
              rule={item}
              onPress={openRow}
              busy={actions.togglingId === item.id}
              now={now}
            />
          );
          if (!access.allowed) return row;
          return (
            <SwipeableRow
              accessibilityLabel={`Alert rule ${item.name}`}
              right={[
                {
                  label: item.enabled ? "Pause" : "Resume",
                  kind: item.enabled ? "danger" : "success",
                  onPress: () => void actions.onToggle(item),
                },
              ]}
            >
              {row}
            </SwipeableRow>
          );
        }}
      />

      <AuditAlertDetailSheet
        rule={openRule}
        fires={Array.isArray(fires.data) ? fires.data : []}
        firesLoading={fires.isLoading}
        firesFailed={fires.isError}
        incidents={Array.isArray(incidents.data?.incidents) ? incidents.data?.incidents : []}
        incidentsLoading={incidents.isLoading}
        incidentsFailed={incidents.isError}
        incidentsTruncated={Boolean(incidents.data?.nextCursor)}
        onClose={closeSheet}
        onToggle={(rule) => void actions.onToggle(rule)}
        toggling={actions.toggling}
        canToggle={access.allowed}
        toggleNotice={access.notice}
        onToggleSlack={(rule, next) => void actions.onToggleSlack(rule, next)}
        slackToggling={actions.slackToggling}
        onDelete={(rule) => void actions.onDelete(rule)}
        deleting={actions.deleting}
        now={now}
      />
      <AuditAlertCreateSheet
        visible={actions.createOpen}
        onClose={actions.closeCreate}
        creating={actions.creating}
        serverError={actions.createError}
        onSubmit={(body) => void actions.onCreate(body)}
      />
    </SafeAreaView>
  );
}

/**
 * No rows and nothing the server ever said: the gate never let the read run,
 * or TanStack paused its first fetch for want of a connection (the gate is
 * auth state, so it stays open). Either way the roster's counts are unknown.
 * Out here rather than inline because AuditAlerts sits at the complexity cap.
 */
function rosterUnfetched(
  queriesEnabled: boolean,
  rules: Pick<QueryLike, "isPending" | "isPaused">,
  rowCount: number,
): boolean {
  return (!queriesEnabled || isPausedFirstFetch(rules)) && rowCount === 0;
}

/** The header verb. Rendered only for someone the server would let through. */
function NewRuleButton({ onPress }: { onPress: () => void }) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="New alert rule"
      accessibilityHint="Opens the form for a new audit alert rule"
      hitSlop={8}
      style={{
        minHeight: 44,
        minWidth: 44,
        paddingHorizontal: 6,
        alignItems: "flex-end",
        justifyContent: "center",
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: t.accent,
          fontWeight: "600",
          fontFamily: FONT.semibold,
          ...typeStyle("callout"),
        }}
      >
        New rule
      </Text>
    </Pressable>
  );
}

/**
 * One roster-wide claim, said in words rather than shown in a colour.
 *
 * The tone reinforces the sentence and is never the sentence itself. Only the
 * danger tone takes `role="alert"`: a rule that has stopped DELIVERING is worth
 * interrupting a screen-reader user for, whereas one that has merely gone quiet
 * is worth reading in turn — announcing both the same way would train the first
 * one to be ignored.
 */
function Summary({ text, tone }: { text: string; tone: "danger" | "muted" }) {
  const { t } = useTheme();
  return (
    <Text
      accessibilityRole={tone === "danger" ? "alert" : "text"}
      accessibilityLiveRegion="polite"
      accessibilityLabel={text}
      {...typeCap("bodySmall")}
      style={{
        color: tone === "danger" ? t.danger : t.fgMuted,
        ...typeStyle("bodySmall"),
        fontFamily: FONT.semibold,
        marginBottom: 10,
      }}
    >
      {text}
    </Text>
  );
}
