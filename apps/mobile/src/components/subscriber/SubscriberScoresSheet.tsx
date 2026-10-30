/**
 * SubscriberScoresSheet — the workspace engagement-score explorer, opened
 * from the subscribers header.
 *
 * Desktop's EngagementScoreSection + ScoringRulesCard as one phone sheet:
 * the decile distribution (tap a slice to browse that band), the
 * score-banded audience list (rows open the profile), and the rule set
 * that produced the numbers — read for every viewer, editable for admins.
 *
 * NO recompute verb: the server holds POST /scoring/recompute behind a 409
 * until it is a durable job; the note under the rules says so instead of
 * offering a button that always fails.
 */
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { Chip } from "@/components/Chip";
import { ErrorState } from "@/components/ErrorState";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { ModalHeader } from "@/components/subscriber/SubActionButton";
import {
  useSaveScoringRules,
  useScoreDistribution,
  useScoredSubscribers,
  useScoringRules,
  type ScoreBand,
} from "@/hooks/useSubscriberEngagement";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { keyboardDismiss } from "@/lib/keyboardChain";
import {
  SCORE_RECOMPUTE_NOTE,
  bucketTone,
  buildScoringRulesPut,
  scoringRulesProblem,
  type ScoringRuleRow,
} from "@/lib/subscriberEngagement";
import { useTheme } from "@/lib/theme";
import type { ThemeTokens } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

function SectionLabel({ text, t }: { text: string; t: ThemeTokens }) {
  return (
    <Text
      {...typeCap("label")}
      style={{
        color: t.fgMuted,
        ...typeStyle("label"),
        fontFamily: FONT.medium,
        marginTop: 12,
      }}
    >
      {text}
    </Text>
  );
}

/** The rules half. Extracted so the sheet stays inside its budgets. */
function ScoringRulesSection({
  visible,
  canEdit,
  t,
}: {
  visible: boolean;
  canEdit: boolean;
  t: ThemeTokens;
}) {
  const { toast } = useToast();
  const rules = useScoringRules(visible);
  const save = useSaveScoringRules();
  /** Draft weights keyed by event type; absent = untouched. */
  const [draft, setDraft] = useState<Record<string, string>>({});

  const view = rules.data;

  const effective = (): ScoringRuleRow[] =>
    (view?.rules ?? []).map((rule) => {
      const edited = draft[rule.eventType];
      const weight =
        edited === undefined ? rule.weight : Number.parseInt(edited, 10);
      return { ...rule, weight: Number.isNaN(weight) ? rule.weight : weight };
    });

  const onSave = () => {
    if (!view) return;
    const next = effective();
    const problem = scoringRulesProblem(next);
    if (problem) {
      haptics.warning();
      toast({ kind: "info", message: problem });
      return;
    }
    haptics.tap();
    save.mutate(buildScoringRulesPut(next, view.version), {
      onSuccess: () => {
        haptics.success();
        setDraft({});
        toast({ kind: "success", message: "Scoring rules saved." });
      },
      onError: (e: unknown) => {
        haptics.error();
        toast({
          kind: "error",
          message: `The scoring rules were not saved. ${e instanceof Error ? e.message : ""}`.trim(),
        });
      },
    });
  };

  return (
    <>
      <SectionLabel text="Scoring rules" t={t} />
      {rules.isLoading ? (
        <SkeletonList rows={3} />
      ) : rules.isError ? (
        <ErrorState error={rules.error} onRetry={() => void rules.refetch()} />
      ) : view ? (
        <>
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
            }}
          >
            {view.usingDefaults
              ? "This workspace runs the default weights — saving creates its own set."
              : "This workspace runs its own weights."}
            {view.windowDays > 0
              ? ` Events count for ${view.windowDays} days.`
              : ""}
          </Text>
          {view.rules.map((rule) => (
            <View
              key={rule.eventType}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                borderTopColor: t.borderSubtle,
                borderTopWidth: 1,
                paddingVertical: 6,
              }}
            >
              <Text
                {...typeCap("bodySmall")}
                style={{
                  flex: 1,
                  minWidth: 0,
                  color: t.fg,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.regular,
                }}
                numberOfLines={1}
              >
                {rule.label}
              </Text>
              {canEdit ? (
                <TextInput
                  {...typeCap("bodySmall")}
                  value={draft[rule.eventType] ?? String(rule.weight)}
                  onChangeText={(next) =>
                    setDraft((d) => ({ ...d, [rule.eventType]: next }))
                  }
                  keyboardType="numbers-and-punctuation"
                  accessibilityLabel={`Weight for ${rule.label}`}
                  // One weight per rule row, saved by the button below — the
                  // return key has nowhere to advance to, so it closes the
                  // keyboard rather than promising a submit it cannot make.
                  {...keyboardDismiss()}
                  style={{
                    color: t.fg,
                    backgroundColor: t.surface,
                    borderColor: t.border,
                    borderWidth: 1,
                    borderRadius: 8,
                    paddingHorizontal: 10,
                    minHeight: 40,
                    minWidth: 64,
                    textAlign: "right",
                    fontFamily: FONT.medium,
                    fontSize: fontSizeFor("bodySmall"),
                  }}
                />
              ) : (
                <Text
                  {...typeCap("bodySmall")}
                  accessibilityLabel={`${rule.label} weight ${rule.weight}`}
                  style={{
                    color: t.fgMuted,
                    ...typeStyle("bodySmall"),
                    fontFamily: FONT.medium,
                  }}
                >
                  {rule.weight}
                </Text>
              )}
            </View>
          ))}
          {canEdit ? (
            <Chip
              label={save.isPending ? "Saving…" : "Save rule set"}
              active={false}
              onPress={onSave}
              accessibilityLabel="Save the scoring rule set"
            />
          ) : null}
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
              marginTop: 6,
            }}
          >
            {SCORE_RECOMPUTE_NOTE}
          </Text>
        </>
      ) : null}
    </>
  );
}

