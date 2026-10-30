/**
 * SoftBounceRecoveryCard — recovered-soft-bounce outcomes plus the run-now
 * verb.
 *
 * The stats are honest about what recovery IS today: the worker expires
 * transient soft-bounce suppressions whose latest bounce is old and still
 * soft — it never reactivates disabled subscribers. The server pins the old
 * `recovered` field to zero for exactly that reason, and this card reports
 * `expired_suppressions`, the number that actually moved.
 *
 * Run-now is admin-scoped and ONLINE-ONLY, no retry: a retried pass is a
 * second pass.
 */
import { useConfirm } from "@/components/ConfirmSheet";
import {
  OpsAction,
  OpsCard,
  OpsCardBody,
  OpsCardTitle,
} from "@/components/deliverability/OpsCard";
import { useToast } from "@/components/Toast";
import {
  useRunSoftBounceRecovery,
  useSoftBounceStats,
} from "@/hooks/useDeliverabilityRecovery";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isAdminRole } from "@/lib/campaignAccess";
import { errorPresentation } from "@/lib/errorCopy";
import { num, plural } from "@/lib/format";
import { haptics } from "@/lib/haptics";

export function SoftBounceRecoveryCard() {
  const gate = useOnlineQueryGate();
  const confirm = useConfirm();
  const { toast } = useToast();
  const stats = useSoftBounceStats();
  const run = useRunSoftBounceRecovery();

  const admin = isAdminRole(gate.effectiveRole);
  const offline = !gate.enabled;
  const data = stats.data;

  const onRun = async () => {
    haptics.tap();
    const ok = await confirm({
      title: "Run soft-bounce recovery now?",
      message:
        "Expires transient soft-bounce suppressions whose latest bounce is old and still soft, so those addresses become mailable again. Subscriber statuses are never changed.",
      ...(data && data.eligibleSuppressionsNow > 0
        ? {
            consequence: `${plural(data.eligibleSuppressionsNow, "suppression")} would be lifted now.`,
          }
        : {}),
      confirmLabel: "Run recovery",
    });
    if (!ok) return;
    run.mutate(undefined, {
      onSuccess: (result) =>
        toast({
          kind: "success",
          message:
            result.expiredSuppressions === 0
              ? "Recovery ran — nothing was eligible to lift."
              : `Recovery lifted ${plural(result.expiredSuppressions, "expired suppression")}.`,
        }),
      onError: (err) => {
        haptics.error();
        toast({
          kind: "error",
          message:
            errorPresentation(err).message || "Couldn't run the recovery pass.",
        });
      },
    });
  };

  const body = offline
    ? "Soft-bounce recovery can't be read offline."
    : stats.isError
      ? "Recovery stats couldn't be loaded — eligibility is unknown."
      : !data
        ? "Loading soft-bounce recovery stats…"
        : `${num(data.eligibleSuppressionsNow)} suppression${data.eligibleSuppressionsNow === 1 ? "" : "s"} eligible to lift now · ${num(data.disabledCount)} disabled subscribers (never auto-reactivated) · ${num(data.recoveryWindowDays)}-day window.`;

  return (
    <OpsCard>
      <OpsCardTitle>Soft-bounce recovery</OpsCardTitle>
      <OpsCardBody {...(stats.isError ? { role: "alert" as const } : {})}>
        {body}
      </OpsCardBody>
      {admin && !offline && data && !stats.isError ? (
        <OpsAction
          label={run.isPending ? "Running…" : "Run recovery now"}
          onPress={() => void onRun()}
          disabled={run.isPending}
        />
      ) : null}
    </OpsCard>
  );
}
