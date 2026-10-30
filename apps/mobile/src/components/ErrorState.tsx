/**
 * ErrorState — the "couldn't load this" block used by list/detail screens
 * so a failed fetch is NEVER rendered as an empty "nothing here" state.
 * Pairs a human message with a Retry button wired to the query's refetch.
 *
 *   {q.isError ? (
 *     <ErrorState onRetry={q.refetch} error={q.error} />
 *   ) : q.data?.length ? <List/> : <EmptyState .../>}
 *
 * MOTION. This block replaces content the user was reading, or arrives where a
 * skeleton just was. Appearing in one frame reads as a glitch — the eye cannot
 * tell "the screen changed" from "the screen broke". A short decelerating fade
 * (the shared `enter` intent, never a literal duration) says an arrival
 * happened. It collapses to nothing under Reduce Motion, and because this is
 * one of the two blocks every list screen in the app renders, the transition
 * lands everywhere at once rather than screen by screen.
 */
import { useEffect } from "react";
import Animated, { FadeIn } from "react-native-reanimated";
import { Pressable, Text } from "react-native";

import { announce, liveRegionProps } from "@/lib/a11y";
import { MIN_TOUCH_TARGET } from "@/lib/displayPreferences";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { durationFor, useMotion } from "@/lib/motion";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { isProbablyOnline } from "@/lib/connectivity";

export interface ErrorStateProps {
  /** Optional override. Defaults to a friendly, status-aware message. */
  message?: string;
  /**
   * Raw error. Its STATUS shapes the copy and decides whether a retry is even
   * offered — it is never shown verbatim.
   */
  error?: unknown;
  /** Retry handler (typically a query's refetch). */
  onRetry?: () => void;
  /** Compact inline variant for small slots (e.g. a card body). */
  compact?: boolean;
}

export function ErrorState({
  message,
  error,
  onRetry,
  compact = false,
}: ErrorStateProps) {
  const { t } = useTheme();
  const { reduceMotion } = useMotion();
  const presentation = errorPresentation(error, {
    ...(message ? { explicit: message } : {}),
    online: isProbablyOnline(),
  });
  const body = presentation.message;
  useEffect(() => {
    announce(body);
  }, [body]);
  // A "Try again" button on a 403 or a 404 is a button that can never work.
  const showRetry = Boolean(onRetry) && presentation.retryable;
  return (
    <Animated.View
      {...(reduceMotion
        ? {}
        : { entering: FadeIn.duration(durationFor("enter")) })}
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 16,
        paddingVertical: compact ? 16 : 24,
        paddingHorizontal: 20,
        alignItems: "center",
        gap: 12,
      }}
    >
      <Text
        {...liveRegionProps()}
        {...typeCap(compact ? "callout" : "body")}
        style={{
          color: t.fg,
          ...typeStyle(compact ? "callout" : "body"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
          textAlign: "center",
        }}
      >
        {body}
      </Text>
      {showRetry && onRetry ? (
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Retry"
          style={{
            minHeight: MIN_TOUCH_TARGET,
            justifyContent: "center",
            paddingVertical: 10,
            paddingHorizontal: 20,
            borderRadius: 10,
            backgroundColor: t.accent,
            opacity: 1,
          }}
        >
          <Text
            {...typeCap("callout")}
            style={{
              color: t.accentFg,
              fontWeight: "700",
              fontFamily: FONT.bold,
              ...typeStyle("callout"),
            }}
          >
            Try again
          </Text>
        </Pressable>
      ) : null}
    </Animated.View>
  );
}
