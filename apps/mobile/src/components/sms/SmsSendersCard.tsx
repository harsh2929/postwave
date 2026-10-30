/**
 * SmsSendersCard — "stop sending from this number", from a phone.
 *
 * Mobile has read `GET /api/v1/sms/senders` since the inbox shipped (it is how
 * the reply composer decides which profile a reply may go out from) but had no
 * transport for `POST /api/v1/sms/senders/{id}/pause` or `.../resume`, which
 * are mounted right beside it at apps/api/internal/sms/handlers.go:152-153
 * behind the same `ScopeAdmin` the other writes on this screen already require.
 * Neither route is release-held — the SMS holds are dispatch, A2P registration
 * and provider-callback codes, and `setSenderPaused` (handlers.go:527-544)
 * carries no readiness guard.
 *
 * IT BELONGS NEXT TO QUIET HOURS. This is the same question the panel above it
 * answers — "what happens when we text this number, and when it texts us" — and
 * pausing a sender is `stoppingHalfPolicy`'s central example: urgent, safe when
 * wrong (you have removed sending authority, not granted it), and needed
 * exactly when nobody is at a desk. It is also visible immediately inside this
 * app: `isEligibleSmsSender` refuses to compose a reply from a paused sender.
 *
 * A FAILED READ NEVER RENDERS AS "no senders". Same rule as its siblings — the
 * reassuring answer must never be the one produced by a dead request.
 */
import { Switch, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import type { SmsSenderProfile } from "@/lib/smsConversation";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** "+15555550123", or the profile shape when the number is not exposed. */
export function senderLabel(sender: SmsSenderProfile): string {
  const phone = sender.phoneNumber?.trim();
  if (phone) return phone;
  const type = sender.senderType.trim() || "sender";
  return `${type} · ${sender.country}`;
}

export interface SmsSendersCardProps {
  senders: readonly SmsSenderProfile[];
  /** Non-null when the read failed or could not run — never an implied "none". */
  unavailableReason: string | null;
  loading: boolean;
  canEdit: boolean;
  /** Id currently being written, so only that row's switch goes busy. */
  pendingId: string | null;
  onToggle: (sender: SmsSenderProfile, paused: boolean) => void;
}

export function SmsSendersCard({
  senders,
  unavailableReason,
  loading,
  canEdit,
  pendingId,
  onToggle,
}: SmsSendersCardProps) {
  const { t } = useTheme();
  const paused = senders.filter((sender) => sender.paused).length;
  const caption = unavailableReason
    ? unavailableReason
    : loading
      ? "Reading sender profiles…"
      : senders.length === 0
        ? "No sender profiles are configured, so nothing can send."
        : paused === 0
          ? `${plural(senders.length, "sender")} · none paused`
          : `${plural(senders.length, "sender")} · ${paused} paused`;

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 10,
        gap: 10,
      }}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.bold,
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}
      >
        Senders
      </Text>

      <Text
        accessibilityRole="summary"
        {...typeCap("bodySmall")}
        style={{
          color: unavailableReason ? t.fgMuted : t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {caption}
      </Text>

      {unavailableReason || loading
        ? null
        : senders.map((sender) => (
            <SenderRow
              key={sender.id}
              sender={sender}
              canEdit={canEdit}
              busy={pendingId === sender.id}
              onToggle={onToggle}
            />
          ))}
    </View>
  );
}

function SenderRow({
  sender,
  canEdit,
  busy,
  onToggle,
}: {
  sender: SmsSenderProfile;
  canEdit: boolean;
  busy: boolean;
  onToggle: (sender: SmsSenderProfile, paused: boolean) => void;
}) {
  const { t } = useTheme();
  const label = senderLabel(sender);
  return (
    <View
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        paddingTop: 10,
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
      }}
    >
      <View style={{ flex: 1, gap: 4 }}>
        <View
          accessible
          accessibilityLabel={`${label}. ${
            sender.paused ? "Paused — not sending" : "Not paused"
          }. Registration ${sender.registrationStatus}.`}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontFamily: FONT.semibold,
            }}
            numberOfLines={1}
          >
            {label}
          </Text>
          {sender.paused ? (
            <Pill label="Paused" tone="warning" />
          ) : (
            // Not "Sending": SMS dispatch is release-held server-side, so an
            // unpaused sender states its pause flag, never a live-send claim.
            <Pill label="Not paused" tone="neutral" />
          )}
        </View>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
          numberOfLines={2}
        >
          {`${sender.provider} · ${sender.country} · registration ${sender.registrationStatus}`}
        </Text>
      </View>
      {canEdit ? (
        // Same rule as QuietHoursCard: the pause/resume routes are ScopeAdmin,
        // so a viewer is shown the STATE and never a control whose only
        // possible outcome is a 403.
        <Switch
          value={!sender.paused}
          disabled={busy}
          onValueChange={(next) => onToggle(sender, !next)}
          accessibilityLabel={`Sending from ${label}`}
          accessibilityHint="Turning this off pauses outbound SMS from this sender"
        />
      ) : null}
    </View>
  );
}
