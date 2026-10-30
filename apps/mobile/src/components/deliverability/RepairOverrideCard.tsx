/**
 * RepairOverrideCard — release an active auto-throttle.
 *
 * When the hub says `autoThrottled`, a background repair action has ALREADY
 * lowered this workspace's hourly send cap. Mobile rendered that fact
 * read-only, which meant the one screen an operator opens at 2am could name
 * the throttle but not release it — the exact verb the screen exists for.
 *
 * Desktop's ScoreCard semantics, kept precisely:
 *  - exact tenant owner/admin only (POST …/repair-override uses
 *    RequireExactTenantAdmin) — every broader alias or delegated role sees an
 *    explanation instead of an unusable control;
 *  - typed confirm ("RESTORE SENDING"): the release changes live sending
 *    capacity and does not repair the underlying signals, and the confirm
 *    body says exactly that;
 *  - the server must CONFIRM the restoration; a route-exact 404 reconciles a
 *    stale view, 409 keeps the server refusal, and result-bearing 503s become
 *    either "committed but fenced" or a held unknown outcome. The hub is
 *    refetched on every settle because each means our local state is stale.
 *
 * ONLINE-ONLY, NEVER QUEUED: a queued release re-opens capacity at a moment
 * nobody chose.
 */
import { useState } from "react";
import { Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import {
  OpsAction,
  OpsCardBody,
  OpsCardTitle,
} from "@/components/deliverability/OpsCard";
import { useToast } from "@/components/Toast";
import { useClearRepairOverride } from "@/hooks/useDeliverabilityHubOps";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isExactTenantAdminRole } from "@/lib/campaignAccess";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface RepairOverrideCardProps {
  hub:
    | { autoThrottled: boolean; autoThrottleReason: string }
    | null
    | undefined;
}

type HeldRepairOutcome =
  | "committed"
  | "committed-conservatively-fenced"
  | "commit-outcome-unknown"
  | "outcome-unknown";

export function RepairOverrideCard({ hub }: RepairOverrideCardProps) {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const confirm = useConfirm();
  const { toast } = useToast();
  const clear = useClearRepairOverride();
  const [heldOutcome, setHeldOutcome] = useState<{
    kind: HeldRepairOutcome;
    message: string;
  } | null>(null);

  if (!hub?.autoThrottled) return null;
  const admin = isExactTenantAdminRole(gate.effectiveRole);
  const online = gate.enabled;

  const onRelease = async () => {
    haptics.tap();
    const ok = await confirm({
      title: "Restore the recorded send cap?",
      message:
        "This changes live sending capacity; it does not repair the underlying bounce, complaint, DNS, or blocklist signals. A later worker evaluation can throttle again if the low-score condition is met.",
      confirmLabel: "Restore recorded cap",
      confirmPhrase: "RESTORE SENDING",
      destructive: true,
    });
    if (!ok) return;
    clear.mutate(undefined, {
      onSuccess: (outcome) => {
        if (outcome.kind === "committed") {
          setHeldOutcome({
            kind: "committed",
            message:
              "The clear committed. Load fresh repair state before another restoration review.",
          });
          toast({
            kind: "success",
            message:
              "Repair override clear committed. Verifying the recorded sending state.",
          });
          return;
        }
        if (outcome.kind === "nothing-to-clear") {
          setHeldOutcome(null);
          toast({
            kind: "info",
            message:
              "No active repair override remained. Refreshing current sending state.",
          });
          return;
        }
        if (outcome.kind === "committed-conservatively-fenced") {
          setHeldOutcome({ kind: outcome.kind, message: outcome.message });
          toast({
            kind: "warning",
            message:
              "Override cleared, but sending remains conservatively fenced while shared cap authority converges. The clear was not repeated.",
            durationMs: 10_000,
          });
          return;
        }

        setHeldOutcome({ kind: outcome.kind, message: outcome.message });
        haptics.error();
        toast({
          kind: "warning",
          message:
            "The clear outcome could not be proven. Sending remains conservatively fenced; verify current state before any new attempt.",
          durationMs: 10_000,
        });
      },
      onError: (err) => {
        haptics.error();
        toast({
          kind: "error",
          message:
            errorPresentation(err).message ||
            "Couldn't clear the repair override.",
        });
      },
    });
  };

  const onVerifyCurrentState = async () => {
    haptics.tap();
    try {
      await clear.reconcile();
      setHeldOutcome(null);
      toast({
        kind: "info",
        message:
          "Fresh repair state loaded. Review the current throttle before deciding whether another restoration is needed.",
      });
    } catch (err) {
      haptics.error();
      toast({
        kind: "error",
        message:
          errorPresentation(err).message ||
          "Couldn't verify the current repair state.",
      });
    }
  };

  return (
    <View
      accessibilityRole="alert"
      style={{
        backgroundColor: t.surface,
        borderColor: t.danger,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 10,
        gap: 8,
      }}
    >
      <OpsCardTitle>Repair active</OpsCardTitle>
      <Text
        {...typeCap("body")}
        style={{
          color: t.fg,
          ...typeStyle("body"),
          fontFamily: FONT.semibold,
        }}
      >
        A recorded reputation repair lowered this workspace’s hourly send cap.
      </Text>
      <OpsCardBody>
        {hub.autoThrottleReason.trim()
          ? `Server reason: ${hub.autoThrottleReason.trim()}`
          : "New sends use the recorded cap until an admin clears this override."}
      </OpsCardBody>
      {heldOutcome ? (
        <View
          accessibilityRole="alert"
          style={{
            borderColor: t.warning,
            borderWidth: 1,
            borderRadius: 10,
            padding: 10,
            gap: 6,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontFamily: FONT.semibold,
            }}
          >
            {heldOutcome.kind === "committed-conservatively-fenced"
              ? "Override cleared; cap convergence is pending"
              : heldOutcome.kind === "committed"
                ? "Override clear committed; verification pending"
                : "Restoration outcome needs verification"}
          </Text>
          <OpsCardBody>
            {`${heldOutcome.message} The original POST is held and will not be repeated automatically.`}
          </OpsCardBody>
        </View>
      ) : null}
      {!admin ? (
        <OpsCardBody>
          Releasing the recorded cap is a workspace-admin action.
        </OpsCardBody>
      ) : !online ? (
        <OpsCardBody>
          Releasing the cap needs a connection — it changes live sending
          capacity and is never queued.
        </OpsCardBody>
      ) : heldOutcome ? (
        <OpsAction
          label={clear.isPending ? "Checking…" : "Verify current repair state"}
          onPress={() => void onVerifyCurrentState()}
          disabled={clear.isPending}
          accessibilityLabel="Verify current repair state without repeating the restoration"
        />
      ) : (
        <OpsAction
          label={clear.isPending ? "Restoring…" : "Review cap restoration"}
          onPress={() => void onRelease()}
          disabled={clear.isPending}
          destructive
          accessibilityLabel="Review restoring the recorded send cap"
        />
      )}
    </View>
  );
}
