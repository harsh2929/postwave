/**
 * SpendControlsCard — see the meter, and stop it.
 *
 * The billing screen could already show an operator that they were about to
 * blow through the plan (`sends_projection`), and gave them nothing to do about
 * it. `PUT /api/v1/billing/overage` was web-only, so capping spend meant
 * finding a laptop. The SMS wallet had the same shape: this app SENDS billable
 * SMS and could not read the balance.
 *
 * ── ASYMMETRIC FRICTION, DELIBERATELY ──────────────────────────────────────
 * Turning overage ON can cost money, so it confirms. Turning it OFF cannot, so
 * it never does. An operator trying to stop spend should not meet a dialog —
 * that is the moment to get out of the way.
 *
 * ── THE CEILING IS A SEPARATE ACT FROM THE SWITCH ──────────────────────────
 * They are one PUT server-side, but two decisions: "may we exceed the plan?"
 * and "by how much at most?". The ceiling field therefore has its own Save,
 * because typing a number and having it apply on blur is how people set a cap
 * of 5 when they meant 50,000.
 *
 * Below admin the card renders READS only. Knowing money is being spent is
 * worth having even when changing it is not yours to do.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { SMS_FINANCIAL_LEDGER_RELEASE_HELD_CODE } from "@/api/spendControls";
import { Card } from "@/components/Card";
import { useConfirm } from "@/components/ConfirmSheet";
import { Pill } from "@/components/Pill";
import {
  SettingsSwitchRow,
  SettingsTextInput,
} from "@/components/settings/FormControls";
import { useToast } from "@/components/Toast";
import { useSendingAddon, useSetOverage } from "@/hooks/useSpendControls";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import {
  overageEnableConsequence,
  overageHeadroom,
  overageState,
  spendSummary,
  spendTone,
  validateOverageCap,
} from "@/lib/spendControls";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const STATE_LABEL: Record<string, string> = {
  off: "overage off",
  on_not_billed: "on, not billed",
  on_billing: "on, billing",
  capped_out: "ceiling reached",
};

export function SpendControlsCard() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const confirm = useConfirm();
  const { toast } = useToast();

  const addonQuery = useSendingAddon();
  const save = useSetOverage();

  const addon = addonQuery.data ?? null;
  const [capDraft, setCapDraft] = useState<string | null>(null);
  const mayAct = canAccessMinimumRole("admin", gate.effectiveRole);

  const apply = useCallback(
    async (enabled: boolean, cap: number | undefined, done: string) => {
      try {
        await save.mutateAsync({ enabled, cap });
        setCapDraft(null);
        toast({ kind: "success", message: done });
      } catch (err) {
        toast({
          kind: "error",
          message:
            errorPresentation(err).message ||
            "Couldn't change your overage setting.",
        });
      }
    },
    [save, toast],
  );

  const onToggle = useCallback(
    async (next: boolean) => {
      if (!addon) return;
      haptics.tap();
      const cap = addon.overageCap;
      if (next) {
        // Only the money-spending direction asks.
        const ok = await confirm({
          title: "Allow sending past your plan cap?",
          message: overageEnableConsequence(addon, cap),
          confirmLabel: "Allow overage",
        });
        if (!ok) return;
      }
      await apply(
        next,
        cap,
        next
          ? "Overage allowed."
          : "Overage stopped — sends now stop at the plan cap.",
      );
    },
    [addon, apply, confirm],
  );

  const onSaveCap = useCallback(async () => {
    if (!addon || capDraft === null) return;
    const parsed = validateOverageCap(capDraft);
    if (!parsed.ok) {
      toast({ kind: "error", message: parsed.message });
      return;
    }
    haptics.tap();
    await apply(
      addon.overageEnabled,
      parsed.cap,
      parsed.cap === undefined
        ? "Ceiling cleared — overage is now unbounded."
        : `Ceiling set to ${num(parsed.cap)} extra sends.`,
    );
  }, [addon, apply, capDraft, toast]);

  const headroom = addon ? overageHeadroom(addon) : null;
  const capValue =
    capDraft ??
    (addon?.overageCap !== undefined ? String(addon.overageCap) : "");

  return (
    <View style={{ marginTop: 16 }}>
      <Card>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontFamily: FONT.semibold,
              flex: 1,
            }}
          >
            Spend controls
          </Text>
          {addon ? (
            <Pill
              label={STATE_LABEL[overageState(addon)] ?? overageState(addon)}
              tone={spendTone(addon)}
            />
          ) : null}
        </View>

        {addon ? (
          <>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
                marginTop: 6,
              }}
            >
              {spendSummary(addon)}
            </Text>
            {headroom !== null && addon.overageEnabled ? (
              <Text
                {...typeCap("label")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("label"),
                  fontFamily: FONT.regular,
                  marginTop: 4,
                }}
              >
                {`${num(headroom)} extra sends left before the ceiling stops them.`}
              </Text>
            ) : null}

            {mayAct ? (
              <View style={{ marginTop: 12, gap: 8 }}>
                <SettingsSwitchRow
                  label="Allow sending past the plan cap"
                  hint="Off means sends stop at the cap instead of billing as overage."
                  value={addon.overageEnabled}
                  onValueChange={(next) => void onToggle(next)}
                  disabled={save.isPending}
                />
                <SettingsTextInput
                  label="Ceiling on extra sends"
                  hint="Leave blank for no ceiling. Zero allows no overage at all."
                  value={capValue}
                  onChangeText={setCapDraft}
                  keyboardType="number-pad"
                  returnKeyType="done"
                  onSubmitEditing={() => void onSaveCap()}
                  placeholder="No ceiling"
                  editable={!save.isPending}
                />
                {capDraft !== null ? (
                  <Pressable
                    onPress={() => void onSaveCap()}
                    disabled={save.isPending}
                    accessibilityRole="button"
                    accessibilityLabel="Save the ceiling on extra sends"
                    accessibilityState={{ disabled: save.isPending }}
                    style={{ minHeight: 44, justifyContent: "center" }}
                  >
                    <Text
                      {...typeCap("control")}
                      style={{
                        color: save.isPending ? t.fgSubtle : t.accent,
                        ...typeStyle("control"),
                        fontFamily: FONT.semibold,
                      }}
                    >
                      Save ceiling
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </>
        ) : null}

        <View
          // THE GATE CODE LIVES HERE, NOT IN THE SENTENCE. The copy used to
          // read "…are unavailable (sms_financial_ledger_release_held)", which
          // prints an internal server identifier at an operator who cannot act
          // on it and did not ask for it. The sentence itself is honest and
          // stays word for word; only the parenthesis is gone. The code is
          // still worth having for support, so it hangs off the notice as a
          // testID — machine-readable, never spoken, never read.
          testID={`spend-controls-hold-${SMS_FINANCIAL_LEDGER_RELEASE_HELD_CODE}`}
          style={{
            marginTop: 14,
            borderTopColor: t.borderSubtle,
            borderTopWidth: 1,
            paddingTop: 10,
          }}
        >
          <Text
            {...typeCap("caption")}
            style={{
              color: t.warning,
              ...typeStyle("caption"),
              fontFamily: FONT.semibold,
            }}
          >
            SMS financial ledger release-held
          </Text>
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgMuted,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
              marginTop: 4,
            }}
          >
            Balance, usage, purchased credits, and entitlement are unavailable.
            No SMS wallet request was made.
          </Text>
        </View>
      </Card>
    </View>
  );
}
