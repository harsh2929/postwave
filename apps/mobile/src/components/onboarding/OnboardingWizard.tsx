/**
 * OnboardingWizard — the first-run native modal that mirrors desktop's
 * onboarding journey:
 *
 *   verify domain → add subscribers → first campaign → done
 *
 * Each step is a lightweight panel: a title, a sentence of outcome-framed
 * copy, and a primary "Take me there" action that routes the user into
 * the relevant tab (then closes the modal). Skip / Back / Next give a
 * full escape hatch — nothing here is mandatory.
 *
 * Gating: the HOST decides when to mount this (first run + empty
 * workspace — onboarding progress completed === 0). The component itself
 * only owns its open/closed animation + dismissal persistence:
 *
 *   postwave_onboarding_wizard_dismissed_at   ISO string | null
 *
 * Reduced-motion: panel transitions drop to instant (matches the tour).
 * 44pt minimum hit targets. STATIC Pressable styles only (NativeWind v4
 * function-style `style` silently drops layout).
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  Text,
  View,
} from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  useReducedMotion,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { motion } from "@postwave/design-tokens";
import type { OnboardingRouteKey } from "@postwave/onboarding-schema";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

import { WizardNav } from "./WizardNav";
import { ONBOARDING_EVENTS, trackOnboarding } from "./analytics";
import { routeForOnboardingKey } from "./onboardingRoutes";

export const WIZARD_DISMISSED_KEY = "postwave_onboarding_wizard_dismissed_at";
const WIZARD_ID = "mobile_first_run";
const MIN_TAP_TARGET = 44;

interface WizardStep {
  id: string;
  /** Eyebrow label (e.g. "Step 1 of 3"). */
  eyebrow: string;
  title: string;
  body: string;
  /** CTA label routing the user into the relevant tab. */
  actionLabel: string;
  routeKey: OnboardingRouteKey;
}

const STEPS: readonly WizardStep[] = [
  {
    id: "verify-domain",
    eyebrow: "First, deliverability",
    title: "Verify a sending domain",
    body: "Add the DKIM, SPF, and DMARC records at your registrar, then run the verifier. This is what keeps your mail out of spam.",
    actionLabel: "Open sending settings",
    routeKey: "settings.sending-identity",
  },
  {
    id: "add-subscribers",
    eyebrow: "Then, your audience",
    title: "Add your subscribers",
    body: "Import an existing list or add people one at a time — every subscriber carries its own consent record.",
    actionLabel: "Open subscribers",
    routeKey: "subscribers",
  },
  {
    id: "first-campaign",
    eyebrow: "Finally, your first send",
    title: "Review your campaigns",
    body: "Drafts authored on the web admin land here. Watch opens, clicks, and deliverability the moment a send goes out.",
    actionLabel: "Open campaigns",
    routeKey: "campaigns",
  },
] as const;

interface OnboardingWizardProps {
  /** Host controls visibility (first run + empty workspace). */
  visible: boolean;
  /** Called when the wizard should stop being shown (skip / finish). */
  onClose: () => void;
}

