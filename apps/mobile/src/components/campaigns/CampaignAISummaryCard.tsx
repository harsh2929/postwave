/**
 * CampaignAISummaryCard — "here's how it went, and what to do next", in prose.
 *
 * The single highest-value thing to put on a small screen: it replaces a table
 * with a sentence. Desktop has had it since CampaignAISummaryCard; mobile —
 * the client most likely to be read one-handed, thirty seconds after the push
 * notification lands — had ten tables and no sentence.
 *
 * Three things are load-bearing:
 *
 *  - IT DECLARES WHAT WROTE IT. `source` is "voice" (a model) or
 *    "deterministic" (a template over the campaign's own numbers). Only the
 *    first is AI-generated, so only the first carries AI_DISCLOSURE_TEXT.
 *    Stamping the disclosure on template prose would train people to ignore it
 *    on the prose that needs it.
 *  - THE 404 IS AN INVITATION, NOT AN ERROR. Nothing is computed until someone
 *    asks, so the empty state is a Generate button rather than a red box. The
 *    card only claims the capability is missing once a WRITE has failed —
 *    see useCampaignAiSummary for why the read alone cannot know.
 *  - REGENERATE COSTS MONEY. It is gated on write access and disabled while in
 *    flight, and the label says which of the two it is doing.
 */
import { Pressable, Text, View } from "react-native";
import { useMemo } from "react";

import { AI_DISCLOSURE_TEXT } from "@postwave/ai-disclosure";

import { ErrorState } from "@/components/ErrorState";
import { SkeletonCard } from "@/components/Skeleton";
import type { CampaignAiSummaryState } from "@/hooks/useCampaignAiSummary";
import {
  parseSummaryMarkdown,
  summaryPlainText,
  type SummaryBlock,
} from "@/lib/campaignAiSummary";
import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface CampaignAISummaryCardProps {
  state: CampaignAiSummaryState;
  expanded: boolean;
  onToggle: () => void;
  /** False for a viewer, offline, or a cached session. */
  canRegenerate: boolean;
  /** Why regeneration is unavailable, when it is. */
  blockedReason?: string | undefined;
}

