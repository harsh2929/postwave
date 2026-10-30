/**
 * AskAnalyticsSection — type a question, get one answer.
 *
 * The single highest-leverage analytics feature a phone can have. A desktop
 * can render twenty charts and let the reader find the one that answers their
 * question; a phone cannot, and should not try. It can render ONE answer.
 *
 * WHAT THIS IS AND IS NOT, because the provenance is the feature.
 * `POST /api/v1/analytics/nlq` gives a model the question and a registry of
 * pre-authored SQL templates, and the model's entire output is a template id
 * plus two clamped integers. The SQL is a literal in that registry, run under
 * tenant RLS; a hallucinated id is refused with `invalid_template` and never
 * executes. The sentence under the answer is written by a Go switch, not by
 * the model, and no row value is ever sent to it. So this surface discloses
 * that an AI is involved (Article 50, via @postwave/ai-disclosure) AND states
 * precisely how far its involvement goes — a generic "AI may be inaccurate"
 * alone would misdescribe the risk in both directions.
 *
 * A question costs the workspace model tokens against a daily cap, so nothing
 * here re-asks automatically: no refetch on focus, no re-run when the window
 * changes, no retry-on-mount. The user asks; the answer stays until they ask
 * again.
 */
import { useState, type ReactNode } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { AI_DISCLOSURE_TEXT } from "@postwave/ai-disclosure";

import { BarChart } from "@/components/charts/BarChart";
import { SkeletonCard } from "@/components/Skeleton";
import { ANALYTICS_QUESTION_MAX_LEN } from "@/api/analyticsNlq";
import type { AnalyticsAskState } from "@/hooks/useAnalyticsAsk";
import {
  humanizeColumn,
  type AnalyticsAnswer,
} from "@/lib/analyticsAnswer";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

/**
 * Shown while the field is empty. Every one names a metric the whitelist
 * actually covers — a suggestion the registry cannot answer would teach the
 * user that the feature is unreliable when in fact they asked out of scope.
 */
const SUGGESTIONS = [
  "Which campaigns got the most opens?",
  "What drove unsubscribes last month?",
  "How did subscribers grow this month?",
] as const;

export interface AskAnalyticsSectionProps {
  ask: AnalyticsAskState;
  /** False when the session cannot reach the network: the control is hidden. */
  online: boolean;
}

export function AskAnalyticsSection({ ask, online }: AskAnalyticsSectionProps) {
  const { t } = useTheme();
  const [question, setQuestion] = useState("");
  const trimmed = question.trim();
  const canAsk = online && trimmed.length > 0 && !ask.asking;

  const submit = (): void => {
    if (!canAsk) return;
    haptics.tap();
    ask.ask(trimmed);
  };

  return (
    <View style={{ gap: 10 }}>
      <TextInput
        // Inputs scale with the OS text size but their height does not — cap it.
        {...typeCap("body")}
        value={question}
        onChangeText={setQuestion}
        onSubmitEditing={submit}
        editable={online}
        placeholder="Ask about opens, clicks, revenue, growth…"
        placeholderTextColor={t.fgSubtle}
        returnKeyType="search"
        maxLength={ANALYTICS_QUESTION_MAX_LEN}
        autoCapitalize="sentences"
        autoCorrect
        accessibilityLabel="Ask a question about this workspace's analytics"
        accessibilityHint="Moosewave picks a saved report that answers it"
        // NativeWind v4: static style object only.
        style={{
          minHeight: 48,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.surface,
          paddingHorizontal: 14,
          paddingVertical: 12,
          color: t.fg,
          fontFamily: FONT.regular,
          fontSize: fontSizeFor("body"),
        }}
      />

      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <Pressable
          onPress={submit}
          disabled={!canAsk}
          accessibilityRole="button"
          accessibilityLabel={ask.asking ? "Asking" : "Ask"}
          accessibilityState={{ disabled: !canAsk, busy: ask.asking }}
          style={{
            minHeight: 44,
            minWidth: 88,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 12,
            backgroundColor: canAsk ? t.accent : t.bgSubtle,
          }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: canAsk ? t.accentFg : t.fgSubtle,
              fontFamily: FONT.semibold,
              ...typeStyle("control"),
            }}
          >
            {ask.asking ? "Asking…" : "Ask"}
          </Text>
        </Pressable>
        {ask.answer || ask.errorMessage ? (
          <Pressable
            onPress={() => {
              haptics.tap();
              setQuestion("");
              ask.reset();
            }}
            accessibilityRole="button"
            accessibilityLabel="Clear the answer"
            style={{
              minHeight: 44,
              paddingHorizontal: 12,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.fgMuted,
                fontFamily: FONT.medium,
                ...typeStyle("control"),
              }}
            >
              Clear
            </Text>
          </Pressable>
        ) : null}
      </View>

      {!online ? (
        <Body tone="muted">
          Asking needs a connection. The figures below are the last ones this
          device saw.
        </Body>
      ) : null}

      {online && !ask.answer && !ask.errorMessage && !ask.asking ? (
        <View style={{ gap: 8 }}>
          {SUGGESTIONS.map((suggestion) => (
            <Pressable
              key={suggestion}
              onPress={() => {
                haptics.tap();
                setQuestion(suggestion);
                ask.ask(suggestion);
              }}
              accessibilityRole="button"
              accessibilityLabel={`Ask: ${suggestion}`}
              style={{
                minHeight: 44,
                justifyContent: "center",
                paddingHorizontal: 12,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: t.borderSubtle,
                backgroundColor: t.surface,
              }}
            >
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fgMuted,
                  fontFamily: FONT.regular,
                  ...typeStyle("bodySmall"),
                }}
              >
                {suggestion}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {ask.asking ? <SkeletonCard lines={3} /> : null}

      {!ask.asking && ask.errorMessage ? (
        <Body tone="danger" alert>
          {ask.errorMessage}
        </Body>
      ) : null}

      {!ask.asking && ask.answer ? <AnswerBody answer={ask.answer} /> : null}
    </View>
  );
}

function Body({
  children,
  tone,
  alert = false,
}: {
  children: ReactNode;
  tone: "muted" | "danger" | "subtle";
  alert?: boolean;
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
      }}
    >
      {children}
    </Text>
  );
}

