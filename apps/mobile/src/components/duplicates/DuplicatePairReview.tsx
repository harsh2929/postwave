/**
 * DuplicatePairReview — one decision: which of these two people survives.
 *
 * WHY THE SURVIVOR IS A CHOICE AND NOT A LABEL. The scan nominates the OLDEST
 * row in each key cluster as `primary_id` (`first_value(...) OVER (... ORDER BY
 * subscriber_created_at, subscriber_id)`, scan.go:416) — a heuristic, not a
 * verdict. `merge/apply` explicitly accepts the pair in either direction and
 * says why in a comment: "the UI lets an operator choose which subscriber
 * survives" (apply.go:286-295). Presenting the server's suggestion as fixed
 * would hide a decision the API deliberately left open, so the control is here
 * and the suggestion is labelled as a suggestion.
 *
 * WHY THE MERGE BUTTON CAN BE ABSENT WHILE THE QUEUE IS READABLE. The reads
 * are viewer-level; `POST /api/v1/merge/apply` is owner/admin once routeauth
 * has had its say (see the header of `api/subscriberDuplicates.ts`). An editor
 * gets the whole queue and no button, and is told which permission is missing
 * rather than being handed a control that can only 403.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { QueryStates } from "@/components/QueryStates";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SkeletonList } from "@/components/Skeleton";
import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { DuplicateMergePlanCard } from "@/components/duplicates/DuplicateMergePlanCard";
import type { DuplicateMergeRequest } from "@/api/subscriberDuplicates";
import {
  useApplyDuplicateMerge,
  useDuplicateMergePlan,
} from "@/hooks/useSubscriberDuplicates";
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  mergeConfirmCopy,
  mergeErrorMessage,
  mergeSuccessMessage,
  planIsApplyable,
} from "@/lib/duplicateMergePlan";
import { reviewBlockedReason, type DuplicatePair } from "@/lib/duplicateScan";
import { truncateMiddle } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

type SurvivorSide = "primary" | "duplicate";

export interface DuplicatePairReviewProps {
  pair: DuplicatePair;
  scanId: string;
  /** Owner/admin — read off BOTH authorization layers by the caller. */
  canMerge: boolean;
  gate: Pick<OnlineQueryGate, "enabled">;
  /** The manifest itself has aged past `expires_at`. */
  scanExpired: boolean;
  onMerged: (pairKey: string) => void;
}

