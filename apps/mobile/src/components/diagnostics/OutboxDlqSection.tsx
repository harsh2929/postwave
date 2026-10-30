/**
 * OutboxDlqSection — replay a side effect that gave up.
 *
 * VERB#10. `GET /api/v1/dlq` and `POST /api/v1/dlq/{id}/replay`
 * (server/tenant_governance.go:81-82, admin + reviewed) had no client. Mobile
 * shipped the AUDIT-SINK DLQ, a different queue with its own routes, so this gap
 * read as covered while the more consequential queue was invisible.
 *
 * This queue carries the work a request promised and handed off, so an entry stuck
 * here is a webhook that never fired or a downstream write that never happened —
 * and the original request returned 200. Nothing else in the product surfaces that.
 *
 * The summary deliberately refuses to call an empty queue a healthy system: the DLQ
 * being empty proves only that nothing has exhausted its retries.
 */
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { useToast } from "@/components/Toast";
import { useOutboxDlq, useReplayOutboxEntry } from "@/hooks/useOutboxDlq";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { outboxDlqSummary } from "@/lib/outboxDlq";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function OutboxDlqSection() {
  const { t } = useTheme();
  const { toast } = useToast();
  const query = useOutboxDlq();
  const replay = useReplayOutboxEntry();

  // Below admin the query never runs; undefined means "not allowed to look",
  // which must not render as "the queue is empty".
  if (query.data === undefined) return null;
  // Array.isArray, not a bare read. `entries` is passed to outboxDlqSummary,
  // which reduces over it -- so a truthy non-array from the wire throws
  // "entries.reduce is not a function" before anything renders. This is the
  // diagnostics screen an operator opens BECAUSE something is already wrong.
  const entries = Array.isArray(query.data) ? query.data : [];

  const onReplay = (id: string, topic: string) => {
    haptics.tap();
    replay.mutate(id, {
      onSuccess: () =>
        toast({ kind: "success", message: `Replayed ${topic}.` }),
      onError: (err) =>
        toast({
          kind: "error",
          message:
            errorPresentation(err).message || `Couldn't replay ${topic}.`,
        }),
    });
  };

  return (
    <View style={{ gap: 8, marginTop: 16 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.semibold,
          }}
        >
          Dropped side effects
        </Text>
        {entries.length > 0 ? (
          <Pill label={String(entries.length)} tone="warning" />
        ) : null}
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {outboxDlqSummary(entries)}
      </Text>
      {entries.map((entry) => (
        <View
          key={entry.id}
          style={{
            borderTopColor: t.borderSubtle,
            borderTopWidth: 1,
            paddingTop: 10,
            gap: 4,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontFamily: FONT.semibold,
            }}
            numberOfLines={1}
          >
            {entry.topic}
          </Text>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            {entry.attempts} attempt{entry.attempts === 1 ? "" : "s"}
            {entry.failedAt ? ` · ${entry.failedAt}` : ""}
            {entry.lastError ? ` · ${entry.lastError}` : ""}
          </Text>
          <Pressable
            onPress={() => onReplay(entry.id, entry.topic)}
            disabled={replay.isPending}
            accessibilityRole="button"
            accessibilityLabel={`Replay ${entry.topic}`}
            accessibilityState={{ disabled: replay.isPending }}
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: replay.isPending ? t.fgSubtle : t.accent,
                ...typeStyle("control"),
                fontFamily: FONT.semibold,
              }}
            >
              {replay.isPending ? "Replaying…" : "Replay"}
            </Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}
