/**
 * SmsSendersSection — mounts "stop sending from this number" with the reads
 * and writes it was built for.
 *
 * SmsSendersCard shipped with its transport (api/smsInbox.setSmsSenderPaused)
 * and its hook (useSmsSenderPaused) in the same checkpoint, and then nothing
 * ever composed the three: the card had a test, the hook had a route, and no
 * screen rendered either. This is the missing third piece.
 *
 * It follows SmsPolicyPanel's wiring for the sibling policy cards exactly:
 *  - "unavailable" is a STATED reason, never an implied none — a failed read
 *    says so instead of rendering an empty list that looks like zero senders;
 *  - a successful read must precede any write, because pausing a sender you
 *    have not actually seen is a guess;
 *  - one writer at a time, so a double tap cannot race two PATCHes.
 *
 * MOUNT POINT. SmsPolicyPanel on the SMS opt-outs screen, right after
 * QuietHoursCard, inside the panel's collapsed-by-default body, so the read
 * runs only while the panel is open. It takes the panel's single
 * `useSmsInboxAccess` value as a prop rather than reading it again, the way
 * SmsInboxList does. Not the inbox header: that region is fixed above the
 * conversation FlatList, and one row per sender would pin over the list.
 */
import { useCallback, useRef, useState } from "react";

import { SmsSendersCard, senderLabel } from "@/components/sms/SmsSendersCard";
import { useToast } from "@/components/Toast";
import type { SmsInboxAccess } from "@/hooks/smsInboxIdentity";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useSmsSenders } from "@/hooks/useSmsInbox";
import { useSmsSenderPaused } from "@/hooks/useSmsInboxTriage";
import type { SmsSenderProfile } from "@/lib/smsConversation";

/** Copy for a read that could not run. Mirrors SmsPolicyPanel's policyNotice. */
export function sendersUnavailableReason(input: {
  roleAllowed: boolean;
  denialReason: string | null;
  failed: boolean;
  offline: boolean;
}): string | null {
  if (!input.roleAllowed) {
    return (
      input.denialReason ??
      "Sender profiles are restricted to workspace owners and admins."
    );
  }
  if (!input.failed) return null;
  return input.offline
    ? "Sender profiles can't be read offline — pause state is live server state, so no copy is kept."
    : "Sender profiles couldn't be loaded, so this is not a statement that none exist.";
}

export function SmsSendersSection({ access }: { access: SmsInboxAccess }) {
  const gate = useOnlineQueryGate();
  const { toast } = useToast();
  const senders = useSmsSenders(access);
  const setPaused = useSmsSenderPaused(access);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const busyRef = useRef(false);

  const offline = !gate.enabled || !access.online;
  const unavailableReason = sendersUnavailableReason({
    roleAllowed: access.roleAllowed,
    denialReason: access.denialReason,
    // Offline the disabled read never runs (isLoading and isError both false),
    // which must not render as "none configured" — SmsPolicyPanel's rule.
    failed: senders.isError || offline,
    offline,
  });
  // The readiness gate: a write needs a CURRENT successful read behind it.
  const canEdit =
    access.roleAllowed &&
    access.canRequest &&
    !offline &&
    senders.isSuccess &&
    !senders.isFetching;

  const onToggle = useCallback(
    async (sender: SmsSenderProfile, paused: boolean) => {
      if (!canEdit) {
        toast({
          kind: "error",
          message:
            "Reload the current sender profiles before changing one. Stale state is orientation only.",
        });
        return;
      }
      if (busyRef.current) return;
      busyRef.current = true;
      setPendingId(sender.id);
      try {
        await setPaused.mutateAsync({ senderId: sender.id, paused });
        toast({
          kind: "success",
          message: paused
            ? `${senderLabel(sender)} paused. Nothing sends from it until resumed.`
            : `${senderLabel(sender)} resumed.`,
        });
      } catch (error) {
        toast({
          kind: "error",
          message:
            error instanceof Error && error.message
              ? error.message
              : `Couldn't ${paused ? "pause" : "resume"} ${senderLabel(sender)}.`,
        });
      } finally {
        busyRef.current = false;
        setPendingId(null);
      }
    },
    [canEdit, setPaused, toast],
  );

  return (
    <SmsSendersCard
      senders={Array.isArray(senders.data) ? senders.data : []}
      unavailableReason={unavailableReason}
      loading={senders.isLoading && !unavailableReason}
      canEdit={canEdit}
      pendingId={pendingId}
      onToggle={(sender, paused) => void onToggle(sender, paused)}
    />
  );
}
