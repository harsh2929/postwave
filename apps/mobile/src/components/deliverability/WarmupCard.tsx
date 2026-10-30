/**
 * WarmupCard — today's allowance on a domain that is still ramping.
 *
 * Warm-up is a multi-week schedule, but the operator's DAILY question is one
 * number: how much may this domain send today, and how much of that is gone.
 * That is the one period in a domain's life when someone checks every morning,
 * and it was the period mobile could not answer at all.
 *
 * Two distinctions the card refuses to collapse:
 *  - "no plan for this domain" is not "quota zero". A ramping domain with a
 *    0-quota day is a broken plan; a domain with no plan is just sending.
 *  - a FULL bar is not a failure. Reaching today's cap is the plan working, so
 *    the meter tops out warning-toned, never red — unlike the rate-limit meter
 *    it shares an implementation with.
 */
import { Pressable, Text, View } from "react-native";

import { Meter } from "@/components/deliverability/Meter";
import { Pill } from "@/components/Pill";
import { SegmentedControl } from "@/components/SegmentedControl";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import {
  warmupControlFor,
  warmupControlLabel,
  warmupControlStatus,
  warmupMeter,
  type WarmupPlan,
  type WarmupToday,
} from "@/lib/deliverabilityDiagnostics";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

export interface WarmupCardProps {
  plans: readonly WarmupPlan[];
  today: WarmupToday | undefined;
  selectedDomain: string;
  onSelectDomain: (domain: string) => void;
  /** Non-null when the plan list failed, could not run, or was forbidden. */
  unavailableReason: string | null;
  /**
   * Null below admin — PATCH .../status is ScopeAdmin — and null offline,
   * because a queued pause would report a ramp as held while it keeps
   * climbing. The card then renders the plan and no control.
   */
  onSetStatus?: ((plan: WarmupPlan, status: string) => void) | null;
  settingStatus?: boolean;
}

export function WarmupCard({
  plans,
  today,
  selectedDomain,
  onSelectDomain,
  unavailableReason,
  onSetStatus = null,
  settingStatus = false,
}: WarmupCardProps) {
  const { t } = useTheme();
  const meter = warmupMeter(today);
  const plan = plans.find((p) => p.domain === selectedDomain);

  // No plans is the COMMON case, and it is good news — say so rather than
  // rendering an empty card that reads as a broken one.
  if (!unavailableReason && plans.length === 0) return null;

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 10,
        gap: 10,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.bold,
            letterSpacing: 0.6,
            textTransform: "uppercase",
          }}
        >
          Domain warm-up
        </Text>
        {meter.dayLabel ? (
          <Pill
            label={meter.dayLabel}
            tone={today?.atTarget ? "success" : "info"}
          />
        ) : null}
      </View>

      {unavailableReason ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {unavailableReason}
        </Text>
      ) : (
        <>
          {plans.length > 1 ? (
            <SegmentedControl
              options={plans.map((p) => ({ value: p.domain, label: p.domain }))}
              value={selectedDomain}
              onChange={onSelectDomain}
              accessibilityLabel="Warming domain"
              scrollable
            />
          ) : (
            <Text
              {...typeCap("body")}
              style={{
                color: t.fg,
                ...typeStyle("body"),
                fontFamily: FONT.semibold,
              }}
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {selectedDomain || "—"}
            </Text>
          )}
          <Meter
            label="Today's allowance"
            fraction={meter.fraction}
            tone={meter.tone}
            caption={meter.caption}
            accessibilityValueText={`${meter.dayLabel}. ${meter.caption}`}
          />
          {plan ? (
            <Text
              {...typeCap("label")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
              }}
            >
              {`Ramping to ${num(plan.targetDaily)} a day over ${num(
                plan.days,
              )} days · ${plan.status}`}
            </Text>
          ) : null}
          {/* The card has always rendered the ramp's status and never let
              anybody change it. Only pause/resume are offered — see
              warmupControlFor for why the terminal transitions stay on a
              desk. */}
          {plan && onSetStatus && warmupControlLabel(warmupControlFor(plan)) ? (
            <Pressable
              onPress={() => {
                const status = warmupControlStatus(warmupControlFor(plan));
                if (status) onSetStatus(plan, status);
              }}
              disabled={settingStatus}
              accessibilityRole="button"
              accessibilityLabel={`${warmupControlLabel(warmupControlFor(plan))} for ${plan.domain}`}
              accessibilityState={{ disabled: settingStatus }}
              // NativeWind v4: static style object only.
              style={{ minHeight: 44, justifyContent: "center" }}
            >
              <Text
                {...typeCap("control")}
                style={{
                  color: settingStatus ? t.fgSubtle : t.accent,
                  ...typeStyle("control"),
                  fontFamily: FONT.semibold,
                }}
              >
                {settingStatus
                  ? "Updating…"
                  : warmupControlLabel(warmupControlFor(plan))}
              </Text>
            </Pressable>
          ) : null}
        </>
      )}
    </View>
  );
}