export function OnboardingWizard({ visible, onClose }: OnboardingWizardProps) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(0);
  // One source for the preference (see OnboardingChecklist).
  const reducedMotion = useReducedMotion();

  // wizard_started — once per open.
  const startedRef = useRef(false);
  useEffect(() => {
    if (!visible || startedRef.current) return;
    startedRef.current = true;
    setIndex(0);
    trackOnboarding(ONBOARDING_EVENTS.wizardStarted, {
      wizardId: WIZARD_ID,
      stepId: STEPS[0]?.id ?? "verify-domain",
    });
  }, [visible]);

  // Panel cross-fade + slide on step change.
  const panelOpacity = useSharedValue(1);
  const panelShift = useSharedValue(0);
  useEffect(() => {
    if (reducedMotion) {
      panelOpacity.value = 1;
      panelShift.value = 0;
      return;
    }
    panelOpacity.value = 0;
    panelShift.value = 12;
    panelOpacity.value = withTiming(1, {
      duration: motion.durations.tooltipEnterMs,
      easing: Easing.bezier(...motion.easing.decelerate.bezier),
    });
    panelShift.value = withTiming(0, {
      duration: motion.durations.tooltipEnterMs,
      easing: Easing.bezier(...motion.easing.decelerate.bezier),
    });
  }, [index, reducedMotion, panelOpacity, panelShift]);

  const panelStyle = useAnimatedStyle(() => ({
    opacity: panelOpacity.value,
    transform: [{ translateY: panelShift.value }],
  }));

  const step = STEPS[index];
  const isFirst = index === 0;
  const isLast = index === STEPS.length - 1;

  async function persistDismissal(): Promise<void> {
    try {
      await AsyncStorage.setItem(
        WIZARD_DISMISSED_KEY,
        new Date().toISOString(),
      );
    } catch {
      /* ignore — host also tracks dismissal in-memory */
    }
  }

  function completeStep(stepId: string): void {
    trackOnboarding(ONBOARDING_EVENTS.wizardStepCompleted, {
      wizardId: WIZARD_ID,
      stepId,
    });
  }

  async function finish(): Promise<void> {
    trackOnboarding(ONBOARDING_EVENTS.wizardCompleted, {
      wizardId: WIZARD_ID,
    });
    await persistDismissal();
    onClose();
  }

  async function skip(): Promise<void> {
    await persistDismissal();
    onClose();
  }

  function next(): void {
    if (!step) return;
    completeStep(step.id);
    if (isLast) {
      void finish();
      return;
    }
    setIndex((i) => Math.min(STEPS.length - 1, i + 1));
  }

  function back(): void {
    setIndex((i) => Math.max(0, i - 1));
  }

  async function goToStepRoute(): Promise<void> {
    if (!step) return;
    completeStep(step.id);
    // Routing into a tab IS the meaningful "done with the modal" action —
    // persist dismissal so we don't re-prompt next launch, then route.
    await persistDismissal();
    onClose();
    router.push(routeForOnboardingKey(step.routeKey) as never);
  }

  const dots = useMemo(() => STEPS.map((s) => s.id), []);

  if (!step) return null;

  return (
    <ReducedMotionModal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => void skip()}
    >
      <View
        style={{
          flex: 1,
          backgroundColor: t.overlay,
          justifyContent: "flex-end",
        }}
      >
        <View
          style={{
            backgroundColor: t.surface,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            borderColor: t.borderSubtle,
            borderWidth: 1,
            paddingHorizontal: 22,
            paddingTop: 18,
            paddingBottom: Math.max(insets.bottom + 12, 20),
          }}
          accessibilityViewIsModal
          accessibilityLabel="Welcome to Moosewave — getting started"
        >
          {/* Grabber. */}
          <View
            style={{
              alignSelf: "center",
              width: 36,
              height: 5,
              borderRadius: 3,
              backgroundColor: t.borderSubtle,
              marginBottom: 16,
            }}
          />

          <Animated.View style={panelStyle}>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.accent,
                ...typeStyle("caption"),
                fontWeight: "700",
                fontFamily: FONT.bold,
                letterSpacing: 0.4,
                textTransform: "uppercase",
              }}
            >
              {step.eyebrow}
            </Text>
            <Text
              accessibilityRole="header"
              {...typeCap("title")}
              style={{
                color: t.fg,
                ...typeStyle("title"),
                fontWeight: "800",
                fontFamily: FONT.display,
                letterSpacing: -0.4,
                marginTop: 6,
              }}
            >
              {step.title}
            </Text>
            <Text
              {...typeCap("callout")}
              style={{
                color: t.fgMuted,
                ...typeStyle("callout"),
                marginTop: 8,
                fontFamily: FONT.regular,
              }}
            >
              {step.body}
            </Text>

            <Pressable
              onPress={() => void goToStepRoute()}
              accessibilityRole="button"
              accessibilityLabel={step.actionLabel}
              hitSlop={6}
              style={{
                minHeight: MIN_TAP_TARGET,
                marginTop: 18,
                borderRadius: 12,
                backgroundColor: t.accent,
                alignItems: "center",
                justifyContent: "center",
                paddingVertical: 12,
              }}
            >
              <Text
                {...typeCap("body")}
                style={{
                  color: t.accentFg,
                  ...typeStyle("body"),
                  fontWeight: "700",
                  fontFamily: FONT.bold,
                }}
              >
                {step.actionLabel}
              </Text>
            </Pressable>
          </Animated.View>

          {/* Dot indicator. */}
          <View
            style={{
              flexDirection: "row",
              justifyContent: "center",
              gap: 6,
              marginTop: 18,
              marginBottom: 14,
            }}
            accessibilityLabel={`Step ${index + 1} of ${STEPS.length}`}
          >
            {dots.map((id, i) => (
              <View
                key={id}
                style={{
                  width: i === index ? 18 : 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: i === index ? t.accent : t.borderSubtle,
                }}
              />
            ))}
          </View>

          <WizardNav
            isFirst={isFirst}
            isLast={isLast}
            onSkip={() => void skip()}
            onBack={back}
            onNext={next}
          />
        </View>
      </View>
    </ReducedMotionModal>
  );
}
