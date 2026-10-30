/**
 * AiRegressionHistorySheet — the evidence workspace, phone-sized.
 *
 * Desktop's "AI Changelog" (ModelChangelogPanel) is a full run browser; this
 * is the same evidence at two depths: the recent runs, and — one tap in — one
 * run's per-surface rollup and per-example results.
 *
 * WHAT THE DRILL-IN MUST NOT DO is present an unscored example as a bad score.
 * A result with severity `error` has a NULL fidelity_score, so it renders as
 * "Replay failed / not scored" with the server's error message, never as 0.
 * lib/aiRegressionRuns owns that split; this file only lays it out.
 *
 * Every read here is `read:reports`, so a viewer sees the whole workspace.
 */
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { Pill } from "@/components/Pill";
import { SkeletonCard } from "@/components/Skeleton";
import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { regressionPresentation } from "@/lib/aiRegression";
import { surfaceKindLabel } from "@/lib/aiRegressionAdmin";
import {
  runHistoryCounts,
  runHistoryTitle,
  runSurfaceLines,
  resultPresentation,
  type RegressionRunDetailWire,
} from "@/lib/aiRegressionRuns";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  useRegressionRunResults,
  useRegressionRuns,
} from "@/hooks/useAiRegressionRuns";

export function AiRegressionHistorySheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTheme();
  const [openRun, setOpenRun] = useState<string | null>(null);
  const history = useRegressionRuns(visible);

  if (!visible) return null;
  const runs = Array.isArray(history.data) ? history.data : [];

  return (
    <KeyboardFormSheet
      visible
      onClose={() => {
        setOpenRun(null);
        onClose();
      }}
      accessibilityLabel="AI regression run history"
      contentContainerStyle={{ gap: 12 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          {...typeCap("title")}
          style={{
            color: t.fg,
            ...typeStyle("title"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
            flex: 1,
          }}
        >
          {openRun ? "Run evidence" : "Run history"}
        </Text>
        {openRun ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to run history"
            hitSlop={8}
            onPress={() => {
              haptics.tap();
              setOpenRun(null);
            }}
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.accent,
                ...typeStyle("bodySmall"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
              }}
            >
              Back
            </Text>
          </Pressable>
        ) : null}
      </View>

      {openRun ? (
        <RunEvidence runId={openRun} />
      ) : history.isLoading ? (
        <SkeletonCard lines={4} />
      ) : history.isError ? (
        <ErrorLine
          message={(history.error as Error).message}
          onRetry={() => void history.refetch()}
        />
      ) : runs.length === 0 ? (
        <Text
          {...typeCap("body")}
          style={{
            color: t.fgMuted,
            ...typeStyle("body"),
            fontFamily: FONT.regular,
          }}
        >
          No regression run has happened for this workspace yet.
        </Text>
      ) : (
        <ScrollView
          style={{ maxHeight: 380 }}
          contentContainerStyle={{ gap: 10 }}
        >
          {runs.map((run) => (
            <RunRow
              key={String(run.id)}
              run={run}
              onOpen={() => {
                haptics.tap();
                setOpenRun(String(run.id));
              }}
            />
          ))}
        </ScrollView>
      )}
    </KeyboardFormSheet>
  );
}

function RunRow({
  run,
  onOpen,
}: {
  run: RegressionRunDetailWire;
  onOpen: () => void;
}) {
  const { t } = useTheme();
  const p = regressionPresentation(run);
  const counts = runHistoryCounts(run);
  const when = run.completed_at ?? run.created_at;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open run ${runHistoryTitle(run)}: ${p.label}`}
      onPress={onOpen}
      style={{ minHeight: 44, gap: 3 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.regular,
            flex: 1,
          }}
          numberOfLines={1}
        >
          {runHistoryTitle(run)}
        </Text>
        <Pill label={p.label} tone={p.tone} />
      </View>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
          fontVariant: ["tabular-nums"],
        }}
      >
        {[p.score, counts, when ? relativeTime(when) : null]
          .filter(Boolean)
          .join(" · ")}
      </Text>
    </Pressable>
  );
}

function RunEvidence({ runId }: { runId: string }) {
  const { t } = useTheme();
  const query = useRegressionRunResults(runId);

  if (query.isLoading) return <SkeletonCard lines={4} />;
  if (query.isError) {
    return (
      <ErrorLine
        message={(query.error as Error).message}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const run = query.data?.run ?? null;
  const results = Array.isArray(query.data?.results) ? query.data.results : [];
  const surfaces = runSurfaceLines(run, surfaceKindLabel);

  return (
    <ScrollView style={{ maxHeight: 400 }} contentContainerStyle={{ gap: 12 }}>
      {run ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {regressionPresentation(run).detail}
        </Text>
      ) : null}

      {surfaces.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
            }}
          >
            By surface
          </Text>
          {surfaces.map((line) => (
            <View
              key={line.surface}
              style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            >
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fg,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.regular,
                  flex: 1,
                }}
              >
                {`${line.surface} — ${line.summary}`}
              </Text>
              {line.score ? (
                <Text
                  {...typeCap("bodySmall")}
                  style={{
                    color: t.fgMuted,
                    ...typeStyle("bodySmall"),
                    fontFamily: FONT.regular,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {line.score}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      <View style={{ gap: 10 }}>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          Examples
        </Text>
        {results.length === 0 ? (
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            This run recorded no per-example results.
          </Text>
        ) : (
          results.map((row, index) => {
            const p = resultPresentation(row, index, surfaceKindLabel);
            return (
              <View key={p.key} style={{ gap: 3 }}>
                <View
                  style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
                >
                  <Text
                    {...typeCap("bodySmall")}
                    style={{
                      color: t.fg,
                      ...typeStyle("bodySmall"),
                      fontFamily: FONT.medium,
                      flex: 1,
                    }}
                  >
                    {p.surface}
                  </Text>
                  <Pill label={p.score ?? p.label} tone={p.tone} />
                </View>
                <Text
                  {...typeCap("label")}
                  style={{
                    color: t.fgSubtle,
                    ...typeStyle("label"),
                    fontFamily: FONT.regular,
                  }}
                  numberOfLines={3}
                >
                  {p.detail}
                </Text>
              </View>
            );
          })
        )}
      </View>
    </ScrollView>
  );
}

function ErrorLine({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <Text
        {...typeCap("bodySmall")}
        accessibilityLiveRegion="polite"
        style={{
          color: t.danger,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {message}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Retry"
        onPress={onRetry}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.accent,
            ...typeStyle("bodySmall"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          Retry
        </Text>
      </Pressable>
    </View>
  );
}
