/**
 * The milestone-reward fulfilment checklist — GET /api/v1/referrals/payouts,
 * and (for admin sessions, since the desktop-parity pass) the advance verbs.
 *
 * WHY THIS IS WORTH A CARD. Everything else on the Referrals screen answers
 * "what happened?". This one answers "what do I owe?": a payout row is a reward
 * a subscriber has EARNED and someone has to hand over. It is the only referral
 * read with an outstanding-work reading, so it leads with a status summary
 * ("2 pending · 5 paid") rather than a total.
 *
 * THE ADVANCE VERBS. PATCH /api/v1/referrals/payouts/{id} moves a reward
 * pending→approved→paid, FORWARD-ONLY (payouts.go: any other transition is a
 * 409, and there is no way back). lib/referralAdmin mirrors that table so a
 * row only ever offers verbs the server will accept, each behind a
 * ConfirmSheet that says the advance cannot be undone. ADMIN and ONLINE-ONLY:
 * this records fulfilment of something owed to a person, so it is never
 * queued and never rendered below the role floor — non-admin sessions see the
 * same read-only checklist as before, with the caption saying where the verbs
 * live.
 *
 * THE REFERRER IS A BARE UUID. The server sends no email on this row, so the
 * row is identified by its reward and milestone and carries the id only as a
 * truncated cross-reference an operator can search on elsewhere. It is labelled
 * "Referrer" so it is not mistaken for the payout's own id, and it is dropped
 * entirely when the server sent nothing rather than rendered as an empty cell.
 *
 * NativeWind v4: static style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { Pill, type PillTone } from "@/components/Pill";
import { useToast } from "@/components/Toast";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useAdvanceReferralPayout } from "@/hooks/useReferrals";
import { FONT } from "@/lib/fonts";
import { date, num, truncateMiddle } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import {
  payoutActionsFor,
  payoutAdvanceCopy,
  type PayoutAdvanceTarget,
} from "@/lib/referralAdmin";
import {
  payoutsSummaryLine,
  type ReferralPayout,
  type ReferralPayoutList,
} from "@/lib/referrals";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** How many rows a phone shows before deferring to the desktop ledger. */
const MAX_ROWS = 8;

/**
 * An unrecognised status keeps the neutral tone. Guessing — "it ends in -ed, it
 * is probably done" — would paint an unknown state green.
 */
function toneFor(status: string): PillTone {
  if (status === "paid") return "success";
  if (status === "approved") return "info";
  if (status === "pending") return "warning";
  return "neutral";
}

export interface ReferralPayoutsCardProps {
  payouts: ReferralPayoutList;
  /** Admin-and-up online session — the floor for the advance PATCH. */
  canAdmin?: boolean;
}