function AnswerBody({ answer }: { answer: AnalyticsAnswer }) {
  const { t } = useTheme();
  const chartable =
    answer.kind === "table" &&
    answer.labelColumn !== null &&
    answer.valueColumn !== null &&
    answer.rows.some((row) => row.value !== null);

  return (
    <View style={{ gap: 12 }}>
      {/* The server's own sentence, written by a Go switch over the template
          that ran. Deterministic — so it is presented as a finding, not as
          model prose. */}
      <Text
        accessibilityRole="summary"
        {...typeCap("callout")}
        style={{
          color: t.fg,
          fontFamily: FONT.regular,
          ...typeStyle("callout"),
        }}
      >
        {answer.summaryText}
      </Text>

      {chartable ? (
        <BarChart
          data={answer.rows
            .filter((row) => row.value !== null)
            .map((row) => ({
              id: row.id,
              label: row.label,
              value: row.value ?? 0,
            }))}
          valueNoun={humanizeColumn(answer.valueColumn ?? "").toLowerCase()}
          maxRows={6}
        />
      ) : null}

      {/* Single-aggregate answers, and any table the chart could not carry,
          are still readable as plain key/value lines — an answer that only
          exists as a chart is unreadable to a screen reader and to anyone
          whose question returned one row. */}
      {!chartable && answer.rows.length > 0 ? (
        <View style={{ gap: 8 }}>
          {answer.rows.slice(0, 6).map((row, index) => (
            <View key={`${row.id}-${index}`} style={{ gap: 2 }}>
              {answer.rows.length > 1 ? (
                <Body tone="muted">{row.label}</Body>
              ) : null}
              {row.cells.map((cell) => (
                <View
                  key={cell.column}
                  accessible
                  accessibilityLabel={`${humanizeColumn(cell.column)}: ${
                    cell.value === null ? cell.text : num(cell.value)
                  }`}
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    gap: 12,
                  }}
                >
                  <Body tone="subtle">{humanizeColumn(cell.column)}</Body>
                  <Text
                    {...typeCap("numeric")}
                    style={{
                      color: t.fg,
                      fontFamily: FONT.medium,
                      ...typeStyle("numeric"),
                      fontVariant: ["tabular-nums"],
                    }}
                  >
                    {cell.value === null ? cell.text : num(cell.value)}
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      ) : null}

      {/* Provenance. Which saved report ran and over what window is the only
          way a reader can tell whether the question was understood. */}
      <Body tone="subtle">
        {`Ran the saved report “${humanizeColumn(answer.template)}”${
          answer.windowDays > 0 ? ` over the last ${answer.windowDays} days` : ""
        }.`}
      </Body>
      <Body tone="subtle">
        {AI_DISCLOSURE_TEXT} Moosewave only lets it choose which saved report to
        run — the figures above come from your workspace and are never sent to
        the model.
      </Body>
    </View>
  );
}
