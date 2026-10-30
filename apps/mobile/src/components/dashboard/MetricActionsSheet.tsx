/**
 * MetricActionsSheet — long-press a dashboard tile.
 *
 * Two actions, and the reasoning for what is NOT here matters as much:
 *
 *  - EXPLAIN. `POST /api/v1/analytics/anomaly-brief`. Offered only for the
 *    metrics the server whitelists; `subscribers` is charted on the dashboard
 *    but is NOT on that whitelist, so the item is absent rather than present
 *    and failing with `invalid_metric`.
 *  - SHARE. `Share.share`, the OS sheet the app already uses a dozen times.
 *    There is deliberately no "Copy value": expo-clipboard is not a dependency
 *    of this app, and adding one for a single menu item is the wrong trade
 *    when the share sheet already offers Copy on both platforms.
 *
 * THE BRIEF IS AI OUTPUT AND SAYS SO. The disclosure banner is not decoration:
 * the model is interpreting real aggregates, and the reader must be able to
 * tell prose from measurement. The figures the brief was written from are
 * printed beside it for exactly that reason.
 */
import { useCallback, useState } from "react";
import { Pressable, ScrollView, Share, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AI_DISCLOSURE_TEXT } from "@postwave/ai-disclosure";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import {
  isAnomalyBriefMetric,
  requestAnomalyBrief,
  type AnomalyBrief,
} from "@/api/anomalyBrief";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface MetricSheetTarget {
  /** Tile label, e.g. "Bounce rate". */
  label: string;
  /** Value as printed on the tile. */
  value: string;
  /** Server metric id, when this tile maps onto one. */
  metric?: string | undefined;
}

export interface MetricActionsSheetProps {
  target: MetricSheetTarget | null;
  onClose: () => void;
  /** Workspace name, so a shared line says WHOSE number it is. */
  workspaceName?: string | undefined;
  /** Reporting window label, e.g. "30d". */
  rangeLabel?: string | undefined;
}

type BriefState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; brief: AnomalyBrief }
  | { status: "error"; message: string };

export function MetricActionsSheet({
  target,
  onClose,
  workspaceName,
  rangeLabel,
}: MetricActionsSheetProps) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const [brief, setBrief] = useState<BriefState>({ status: "idle" });

  const close = useCallback(() => {
    setBrief({ status: "idle" });
    onClose();
  }, [onClose]);

  const explain = useCallback(async () => {
    const metric = target?.metric;
    if (!isAnomalyBriefMetric(metric)) return;
    haptics.tap();
    setBrief({ status: "loading" });
    try {
      const result = await requestAnomalyBrief({ metric });
      setBrief({ status: "ready", brief: result });
      haptics.success();
    } catch (error) {
      haptics.error();
      setBrief({
        status: "error",
        // The endpoint can be genuinely unconfigured (no model key on the
        // API server) or over its token budget. Both are facts about the
        // workspace, not bugs, so the message is shown as-is when it is a
        // sentence and replaced when it is transport noise.
        message: briefErrorMessage(error),
      });
    }
  }, [target?.metric]);

  if (!target) return null;

  const shareMetric = (): void => {
    haptics.tap();
    const where = workspaceName ? ` — ${workspaceName}` : "";
    const when = rangeLabel ? ` (${rangeLabel})` : "";
    void Share.share({
      message: `${target.label}: ${target.value}${when}${where}`,
    });
  };

  const canExplain = isAnomalyBriefMetric(target.metric);

  return (
    <ReducedMotionModal
      visible
      transparent
      animationType="fade"
      onRequestClose={close}
      accessibilityViewIsModal
    >
      <View style={{ flex: 1, justifyContent: "flex-end" }}>
        <Pressable
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: t.overlay,
          }}
        />
        <View
          style={{
            backgroundColor: t.surfaceElevated,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            borderColor: t.border,
            borderWidth: 1,
            paddingHorizontal: 20,
            paddingTop: 16,
            paddingBottom: insets.bottom + 16,
            gap: 12,
            maxHeight: "80%",
          }}
        >
          <View
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={{
              alignSelf: "center",
              width: 36,
              height: 4,
              borderRadius: 2,
              backgroundColor: t.border,
            }}
          />
          <Text
            {...typeCap("title")}
            style={{
              color: t.fg,
              fontFamily: FONT.display,
              ...typeStyle("title"),
              letterSpacing: -0.3,
            }}
          >
            {target.label} · {target.value}
          </Text>

          {brief.status === "idle" ? (
            <View style={{ gap: 8 }}>
              {canExplain ? (
                <SheetAction
                  label="Explain with AI"
                  hint="Asks Moosewave to interpret this metric's recent movement"
                  onPress={() => void explain()}
                />
              ) : null}
              <SheetAction
                label="Share this number"
                hint="Opens the system share sheet"
                onPress={shareMetric}
              />
            </View>
          ) : (
            <BriefBody state={brief} onRetry={() => void explain()} />
          )}

          <SheetAction label="Close" onPress={close} muted />
        </View>
      </View>
    </ReducedMotionModal>
  );
}

