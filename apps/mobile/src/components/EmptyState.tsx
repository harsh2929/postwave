/**
 * EmptyState — centered "nothing here" copy block used by every list
 * screen.
 *
 * Two ways to use it (both supported, fully backward compatible):
 *
 *  1. BARE (unchanged): pass `title` / `description` / `cta`. Renders the
 *     original simple block. Every existing call site keeps working.
 *
 *  2. ENRICHED: pass a shared `EmptyStateContent` (from
 *     @postwave/onboarding-schema's EMPTY_STATES) via the `content` prop.
 *     Adds an outcome-framed headline, a clean inline themed illustration
 *     (a composed RN <Svg> motif — no new native deps), and up to two
 *     action cards driven by the content's primary/secondary CTAs, each
 *     routing through the shared OnboardingRouteKey resolver and emitting
 *     the empty_state_cta_clicked analytics event.
 *
 * NativeWind v4: STATIC Pressable styles only.
 */
import { router } from "expo-router";
import { Pressable, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import Svg, { Circle, Path, Rect } from "react-native-svg";

import type {
  EmptyStateContent,
  EmptyStateIllustration,
} from "@postwave/onboarding-schema";

import {
  ONBOARDING_EVENTS,
  trackOnboarding,
} from "@/components/onboarding/analytics";
import { routeForOnboardingKey } from "@/components/onboarding/onboardingRoutes";
import { MIN_TOUCH_TARGET } from "@/lib/displayPreferences";
import { FONT } from "@/lib/fonts";
import { durationFor, useMotion } from "@/lib/motion";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface EmptyStateProps {
  title?: string;
  description?: string;
  cta?: { label: string; onPress: () => void };
  /**
   * Shared, outcome-framed content. When provided, the enriched layout
   * (illustration + action cards) renders and `title`/`description`/`cta`
   * are ignored. Omit it for the original bare block. Accepts `undefined`
   * so call sites can spread `EMPTY_STATES[key]` (index access) directly.
   */
  content?: EmptyStateContent | undefined;
}

export function EmptyState({
  title,
  description,
  cta,
  content,
}: EmptyStateProps) {
  if (content) {
    return <EnrichedEmptyState content={content} />;
  }
  return (
    <BareEmptyState title={title ?? ""} description={description} cta={cta} />
  );
}

function BareEmptyState({
  title,
  description,
  cta,
}: {
  title: string;
  description?: string | undefined;
  cta?: { label: string; onPress: () => void } | undefined;
}) {
  const { t } = useTheme();
  const { reduceMotion } = useMotion();
  return (
    <Animated.View
      // MOTION. An empty state arrives where a skeleton just was; appearing in
      // one frame reads as a glitch rather than as an answer. The duration is
      // the shared `enter` intent, never a literal, and Reduce Motion removes
      // the transition entirely rather than running it at 0ms.
      {...(reduceMotion
        ? {}
        : { entering: FadeIn.duration(durationFor("enter")) })}
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 16,
        paddingVertical: 28,
        paddingHorizontal: 20,
        alignItems: "center",
      }}
    >
      <Text
        {...typeCap("heading")}
        style={{
          color: t.fg,
          ...typeStyle("heading"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
          textAlign: "center",
        }}
      >
        {title}
      </Text>
      {description ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
            marginTop: 6,
            textAlign: "center",
          }}
        >
          {description}
        </Text>
      ) : null}
      {cta ? (
        <Pressable
          onPress={cta.onPress}
          accessibilityRole="button"
          style={{
            marginTop: 14,
            minHeight: MIN_TOUCH_TARGET,
            justifyContent: "center",
            paddingHorizontal: 16,
            paddingVertical: 10,
            borderRadius: 10,
            backgroundColor: t.accent,
            opacity: 1,
          }}
        >
          <Text
            {...typeCap("callout")}
            style={{
              color: t.accentFg,
              ...typeStyle("callout"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            {cta.label}
          </Text>
        </Pressable>
      ) : null}
    </Animated.View>
  );
}

/**
 * EnrichedEmptyState — illustration + outcome copy + action cards, driven
 * by a shared EmptyStateContent. Exported for screens that want it
 * directly, though passing `content` to <EmptyState> is the usual path.
 */
export function EnrichedEmptyState({
  content,
}: {
  content: EmptyStateContent;
}) {
  const { t } = useTheme();

  function onCta(
    cta: NonNullable<EmptyStateContent["primaryCta"]>,
    which: "primary" | "secondary",
  ): void {
    trackOnboarding(ONBOARDING_EVENTS.emptyStateCtaClicked, {
      surfaceId: content.id,
      cta: which,
    });
    router.push(routeForOnboardingKey(cta.routeKey) as never);
  }

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 16,
        paddingVertical: 28,
        paddingHorizontal: 20,
        alignItems: "center",
      }}
      accessibilityLabel={`${content.title}. ${content.subtitle}`}
    >
      <EmptyStateMotif kind={content.illustrationKey ?? "generic"} />
      <Text
        {...typeCap("heading")}
        style={{
          color: t.fg,
          ...typeStyle("heading"),
          fontWeight: "700",
          fontFamily: FONT.display,
          letterSpacing: -0.3,
          textAlign: "center",
          marginTop: 16,
        }}
      >
        {content.title}
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
          marginTop: 6,
          textAlign: "center",
          maxWidth: 320,
        }}
      >
        {content.subtitle}
      </Text>

      {content.primaryCta || content.secondaryCta ? (
        <View
          style={{
            flexDirection: "row",
            gap: 10,
            marginTop: 18,
            flexWrap: "wrap",
            justifyContent: "center",
          }}
        >
          {content.primaryCta ? (
            <Pressable
              onPress={() => onCta(content.primaryCta!, "primary")}
              accessibilityRole="button"
              accessibilityLabel={content.primaryCta.label}
              hitSlop={6}
              style={{
                minHeight: 44,
                paddingHorizontal: 18,
                borderRadius: 11,
                backgroundColor: t.accent,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text
                {...typeCap("callout")}
                style={{
                  color: t.accentFg,
                  ...typeStyle("callout"),
                  fontWeight: "700",
                  fontFamily: FONT.bold,
                }}
              >
                {content.primaryCta.label}
              </Text>
            </Pressable>
          ) : null}
          {content.secondaryCta ? (
            <Pressable
              onPress={() => onCta(content.secondaryCta!, "secondary")}
              accessibilityRole="button"
              accessibilityLabel={content.secondaryCta.label}
              hitSlop={6}
              style={{
                minHeight: 44,
                paddingHorizontal: 18,
                borderRadius: 11,
                borderWidth: 1,
                borderColor: t.border,
                backgroundColor: t.surface,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text
                {...typeCap("callout")}
                style={{
                  color: t.fg,
                  ...typeStyle("callout"),
                  fontWeight: "600",
                  fontFamily: FONT.semibold,
                }}
              >
                {content.secondaryCta.label}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * EmptyStateMotif — a small, clean inline SVG motif themed to the active
 * palette. One composed primitive per illustration key; no asset files,
 * no new native deps (react-native-svg is already a dependency).
 */
function EmptyStateMotif({ kind }: { kind: EmptyStateIllustration }) {
  const { t } = useTheme();
  const size = 72;
  const stroke = t.border;
  const accent = t.accent;
  const fill = t.surfaceElevated;

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: t.bgSubtle,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Svg width={40} height={40} viewBox="0 0 40 40">
        {kind === "subscribers" ? (
          <>
            <Circle
              cx={20}
              cy={14}
              r={7}
              stroke={accent}
              strokeWidth={2.5}
              fill={fill}
            />
            <Path
              d="M7 34c0-7 6-11 13-11s13 4 13 11"
              stroke={stroke}
              strokeWidth={2.5}
              fill="none"
              strokeLinecap="round"
            />
          </>
        ) : kind === "campaigns" ? (
          <>
            <Rect
              x={6}
              y={11}
              width={28}
              height={20}
              rx={3}
              stroke={stroke}
              strokeWidth={2.5}
              fill={fill}
            />
            <Path
              d="M6 14l14 9 14-9"
              stroke={accent}
              strokeWidth={2.5}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : kind === "sequences" ? (
          <>
            <Circle
              cx={10}
              cy={12}
              r={4}
              stroke={accent}
              strokeWidth={2.5}
              fill={fill}
            />
            <Circle
              cx={30}
              cy={28}
              r={4}
              stroke={accent}
              strokeWidth={2.5}
              fill={fill}
            />
            <Path
              d="M10 16v6a6 6 0 006 6h10"
              stroke={stroke}
              strokeWidth={2.5}
              fill="none"
              strokeLinecap="round"
            />
          </>
        ) : kind === "forms" ? (
          <>
            <Rect
              x={9}
              y={7}
              width={22}
              height={26}
              rx={3}
              stroke={stroke}
              strokeWidth={2.5}
              fill={fill}
            />
            <Path
              d="M14 15h12M14 21h12M14 27h7"
              stroke={accent}
              strokeWidth={2.5}
              strokeLinecap="round"
            />
          </>
        ) : (
          <Circle
            cx={20}
            cy={20}
            r={12}
            stroke={accent}
            strokeWidth={2.5}
            fill={fill}
          />
        )}
      </Svg>
    </View>
  );
}