export function CampaignAISummaryCard({
  state,
  expanded,
  onToggle,
  canRegenerate,
  blockedReason,
}: CampaignAISummaryCardProps) {
  const { t } = useTheme();
  const blocks = useMemo(
    () => (state.reading ? parseSummaryMarkdown(state.reading.markdown) : []),
    [state.reading],
  );
  // VoiceOver reads the sentence, not the Markdown: without this the card
  // announces "star star 41.2 percent star star".
  const spoken = useMemo(() => summaryPlainText(blocks), [blocks]);

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        paddingHorizontal: 14,
        marginBottom: 8,
      }}
    >
      <Pressable
        onPress={() => {
          haptics.tap();
          onToggle();
        }}
        accessibilityRole="button"
        accessibilityLabel="Post-send summary"
        accessibilityState={{ expanded }}
        accessibilityHint={
          expanded ? "Collapses this section" : "Loads and shows this section"
        }
        style={{
          minHeight: 48,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.fg,
            ...typeStyle("callout"),
            fontFamily: FONT.semibold,
            flex: 1,
          }}
        >
          Post-send summary
        </Text>
        <Text
          {...typeCap("bodySmall")}
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {expanded ? "Hide" : "Show"}
        </Text>
      </Pressable>

      {expanded ? (
        <View style={{ paddingBottom: 14 }}>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              marginBottom: 8,
              fontFamily: FONT.regular,
            }}
          >
            How this send went, and the one thing worth doing next.
          </Text>

          <SummaryBody state={state} blocks={blocks} spoken={spoken} />

          <RegenerateRow
            state={state}
            canRegenerate={canRegenerate}
            {...(blockedReason ? { blockedReason } : {})}
          />

          {state.reading?.source === "voice" ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                marginTop: 10,
                fontFamily: FONT.regular,
              }}
            >
              {AI_DISCLOSURE_TEXT}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function SummaryBody({
  state,
  blocks,
  spoken,
}: {
  state: CampaignAiSummaryState;
  blocks: SummaryBlock[];
  spoken: string;
}) {
  const { t } = useTheme();

  if (state.loading) return <SkeletonCard lines={3} />;

  if (state.unsupported) {
    return (
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        This deployment doesn&rsquo;t expose campaign summaries.
      </Text>
    );
  }

  // A regenerate failure while prose is already on screen keeps the prose and
  // reports the failure below; only a bare failure replaces the body.
  if (state.error && blocks.length === 0) {
    return <ErrorState compact error={state.error} onRetry={state.refetch} />;
  }

  if (blocks.length === 0) {
    return (
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        No summary has been generated for this campaign yet.
      </Text>
    );
  }

  return (
    <View
      accessible
      accessibilityLabel={spoken}
      style={{ gap: 8, opacity: state.regenerating ? 0.6 : 1 }}
    >
      {blocks.map((block, i) => (
        <View
          key={`${block.kind}-${i}`}
          style={
            block.kind === "bullet"
              ? { flexDirection: "row", gap: 8, paddingStart: 2 }
              : undefined
          }
        >
          {block.kind === "bullet" ? (
            <Text
              {...typeCap("bodySmall")}
              accessibilityElementsHidden
              importantForAccessibility="no"
              style={{ color: t.fgSubtle, ...typeStyle("bodySmall") }}
            >
              {"•"}
            </Text>
          ) : null}
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
              flex: 1,
              writingDirection: "auto",
            }}
          >
            {block.spans.map((span, j) => (
              <Text
                key={j}
                {...typeCap("bodySmall")}
                style={{
                  color: span.code ? t.fgMuted : t.fg,
                  fontFamily: span.bold
                    ? FONT.semibold
                    : span.code
                      ? FONT.medium
                      : FONT.regular,
                }}
              >
                {span.text}
              </Text>
            ))}
          </Text>
        </View>
      ))}
    </View>
  );
}

function RegenerateRow({
  state,
  canRegenerate,
  blockedReason,
}: {
  state: CampaignAiSummaryState;
  canRegenerate: boolean;
  blockedReason?: string | undefined;
}) {
  const { t } = useTheme();
  if (state.unsupported) return null;

  const hasBody = state.reading != null;
  const label = state.regenerating
    ? hasBody
      ? "Regenerating…"
      : "Generating…"
    : hasBody
      ? "Regenerate"
      : "Generate summary";
  const disabled = !canRegenerate || state.regenerating;

  return (
    <View style={{ marginTop: 12, gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Pressable
          onPress={() => {
            if (disabled) return;
            haptics.tap();
            state.regenerate();
          }}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ disabled, busy: state.regenerating }}
          accessibilityHint={
            canRegenerate
              ? "Recomputes this summary from the campaign's current numbers"
              : blockedReason
          }
          // Static style object: a function-style `style` on a Pressable
          // silently drops layout under NativeWind v4.
          style={{
            minHeight: 44,
            justifyContent: "center",
            paddingHorizontal: 14,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: t.borderSubtle,
            backgroundColor: t.bg,
            opacity: disabled ? 0.5 : 1,
          }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: t.fg,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            {label}
          </Text>
        </Pressable>

        {state.reading?.generatedAt != null ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              flex: 1,
            }}
          >
            Generated {relativeTime(state.reading.generatedAt)}
          </Text>
        ) : null}
      </View>

      {!canRegenerate && blockedReason ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {blockedReason}
        </Text>
      ) : null}

      {/* A failure that arrived while prose is on screen: the body kept the
          prose, so the failure needs to be said here or it is said nowhere. */}
      {state.error && state.reading ? (
        <ErrorState compact error={state.error} onRetry={state.refetch} />
      ) : null}
    </View>
  );
}
