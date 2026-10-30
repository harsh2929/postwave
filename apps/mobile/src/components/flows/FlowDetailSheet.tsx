/**
 * FlowDetailSheet — what this flow is made of, in what order, and what has
 * been published.
 *
 * A SHEET RATHER THAN A ROUTE, for the two reasons AgentRoutineDetailSheet is:
 * the rhythm is open → read → close, and a pushed screen charges a navigation
 * animation each way; and it keeps this surface to ONE route file, so it costs
 * the tab layout one registration instead of two.
 *
 * IT RENDERS THE TAPPED ROW'S GRAPH IMMEDIATELY. The list read already carries
 * every node — `flowSelectSQL` LEFT JOINs the newest version and `scanFlow`
 * prefers its graph — so there is no reason to show a spinner over a topology
 * we already have. The single-flow query refreshes it underneath and takes
 * over when it lands; that is why `flow` is a prop and `fresh` is separate.
 *
 * THE ORDER NOTE IS NOT DECORATION. `buildFlowTopology` reports which of three
 * rules produced the vertical order — a real entry node, inferred roots, or
 * stored-array order when nothing can be inferred. Only the first is EXECUTION
 * order. Printing the list without saying which one happened would assert an
 * ordering the server never claimed, so `flowTopologyOrderNote` always shows.
 *
 * NOTHING HERE CAN BE EDITED, AND THAT IS A SERVER FACT, NOT A SHORTCUT.
 * `ActivateFlow` (flowbuilder.go:468) is a bare 503; `UpdateFlow` 503s the
 * moment the target status is "active"; `CreateFlow` refuses any status but
 * draft. There is no status control anywhere on this surface because every
 * one of them could only ever fail.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import {
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { Pill } from "@/components/Pill";
import { QueryStates, type QueryLike } from "@/components/QueryStates";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import { FlowGraphCheck } from "@/components/flows/FlowGraphCheck";
import { FlowStepRow } from "@/components/flows/FlowStepRow";
import { FONT } from "@/lib/fonts";
import { date, EMDASH, plural, relativeTime } from "@/lib/format";
import type { FlowLabels } from "@/lib/flowCatalog";
import {
  buildFlowTopology,
  flowRuntimeExecuting,
  flowStatusPresentation,
  flowTopologyOrderNote,
  reEnrollmentLabel,
} from "@/lib/flowTopology";
import type { MobileFlowValidation } from "@/lib/flowValidation";
import type { MobileFlow, MobileFlowVersion } from "@/lib/flowWire";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

/** The wiring-check slice of this sheet's state, owned by the route. */
export interface FlowCheckState {
  canCheck: boolean;
  online: boolean;
  pending: boolean;
  result: MobileFlowValidation | null;
  failure: string | null;
  onCheck: (flow: MobileFlow) => void;
}

export interface FlowDetailSheetProps {
  /** The tapped list row. Null closes the sheet. */
  flow: MobileFlow | null;
  /** The refreshed single-flow read; preferred once it lands. */
  fresh: MobileFlow | null;
  versions: readonly MobileFlowVersion[];
  versionsQuery: QueryLike;
  /** The online/auth gate, so versions can say "offline", not "none". */
  gate: { enabled: boolean };
  /** Server catalogue labels, falling back to the built-in mirror. */
  labels: FlowLabels;
  check: FlowCheckState;
  now: number;
  onClose: () => void;
}

