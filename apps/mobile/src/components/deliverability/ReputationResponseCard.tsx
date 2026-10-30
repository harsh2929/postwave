/**
 * ReputationResponseCard — the three things you can actually DO when sending
 * reputation is on fire.
 *
 * `deliverability.degraded` push (default ON) lands an operator on this screen
 * at exactly the wrong moment of the day, and until now every response to it
 * required a laptop: attack mode was readable but not writable, the manual
 * blocklist suppression had no client on ANY surface, and the spam-trap sweep
 * was desktop-only.
 *
 * ORDERED BY WHAT STOPS THE BLEEDING FIRST. Blocklist suppression stops mail
 * leaving a listed IP or domain right now; attack mode changes who can sign up
 * next; the sweep is a check. That is also the order of irreversibility, so the
 * most consequential control is the one with the most explanation attached.
 *
 * Everything here is admin. Below that the card renders reads only — knowing
 * the workspace is listed on Spamhaus is worth having even when fixing it is
 * not yours to do.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { useConfirm } from "@/components/ConfirmSheet";
import { Pill } from "@/components/Pill";
import { SettingsSwitchRow } from "@/components/settings/FormControls";
import { useToast } from "@/components/Toast";
import {
  useBlocklistStatus,
  useFirewallSettings,
  useRunSpamTrapSweep,
  useSetAttackMode,
  useSuppressBlocklistSubject,
} from "@/hooks/useReputationResponse";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import {
  attackModeConsequence,
  attackModeOrigin,
  attackModeSummary,
  blocklistSeverity,
  blocklistSummary,
  blocklistSuppressConsequence,
  isSuppressibleSubject,
  spamTrapRunSummary,
  type BlocklistSubjectLike,
} from "@/lib/reputationResponse";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function ReputationResponseCard() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const confirm = useConfirm();
  const { toast } = useToast();

  const firewall = useFirewallSettings();
  const blocklist = useBlocklistStatus();
  const setMode = useSetAttackMode();
  const suppress = useSuppressBlocklistSubject();
  const sweep = useRunSpamTrapSweep();

  const mayAct = canAccessMinimumRole("admin", gate.effectiveRole);
  const settings = firewall.data ?? null;
  // Array.isArray, not `?? []` or a bare read. The nullish guard catches null and undefined and NOTHING else, so a truthy non-array from the wire -- `{}`, or a paged `{items: []}` envelope -- goes straight into the iteration. This is the control an operator reaches for during a
  // spam-trap or attack incident, which is the worst moment to hand them a
  // blank screen.
  const listed = (
    Array.isArray(blocklist.data) ? blocklist.data : []
  ).filter((s) => blocklistSeverity(s) !== "clean");

  const onToggleAttackMode = useCallback(
    async (next: boolean) => {
      haptics.tap();
      const ok = await confirm({
        title: next ? "Turn on attack mode?" : "Turn off attack mode?",
        message: attackModeConsequence(next),
        confirmLabel: next ? "Turn on" : "Turn off",
        destructive: next,
      });
      if (!ok) return;
      try {
        await setMode.mutateAsync(next);
        toast({
          kind: "success",
          message: next
            ? "Attack mode on."
            : "Attack mode off. The detector is held off for 24 hours.",
        });
      } catch (err) {
        toast({
          kind: "error",
          message:
            errorPresentation(err).message || "Couldn't change attack mode.",
        });
      }
    },
    [confirm, setMode, toast],
  );

  const onSuppress = useCallback(
    async (subject: BlocklistSubjectLike) => {
      haptics.tap();
      const ok = await confirm({
        title: `Stop sending from ${subject.subject}?`,
        message: blocklistSummary(subject),
        consequence: blocklistSuppressConsequence(subject),
        confirmLabel: "Suppress now",
        destructive: true,
      });
      if (!ok) return;
      try {
        const result = await suppress.mutateAsync({
          subjectType: subject.subject_type,
          subject: subject.subject,
        });
        toast({
          kind: "success",
          // A 409 means it was already suppressed. The caller's intent is
          // satisfied, so this is not a failure — but saying "suppressed" would
          // claim an action that did not happen.
          message: result.added
            ? `${subject.subject} suppressed.`
            : `${subject.subject} was already suppressed.`,
        });
      } catch (err) {
        toast({
          kind: "error",
          message:
            errorPresentation(err).message || "Couldn't suppress that subject.",
        });
      }
    },
    [confirm, suppress, toast],
  );

  const onSweep = useCallback(async () => {
    haptics.tap();
    try {
      const result = await sweep.mutateAsync();
      toast({ kind: "success", message: spamTrapRunSummary(result) });
    } catch (err) {
      toast({
        kind: "error",
        message:
          errorPresentation(err).message || "Couldn't run the spam-trap sweep.",
      });
    }
  }, [sweep, toast]);

  // Nothing loaded and nothing listed: no card rather than an empty one.
  if (!settings && listed.length === 0) return null;

  return (
    <View style={{ marginTop: 16 }}>
      <Card>
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
          }}
        >
          Reputation controls
        </Text>

        {listed.map((subject) => (
          <View
            key={`${subject.subject_type}:${subject.subject}`}
            style={{
              marginTop: 10,
              borderTopColor: t.borderSubtle,
              borderTopWidth: 1,
              paddingTop: 10,
              gap: 4,
            }}
          >
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            >
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fg,
                  ...typeStyle("caption"),
                  fontFamily: FONT.semibold,
                  flexShrink: 1,
                }}
                numberOfLines={1}
              >
                {subject.subject}
              </Text>
              <Pill
                label={blocklistSeverity(subject)}
                tone={
                  blocklistSeverity(subject) === "critical"
                    ? "warning"
                    : "neutral"
                }
              />
            </View>
            <Text
              {...typeCap("label")}
              style={{
                color: t.fgMuted,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
              }}
            >
              {blocklistSummary(subject)}
            </Text>
            {mayAct && isSuppressibleSubject(subject) ? (
              <Pressable
                onPress={() => void onSuppress(subject)}
                disabled={suppress.isPending}
                accessibilityRole="button"
                accessibilityLabel={`Stop sending from ${subject.subject}`}
                accessibilityState={{ disabled: suppress.isPending }}
                style={{ minHeight: 44, justifyContent: "center" }}
              >
                <Text
                  {...typeCap("control")}
                  style={{
                    color: suppress.isPending ? t.fgSubtle : t.danger,
                    ...typeStyle("control"),
                    fontFamily: FONT.semibold,
                  }}
                >
                  Suppress now
                </Text>
              </Pressable>
            ) : null}
          </View>
        ))}

        {settings ? (
          <View
            style={{
              marginTop: 12,
              borderTopColor: t.borderSubtle,
              borderTopWidth: 1,
              paddingTop: 10,
            }}
          >
            <Text
              {...typeCap("label")}
              style={{
                color:
                  attackModeOrigin(settings) === "off" ? t.fgMuted : t.warning,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
              }}
            >
              {attackModeSummary(settings)}
            </Text>
            {mayAct ? (
              <View style={{ marginTop: 8 }}>
                <SettingsSwitchRow
                  label="Attack mode"
                  hint="Strictest signup checks. Turning it off holds the automatic detector back for 24 hours."
                  value={settings.attackModeEnabled}
                  onValueChange={(next) => void onToggleAttackMode(next)}
                  disabled={setMode.isPending}
                />
              </View>
            ) : null}
          </View>
        ) : null}

        {mayAct ? (
          <Pressable
            onPress={() => void onSweep()}
            disabled={sweep.isPending}
            accessibilityRole="button"
            accessibilityLabel="Run the spam-trap sweep now"
            accessibilityState={{ disabled: sweep.isPending }}
            style={{ minHeight: 44, justifyContent: "center", marginTop: 8 }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: sweep.isPending ? t.fgSubtle : t.accent,
                ...typeStyle("control"),
                fontFamily: FONT.semibold,
              }}
            >
              {sweep.isPending ? "Sweeping…" : "Run spam-trap sweep"}
            </Text>
          </Pressable>
        ) : null}
      </Card>
    </View>
  );
}
