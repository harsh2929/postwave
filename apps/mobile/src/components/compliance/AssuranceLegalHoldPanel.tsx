/**
 * AssuranceLegalHoldPanel — preserve assurance evidence, and release it again.
 *
 * ASSURE#6 / VERB#8: the three routes are mounted
 * (assurancelegalholdapi/handlers.go:61-63, all `admin` + reviewed) and had NO
 * CLIENT ON ANY SURFACE. Placing a hold meant a direct API call; releasing one
 * meant knowing an id nobody could list.
 *
 * ── WHY A WRITE BELONGS ON A SCREEN THAT REFUSES WRITES ────────────────────
 * `app/(tabs)/compliance.tsx` states a rule: it is "A MONITOR, NOT AN ATTESTATION
 * CONSOLE", and it names the deciding test — "revoking a tracker row stops nothing
 * tonight, unlike the warehouse monitor's `pause`, which is why that surface
 * carries a write and this one does not."
 *
 * A legal hold passes that test rather than breaking the rule. Placing one STOPS
 * SOMETHING TONIGHT: it suspends the retention sweeps that would otherwise delete
 * assurance evidence, and evidence a sweep has taken cannot be recreated. It is
 * also unlike attestation in the other way the docstring cares about — it needs no
 * document hash, only a reason.
 *
 * The asymmetry in this panel is deliberate. PLACING is safe and reversible, so it
 * is one field and a button. RELEASING is the irreversible direction — it lets the
 * sweeps run — so it confirms, and the confirmation escalates its wording when the
 * hold is tenant-wide.
 */
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { Pill } from "@/components/Pill";
import { useToast } from "@/components/Toast";
import { settingsInputStyle } from "@/components/settings/FormControls";
import {
  useAssuranceLegalHolds,
  usePlaceAssuranceLegalHold,
  useReleaseAssuranceLegalHold,
} from "@/hooks/useAssuranceLegalHolds";
import {
  legalHoldErrorMessage,
  legalHoldReasonUsable,
  legalHoldReleaseCopy,
  legalHoldScopeSummary,
  type AssuranceLegalHold,
} from "@/lib/assuranceLegalHold";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { keyboardChain } from "@/lib/keyboardChain";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

function errorCode(err: unknown): string {
  return err && typeof err === "object" && "code" in err
    ? String((err as { code?: unknown }).code ?? "")
    : "";
}

export function AssuranceLegalHoldPanel() {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const holds = useAssuranceLegalHolds();
  const place = usePlaceAssuranceLegalHold();
  const release = useReleaseAssuranceLegalHold();
  const [reason, setReason] = useState("");

  // Below admin the query never runs, so there is nothing to show and no control
  // to offer — rather than a panel whose every button 403s.
  if (holds.data === undefined) return null;

  // Checked for `undefined` above and then mapped directly, which still
  // throws for any other non-array. A legal hold suspends erasure, so a crash
  // here hides a statutory obligation rather than merely a list.
  const rows = Array.isArray(holds.data) ? holds.data : [];
  const busy = place.isPending || release.isPending;
  const canPlace = legalHoldReasonUsable(reason) && !busy;

  const onPlace = () => {
    haptics.tap();
    place.mutate(
      { reason },
      {
        onSuccess: () => {
          setReason("");
          toast({
            kind: "success",
            message: "Legal hold placed. Assurance evidence is preserved.",
          });
        },
        onError: (err) =>
          toast({
            kind: "error",
            message: legalHoldErrorMessage(
              errorCode(err),
              "Couldn't place the legal hold.",
            ),
          }),
      },
    );
  };

  const onRelease = async (hold: AssuranceLegalHold) => {
    haptics.tap();
    const copy = legalHoldReleaseCopy(hold);
    const ok = await confirm({
      title: copy.title,
      message: copy.body,
      confirmLabel: copy.confirmLabel,
      destructive: true,
    });
    if (!ok) return;
    release.mutate(
      { holdId: hold.id, reason: hold.reason || "released from mobile" },
      {
        onSuccess: () =>
          toast({ kind: "success", message: "Hold released." }),
        onError: (err) =>
          toast({
            kind: "error",
            message: legalHoldErrorMessage(
              errorCode(err),
              "Couldn't release the hold.",
            ),
          }),
      },
    );
  };

  return (
    <View style={{ gap: 10, marginTop: 16 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.semibold,
        }}
      >
        Assurance legal holds
      </Text>
      {rows.length === 0 ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          No holds. Assurance evidence is swept on the normal retention schedule.
        </Text>
      ) : null}
      {rows.map((hold) => (
        <View
          key={hold.id}
          style={{
            borderTopColor: t.borderSubtle,
            borderTopWidth: 1,
            paddingTop: 10,
            gap: 6,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Pill
              label={hold.scope === "tenant" ? "Workspace-wide" : "One campaign"}
              tone={hold.scope === "tenant" ? "warning" : "info"}
            />
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
                flexShrink: 1,
              }}
              numberOfLines={1}
            >
              {hold.placedAt}
            </Text>
          </View>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            {legalHoldScopeSummary(hold)}
          </Text>
          {hold.reason ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              {hold.reason}
            </Text>
          ) : null}
          <Pressable
            onPress={() => void onRelease(hold)}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={`Release this ${hold.scope === "tenant" ? "workspace-wide" : "campaign"} legal hold`}
            accessibilityState={{ disabled: busy }}
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: busy ? t.fgSubtle : t.danger,
                ...typeStyle("control"),
                fontFamily: FONT.semibold,
              }}
            >
              Release hold
            </Text>
          </Pressable>
        </View>
      ))}
      <TextInput
        {...typeCap("body")}
        {...keyboardChain({ onSubmit: onPlace })}
        value={reason}
        onChangeText={setReason}
        placeholder="Why is evidence being preserved?"
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel="Reason for placing a workspace-wide legal hold"
        style={settingsInputStyle(t)}
      />
      <Pressable
        onPress={onPlace}
        disabled={!canPlace}
        accessibilityRole="button"
        accessibilityLabel="Place a workspace-wide legal hold on assurance evidence"
        accessibilityState={{ disabled: !canPlace }}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text
          {...typeCap("control")}
          style={{
            color: canPlace ? t.accent : t.fgSubtle,
            ...typeStyle("control"),
            fontFamily: FONT.semibold,
          }}
        >
          {place.isPending ? "Placing…" : "Hold all assurance evidence"}
        </Text>
      </Pressable>
    </View>
  );
}