export function ReferralPayoutsCard({
  payouts,
  canAdmin = false,
}: ReferralPayoutsCardProps) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const online = useIsOnline();
  const advance = useAdvanceReferralPayout();

  // `payouts` can come out of the PERSISTED query cache, so its shape is only
  // as good as the parser in whichever build of the app wrote it. `.rows`
  // reaching `.slice` on an older envelope is a red screen on a card that,
  // at worst, has nothing to say.
  const rows = Array.isArray(payouts?.rows) ? payouts.rows : [];
  const shown = rows.slice(0, MAX_ROWS);
  const actionable = canAdmin && online;

  const onAdvance = async (
    row: ReferralPayout,
    target: PayoutAdvanceTarget,
  ) => {
    if (advance.isPending) return;
    const copy = payoutAdvanceCopy(target, row.rewardLabel);
    const ok = await confirm({
      title: copy.confirmTitle,
      message: copy.confirmMessage,
      confirmLabel: copy.label,
    });
    if (!ok) return;
    haptics.impact();
    try {
      await advance.mutateAsync({ id: row.id, status: target });
      haptics.success();
      toast({ kind: "success", message: copy.successMessage });
    } catch (error) {
      haptics.error();
      const status =
        error && typeof error === "object" && "status" in error
          ? (error as { status?: unknown }).status
          : undefined;
      toast({
        kind: "error",
        message:
          status === 409
            ? "This payout moved on another device — pull to refresh."
            : status === 403
              ? "Your role no longer allows advancing payouts."
              : error instanceof Error && error.message
                ? error.message
                : `${copy.label} failed. Please try again.`,
      });
    }
  };

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.border,
        borderWidth: 1,
        borderRadius: 12,
        marginHorizontal: 16,
        marginTop: 12,
        paddingHorizontal: 14,
        paddingVertical: 12,
      }}
    >
      <Text
        {...typeCap("label")}
        accessibilityRole="header"
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.semibold,
        }}
      >
        Reward fulfilment
      </Text>
      <Text
        {...typeCap("body")}
        style={{
          color: t.fg,
          ...typeStyle("body"),
          marginTop: 4,
          fontFamily: FONT.regular,
        }}
      >
        {payoutsSummaryLine(payouts)}
      </Text>

      {shown.map((row) => (
        <PayoutRow
          key={row.id}
          row={row}
          actions={actionable ? payoutActionsFor(row.status) : []}
          busy={advance.isPending}
          onAdvance={(target) => void onAdvance(row, target)}
        />
      ))}

      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          marginTop: 10,
          fontFamily: FONT.regular,
        }}
      >
        {[
          rows.length > shown.length
            ? `${rows.length - shown.length} more in the full ledger.`
            : "",
          canAdmin
            ? online
              ? "Advancing a payout is permanent — approve, then mark paid once the reward is handed over."
              : "Advancing payouts needs a connection; it is never queued."
            : "Rewards are marked approved or paid by an owner or admin — here, or in the web or desktop app.",
        ]
          .filter(Boolean)
          .join(" ")}
      </Text>
    </View>
  );
}

function PayoutRow({
  row,
  actions,
  busy,
  onAdvance,
}: {
  row: ReferralPayout;
  actions: readonly PayoutAdvanceTarget[];
  busy: boolean;
  onAdvance: (target: PayoutAdvanceTarget) => void;
}) {
  const { t } = useTheme();
  const milestone =
    row.milestone === null ? "" : `Milestone ${num(row.milestone)}`;
  const when = row.createdAt ? date(row.createdAt) : "";
  const meta = [milestone, when].filter(Boolean).join(" · ");
  return (
    <View style={{ marginTop: 10, gap: 4 }}>
      <View
        accessible
        accessibilityLabel={[
          row.rewardLabel,
          milestone,
          when ? `earned ${when}` : "",
          row.status,
        ]
          .filter(Boolean)
          .join(", ")}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
        }}
      >
        <View style={{ flexShrink: 1, flexGrow: 1 }}>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            {row.rewardLabel}
          </Text>
          {meta ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              {meta}
            </Text>
          ) : null}
          {row.referrerId ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              {`Referrer ${truncateMiddle(row.referrerId, 13)}`}
            </Text>
          ) : null}
        </View>
        <Pill label={row.status} tone={toneFor(row.status)} />
      </View>
      {actions.length > 0 ? (
        <View style={{ flexDirection: "row", gap: 16 }}>
          {actions.map((target) => (
            <Pressable
              key={target}
              onPress={() => onAdvance(target)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={`${payoutAdvanceCopy(target, row.rewardLabel).label}: ${row.rewardLabel}`}
              accessibilityState={{ disabled: busy }}
              style={{ minHeight: 44, justifyContent: "center" }}
            >
              <Text
                {...typeCap("control")}
                style={{
                  color: busy ? t.fgSubtle : t.accent,
                  ...typeStyle("control"),
                  fontFamily: FONT.semibold,
                }}
              >
                {payoutAdvanceCopy(target, row.rewardLabel).label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}
