/**
 * DlqCard — one dead-lettered batch of audit events, and the button that
 * gets it delivered.
 *
 * Every row here is audit history that never reached its destination. The
 * mobile screen listed them with the closing line "replay from desktop",
 * which is a strange thing for a monitoring surface to say about a one-tap,
 * fully-wrapped, idempotent-by-id endpoint
 * (POST /api/v1/audit-sinks/dlq/{id}/replay).
 *
 * Replay is offered only on an un-replayed batch (canReplayDlqEntry) so the
 * control can never be a guaranteed 409.
 */
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import type { MobileAuditSinkDlqEntry } from "@/api/ops";
import { dateTime, num, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { canReplayDlqEntry } from "@/lib/governanceActionPolicy";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { AuditAction } from "./AuditAction";

export interface DlqCardProps {
  entry: MobileAuditSinkDlqEntry;
  now: number;
  busy: boolean;
  canAct: boolean;
  onReplay: (entry: MobileAuditSinkDlqEntry) => void;
  onShareError: (message: string) => void;
}

export function DlqCard({
  entry,
  now,
  busy,
  canAct,
  onReplay,
  onShareError,
}: DlqCardProps) {
  const { t } = useTheme();
  const error = entry.last_error?.trim();
  const replayable = canReplayDlqEntry(entry) && canAct;
  const rows = `Rows ${num(entry.from_audit_id)}–${num(entry.to_audit_id)}`;

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
        accessibilityLabel={`${rows}, sink ${entry.sink_id}, ${
          entry.replayed_at
            ? `replayed ${dateTime(entry.replayed_at)}`
            : `${num(entry.attempt_count)} attempts`
        }. Last attempt ${dateTime(entry.last_attempt_at)}.${
          error ? ` Error: ${error}` : ""
        }`}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text
            numberOfLines={1}
            {...typeCap("body")}
            style={{
              color: t.fg,
              fontWeight: "600",
              fontFamily: FONT.semibold,
              flex: 1,
              ...typeStyle("body"),
            }}
          >
            {rows}
          </Text>
          <Pill
            label={
              entry.replayed_at
                ? "replayed"
                : `${num(entry.attempt_count)} ${
                    entry.attempt_count === 1 ? "try" : "tries"
                  }`
            }
            tone={entry.replayed_at ? "success" : "warning"}
          />
        </View>
        <Text
          numberOfLines={1}
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            marginTop: 8,
            fontFamily: FONT.regular,
            ...typeStyle("bodySmall"),
          }}
        >
          {`Sink ${entry.sink_id}`}
        </Text>
        <Text
          selectable
          {...typeCap("bodySmall")}
          style={{
            color: error ? t.danger : t.fgSubtle,
            marginTop: 8,
            fontFamily: FONT.regular,
            ...typeStyle("bodySmall"),
          }}
        >
          {error || "No error message recorded"}
        </Text>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            marginTop: 8,
            fontFamily: FONT.regular,
            ...typeStyle("caption"),
          }}
        >
          {`Last attempt ${relativeTime(entry.last_attempt_at, { now })}`}
          {entry.replayed_at
            ? ` · replayed ${relativeTime(entry.replayed_at, { now })}`
            : ""}
        </Text>
      </View>

      <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
        {error ? (
          <Pressable
            onPress={() => onShareError(error)}
            accessibilityRole="button"
            accessibilityLabel="Share this batch's error"
            accessibilityHint="Opens the system share sheet with the full error text"
            style={{
              flex: 1,
              minHeight: 44,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 10,
              borderWidth: 1,
              borderColor: t.border,
            }}
          >
            <Text
              {...typeCap("control")}
              numberOfLines={2}
              style={{
                color: t.fgMuted,
                fontWeight: "700",
                fontFamily: FONT.bold,
                textAlign: "center",
                ...typeStyle("control"),
              }}
            >
              Share error
            </Text>
          </Pressable>
        ) : null}
        {!entry.replayed_at ? (
          <AuditAction
            label={busy ? "Replaying…" : "Replay"}
            hint="Re-delivers this batch of audit events to the sink"
            emphasis
            disabled={!replayable || busy}
            onPress={() => onReplay(entry)}
          />
        ) : null}
      </View>
    </View>
  );
}
