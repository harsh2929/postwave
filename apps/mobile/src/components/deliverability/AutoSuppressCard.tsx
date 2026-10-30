/**
 * AutoSuppressCard — the automatic sibling of the manual "suppress a listed
 * IP" verb on ReputationResponseCard.
 *
 * The policy: when a monitored blocklist lists one of this workspace's
 * sending identities, pause that identity automatically. Viewer-readable
 * (GET), admin-flippable (PATCH). The confirm names the immediate blast
 * radius — `eligible_now` identities would be suppressed the moment the
 * policy turns on.
 *
 * ONLINE-ONLY WRITE: a queued policy flip lands on a blocklist state the
 * operator has stopped watching.
 */
import { useConfirm } from "@/components/ConfirmSheet";
import {
  OpsAction,
  OpsCard,
  OpsCardBody,
  OpsCardTitle,
} from "@/components/deliverability/OpsCard";
import { Pill } from "@/components/Pill";
import { useToast } from "@/components/Toast";
import {
  useAutoSuppress,
  useSetAutoSuppress,
} from "@/hooks/useDeliverabilityRecovery";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isAdminRole } from "@/lib/campaignAccess";
import { errorPresentation } from "@/lib/errorCopy";
import { plural } from "@/lib/format";
import { haptics } from "@/lib/haptics";

export function AutoSuppressCard() {
  const gate = useOnlineQueryGate();
  const confirm = useConfirm();
  const { toast } = useToast();
  const query = useAutoSuppress();
  const set = useSetAutoSuppress();

  const admin = isAdminRole(gate.effectiveRole);
  const offline = !gate.enabled;
  const state = query.data;

  const onFlip = async (enabled: boolean) => {
    haptics.tap();
    const ok = await confirm({
      title: enabled
        ? "Auto-suppress listed identities?"
        : "Turn off auto-suppress?",
      message: enabled
        ? "When a monitored blocklist lists a sending identity, Moosewave will pause it automatically until it is delisted."
        : "Newly listed identities will keep sending until someone suppresses them by hand.",
      ...(enabled && state && state.eligibleNow > 0
        ? {
            consequence: `${plural(state.eligibleNow, "currently listed identity", "currently listed identities")} would be suppressed immediately.`,
          }
        : {}),
      confirmLabel: enabled ? "Turn on" : "Turn off",
      destructive: !enabled,
    });
    if (!ok) return;
    set.mutate(enabled, {
      onSuccess: () =>
        toast({
          kind: "success",
          message: enabled
            ? "Listed identities now pause automatically."
            : "Auto-suppress is off — listings need a manual response again.",
        }),
      onError: (err) => {
        haptics.error();
        toast({
          kind: "error",
          message:
            errorPresentation(err).message ||
            "Couldn't change the auto-suppress policy.",
        });
      },
    });
  };

  const body = offline
    ? "The auto-suppress policy can't be read offline."
    : query.isError
      ? "The auto-suppress policy couldn't be loaded — its real state is unknown."
      : !state
        ? "Loading the auto-suppress policy…"
        : state.autoSuppress
          ? `Listed identities pause automatically. ${plural(state.activeSuppressions, "suppression")} active now.`
          : `Off — a new listing keeps sending until someone acts. ${plural(state.eligibleNow, "identity", "identities")} currently eligible.`;

  return (
    <OpsCard>
      <OpsCardTitle>Blocklist auto-suppress</OpsCardTitle>
      {state && !offline && !query.isError ? (
        <Pill
          label={state.autoSuppress ? "on" : "off"}
          tone={state.autoSuppress ? "success" : "neutral"}
        />
      ) : null}
      <OpsCardBody {...(query.isError ? { role: "alert" as const } : {})}>
        {body}
      </OpsCardBody>
      {admin && !offline && state && !query.isError ? (
        <OpsAction
          label={
            set.isPending
              ? "Saving…"
              : state.autoSuppress
                ? "Turn off auto-suppress"
                : "Turn on auto-suppress"
          }
          onPress={() => void onFlip(!state.autoSuppress)}
          disabled={set.isPending}
          destructive={state.autoSuppress}
        />
      ) : null}
    </OpsCard>
  );
}
