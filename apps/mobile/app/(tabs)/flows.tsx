/**
 * Flows — the flow builder's automation spine, read on a phone.
 *
 * A complete flow subsystem shipped server-side (`internal/flowbuilder` —
 * catalog, validator, versioned graphs, keyset-paginated list;
 * `internal/flow_approvals` — the parked manual-review queue) with ZERO mobile
 * references. The nearest thing on this device was app/(tabs)/sequences, a
 * DIFFERENT and older subsystem, so the automations most workspaces actually
 * run were invisible here.
 *
 * MOBILE IS NOT A FLOW AUTHORING CANVAS, AND THIS IS NOT A COMPROMISE.
 * apps/web ships a real 2-D editor with draggable pinned coordinates
 * (flow-editor.tsx + flow-layout.ts) over a 16,384-unit canvas. Reproducing
 * that on a 390pt viewport produces a diagram you navigate rather than read.
 * app/(tabs)/sequences/[id].tsx already settled this for the older subsystem —
 * a read-only vertical column — and this surface is the same answer, plus the
 * one thing a phone is genuinely better at than a laptop: clearing a queue.
 *
 * SO THE SURFACE IS TWO PANES, AND THE SECOND ONE IS THE POINT.
 *   Flows   — what exists, what it is made of, and what its status MEANS.
 *   Reviews — the `manual_review` gates a flow is parked on, with approve and
 *             reject. Short items, a binary decision, a backlog you clear in
 *             the gaps of a day. That is a phone interaction; authoring is not.
 *
 * THE SINGLE MOST IMPORTANT FACT ON THIS SCREEN IS THAT NOTHING IS RUNNING.
 * `flowbuilder.go:27` declares `flowRuntimeQualified = false`; `ActivateFlow`
 * (:468) does nothing but 503; `CreateFlow` refuses any status but draft; and
 * `UpdateFlow` 503s the moment the target status is "active". Every Flow the
 * API returns is stamped with a `runtime` descriptor saying so. A row reading
 * "active" is therefore a HISTORICAL LABEL, not a claim about the world — so
 * the status pill takes the runtime as an argument and says "Legacy active",
 * and the header says it once in words. This is the same failure
 * __tests__/sequences-runtime-truth.native.test.tsx pins for sequences.
 *
 * NO WRITE VERB EXISTS FOR A FLOW ITSELF, BY CONSTRUCTION. Activate is a bare
 * 503, and every status transition to active is refused, so there is no
 * status control anywhere here — a button for it could only ever fail. The
 * two write verbs this screen does expose are the approval decisions.
 *
 * ROLE. Reading flows and reviews is `viewer`: both are mounted behind
 * `RequireScope(ScopeReadCampaigns)`, and `read:campaigns` is in
 * `readOnlyScopes` (apikeys/middleware.go:332), so the session path applies no
 * role check at all. Deciding a review is `editor`: `write:campaigns` is in
 * `editorWriteScopes` (:291), which `sessionRoleAllowsScopes` admits for
 * owner, admin and editor. Both were read out of the middleware, not out of
 * routeauth/manifest.json.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useIsFocused, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { useConfirm } from "@/components/ConfirmSheet";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SearchField } from "@/components/SearchField";
import { SegmentedControl } from "@/components/SegmentedControl";
import { useToast } from "@/components/Toast";
import { FlowDetailSheet } from "@/components/flows/FlowDetailSheet";
import { FlowsPane } from "@/components/flows/FlowsPane";
import { ReviewsPane } from "@/components/flows/ReviewsPane";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useRefreshControl } from "@/hooks/useRefreshControl";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { MINUTE_MS, useTickingNow } from "@/hooks/useTickingNow";
import {
  PENDING_APPROVAL_STATUS,
  useDecideFlowApproval,
  useFlow,
  useFlowApprovals,
  useFlowCatalog,
  useFlowVersions,
  useFlows,
  useValidateFlowGraph,
} from "@/hooks/useFlows";
import { plural } from "@/lib/format";
import {
  decisionCopy,
  decisionErrorMessage,
  decisionSuccessMessage,
  type FlowApprovalDecision,
  type MobileFlowApproval,
} from "@/lib/flowApprovals";
import { flowLabels } from "@/lib/flowCatalog";
import {
  flowValidateBody,
  flowValidationErrorMessage,
} from "@/lib/flowValidation";
import type { MobileFlow } from "@/lib/flowWire";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { useAuthStore } from "@/store/auth";

export { AppErrorBoundary as ErrorBoundary };

type Pane = "flows" | "reviews";

const PANES: readonly Pane[] = ["flows", "reviews"];
const PANE_LABELS: Record<Pane, string> = {
  flows: "Flows",
  reviews: "Reviews",
};

export default function Flows() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const online = useIsOnline();
  const { toast } = useToast();
  const confirm = useConfirm();
  useScreenViewed("flows");

  const mode = useAuthStore((s) => s.mode);
  // POST /flow-builder/approvals/{id}/{approve,reject} resolves to editor on
  // the session path — see the header. Reading needs nothing above viewer.
  // POST /flow-builder/validate lands on the same floor from BOTH sources:
  // `r.With(write)` at the mount and `session_minimum_role: "editor"` in
  // routeauth/manifest.json.
  const canDecide = canAccessMinimumRole("editor", gate.effectiveRole, mode);

  const [pane, setPane] = useState<Pane>("flows");
  // A tap on a flow hit in Search arrives with the hit's title as `q`
  // (src/api/search.ts registryTarget), and lib/navDeepLinks appends the same
  // suffix to a destination deep link. Without seeding it here the param is
  // routed and then dropped, so the tap lands on the unfiltered list and reads
  // as the search having done nothing.
  const params = useLocalSearchParams<{ q?: string }>();
  const [query, setQuery] = useState(
    typeof params.q === "string" ? params.q : "",
  );
  // …and `useState` reads its initializer ONCE. This route is a hidden
  // `Tabs.Screen` and nothing in app/(tabs)/_layout.tsx sets `unmountOnBlur`,
  // so React Navigation hands a SECOND search hit to the still-mounted screen
  // as new params rather than remounting it: without this the operator would
  // be left looking at the previous query with the new one dropped.
  //
  // Keyed on the param VALUE, not on the params object — `useLocalSearchParams`
  // returns a fresh object every render, so an identity-keyed effect would
  // re-seed on every keystroke and fight the typing it exists to preserve.
  const paramQ = typeof params.q === "string" ? params.q : "";
  useEffect(() => {
    if (!paramQ || paramQ === query) return;
    setQuery(paramQ);
    // A narrowed flow list is invisible from the Reviews pane, so an arriving
    // hit also brings the operator back to the pane its query filters.
    setPane("flows");
    // Deliberately NOT depending on `query`: this must react to the incoming
    // param only, never to the operator's own subsequent typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramQ]);
  const [openId, setOpenId] = useState<string | null>(null);

  // "" is the server's own "no status filter" sentinel: `ListFlows` passes it
  // through as `($2 = '' OR j.status = $2)`.
  const flows = useFlows("");
  const detail = useFlow(openId);
  const versions = useFlowVersions(openId);
  const approvals = useFlowApprovals(PENDING_APPROVAL_STATUS);
  const decide = useDecideFlowApproval();

  // The server's own node/trigger names, overlaid on the built-in mirror. The
  // mirror is the floor, so this never gates a render — see lib/flowCatalog.
  const catalog = useFlowCatalog();
  const labels = useMemo(() => flowLabels(catalog.data ?? null), [catalog.data]);

  // The wiring check. Its result is keyed to the flow it judged: a verdict left
  // over from the previously-opened flow painted onto this one would be a
  // confident, wrong statement about someone's automation.
  const validate = useValidateFlowGraph();
  const [checked, setChecked] = useState<{
    flowId: string;
    failure: string | null;
  } | null>(null);

  const runCheck = useCallback(
    (flow: MobileFlow) => {
      if (validate.isPending) return;
      haptics.impact();
      validate.mutate(flowValidateBody(flow), {
        onSuccess: () => {
          haptics.success();
          setChecked({ flowId: flow.id, failure: null });
        },
        onError: (error) => {
          haptics.error();
          setChecked({
            flowId: flow.id,
            failure: flowValidationErrorMessage(error),
          });
        },
      });
    },
    [validate],
  );

  const activeQuery = pane === "flows" ? flows : approvals;
  const refresh = useRefreshControl(activeQuery);

  // "Waiting since 3h" and "edited 2h ago" both age while the screen sits open
  // on a desk. Without a ticker they freeze at whatever they said on mount.
  // Expo Router keeps unfocused tabs MOUNTED, so an ungated 1 Hz clock
  // re-renders this screen once a second forever in the background.
  const focused = useIsFocused();
  /**
   * MINUTE RESOLUTION. Everything this screen renders the clock into is
   * relativeTime ("Edited 2h ago"), nothing finer, so 59 of every 60 ticks
   * used to re-render the whole screen — and every row that takes `now` as a
   * prop — to repaint an identical string. Measured: 60 renders/min → 1.
   *
   * The cost is that a boundary lands on the wall-clock minute rather than
   * exactly 60s after the event; see useTickingNow for where that is NOT
   * acceptable.
   */
  const now = useTickingNow(focused, MINUTE_MS);

  /**
   * EVERY list read is coerced to an array at the boundary rather than trusted.
   * This app PERSISTS the query cache to disk (lib/secureQueryPersister), so a
   * cache entry written by an older build — whose fetcher returned a different
   * shape — can be rehydrated straight into these hooks after an app update.
   * `?? []` is a NULLISH guard and passes a truthy `{}` or `{items: {}}`
   * through; `.find`/`.filter`/`.map` on that value throws inside render, which
   * an error boundary turns into a blank screen with no way back. An empty list
   * plus a refetch is the recoverable failure; a thrown render is not.
   *
   * This comment used to claim "both list reads are coerced" while guarding
   * only `versionRows` — `allFlows` reached `.find` on line 204 unguarded and
   * took the tab down. The claim is now true of all three.
   */
  const page = flows.data;
  const allFlows = useMemo(
    () => (Array.isArray(page?.items) ? page.items : []),
    [page],
  );

  const flowRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return allFlows;
    return allFlows.filter((flow) => flow.name.toLowerCase().includes(needle));
  }, [allFlows, query]);

  const approvalRows = useMemo(
    () => (Array.isArray(approvals.data) ? approvals.data : []),
    [approvals.data],
  );

  const versionRows = useMemo(
    () => (Array.isArray(versions.data) ? versions.data : []),
    [versions.data],
  );

  const openFlow = useMemo(
    () => allFlows.find((flow) => flow.id === openId) ?? null,
    [allFlows, openId],
  );

  const runDecision = useCallback(
    async (approval: MobileFlowApproval, decision: FlowApprovalDecision) => {
      if (decide.isPending) return;
      const copy = decisionCopy(approval, decision);
      const ok = await confirm({
        title: copy.title,
        message: copy.message,
        consequence: copy.consequence,
        confirmLabel: copy.confirmLabel,
        destructive: copy.destructive,
      });
      if (!ok) return;
      // Acknowledge the press; the success thump waits for the response, so a
      // failing network never feels like a success followed by an error.
      haptics.impact();
      try {
        await decide.mutateAsync({ id: approval.id, decision });
        haptics.success();
        // No undo offered: nothing in flow_approvals returns a decided row to
        // pending, so an Undo toast would be a lie about what it can do.
        toast({ kind: "success", message: decisionSuccessMessage(decision) });
      } catch (error) {
        haptics.error();
        toast({ kind: "error", message: decisionErrorMessage(error) });
      }
    },
    [confirm, decide, toast],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Flows"
        {...(pane === "flows" && page
          ? { subtitle: plural(allFlows.length, "flow") }
          : pane === "reviews" && approvals.data
            ? { subtitle: `${plural(approvalRows.length, "review")} waiting` }
            : {})}
        onBack={goBackOrMore}
      />

      <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 10 }}>
        <SegmentedControl
          accessibilityLabel="Flows or reviews"
          options={PANES.map((value) => ({
            value,
            label: PANE_LABELS[value],
            ...(value === "reviews" && approvalRows.length > 0
              ? { badge: approvalRows.length }
              : {}),
          }))}
          value={pane}
          onChange={setPane}
        />
        {pane === "flows" ? (
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder="Search flows"
            accessibilityLabel="Search flows by name"
            resultCount={flowRows.length}
            resultNoun="flow"
          />
        ) : null}
      </View>

      {pane === "flows" ? (
        <FlowsPane
          flows={flows}
          rows={flowRows}
          hasMore={page?.nextCursor != null}
          gate={gate}
          refresh={refresh}
          now={now}
          searching={query.trim().length > 0}
          labels={labels}
          onOpen={(flow: MobileFlow) => setOpenId(flow.id)}
        />
      ) : (
        <ReviewsPane
          approvals={approvals}
          rows={approvalRows}
          gate={gate}
          refresh={refresh}
          now={now}
          canDecide={canDecide}
          online={online}
          pendingId={decide.isPending ? (decide.variables?.id ?? null) : null}
          onDecide={(approval, decision) => void runDecision(approval, decision)}
        />
      )}

      <FlowDetailSheet
        flow={openFlow}
        fresh={detail.data ?? null}
        versions={versionRows}
        versionsQuery={versions}
        gate={gate}
        labels={labels}
        check={{
          canCheck: canDecide,
          online,
          pending: validate.isPending,
          // Both the verdict and the failure are shown ONLY for the flow they
          // belong to. `openId` changing is what retires them.
          result:
            checked?.flowId === openId && checked.failure === null
              ? (validate.data ?? null)
              : null,
          failure: checked?.flowId === openId ? checked.failure : null,
          onCheck: runCheck,
        }}
        now={now}
        onClose={() => setOpenId(null)}
      />
    </SafeAreaView>
  );
}
