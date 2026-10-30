/**
 * SubscriberSuppressionCard — "will this address actually receive mail?"
 *
 * The profile shipped a Suppress button and a whole Suppressions screen but
 * never said whether THIS person was already suppressed, why, or when. Its
 * only signal was `status === "blocklisted"`, which reads the subscribers
 * row — a different table from deliverability suppressions. A hard bounce
 * recorded by the bounce webhook suppresses an address without touching
 * that status, so the profile could show "Subscribed" for someone the
 * sender will never mail again.
 *
 * Deliberate behaviour: removing the suppression removes ONLY the
 * deliverability hold. It does not flip the subscriber's status back to
 * enabled. Those are different facts — a hard-bounce hold is a delivery
 * decision, `blocklisted` is a consent decision — and silently restoring
 * consent because someone cleared a bounce would be the worse bug. The
 * toast says so when a residual status remains.
 *
 * The card renders only when there is something to say: a real suppression,
 * or a failed lookup (which is reported, never rendered as "clean").
 */
import { Text, View } from "react-native";

import { useToast } from "@/components/Toast";
import { Pill } from "@/components/Pill";
import {
  Card,
  Label,
} from "@/components/subscriber/SubscriberDetailPrimitives";
import { SubActionButton } from "@/components/subscriber/SubActionButton";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useSubscriberSuppression } from "@/hooks/useSubscriberSuppression";
import { useUnsuppressSubscriber } from "@/hooks/useSubscribers";
import { FONT } from "@/lib/fonts";
import { dateTime, relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { suppressionSpokenSummary } from "@/lib/subscriberSuppression";
import { uiStatusToEngine } from "@/lib/subscriberStatus";
import { reasonLabel, reasonTone } from "@/lib/suppressionSearch";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

export function SubscriberSuppressionCard({
  subscriberId,
  email,
  currentStatus,
  canMutate,
  disabledReason,
}: {
  subscriberId: string;
  email: string | undefined;
  /** Engine/UI status as currently displayed, for the residual-state note. */
  currentStatus: string | undefined;
  canMutate: boolean;
  disabledReason?: string | undefined;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const gate = useOnlineQueryGate();
  const authMode = useAuthStore((s) => s.mode);
  const suppression = useSubscriberSuppression(email);
  const unsuppress = useUnsuppressSubscriber();

  // DELETE /api/v1/deliverability/suppressions/{email} is ADMIN in the
  // route-auth manifest, while POST .../suppress is only editor. Reusing
  // the profile's editor-level `canMutate` here would offer an editor a
  // button that is a guaranteed 403 after a destructive-looking press.
  const hasAdminRole = canAccessMinimumRole(
    "admin",
    gate.effectiveRole,
    authMode,
  );
  const canRemove = canMutate && hasAdminRole;
  const removeBlockedReason = !canMutate
    ? disabledReason
    : !hasAdminRole
      ? "Removing a suppression is an admin action."
      : undefined;

  if (suppression.isError) {
    return (
      <Card style={{ marginTop: 12 }}>
        <Label>Deliverability</Label>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          Couldn&apos;t check the suppression list, so this profile can&apos;t
          confirm whether mail is being held.
        </Text>
      </Card>
    );
  }

  const row = suppression.data;
  if (!row) return null;

  const reasonText = reasonLabel(row.reason);
  const since = relativeTime(row.createdAt, { fallback: "" });
  const exactWhen = dateTime(row.createdAt, "");

  function onRemove() {
    if (!canRemove || !email || !row) return;
    haptics.warning();
    unsuppress.mutate(
      // No `restoreStatus`: clearing a delivery hold must not silently
      // restore consent. See the module comment.
      { id: subscriberId, email },
      {
        onSuccess: () => {
          haptics.success();
          const stillBlocked =
            uiStatusToEngine(currentStatus) === "blocklisted";
          toast({
            kind: "success",
            message: stillBlocked
              ? "Suppression removed. This contact is still unsubscribed."
              : "Suppression removed. Mail can be delivered again.",
          });
        },
        onError: (e: unknown) => {
          haptics.error();
          toast({
            kind: "error",
            message: `Couldn't remove the suppression. ${e instanceof Error ? e.message : ""}`.trim(),
          });
        },
      },
    );
  }

  return (
    <Card style={{ marginTop: 12, borderColor: t.danger }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Label>Suppressed</Label>
        <Pill label={reasonText} tone={reasonTone(row.reason)} />
      </View>

      <Text
        // One spoken sentence carrying reason + date, so the state does not
        // depend on reading a coloured pill next to a relative timestamp.
        accessibilityLabel={suppressionSpokenSummary(reasonText, since)}
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          marginTop: 8,
          fontFamily: FONT.regular,
        }}
      >
        Mail to this address is being held. Campaigns and sequences will skip
        it until the suppression is removed.
      </Text>

      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          marginTop: 4,
          fontFamily: FONT.regular,
        }}
      >
        {since ? `Added ${since}${exactWhen ? ` · ${exactWhen}` : ""}` : "Date unknown"}
      </Text>

      <View style={{ flexDirection: "row", marginTop: 12 }}>
        <SubActionButton
          label={unsuppress.isPending ? "Removing…" : "Remove suppression"}
          onPress={onRemove}
          danger
          disabled={!canRemove}
          busy={unsuppress.isPending}
          {...(!canRemove && removeBlockedReason
            ? { disabledReason: removeBlockedReason }
            : {})}
          t={t}
        />
      </View>
    </Card>
  );
}