export function SubscriberScoresSheet({
  visible,
  canEditRules,
  onClose,
}: {
  visible: boolean;
  /** Admin + online + live session — the PUT's floor. */
  canEditRules: boolean;
  onClose: () => void;
}) {
  const { t } = useTheme();
  const [band, setBand] = useState<ScoreBand>({ min: null, max: null });
  const [page, setPage] = useState(1);
  const distribution = useScoreDistribution(visible);
  const scored = useScoredSubscribers(visible, band, page);

  // `??` would admit a truthy non-array (a paged envelope, an SPA HTML
  // fallback) straight into the reduce below.
  const buckets = Array.isArray(distribution.data) ? distribution.data : [];
  const maxCount = buckets.reduce((acc, b) => Math.max(acc, b.count), 0);
  const toneColor = (tone: "low" | "mid" | "high") =>
    tone === "low" ? t.danger : tone === "mid" ? t.warning : t.success;

  // Defensive: the parsed shape guarantees items, but a shared test harness
  // (or a cache seeded by an older build) may hand this component something
  // else — an explorer must degrade to its empty state, never crash.
  const pageData =
    scored.data && Array.isArray(scored.data.items) ? scored.data : undefined;
  const hasNext =
    pageData !== undefined && page * 50 < pageData.total;

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel="Engagement score explorer"
    >
      <ModalHeader title="Engagement scores" onClose={onClose} t={t} />

      {distribution.isLoading ? (
        <SkeletonList rows={4} />
      ) : distribution.isError ? (
        <ErrorState
          error={distribution.error}
          onRetry={() => void distribution.refetch()}
        />
      ) : buckets.length === 0 ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          Nobody has been scored yet — scores appear after the first
          engagement events.
        </Text>
      ) : (
        buckets.map((bucket, i) => (
          <Pressable
            key={bucket.range}
            onPress={() => {
              haptics.tap();
              setBand({ min: bucket.min, max: bucket.max });
              setPage(1);
            }}
            accessibilityRole="button"
            accessibilityLabel={`Scores ${bucket.range}: ${bucket.count} subscribers. Shows them below.`}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              minHeight: 32,
            }}
          >
            <Text
              {...typeCap("label")}
              style={{
                width: 74,
                color: t.fgMuted,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
              }}
            >
              {bucket.range}
            </Text>
            <View style={{ flex: 1, height: 10, justifyContent: "center" }}>
              <View
                style={{
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: toneColor(bucketTone(i, buckets.length)),
                  width: `${maxCount > 0 ? Math.max(3, Math.round((bucket.count / maxCount) * 100)) : 3}%`,
                }}
              />
            </View>
            <Text
              {...typeCap("label")}
              style={{
                color: t.fg,
                ...typeStyle("label"),
                fontFamily: FONT.medium,
              }}
            >
              {bucket.count}
            </Text>
          </Pressable>
        ))
      )}

      <SectionLabel
        text={
          band.min === null
            ? "All scored subscribers"
            : `Scores ${band.min}..${band.max}`
        }
        t={t}
      />
      {band.min !== null ? (
        <Chip
          label="All scores"
          active={false}
          onPress={() => {
            setBand({ min: null, max: null });
            setPage(1);
          }}
          accessibilityLabel="Clear the score band"
        />
      ) : null}
      {scored.isLoading ? (
        <SkeletonList rows={3} />
      ) : scored.isError ? (
        <ErrorState error={scored.error} onRetry={() => void scored.refetch()} />
      ) : pageData && pageData.items.length > 0 ? (
        <>
          {pageData.items.map((row) => (
            <Pressable
              key={row.id}
              onPress={() => {
                haptics.tap();
                onClose();
                router.push({
                  pathname: "/(tabs)/subscribers/[id]",
                  params: { id: row.id },
                });
              }}
              accessibilityRole="button"
              accessibilityLabel={`${row.email}, score ${row.score}. Opens the profile.`}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                minHeight: 44,
                borderTopColor: t.borderSubtle,
                borderTopWidth: 1,
              }}
            >
              <Text
                {...typeCap("bodySmall")}
                style={{
                  flex: 1,
                  minWidth: 0,
                  color: t.fg,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.regular,
                }}
                numberOfLines={1}
              >
                {row.email}
              </Text>
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.medium,
                }}
              >
                {row.score}
              </Text>
            </Pressable>
          ))}
          <View style={{ flexDirection: "row", gap: 6, marginTop: 8 }}>
            {page > 1 ? (
              <Chip
                label="Previous"
                active={false}
                onPress={() => setPage((p) => Math.max(1, p - 1))}
                accessibilityLabel="Previous page of scored subscribers"
              />
            ) : null}
            {hasNext ? (
              <Chip
                label="Next"
                active={false}
                onPress={() => setPage((p) => p + 1)}
                accessibilityLabel="Next page of scored subscribers"
              />
            ) : null}
          </View>
        </>
      ) : (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          No scored subscribers in this range.
        </Text>
      )}

      <ScoringRulesSection visible={visible} canEdit={canEditRules} t={t} />
    </KeyboardFormSheet>
  );
}
