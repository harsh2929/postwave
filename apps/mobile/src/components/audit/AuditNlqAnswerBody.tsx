/**
 * AuditNlqAnswerBody — one answer from the audit assistant, rendered in the
 * order a compliance reader has to read it.
 *
 * TRANSLATION FIRST, RESULTS SECOND. That order is the whole design. The model
 * chose a filter; the rows are what that filter returned from the log. Showing
 * the rows above the filter would invite reading them as an answer to the
 * question asked, when they are an answer to the question the model heard.
 *
 * ROWS ARE DRAWN HERE, NOT BY AuditRowCard, and the reason is a projection gap
 * rather than a style preference — `runFilteredAudit` does not select
 * `redacted_fields`, `legal_hold`, `metadata_encrypted` or `session_id`, so the
 * log's own card would render "no redaction badge" over a row that IS redacted.
 * See AUDIT_NLQ_PROJECTION_NOTE.
 */
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

import { AI_DISCLOSURE_TEXT } from "@postwave/ai-disclosure";

import {
  AUDIT_NLQ_NO_FILTER_NOTE,
  AUDIT_NLQ_PROJECTION_NOTE,
  AUDIT_NLQ_PROVENANCE_NOTE,
  auditNlqResultSentence,
  describeAuditNlqFilters,
  type AuditNlqAnswer,
} from "@/lib/auditNlq";
import type { AuditRow } from "@/hooks/useAudit";
import { auditActionLabel } from "@/lib/auditActionLabel";
import { dateTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function AuditNlqAnswerBody({
  answer,
  onOpenRow,
}: {
  answer: AuditNlqAnswer<AuditRow>;
  /** Hand the row to the log's own detail sheet, where provenance lives. */
  onOpenRow: (row: AuditRow) => void;
}) {
  const { t } = useTheme();
  const facts = describeAuditNlqFilters(answer.filters);

  return (
    <View style={{ gap: 14 }}>
      <Section title="What the model understood">
        {facts.length === 0 ? (
          <Line tone="muted" alert>
            {AUDIT_NLQ_NO_FILTER_NOTE}
          </Line>
        ) : (
          <View style={{ gap: 6 }}>
            {facts.map((fact) => (
              <View
                key={fact.label}
                accessible
                accessibilityLabel={`${fact.label}: ${fact.value}`}
                style={{ flexDirection: "row", gap: 12 }}
              >
                <Line tone="subtle" flexed>
                  {fact.label}
                </Line>
                <FactValue value={fact.value} />
              </View>
            ))}
          </View>
        )}
        {answer.invalidFields.length > 0 ? (
          <Line tone="danger" alert>
            {`The model asked to filter on ${answer.invalidFields.join(", ")}, which the audit log does not have. Those were dropped before the query ran.`}
          </Line>
        ) : null}
        {answer.trace.reasoning ? (
          <Line tone="subtle">{answer.trace.reasoning}</Line>
        ) : null}
      </Section>

      {answer.summary ? (
        <Section title="Summary">
          <Text
            accessibilityRole="summary"
            {...typeCap("callout")}
            style={{
              color: t.fg,
              fontFamily: FONT.regular,
              ...typeStyle("callout"),
            }}
          >
            {answer.summary}
          </Text>
        </Section>
      ) : null}

      <Section title="Events">
        <Line tone="muted">
          {auditNlqResultSentence(answer.rows.length, answer.totalCount)}
        </Line>
        <View style={{ gap: 8 }}>
          {answer.rows.map((row, index) => (
            <ResultRow
              key={row.id != null ? `row-${row.id}` : `row-idx-${index}`}
              row={row}
              onOpen={onOpenRow}
            />
          ))}
        </View>
        <Line tone="subtle">{AUDIT_NLQ_PROJECTION_NOTE}</Line>
      </Section>

      <View style={{ gap: 6 }}>
        <Line tone="subtle">{AI_DISCLOSURE_TEXT}</Line>
        <Line tone="subtle">{AUDIT_NLQ_PROVENANCE_NOTE}</Line>
        {answer.trace.model ? (
          <Line tone="subtle">
            {`Translated by ${answer.trace.model}${
              answer.trace.cacheHit
                ? " (cached translation, no new tokens spent)"
                : ""
            }.`}
          </Line>
        ) : null}
      </View>
    </View>
  );
}

function ResultRow({
  row,
  onOpen,
}: {
  row: AuditRow;
  onOpen: (row: AuditRow) => void;
}) {
  const { t } = useTheme();
  const action = auditActionLabel(row.action);
  const actor = row.actorLabel || row.actorType || "—";
  const resource = [row.resourceType, row.resourceId]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const stamp = dateTime(row.at, "—");

  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        onOpen(row);
      }}
      accessibilityRole="button"
      accessibilityLabel={`${action} by ${actor}${
        resource ? `, ${resource}` : ""
      }, ${stamp}`}
      accessibilityHint="Opens this event in the audit log"
      // NativeWind v4: a function-style style prop silently drops layout.
      style={{
        minHeight: 44,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: t.borderSubtle,
        backgroundColor: t.surface,
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 4,
      }}
    >
      <Text
        {...typeCap("body")}
        style={{
          color: t.fg,
          fontFamily: FONT.medium,
          ...typeStyle("body"),
        }}
        numberOfLines={1}
      >
        {action}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          fontFamily: FONT.regular,
          ...typeStyle("caption"),
        }}
        numberOfLines={1}
      >
        {resource ? `${actor} · ${resource}` : actor}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          fontFamily: FONT.regular,
          ...typeStyle("caption"),
          fontVariant: ["tabular-nums"],
        }}
      >
        {stamp}
      </Text>
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <Text
        accessibilityRole="header"
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          fontFamily: FONT.semibold,
          ...typeStyle("label"),
        }}
      >
        {title}
      </Text>
      {children}
    </View>
  );
}

function FactValue({ value }: { value: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("bodySmall")}
      style={{
        color: t.fg,
        fontFamily: FONT.medium,
        ...typeStyle("bodySmall"),
        flex: 2,
        textAlign: "right",
      }}
    >
      {value}
    </Text>
  );
}

export function Line({
  children,
  tone,
  alert = false,
  flexed = false,
}: {
  children: ReactNode;
  tone: "muted" | "subtle" | "danger";
  alert?: boolean;
  flexed?: boolean;
}) {
  const { t } = useTheme();
  const color =
    tone === "danger" ? t.danger : tone === "subtle" ? t.fgSubtle : t.fgMuted;
  return (
    <Text
      {...(alert ? { accessibilityRole: "alert" as const } : {})}
      {...typeCap("bodySmall")}
      style={{
        color,
        fontFamily: FONT.regular,
        ...typeStyle("bodySmall"),
        ...(flexed ? { flex: 1 } : {}),
      }}
    >
      {children}
    </Text>
  );
}
