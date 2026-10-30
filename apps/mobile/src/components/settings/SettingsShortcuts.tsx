/**
 * SettingsShortcuts — the bottom of Settings: plan, setup, audit, tour.
 *
 * Three things were wrong before this existed, all of them "the app knows but
 * never says":
 *
 *  - PLAN WAS A WORD, NOT A NUMBER. Settings had no plan or usage summary at
 *    all, and never even mentioned that /(tabs)/billing exists — it was
 *    reachable only from More → Account. This renders the tier and the send
 *    meter inline, from the SAME query key the Plan & usage screen uses
 *    (`["billing","plan-summary",tenantId]`), so it costs no extra request and
 *    the two surfaces can never disagree.
 *  - SETUP PROGRESS WAS INVISIBLE. The onboarding checklist lives only on the
 *    dashboard and hides itself behind a persisted "dismissed" flag, so once
 *    dismissed there was no route back to it anywhere in the app and no other
 *    surface reported how far setup had got.
 *  - The checklist could not be brought back. "Show setup checklist" clears
 *    that flag and returns to the dashboard.
 *
 * Extracted from settings.tsx (which was at its source-budget ceiling) so the
 * screen shrank while gaining these.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useRef } from "react";
import { Pressable, Text, View } from "react-native";

import { fetchPlanSummary } from "@/api/billing";
import { restoreChecklist } from "@/lib/onboardingDecisions";
import { useOnboardingProgressQuery } from "@/components/onboarding/useOnboardingProgress";
import { Card, SectionHeader } from "@/components/settings/SettingsScreenPrimitives";
import { NewFeatureBadge } from "@/components/settings/NewFeatureBadge";
import { UsageBar } from "@/components/billing/UsageBar";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { useTour, useTourTarget } from "@/components/tour/TourProvider";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const SENDS_RESOURCE = "monthly_sends";

export function SettingsShortcuts() {
  const tour = useTour();
  const { toast } = useToast();
  const replayRowRef = useRef<View>(null);
  useTourTarget("settings.replay", replayRowRef);

  return (
    <>
      <SectionHeader
        title="Plan and setup"
        subtitle="What this workspace is entitled to, and how far setup got."
      />
      <PlanSummaryCard />
      <SetupProgressCard
        onRestore={() => {
          haptics.tap();
          // Clears the server decision too. Removing only the local key would
          // now be worse than before: the next read puts the checklist straight
          // back and this control looks broken.
          void restoreChecklist()
            .then(() => {
              toast({
                kind: "success",
                message: "Setup checklist restored on the dashboard.",
              });
              router.push("/(tabs)/dashboard");
            })
            .catch(() =>
              toast({
                kind: "error",
                message: "Couldn't restore the setup checklist.",
              }),
            );
        }}
      />

      <LinkRow
        label="Open audit log"
        onPress={() => router.push("/(tabs)/audit")}
      />

      {/* Replay tour — the tour overlay also exposes a floating "?" FAB; this
          row gives the same affordance a persistent home in Settings. */}
      <View ref={replayRowRef} collapsable={false}>
        <LinkRow
          label="Replay tour"
          hint="60-second walk through the main surfaces"
          onPress={() => tour.start()}
        />
      </View>
    </>
  );
}

/**
 * Plan tier + the send meter, tappable through to Plan & usage.
 *
 * Deliberately silent when the query has no answer: an entitlement figure that
 * might be wrong is worse on a billing surface than no figure, and the row
 * below still gets the user to the full screen.
 */
function PlanSummaryCard() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const plan = useQuery({
    // The SAME key /(tabs)/billing uses — this is a cache read, not a request.
    queryKey: ["billing", "plan-summary", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    queryFn: () => fetchPlanSummary(),
    staleTime: 60_000,
  });
  // The optional chain guards `data` but NOT `resources`, so a payload
  // missing that key reaches `.find` on undefined.
  const sends = (
    Array.isArray(plan.data?.resources) ? plan.data.resources : []
  ).find(
    (row) => row.resource === SENDS_RESOURCE,
  );
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        router.push("/(tabs)/billing");
      }}
      accessibilityRole="button"
      accessibilityLabel={
        plan.data
          ? `Plan and usage. ${plan.data.tier} plan.`
          : "Open plan and usage"
      }
      style={{ marginBottom: 8 }}
    >
      <Card>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              flexShrink: 1,
            }}
          >
            <Text
              // Card headline sharing its row with a "View" affordance.
              {...typeCap("body")}
              style={{
                color: t.fg,
                ...typeStyle("body"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
                flexShrink: 1,
              }}
              numberOfLines={1}
            >
              {plan.data ? `${plan.data.tier} plan` : "Plan & usage"}
            </Text>
            {/* 30-day discovery cue for the API usage & cost dashboard that
                now lives behind this row (desktop parity: lib/newFeatures). */}
            <NewFeatureBadge featureKey="billing-api-usage" />
          </View>
          <Text
            // Trailing affordance on a shared row: dense, so it cannot push
            // the plan name out.
            {...typeCap("control")}
            style={{
              color: t.accent,
              ...typeStyle("control"),
              fontFamily: FONT.medium,
            }}
          >
            View
          </Text>
        </View>
        {plan.isLoading ? (
          <View style={{ marginTop: 10 }}>
            <SkeletonList rows={1} lines={2} label="Loading your plan" />
          </View>
        ) : null}
        {sends ? (
          <View style={{ marginTop: 10 }}>
            <UsageBar row={sends} />
          </View>
        ) : null}
      </Card>
    </Pressable>
  );
}

/** Completed / total setup steps, plus the way back to the checklist. */
function SetupProgressCard({ onRestore }: { onRestore: () => void }) {
  const { t } = useTheme();
  const progress = useOnboardingProgressQuery();
  const steps = Array.isArray(progress.data?.steps) ? progress.data?.steps : [];
  const done = steps.filter((step) => step.completed).length;
  const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;
  return (
    <Card>
      <View
        // The bar is decorative; the label carries the value, so a screen
        // reader hears the number rather than "image".
        accessible
        accessibilityLabel={
          steps.length
            ? `Setup progress: ${done} of ${steps.length} steps complete.`
            : "Setup progress is unavailable."
        }
      >
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.medium,
          }}
        >
          {steps.length
            ? `Setup ${done}/${steps.length} complete`
            : "Setup progress unavailable"}
        </Text>
        <View
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{
            height: 6,
            borderRadius: 3,
            backgroundColor: t.bgSubtle,
            marginTop: 8,
            overflow: "hidden",
          }}
        >
          <View
            style={{
              width: `${pct}%`,
              height: "100%",
              backgroundColor: t.accent,
            }}
          />
        </View>
      </View>
      <Pressable
        onPress={onRestore}
        accessibilityRole="button"
        accessibilityLabel="Show setup checklist on the dashboard"
        style={{
          marginTop: 12,
          minHeight: 44,
          justifyContent: "center",
          alignItems: "center",
          borderRadius: 10,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.surface,
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.fg,
            ...typeStyle("callout"),
            fontFamily: FONT.medium,
          }}
        >
          Show setup checklist
        </Text>
      </Pressable>
    </Card>
  );
}

function LinkRow({
  label,
  hint,
  onPress,
}: {
  label: string;
  hint?: string;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        marginTop: 16,
        minHeight: 44,
        paddingVertical: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.surface,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        {...typeCap("body")}
        style={{
          color: t.fg,
          ...typeStyle("body"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
      {hint ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 2,
            fontFamily: FONT.regular,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </Pressable>
  );
}
