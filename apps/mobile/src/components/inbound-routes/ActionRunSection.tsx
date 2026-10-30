/**
 * ActionRunSection — what each of the rule's actions actually did for one
 * matched message. This is the answer the whole screen exists to reach.
 *
 * THREE THINGS THIS SECTION REFUSES TO INVENT.
 *
 *  1. `http_status` IS AN EM-DASH FOR THREE OF THE FIVE ACTION KINDS. Only
 *     `webhook` and `automation_trigger` POST anywhere; `tag`, `forward` and
 *     `store_only` have no meaningful single int (migration 0194:67-70).
 *     Printing "0" would invent a response to a request that was never made.
 *  2. AN EMPTY RUN LIST IS NOT A SUCCESS. It has two causes — the rule has no
 *     actions, or the run rows were pruned — and `emptyRunsNotice` states both
 *     rather than picking one.
 *  3. A GREEN ROW CAN STILL BE A PROBLEM. `attempts` counts every try, so a
 *     succeeded run with attempts > 1 means the upstream refused and then
 *     relented. That is the flaky-integration signal a bare "succeeded" hides,
 *     so the retry count is shown on the row rather than only in the total.
 *
 * State is never colour alone: each run carries a labelled Pill and the row's
 * spoken label opens with the same word.
 */
import { Text, View } from "react-native";

import { Pill, type PillTone } from "@/components/Pill";
import { QueryStates, type QueryLike } from "@/components/QueryStates";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { EMDASH, duration, num, plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { emptyRunsNotice, runOutcome } from "@/lib/inboundRouteVerdict";
import type {
  ActionRunStatus,
  InboundActionRun,
  InboundRoute,
} from "@/lib/inboundRoutes";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const STATUS_TONE: Readonly<Record<ActionRunStatus, PillTone>> = {
  succeeded: "success",
  failed: "danger",
  skipped: "neutral",
  unknown: "warning",
};

export function ActionRunSection({
  query,
  gate,
  route,
}: {
  query: QueryLike & { data?: InboundActionRun[] | undefined };
  gate: OnlineQueryGate;
  route: InboundRoute;
}) {
  const rows = Array.isArray(query.data) ? query.data : [];
  const outcome = runOutcome(rows);
  const notice = query.data === undefined ? null : emptyRunsNotice(route, rows);
  const subtitle =
    rows.length > 0
      ? [
          `${plural(outcome.failed, "failed action")}`,
          outcome.retried > 0
            ? `${plural(outcome.retried, "action")} needed a retry`
            : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : "";

  return (
    <View style={{ marginTop: 16 }}>
      <SectionLabel topMargin={0} {...(subtitle ? { subtitle } : {})}>
        What its actions did
      </SectionLabel>
      <QueryStates
        query={query}
        gate={gate}
        isEmpty={rows.length === 0}
        offlineMessage="The action log needs a connection. Reconnect and pull to refresh — an empty list here is not the same as nothing having run."
        skeleton={<SkeletonList rows={2} lines={2} label="Loading action runs" />}
        empty={{
          title: "No action runs recorded",
          description:
            notice ??
            "Nothing is recorded against this match. That is not the same as every action succeeding.",
        }}
      >
        {rows.map((run) => (
          <RunRow key={run.id} run={run} />
        ))}
      </QueryStates>
    </View>
  );
}

function RunRow({ run }: { run: InboundActionRun }) {
  const { t } = useTheme();
  const status = run.httpStatus === null ? EMDASH : String(run.httpStatus);
  const took = run.durationMs > 0 ? duration(run.durationMs) : EMDASH;

  return (
    <View
      accessible
      accessibilityLabel={[
        `${run.status === "unknown" ? "unrecognised status" : run.status}.`,
        `Action ${num(run.actionIndex + 1)}, ${run.actionKind || "unnamed kind"}.`,
        run.httpStatus === null
          ? "This action kind makes no HTTP request, so it has no response status."
          : `HTTP ${run.httpStatus}.`,
        run.attempts > 1
          ? `Took ${num(run.attempts)} attempts — it was retried.`
          : "First attempt.",
        run.durationMs > 0 ? `Took ${took}.` : "",
        run.errorMessage ? `Error: ${run.errorMessage}.` : "",
        run.responseSnippet ? `Upstream replied: ${run.responseSnippet}` : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 8,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            flex: 1,
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
          numberOfLines={1}
        >
          {`${run.actionIndex + 1}. ${run.actionKind || "unnamed action"}`}
        </Text>
        <Pill label={run.status} tone={STATUS_TONE[run.status]} />
      </View>

      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          marginTop: 10,
          flexWrap: "wrap",
        }}
      >
        <Meta text={`HTTP ${status}`} />
        <Meta text={took === EMDASH ? "no duration" : `took ${took}`} />
        {run.attempts > 1 ? (
          <Pill label={`${num(run.attempts)} attempts`} tone="warning" />
        ) : null}
      </View>

      {run.errorMessage ? (
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          {...typeCap("bodySmall")}
          style={{
            color: t.danger,
            ...typeStyle("bodySmall"),
            marginTop: 8,
            fontFamily: FONT.regular,
          }}
        >
          {run.errorMessage}
        </Text>
      ) : null}
      {run.responseSnippet ? (
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
          numberOfLines={4}
        >
          {run.responseSnippet}
        </Text>
      ) : null}
    </View>
  );
}

function Meta({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
      }}
      numberOfLines={1}
    >
      {text}
    </Text>
  );
}