export function FlowDetailSheet(props: FlowDetailSheetProps) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();

  // Prefer the refreshed read, but only when it is the SAME flow — a stale
  // response for the previously-opened flow must never paint over this one.
  const flow =
    props.fresh && props.flow && props.fresh.id === props.flow.id
      ? props.fresh
      : props.flow;

  const executing = flowRuntimeExecuting(flow?.runtime ?? null);
  const status = flow
    ? flowStatusPresentation(flow.status, executing)
    : null;
  const topology = buildFlowTopology(flow);

  return (
    <ReducedMotionModal
      visible={props.flow !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 8,
            gap: 12,
          }}
        >
          <Text
            numberOfLines={maxLinesAtScale(2, fontScale)}
            {...typeCap("title")}
            style={{
              color: t.fg,
              ...typeStyle("title"),
              fontFamily: FONT.display,
              flexShrink: 1,
            }}
          >
            {flow?.name ?? "Flow"}
          </Text>
          <Pressable
            onPress={props.onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={12}
            style={{
              minHeight: 44,
              minWidth: 44,
              alignItems: "flex-end",
              justifyContent: "center",
            }}
          >
            <Text
              {...typeCap("callout")}
              style={{
                color: t.accent,
                ...typeStyle("callout"),
                fontFamily: FONT.semibold,
              }}
            >
              Done
            </Text>
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={{ padding: 16, paddingTop: 4, paddingBottom: 40 }}
        >
          {/* The runtime descriptor is the server's own words. Showing its
              message verbatim beats paraphrasing a capability contract. */}
          {flow && !executing ? (
            <MobileScopeNotice
              title="This flow is not running"
              body={
                flow.runtime?.message ||
                "The flow runtime is unavailable, so no subscriber is moving through any flow. What you see below is the stored design."
              }
            />
          ) : null}

          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 6,
              marginBottom: 12,
            }}
          >
            {status ? (
              <Pill
                label={status.label}
                tone={status.tone === "info" ? "info" : status.tone}
                accessibilityLabel={status.spoken}
              />
            ) : null}
            {flow ? (
              <Pill
                label={reEnrollmentLabel(
                  flow.reEnrollment,
                  flow.reEnrollmentCooldownHours,
                )}
                tone={flow.reEnrollment === "once" ? "neutral" : "info"}
                accessibilityLabel={`Re-entry policy: ${reEnrollmentLabel(
                  flow.reEnrollment,
                  flow.reEnrollmentCooldownHours,
                )}`}
              />
            ) : null}
            {flow && flow.goalCount > 0 ? (
              <Pill
                label={plural(flow.goalCount, "goal")}
                tone="neutral"
                accessibilityLabel={`${plural(flow.goalCount, "goal")} defined.`}
              />
            ) : null}
          </View>

          <SectionLabel>Starts on</SectionLabel>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
              marginBottom: 16,
            }}
          >
            {flow && flow.triggers.length > 0
              ? flow.triggers
                  .map((trigger) => props.labels.trigger(trigger.type))
                  .join(", ")
              : "No trigger, so nothing can enter this flow."}
          </Text>

          <SectionLabel>
            {plural(topology.rows.length, "step")}
          </SectionLabel>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              marginBottom: 12,
            }}
          >
            {flowTopologyOrderNote(topology)}
            {topology.unreachableCount > 0
              ? ` ${plural(topology.unreachableCount, "step")} at the end are not reached by anything.`
              : ""}
          </Text>

          {topology.rows.length === 0 ? (
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
                marginBottom: 16,
              }}
            >
              This flow has no steps yet. It was created but never built out.
            </Text>
          ) : (
            <View style={{ marginBottom: 20 }}>
              {topology.rows.map((row, index) => (
                <FlowStepRow
                  key={row.node.id}
                  row={row}
                  index={index + 1}
                  hasNext={index < topology.rows.length - 1}
                  labels={props.labels}
                />
              ))}
            </View>
          )}

          {flow ? (
            <FlowGraphCheck
              canCheck={props.check.canCheck}
              online={props.check.online}
              stepCount={flow.nodes.length}
              pending={props.check.pending}
              result={props.check.result}
              failure={props.check.failure}
              onCheck={() => props.check.onCheck(flow)}
            />
          ) : null}

          <SectionLabel>Version history</SectionLabel>
          <QueryStates
            query={props.versionsQuery}
            gate={props.gate}
            isEmpty={props.versions.length === 0}
            skeleton={<SkeletonList rows={2} />}
            offlineMessage="You're offline, so this flow's version history can't be loaded."
            empty={{
              title: "No published versions",
              // A draft that was never published has no version rows at all —
              // which is different from "we could not load them".
              description:
                "Nothing has been published from this flow. Publishing happens in the desktop flow builder.",
            }}
          >
            <View style={{ gap: 10, marginTop: 4 }}>
              {props.versions.map((version) => (
                <FlowVersionRow
                  key={version.id}
                  version={version}
                  now={props.now}
                />
              ))}
            </View>
          </QueryStates>
        </ScrollView>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

/**
 * One row of version history. `generated_by` is the interesting column: it is
 * normalised server-side to human | ai | migration | template
 * (`normalizeGeneratedBy`, flowbuilder.go:735), so "who wrote this version"
 * is answerable — and on a platform with AI drafting routines, "ai" is the
 * answer an approver most needs to see.
 */
function FlowVersionRow({
  version,
  now,
}: {
  version: MobileFlowVersion;
  now: number;
}) {
  const { t } = useTheme();

  const authored = generatedByLabel(version.generatedBy);
  // Published and created are DIFFERENT instants and only one may exist.
  // Neither is invented from the other.
  const when = version.publishedAt
    ? `Published ${relativeTime(version.publishedAt, { now })}`
    : version.createdAt
      ? `Created ${relativeTime(version.createdAt, { now })}, never published`
      : `Dated ${EMDASH}`;

  return (
    <View
      accessible
      accessibilityLabel={`Version ${version.version}. ${authored}. ${when}. ${plural(
        version.nodeCount,
        "step",
      )}. ${
        version.publishedAt ? `Published on ${date(version.publishedAt)}.` : ""
      }`}
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 4,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.fg,
            ...typeStyle("callout"),
            fontFamily: FONT.semibold,
          }}
        >
          Version {version.version}
        </Text>
        <Pill
          label={authored}
          tone={version.generatedBy === "ai" ? "info" : "neutral"}
          accessibilityLabel={authored}
        />
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {when} {EMDASH} {plural(version.nodeCount, "step")}
      </Text>
    </View>
  );
}

/** `normalizeGeneratedBy` (flowbuilder.go:735) collapses to these four. */
function generatedByLabel(generatedBy: string): string {
  switch (generatedBy) {
    case "ai":
      return "Written by AI";
    case "migration":
      return "From a migration";
    case "template":
      return "From a template";
    case "human":
      return "Written by a person";
    default:
      // The column is normalised on write, so anything else is a row that
      // pre-dates the normalisation. Show it rather than guess.
      return generatedBy || "Author not recorded";
  }
}
