/**
 * DoubleOptinQueueCard — the pending double opt-in review queue, with the two
 * verbs a stuck confirmation actually needs from a phone: extend the window
 * (a subscriber phoned support, the mail expired) and cancel the row.
 *
 * THE VERB IS "EXTEND", NOT "RESEND" — the endpoint verifiably moves
 * `sent_at`/`expires_at`; the mail itself is the consent worker's job.
 * Desktop's DoubleOptinPendingTable records the same doctrine and this card
 * repeats it out loud (DOUBLE_OPTIN_EXTEND_COPY).
 *
 * CANCEL IS THE DESTRUCTIVE HALF: it hard-deletes the row, so it goes through
 * the ConfirmSheet in the danger colour. Both writes are ONLINE-ONLY — a
 * consent action replayed from an outbox after the subscriber confirmed would
 * delete a confirmation that now exists.
 *
 * NativeWind v4: static style objects only.
 */
import { Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { useComplianceCardStyle } from "@/components/compliance/complianceEvidenceStyle";
import {
  useCancelDoubleOptin,
  useExtendDoubleOptin,
} from "@/hooks/usePrivacyPortalOps";
import {
  DOUBLE_OPTIN_CANCEL_COPY,
  DOUBLE_OPTIN_EXTEND_COPY,
  doubleOptinExpiryLabel,
  type PendingDoubleOptin,
} from "@/lib/privacyPortalOps";
import { dateTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { Pressable } from "react-native";

/** Rows rendered; the query asks for 50. */
const RENDER_CAP = 8;

export function DoubleOptinQueueCard({
  rows,
  truncated,
  now,
}: {
  rows: readonly PendingDoubleOptin[];
  /** True when the server has more rows than the fetched page. */
  truncated: boolean;
  now: number;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const styles = useComplianceCardStyle();
  const extend = useExtendDoubleOptin();
  const cancel = useCancelDoubleOptin();
  const busy = extend.isPending || cancel.isPending;
  const hidden = Math.max(0, rows.length - RENDER_CAP);

  const failToast = (err: unknown, fallback: string) =>
    toast({
      kind: "error",
      message:
        (err as { status?: number }).status === 403
          ? "Only an owner or admin can act on pending opt-ins."
          : (err as { status?: number }).status === 404
            ? "That row is gone — it was confirmed or removed elsewhere. The queue has been refreshed."
            : (err as Error).message || fallback,
    });

  const onExtend = async (row: PendingDoubleOptin) => {
    const confirmed = await confirm({
      title: `Extend the window for ${row.email}?`,
      message: DOUBLE_OPTIN_EXTEND_COPY,
      confirmLabel: "Extend window",
    });
    if (!confirmed) return;
    haptics.tap();
    extend.mutate(row.id, {
      onSuccess: () =>
        toast({
          kind: "success",
          message: `Confirmation window extended for ${row.email}.`,
        }),
      onError: (err) => failToast(err, "The window could not be extended."),
    });
  };

  const onCancel = async (row: PendingDoubleOptin) => {
    const confirmed = await confirm({
      title: `Cancel the pending opt-in for ${row.email}?`,
      message: DOUBLE_OPTIN_CANCEL_COPY,
      confirmLabel: "Cancel opt-in",
      destructive: true,
    });
    if (!confirmed) return;
    haptics.tap();
    cancel.mutate(row.id, {
      onSuccess: () =>
        toast({
          kind: "success",
          message: `Pending opt-in for ${row.email} cancelled.`,
        }),
      onError: (err) => failToast(err, "The pending row could not be removed."),
    });
  };

  if (rows.length === 0) {
    return (
      <Text {...typeCap("caption")} style={styles.note}>
        No double opt-ins are waiting on confirmation.
      </Text>
    );
  }

  return (
    <View>
      {rows.slice(0, RENDER_CAP).map((row) => (
        <View
          key={row.id}
          style={styles.card}
          accessible
          accessibilityLabel={`Pending opt-in for ${row.email}, ${doubleOptinExpiryLabel(row.expiresAt, now)}`}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.medium,
            }}
          >
            {row.email}
          </Text>
          <Text {...typeCap("caption")} style={styles.note}>
            {`sent ${dateTime(row.sentAt)} · ${doubleOptinExpiryLabel(row.expiresAt, now)}`}
          </Text>
          <View style={{ flexDirection: "row", gap: 16, marginTop: 6 }}>
            <RowAction
              label="Extend window"
              accessibilityLabel={`Extend the confirmation window for ${row.email}`}
              disabled={busy}
              color={t.accent}
              onPress={() => void onExtend(row)}
            />
            <RowAction
              label="Cancel"
              accessibilityLabel={`Cancel the pending opt-in for ${row.email}`}
              disabled={busy}
              color={t.danger}
              onPress={() => void onCancel(row)}
            />
          </View>
        </View>
      ))}
      {hidden > 0 || truncated ? (
        <Text {...typeCap("caption")} style={styles.note}>
          {truncated
            ? "More pending rows exist than this page shows — the full queue is on the web admin."
            : `+${hidden} more pending row${hidden === 1 ? "" : "s"} not shown.`}
        </Text>
      ) : null}
    </View>
  );
}

function RowAction({
  label,
  accessibilityLabel,
  disabled,
  color,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  disabled: boolean;
  color: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      style={{ paddingVertical: 4 }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.medium,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