function briefErrorMessage(error: unknown): string {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : "";
  // A sentence from the API (e.g. "anomaly briefs are not configured…") is
  // more useful than our generic copy. A transport string is not.
  return message && message.length < 200 && /\s/.test(message)
    ? message
    : "The brief could not be generated. Try again in a moment.";
}

function BriefBody({
  state,
  onRetry,
}: {
  state: BriefState;
  onRetry: () => void;
}) {
  const { t } = useTheme();
  if (state.status === "loading") {
    return (
      <Text
        accessibilityRole="alert"
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          fontFamily: FONT.regular,
          ...typeStyle("bodySmall"),
        }}
      >
        Reading the last seven days…
      </Text>
    );
  }
  if (state.status === "error") {
    return (
      <View style={{ gap: 10 }}>
        <Text
          accessibilityRole="alert"
          {...typeCap("bodySmall")}
          style={{
            color: t.danger,
            fontFamily: FONT.regular,
            ...typeStyle("bodySmall"),
          }}
        >
          {state.message}
        </Text>
        <SheetAction label="Try again" onPress={onRetry} />
      </View>
    );
  }
  if (state.status !== "ready") return null;

  const { brief } = state;
  return (
    <ScrollView style={{ maxHeight: 380 }} contentContainerStyle={{ gap: 12 }}>
      <Text
        {...typeCap("callout")}
        style={{
          color: t.fg,
          fontFamily: FONT.regular,
          ...typeStyle("callout"),
        }}
      >
        {brief.summary}
      </Text>

      {/* The measurements the prose was written from, so the reader can tell
          interpretation from fact without leaving the sheet. */}
      {brief.currentTotal !== null ? (
        <Text
          {...typeCap("numeric")}
          style={{
            color: t.fgMuted,
            fontFamily: FONT.regular,
            ...typeStyle("numeric"),
            fontVariant: ["tabular-nums"],
          }}
        >
          {num(brief.currentTotal)} in the last {brief.windowDays} days
          {brief.previousTotal !== null
            ? ` · ${num(brief.previousTotal)} in the ${brief.windowDays} before that`
            : ""}
        </Text>
      ) : null}

      <BriefList title="Probable causes" items={brief.probableCauses} />
      <BriefList title="Suggested actions" items={brief.suggestedActions} />

      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          fontFamily: FONT.regular,
          ...typeStyle("caption"),
        }}
      >
        {AI_DISCLOSURE_TEXT}
      </Text>
    </ScrollView>
  );
}

function BriefList({ title, items }: { title: string; items: string[] }) {
  const { t } = useTheme();
  if (items.length === 0) return null;
  return (
    <View style={{ gap: 6 }}>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          letterSpacing: 0.6,
          fontFamily: FONT.semibold,
          textTransform: "uppercase",
        }}
      >
        {title}
      </Text>
      {items.map((item) => (
        <Text
          key={item}
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            fontFamily: FONT.regular,
            ...typeStyle("bodySmall"),
          }}
        >
          {"•"} {item}
        </Text>
      ))}
    </View>
  );
}

function SheetAction({
  label,
  hint,
  onPress,
  muted = false,
}: {
  label: string;
  hint?: string;
  onPress: () => void;
  muted?: boolean;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(hint ? { accessibilityHint: hint } : {})}
      // NativeWind v4: a function-style `style={({pressed}) => …}` silently
      // drops layout on a Pressable. Static object only.
      style={{
        minHeight: 48,
        justifyContent: "center",
        paddingHorizontal: 16,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: muted ? t.borderSubtle : t.border,
        backgroundColor: muted ? "transparent" : t.surface,
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: muted ? t.fgMuted : t.fg,
          fontFamily: FONT.semibold,
          ...typeStyle("callout"),
          textAlign: muted ? "center" : "left",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
