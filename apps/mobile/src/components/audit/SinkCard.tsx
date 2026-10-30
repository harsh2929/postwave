/**
 * SinkCard — one outbound audit-streaming destination, with the two
 * remediations that matter when it breaks.
 *
 * The screen this was lifted out of carried a header comment claiming the
 * mutation endpoints "the mobile SDK does not expose yet". They exist and
 * are wrapped: POST /audit-sinks/{id}/circuit/reset and
 * POST /audit-sinks/{id}/test. While a breaker is open every audit event is
 * dead-lettering and nothing re-closes it automatically — which makes
 * "reset the circuit" the single most time-sensitive control in the whole
 * governance cluster, and it was desktop-only.
 *
 * Reset is offered ONLY when the breaker is actually open or probing
 * (canResetCircuit): a control that can only be a no-op is worse than no
 * control, because it teaches the operator the button does nothing.
 */
import { Pressable, Text, View } from "react-native";

import { Pill, type PillTone } from "@/components/Pill";
import { AuditAction } from "./AuditAction";
import type { MobileAuditSink } from "@/api/ops";
import {
  canResetCircuit,
  circuitLabel,
  failureBudgetPct,
  relativeFromNow,
  sinkTone,
} from "@/lib/auditSinkHealth";
import { dateTime, num, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface SinkCardProps {
  sink: MobileAuditSink;
  now: number;
  /** Which action, if any, is in flight for THIS sink. */
  busy: "reset" | "test" | "disable" | "delete" | null;
  canAct: boolean;
  onReset: (sink: MobileAuditSink) => void;
  onTest: (sink: MobileAuditSink) => void;
  /** Disable (or re-enable) delivery — the softer stopping half. */
  onSetEnabled: (sink: MobileAuditSink, enabled: boolean) => void;
  /** Delete the sink — typed confirm at the screen. */
  onDelete: (sink: MobileAuditSink) => void;
  /** Open the range-replay sheet for this sink. */
  onOpenReplay: (sink: MobileAuditSink) => void;
  onShareError: (message: string) => void;
}

export function SinkCard({
  sink,
  now,
  busy,
  canAct,
  onReset,
  onTest,
  onSetEnabled,
  onDelete,
  onOpenReplay,
  onShareError,
}: SinkCardProps) {
  const { t } = useTheme();
  const tone = sinkTone(sink);
  const budgetPct = failureBudgetPct(sink);
  const cooldown =
    sink.circuit_state !== "closed" && sink.cooldown_until
      ? relativeFromNow(sink.cooldown_until, now)
      : null;
  const resettable = canResetCircuit(sink) && canAct;

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 8,
      }}
    >
      <View
        accessible
        accessibilityLabel={`${sink.name || "Untitled sink"}, ${(
          sink.kind || "unknown"
        ).toUpperCase()}, circuit ${circuitLabel(sink)}. ${num(
          sink.consecutive_failures,
        )} of ${num(sink.auto_disable_after)} failures before auto-disable.${
          cooldown ? ` Cooldown ends in ${cooldown}.` : ""
        }`}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Text
              numberOfLines={1}
              {...typeCap("body")}
              style={{
                color: t.fg,
                fontWeight: "600",
                fontFamily: FONT.semibold,
                ...typeStyle("body"),
              }}
            >
              {sink.name || "Untitled sink"}
            </Text>
            <Text
              numberOfLines={1}
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                marginTop: 2,
                fontFamily: FONT.regular,
                ...typeStyle("bodySmall"),
              }}
            >
              {(sink.kind || "unknown").toUpperCase()}
            </Text>
          </View>
          <Pill label={circuitLabel(sink)} tone={tone as PillTone} />
        </View>

        <View
          style={{
            flexDirection: "row",
            gap: 8,
            marginTop: 12,
            flexWrap: "wrap",
          }}
        >
          <Pill
            label={`${num(sink.consecutive_failures)}/${num(
              sink.auto_disable_after,
            )} failures`}
            tone={sink.consecutive_failures > 0 ? "warning" : "neutral"}
          />
          {cooldown ? (
            <Pill label={`cooldown ${cooldown}`} tone="danger" />
          ) : null}
          {sink.last_success_at ? (
            <Pill
              label={`ok ${relativeTime(sink.last_success_at, { now })}`}
              tone="success"
            />
          ) : null}
          {sink.last_failure_at ? (
            <Pill
              label={`fail ${relativeTime(sink.last_failure_at, { now })}`}
              tone="danger"
            />
          ) : null}
        </View>

        {sink.auto_disable_after > 0 && sink.consecutive_failures > 0 ? (
          <FailureMeter pct={budgetPct} />
        ) : null}
      </View>

      {sink.last_error ? (
        <SinkError
          message={sink.last_error}
          at={sink.last_failure_at ?? null}
          onShare={onShareError}
        />
      ) : null}

      <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
        <AuditAction
          label={busy === "test" ? "Testing…" : "Send test event"}
          hint="Sends a probe event through this sink to prove it is reachable"
          disabled={!canAct || busy !== null}
          onPress={() => onTest(sink)}
        />
        {canResetCircuit(sink) ? (
          <AuditAction
            label={busy === "reset" ? "Resetting…" : "Reset circuit"}
            hint="Closes the breaker so this sink starts delivering again"
            emphasis
            disabled={!resettable || busy !== null}
            onPress={() => onReset(sink)}
          />
        ) : null}
      </View>
      <SinkLifecycleRow
        sink={sink}
        busy={busy}
        canAct={canAct}
        onSetEnabled={onSetEnabled}
        onDelete={onDelete}
        onOpenReplay={onOpenReplay}
      />
    </View>
  );
}