export function DuplicatePairReview({
  pair,
  scanId,
  canMerge,
  gate,
  scanExpired,
  onMerged,
}: DuplicatePairReviewProps) {
  const { t } = useTheme();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [side, setSide] = useState<SurvivorSide>("primary");
  const [busy, setBusy] = useState(false);

  const survivorIsPrimary = side === "primary";
  const survivorEmail = survivorIsPrimary ? pair.primaryEmail : pair.duplicateEmail;
  const loserEmail = survivorIsPrimary ? pair.duplicateEmail : pair.primaryEmail;
  const blocked = reviewBlockedReason(pair, scanExpired);

  const request = useMemo<DuplicateMergeRequest | null>(() => {
    if (blocked || !scanId) return null;
    return survivorIsPrimary
      ? {
          scanId,
          survivorId: pair.primaryId,
          loserId: pair.duplicateId,
          survivorUpdatedAt: pair.primaryUpdatedAt,
          loserUpdatedAt: pair.duplicateUpdatedAt,
        }
      : {
          scanId,
          survivorId: pair.duplicateId,
          loserId: pair.primaryId,
          survivorUpdatedAt: pair.duplicateUpdatedAt,
          loserUpdatedAt: pair.primaryUpdatedAt,
        };
  }, [blocked, scanId, survivorIsPrimary, pair]);

  const planQuery = useDuplicateMergePlan(request, canMerge);
  const apply = useApplyDuplicateMerge();
  const plan = planQuery.data ?? null;
  const applyable = planIsApplyable(plan);

  const onMerge = useCallback(async () => {
    if (!request || !plan || !applyable) return;
    const copy = mergeConfirmCopy({ survivorEmail, loserEmail, plan });
    const agreed = await confirm({
      title: copy.title,
      message: copy.message,
      consequence: copy.consequence,
      confirmLabel: copy.confirmLabel,
      destructive: true,
    });
    if (!agreed) return;
    setBusy(true);
    apply.mutate(
      { ...request, planFingerprint: plan.planFingerprint },
      {
        onSuccess: (result) => {
          haptics.success();
          toast({
            kind: "success",
            message: mergeSuccessMessage(survivorEmail, result ?? null),
          });
          setBusy(false);
          onMerged(`${pair.primaryId}:${pair.duplicateId}`);
        },
        onError: (error) => {
          haptics.error();
          toast({ kind: "error", message: mergeErrorMessage(error) });
          setBusy(false);
        },
      },
    );
  }, [
    apply,
    applyable,
    confirm,
    loserEmail,
    onMerged,
    pair.duplicateId,
    pair.primaryId,
    plan,
    request,
    survivorEmail,
    toast,
  ]);

  return (
    <View style={{ marginTop: 8 }}>
      <SegmentedControl<SurvivorSide>
        options={[
          {
            // Truncated in the MIDDLE, not the end: two addresses share one
            // 390pt row under `numberOfLines={1}`, and the tail of an email is
            // the domain — the part that tells them apart. The full address is
            // on the row directly above and in the spoken label here.
            value: "primary",
            label: truncateMiddle(pair.primaryEmail || "First record", 18),
            accessibilityLabel: `${pair.primaryEmail || "the first record"} survives — the scan's suggestion, because it is the older row`,
          },
          {
            value: "duplicate",
            label: truncateMiddle(pair.duplicateEmail || "Second record", 18),
            accessibilityLabel: `${pair.duplicateEmail || "the second record"} survives instead`,
          },
        ]}
        value={side}
        onChange={setSide}
        accessibilityLabel="Which record survives"
      />
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginTop: 6,
        }}
      >
        {survivorIsPrimary
          ? "The scan suggests this one because it is the older row. You can pick the other."
          : "You have overridden the scan's suggestion. The server accepts either direction."}
      </Text>

      {blocked ? (
        <Notice tone="warning" text={blocked} />
      ) : !canMerge ? (
        <Notice
          tone="muted"
          text="Merging needs an owner or admin session on this server, so the plan below is not requested. You can still review the evidence above."
        />
      ) : (
        <QueryStates
          query={planQuery}
          gate={gate}
          isEmpty={plan === null}
          offlineMessage="The merge plan is computed by the server, so it needs a connection. Nothing is merged offline."
          skeleton={<SkeletonList rows={1} lines={5} label="Computing the merge plan" />}
          empty={{
            title: "No plan returned",
            description:
              "The server accepted the request but described no plan, so there is nothing to agree to. Re-run the scan.",
          }}
        >
          {plan ? (
            <DuplicateMergePlanCard
              plan={plan}
              survivorEmail={survivorEmail}
              loserEmail={loserEmail}
            />
          ) : null}
          {plan && !applyable ? (
            <Notice
              tone="warning"
              text="The server did not return a replayable plan fingerprint for this pair, so a merge could only be refused. Re-run the scan."
            />
          ) : null}
          {applyable && gate.enabled ? (
            <MergeButton
              busy={busy || apply.isPending}
              survivorEmail={survivorEmail}
              loserEmail={loserEmail}
              onPress={() => void onMerge()}
            />
          ) : null}
          {applyable && !gate.enabled ? (
            <Notice
              tone="muted"
              text="A merge is never queued for later — it consolidates two people's consent records, so it only runs while you are connected and watching."
            />
          ) : null}
        </QueryStates>
      )}
    </View>
  );
}

function MergeButton({
  busy,
  survivorEmail,
  loserEmail,
  onPress,
}: {
  busy: boolean;
  survivorEmail: string;
  loserEmail: string;
  onPress: () => void;
}) {
  const { t } = useTheme();
  const survivor = survivorEmail || "the surviving record";
  const loser = loserEmail || "the duplicate record";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Merge ${loser} into ${survivor}`}
      accessibilityHint="Opens a confirmation naming what survives and what is closed"
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      onPress={onPress}
      style={{
        minHeight: 44,
        marginTop: 12,
        borderRadius: 12,
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: 16,
        backgroundColor: busy ? t.surfaceElevated : t.danger,
        opacity: busy ? 0.7 : 1,
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: busy ? t.fgMuted : t.accentFg,
          ...typeStyle("callout"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {busy ? "Merging…" : `Merge into ${survivor}`}
      </Text>
    </Pressable>
  );
}

function Notice({ tone, text }: { tone: "warning" | "muted"; text: string }) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={text}
      style={{
        marginTop: 12,
        backgroundColor: t.surface,
        borderColor: tone === "warning" ? t.warning : t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {text}
      </Text>
    </View>
  );
}
