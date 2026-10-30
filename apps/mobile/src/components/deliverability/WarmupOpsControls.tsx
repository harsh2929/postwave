/**
 * WarmupOpsControls — the missing bookends of the warm-up card: start a ramp,
 * remove a ramp. Mobile already lists / pauses / resumes (WarmupCard); no
 * client anywhere could create or delete until now — desktop has only unwired
 * api-client methods.
 *
 * Both verbs are ScopeAdmin and ONLINE-ONLY (the caller renders this only for
 * an online admin): a queued create starts a multi-week schedule at a moment
 * nobody chose, and a queued delete reports a ramp gone while it keeps
 * raising the daily allowance. Remove confirms with the domain's name —
 * deleting a ramp mid-flight returns the domain to unthrottled full-volume
 * sending, which is the risky direction.
 */
import { useState } from "react";
import { View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import {
  OpsAction,
  OpsCardBody,
  OpsTextInput,
} from "@/components/deliverability/OpsCard";
import { useToast } from "@/components/Toast";
import {
  useCreateWarmupPlan,
  useDeleteWarmupPlan,
} from "@/hooks/useDeliverabilityWarmupOps";
import { errorPresentation } from "@/lib/errorCopy";
import { warmupDraftError } from "@/lib/deliverabilityOpsView";
import { haptics } from "@/lib/haptics";

export function WarmupOpsControls({
  selectedDomain,
  hasPlanForSelected,
}: {
  /** The domain the WarmupCard above is showing; "" when none. */
  selectedDomain: string;
  hasPlanForSelected: boolean;
}) {
  const confirm = useConfirm();
  const { toast } = useToast();
  const create = useCreateWarmupPlan();
  const remove = useDeleteWarmupPlan();

  const [adding, setAdding] = useState(false);
  const [domain, setDomain] = useState("");
  const [targetDaily, setTargetDaily] = useState("");
  const [days, setDays] = useState("");

  const draftError = warmupDraftError({ domain, targetDaily, days });

  const onCreate = () => {
    haptics.tap();
    create.mutate(
      {
        domain: domain.trim().toLowerCase(),
        targetDaily: Number(targetDaily.trim()),
        ...(days.trim() ? { days: Number(days.trim()) } : {}),
      },
      {
        onSuccess: (plan) => {
          setAdding(false);
          setDomain("");
          setTargetDaily("");
          setDays("");
          toast({
            kind: "success",
            message: `Warm-up started for ${plan.domain} — today's allowance appears above.`,
          });
        },
        onError: (err) => {
          haptics.error();
          toast({
            kind: "error",
            message:
              errorPresentation(err).message || "Couldn't start the warm-up plan.",
          });
        },
      },
    );
  };

  const onRemove = async () => {
    haptics.tap();
    const ok = await confirm({
      title: `Remove the ramp for ${selectedDomain}?`,
      message:
        "The domain returns to full-volume sending immediately — the schedule's protection ends with it. Starting over later begins a new ramp from day one.",
      confirmLabel: "Remove ramp",
      confirmPhrase: selectedDomain,
      destructive: true,
    });
    if (!ok) return;
    remove.mutate(selectedDomain, {
      onSuccess: () =>
        toast({
          kind: "success",
          message: `The warm-up ramp for ${selectedDomain} was removed.`,
        }),
      onError: (err) => {
        haptics.error();
        toast({
          kind: "error",
          message:
            errorPresentation(err).message || "Couldn't remove the warm-up plan.",
        });
      },
    });
  };

  return (
    <View style={{ gap: 8, marginBottom: 10 }}>
      {!adding ? (
        <View style={{ flexDirection: "row", gap: 16 }}>
          <OpsAction label="Start a ramp" onPress={() => setAdding(true)} />
          {hasPlanForSelected && selectedDomain ? (
            <OpsAction
              label={remove.isPending ? "Removing…" : "Remove this ramp"}
              onPress={() => void onRemove()}
              disabled={remove.isPending}
              destructive
              accessibilityLabel={`Remove the warm-up ramp for ${selectedDomain}`}
            />
          ) : null}
        </View>
      ) : (
        <>
          <OpsTextInput
            value={domain}
            onChangeText={setDomain}
            placeholder="Domain to warm up"
            accessibilityLabel="Domain to warm up"
            keyboardType="url"
          />
          <OpsTextInput
            value={targetDaily}
            onChangeText={setTargetDaily}
            placeholder="Target daily volume"
            accessibilityLabel="Target daily send volume"
            keyboardType="number-pad"
          />
          <OpsTextInput
            value={days}
            onChangeText={setDays}
            placeholder="Ramp length in days (optional)"
            accessibilityLabel="Ramp length in days"
            keyboardType="number-pad"
          />
          {draftError && (domain || targetDaily || days) ? (
            <OpsCardBody>{draftError}</OpsCardBody>
          ) : null}
          <View style={{ flexDirection: "row", gap: 16 }}>
            <OpsAction
              label={create.isPending ? "Starting…" : "Start warm-up"}
              onPress={onCreate}
              disabled={create.isPending || draftError !== null}
            />
            <OpsAction label="Cancel" onPress={() => setAdding(false)} />
          </View>
        </>
      )}
    </View>
  );
}
