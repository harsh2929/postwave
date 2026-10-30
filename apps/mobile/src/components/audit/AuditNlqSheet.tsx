/**
 * AuditNlqSheet — ask the audit log a question in English.
 *
 * Desktop puts this as a bar above the log (AuditNLQBar.tsx). A phone cannot
 * afford a permanent two-line textarea above the richest list in the product,
 * and more importantly the ANSWER is not a filter applied to the feed: it is
 * its own document — a translation, a summary, a bounded result set and a
 * provenance note. So mobile mounts it as a sheet, the same vocabulary the
 * export and investigation surfaces on this screen already use.
 *
 * WHAT IS DELIBERATELY ABSENT:
 *
 *  · NO "APPLY THESE FILTERS TO THE FEED". The translator can narrow on
 *    `action`, `resource_type` and `resource_id`; the mobile feed's own view
 *    state has no such chips, so mapping the translation onto it would drop
 *    the narrowing that made the answer specific and leave the screen claiming
 *    a filter it is not applying. Tapping a result opens that event's detail
 *    instead — hosted HERE rather than by the screen, so it can carry the
 *    projection note the feed's rows do not need.
 *  · NO HISTORY. Each question replaces the last. Keeping a transcript on a
 *    device implies the questions are stored somewhere they are not.
 *  · NO RETRY-ON-MOUNT and no refetch. A question costs workspace tokens.
 */
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { SafeAreaView } from "react-native-safe-area-context";

import { SkeletonCard } from "@/components/Skeleton";
import type { AuditRow } from "@/hooks/useAudit";
import type { AuditNlqController } from "@/hooks/useAuditNlq";
import {
  AUDIT_NLQ_PROJECTION_NOTE,
  AUDIT_NLQ_QUERY_MAX_LEN,
  auditNlqBudgetExhausted,
  auditNlqBudgetSentence,
} from "@/lib/auditNlq";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";
import { AuditNlqAnswerBody, Line } from "./AuditNlqAnswerBody";
import { AuditRowDetail } from "./AuditRowDetail";
import { SheetHeader } from "./AuditSheetParts";

/**
 * Every suggestion names a filter field the translator's allow-list actually
 * has. A suggestion the pipeline cannot honour would teach the operator that
 * the feature is unreliable when in fact they asked out of scope.
 */
const SUGGESTIONS = [
  "Who deleted subscribers in the last day?",
  "Show API key logins this week",
  "Every export in the last 7 days",
] as const;

/** The header trigger. Absent entirely when the actor may not ask. */
export function AuditNlqButton({ onPress }: { onPress: () => void }) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Ask the audit log a question"
      accessibilityHint="Opens a natural-language search over this workspace's audit history"
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
          color: t.fgMuted,
          ...typeStyle("callout"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        Ask
      </Text>
    </Pressable>
  );
}

export interface AuditNlqSheetProps {
  nlq: AuditNlqController<AuditRow>;
  /** False when the session cannot reach the network — asking is hidden. */
  online: boolean;
  /** False when the viewer lacks audit:read_pii — masked values stay masked. */
  canReadPii: boolean;
}

export function AuditNlqSheet(props: AuditNlqSheetProps) {
  const { t } = useTheme();
  const [question, setQuestion] = useState("");
  // The answer's own detail sheet, hosted here rather than by the screen: a
  // row that arrived through the NLQ projection has to carry the projection
  // note with it, and the screen's own detail sheet is for rows from the feed.
  const [detailRow, setDetailRow] = useState<AuditRow | null>(null);
  const ask = props.nlq.ask;
  const trimmed = question.trim();
  const exhausted = auditNlqBudgetExhausted(props.nlq.budget);
  const canAsk =
    props.online && !exhausted && trimmed.length > 0 && !ask.asking;
  const budgetLine = auditNlqBudgetSentence(props.nlq.budget);

  const submit = (): void => {
    if (!canAsk) return;
    haptics.tap();
    ask.ask(trimmed);
  };

  return (
    <>
      <ReducedMotionModal
        visible={props.nlq.sheetOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={props.nlq.closeSheet}
      >
        <SafeAreaView
          style={{ flex: 1, backgroundColor: t.bg }}
          edges={["top", "bottom"]}
          accessibilityViewIsModal
          accessibilityLabel="Ask the audit log"
        >
          <SheetHeader
            title="Ask the audit log"
            onClose={props.nlq.closeSheet}
          />
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === "ios" ? "padding" : undefined}
          >
            <ScrollView
              contentContainerStyle={{
                padding: 20,
                paddingBottom: 40,
                gap: 14,
              }}
              keyboardShouldPersistTaps="handled"
            >
              <TextInput
                // Inputs scale with the OS text size but their height does not.
                {...typeCap("body")}
                value={question}
                onChangeText={setQuestion}
                onSubmitEditing={submit}
                editable={props.online && !exhausted}
                placeholder="Ask about who did what, to which resource, and when"
                placeholderTextColor={t.fgSubtle}
                returnKeyType="search"
                maxLength={AUDIT_NLQ_QUERY_MAX_LEN}
                multiline
                autoCapitalize="sentences"
                autoCorrect
                accessibilityLabel="Natural-language audit question"
                accessibilityHint="Moosewave translates it into an audit filter you can check"
                style={{
                  minHeight: 72,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: t.border,
                  backgroundColor: t.surface,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  color: t.fg,
                  fontFamily: FONT.regular,
                  fontSize: fontSizeFor("body"),
                  textAlignVertical: "top",
                }}
              />

              <View
                style={{ flexDirection: "row", gap: 8, alignItems: "center" }}
              >
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

              {!props.online ? (
                <Line tone="muted" alert>
                  Asking needs a connection — the question is translated on the
                  server. Reconnect and try again.
                </Line>
              ) : null}
              {budgetLine ? <Line tone="subtle">{budgetLine}</Line> : null}

              {props.online &&
              !ask.answer &&
              !ask.errorMessage &&
              !ask.asking ? (
                <View style={{ gap: 8 }}>
                  {SUGGESTIONS.map((suggestion) => (
                    <Pressable
                      key={suggestion}
                      onPress={() => {
                        if (exhausted) return;
                        haptics.tap();
                        setQuestion(suggestion);
                        ask.ask(suggestion);
                      }}
                      disabled={exhausted}
                      accessibilityRole="button"
                      accessibilityLabel={`Ask: ${suggestion}`}
                      accessibilityState={{ disabled: exhausted }}
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

              {ask.asking ? <SkeletonCard lines={4} /> : null}

              {!ask.asking && ask.errorMessage ? (
                <Line tone="danger" alert>
                  {ask.errorMessage}
                </Line>
              ) : null}

              {!ask.asking && ask.answer ? (
                <AuditNlqAnswerBody
                  answer={ask.answer}
                  onOpenRow={setDetailRow}
                />
              ) : null}
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </ReducedMotionModal>
      <AuditRowDetail
        row={detailRow}
        canReadPii={props.canReadPii}
        provenanceNote={AUDIT_NLQ_PROJECTION_NOTE}
        onClose={() => setDetailRow(null)}
      />
    </>
  );
}