/**
 * The lifecycle verbs, quieter than the remediation row above: replay
 * history, disable/enable, and delete. Delete carries a typed confirm at the
 * screen — the sink's encrypted credentials go with the row. Its own
 * component so SinkCard stays inside the complexity budget.
 */
function SinkLifecycleRow({
  sink,
  busy,
  canAct,
  onSetEnabled,
  onDelete,
  onOpenReplay,
}: Pick<
  SinkCardProps,
  "sink" | "busy" | "canAct" | "onSetEnabled" | "onDelete" | "onOpenReplay"
>) {
  const locked = !canAct || busy !== null;
  return (
    <View style={{ flexDirection: "row", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
      <AuditAction
        label="Replay a range"
        hint="Opens the historical replay jobs for this sink"
        disabled={locked}
        onPress={() => onOpenReplay(sink)}
      />
      <AuditAction
        label={
          busy === "disable"
            ? "Working…"
            : sink.enabled
              ? "Disable"
              : "Enable"
        }
        hint={
          sink.enabled
            ? "Stops streaming audit events to this destination until it is re-enabled"
            : "Resumes streaming audit events to this destination"
        }
        disabled={locked}
        onPress={() => onSetEnabled(sink, !sink.enabled)}
      />
      <AuditAction
        label={busy === "delete" ? "Deleting…" : "Delete"}
        hint="Removes this sink permanently, with its stored credentials"
        destructive
        disabled={locked}
        onPress={() => onDelete(sink)}
      />
    </View>
  );
}

/**
 * The failure text is expandable rather than hard-clamped at three lines: a
 * truncated stack trace with no way to read the rest is the difference
 * between diagnosing an outage from a phone and giving up on it.
 */
function SinkError({
  message,
  at,
  onShare,
}: {
  message: string;
  at: string | null;
  onShare: (message: string) => void;
}) {
  const { t } = useTheme();
  return (
    <View style={{ marginTop: 10, gap: 4 }}>
      <Text
        selectable
        {...typeCap("bodySmall")}
        accessibilityLabel={`Last error${at ? ` at ${dateTime(at)}` : ""}: ${message}`}
        style={{
          color: t.danger,
          fontFamily: FONT.regular,
          ...typeStyle("bodySmall"),
        }}
      >
        {message}
      </Text>
      <Pressable
        onPress={() => onShare(message)}
        accessibilityRole="button"
        accessibilityLabel="Share the last error"
        accessibilityHint="Opens the system share sheet with the full error text"
        hitSlop={8}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text
          {...typeCap("control")}
          style={{
            color: t.accent,
            fontFamily: FONT.semibold,
            ...typeStyle("control"),
          }}
        >
          Share error
        </Text>
      </Pressable>
    </View>
  );
}

function FailureMeter({ pct }: { pct: number }) {
  const { t } = useTheme();
  const color = pct >= 80 ? t.danger : pct >= 40 ? t.warning : t.success;
  return (
    <View
      accessible
      accessibilityLabel={`${pct} percent of the auto-disable budget consumed`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        marginTop: 12,
      }}
    >
      <View
        style={{
          flex: 1,
          height: 6,
          borderRadius: 3,
          backgroundColor: t.borderSubtle,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            width: `${pct}%`,
            height: "100%",
            borderRadius: 3,
            backgroundColor: color,
          }}
        />
      </View>
      <Text
        {...typeCap("numeric")}
        style={{
          color: t.fgSubtle,
          minWidth: 60,
          fontFamily: FONT.regular,
          fontVariant: ["tabular-nums"],
          ...typeStyle("numeric"),
        }}
      >
        {pct}% to disable
      </Text>
    </View>
  );
}
