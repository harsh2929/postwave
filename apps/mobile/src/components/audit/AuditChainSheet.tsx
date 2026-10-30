/**
 * AuditChainSheet — trace one request id to everything it did.
 *
 * The id is the X-Request-ID an on-call engineer already has in hand from an
 * error envelope or a log line; the server stamps the same id into
 * `audit_log.metadata.context.correlation_id` and GET /audit/chain/{requestId}
 * returns the rows for it, ASCENDING — a chain is a narrative, and the
 * reverse-chronological order that suits a feed makes causality read
 * backwards.
 *
 * Reached two ways: pasted into the field here (from the audit screen's
 * toolbox), or seeded from an open event's own correlation id ("Trace this
 * request" in the detail sheet).
 *
 * The lookup runs ON SUBMIT, never per keystroke — a chain query scans the
 * metadata index and a half-typed id can only answer wrongly.
 */
import { useEffect, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { useAuditChain } from "@/hooks/useAuditForensics";
import { auditActionLabel } from "@/lib/auditActionLabel";
import type { AuditChainRow } from "@/lib/auditForensics";
import { dateTime, num } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { AuditAction } from "./AuditAction";
import { SheetHeader } from "./AuditSheetParts";

export interface AuditChainSheetProps {
  visible: boolean;
  /** Pre-seeded correlation id when opened from an event, else null. */
  initialRequestId: string | null;
  online: boolean;
  onClose: () => void;
}

export function AuditChainSheet({
  visible,
  initialRequestId,
  online,
  onClose,
}: AuditChainSheetProps) {
  const { t } = useTheme();
  const [draft, setDraft] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const chain = useAuditChain(visible ? submitted : null);

  // Seed (and immediately run) when opened from an event's own id; reset to a
  // blank search when opened from the toolbox.
  useEffect(() => {
    if (!visible) return;
    setDraft(initialRequestId ?? "");
    setSubmitted(initialRequestId);
  }, [visible, initialRequestId]);

  const submit = () => {
    const id = draft.trim();
    setSubmitted(id ? id : null);
  };

  return (
    <ReducedMotionModal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
        accessibilityViewIsModal
        accessibilityLabel="Trace a request"
      >
        <SheetHeader title="Trace a request" onClose={onClose} />
        <ScrollView
          contentContainerStyle={{ padding: 20, paddingBottom: 40, gap: 12 }}
          keyboardShouldPersistTaps="handled"
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              fontFamily: FONT.regular,
              ...typeStyle("bodySmall"),
            }}
          >
            Paste an X-Request-ID from an error message or a log line to see
            every audit row that request wrote, in order.
          </Text>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={submit}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel="Request id"
            accessibilityHint="The X-Request-ID to trace"
            placeholder="host/AbCdEf-000123"
            placeholderTextColor={t.fgSubtle}
            {...typeCap("body")}
            style={{
              borderColor: t.borderSubtle,
              borderWidth: 1,
              borderRadius: 10,
              paddingHorizontal: 12,
              paddingVertical: 10,
              color: t.fg,
              backgroundColor: t.surface,
              fontFamily: FONT.regular,
              minHeight: 44,
            }}
          />
          <View style={{ flexDirection: "row" }}>
            <AuditAction
              label={chain.isFetching ? "Tracing…" : "Trace"}
              hint="Looks up the audit chain for this request id"
              emphasis
              disabled={!online || chain.isFetching || !draft.trim()}
              onPress={submit}
            />
          </View>
          <ChainResult
            requestId={submitted}
            loading={chain.isFetching}
            failed={chain.isError}
            rows={chain.data?.rows}
            truncated={Boolean(chain.data?.truncated)}
          />
        </ScrollView>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

function ChainResult({
  requestId,
  loading,
  failed,
  rows,
  truncated,
}: {
  requestId: string | null;
  loading: boolean;
  failed: boolean;
  rows: AuditChainRow[] | undefined;
  truncated: boolean;
}) {
  const { t } = useTheme();
  if (!requestId) return null;
  if (loading) return <ChainNote text="Tracing the request…" />;
  if (failed) {
    return (
      <ChainNote text="The trace failed. Check the id and your connection, then try again." />
    );
  }
  if (!rows) return null;
  if (rows.length === 0) {
    return (
      <ChainNote text="No audit rows carry this correlation id. Either the request touched nothing auditable, it predates request tracing, or the id was mistyped." />
    );
  }
  return (
    <View style={{ gap: 8 }}>
      <Text
        accessibilityLiveRegion="polite"
        {...typeCap("callout")}
        style={{
          color: t.fg,
          fontWeight: "700",
          fontFamily: FONT.bold,
          ...typeStyle("callout"),
        }}
      >
        {`${num(rows.length)} ${rows.length === 1 ? "row" : "rows"}, oldest first`}
      </Text>
      {rows.map((row, index) => (
        <View
          key={row.id}
          accessible
          accessibilityLabel={`Step ${index + 1}: ${auditActionLabel(row.action)}${
            row.resourceType ? `, ${row.resourceType}` : ""
          }, ${dateTime(row.at)}`}
          style={{
            backgroundColor: t.surface,
            borderColor: t.borderSubtle,
            borderWidth: 1,
            borderRadius: 12,
            padding: 12,
            gap: 2,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              fontWeight: "600",
              fontFamily: FONT.semibold,
              ...typeStyle("body"),
            }}
          >
            {`${index + 1}. ${auditActionLabel(row.action)}`}
          </Text>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              fontFamily: FONT.regular,
              ...typeStyle("bodySmall"),
            }}
          >
            {[
              row.resourceType
                ? `${row.resourceType}${row.resourceId ? ` · ${row.resourceId}` : ""}`
                : null,
              row.actorLabel || row.actorType || null,
              dateTime(row.at),
            ]
              .filter(Boolean)
              .join(" — ")}
          </Text>
        </View>
      ))}
      {truncated ? (
        <ChainNote text="This chain hit the 500-row cap — the request wrote more rows than are shown here. Use the web admin for the full narrative." />
      ) : null}
    </View>
  );
}

function ChainNote({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <Text
      accessibilityLiveRegion="polite"
      {...typeCap("bodySmall")}
      style={{
        color: t.fgMuted,
        fontFamily: FONT.regular,
        ...typeStyle("bodySmall"),
      }}
    >
      {text}
    </Text>
  );
}
