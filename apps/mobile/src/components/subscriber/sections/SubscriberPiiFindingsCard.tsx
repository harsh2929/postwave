/**
 * SubscriberPiiFindingsCard — this profile's Shadow-PII findings (SUB-071),
 * desktop's PIIFindingsPanel translated to the detail's disclosure idiom.
 *
 * ADMIN-ONLY BY CONSTRUCTION: the parent mounts this card only for roles
 * that clear the admin floor (the same `canReadConsent` boundary the consent
 * ledger uses — GET /subscribers/{id}/pii-findings is admin in the routeauth
 * manifest), so a session that would 403 never sees the card at all. If a
 * stale session still 403s, the error is rendered as the PERMISSION RULE it
 * is (lib/subscriberPiiFindings.piiFailureMessage), never a generic failure.
 *
 * Collapsed and lazy like the rest of the compliance cluster; a pending
 * finding offers Decide, which routes through the same receipt form as the
 * workspace queue. What is deliberately NOT here: the matched value. The
 * server never returns it, and this card never pretends to know it.
 */
import { useState } from "react";
import { Text, View } from "react-native";

import { Chip } from "@/components/Chip";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { PiiFindingDecisionSheet } from "@/components/subscriber/PiiFindingDecisionSheet";
import {
  DisclosureEmptyLine,
  SubscriberDisclosureCard,
} from "@/components/subscriber/sections/SubscriberDisclosureCard";
import {
  useReviewPiiFinding,
  useSubscriberPiiFindings,
} from "@/hooks/useSubscriberPiiFindings";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  buildPiiDecisionBody,
  piiFailureMessage,
  piiReasonLabel,
  piiStatusLabel,
  piiTypeLabel,
  type PiiFindingRow,
} from "@/lib/subscriberPiiFindings";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

function FindingRow({
  row,
  canDecide,
  onDecide,
}: {
  row: PiiFindingRow;
  canDecide: boolean;
  onDecide: (row: PiiFindingRow) => void;
}) {
  const { t } = useTheme();
  const pending = row.status === "pending";
  return (
    <View
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        paddingVertical: 10,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
      }}
    >
      <View
        accessible
        accessibilityLabel={`${piiTypeLabel(row.detectedType)} in ${row.fieldName}: ${piiStatusLabel(row.status)}`}
        style={{ flex: 1, minWidth: 0, gap: 2 }}
      >
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.semibold,
          }}
          numberOfLines={1}
        >
          {`${piiTypeLabel(row.detectedType)} · ${row.fieldName}`}
        </Text>
        <Text
          {...typeCap("label")}
          style={{
            color: pending ? t.warning : t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.medium,
          }}
        >
          {piiStatusLabel(row.status)}
        </Text>
        {row.receipt ? (
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
            }}
            numberOfLines={2}
          >
            {`${piiReasonLabel(row.receipt.reason)} — ${row.receipt.comment}`}
          </Text>
        ) : null}
      </View>
      {canDecide && pending ? (
        <Chip
          label="Decide"
          active={false}
          onPress={() => {
            haptics.tap();
            onDecide(row);
          }}
          accessibilityLabel={`Decide the ${piiTypeLabel(row.detectedType)} finding in ${row.fieldName} — opens the review receipt form`}
        />
      ) : null}
    </View>
  );
}

export function SubscriberPiiFindingsCard({
  subscriberId,
  canDecide,
}: {
  subscriberId: string;
  /** Online AND admin AND live session — decisions never queue offline. */
  canDecide: boolean;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [deciding, setDeciding] = useState<PiiFindingRow | null>(null);
  const findings = useSubscriberPiiFindings(subscriberId, open);
  const review = useReviewPiiFinding();

  const rows = Array.isArray(findings.data?.items) ? findings.data.items : [];

  return (
    <>
      <SubscriberDisclosureCard
        title="PII findings"
        hint="Undeclared personal data the scanner found in this profile's fields"
        open={open}
        count={findings.data ? findings.data.total : null}
        onToggle={() => setOpen((v) => !v)}
      >
        {findings.isLoading ? (
          <SkeletonList rows={2} />
        ) : findings.isError ? (
          <DisclosureEmptyLine
            text={piiFailureMessage(
              (findings.error as { status?: number } | null)?.status,
            )}
          />
        ) : rows.length === 0 ? (
          <DisclosureEmptyLine text="No undeclared personal data has been detected in this profile's fields." />
        ) : (
          <>
            {rows.map((row) => (
              <FindingRow
                key={row.id}
                row={row}
                canDecide={canDecide}
                onDecide={setDeciding}
              />
            ))}
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                marginTop: 8,
                fontFamily: FONT.regular,
              }}
            >
              Matched values are never shown — findings carry only the field
              and the detector&apos;s classification.
            </Text>
          </>
        )}
      </SubscriberDisclosureCard>

      <PiiFindingDecisionSheet
        finding={deciding}
        busy={review.isPending}
        submitError={
          review.error
            ? piiFailureMessage(
                (review.error as { status?: number }).status,
              )
            : undefined
        }
        onClose={() => {
          if (!review.isPending) setDeciding(null);
        }}
        onSubmit={(draft) => {
          if (!deciding) return;
          const body = buildPiiDecisionBody(draft, deciding.updatedAt);
          if (!body) return;
          haptics.warning();
          review.mutate(
            { findingId: deciding.id, subscriberId, body },
            {
              onSuccess: () => {
                haptics.success();
                setDeciding(null);
                toast({
                  kind: "success",
                  message: "Decision recorded. The receipt is permanent.",
                });
              },
              // The sheet stays open with the refusal under the form — a
              // refused receipt must never look recorded.
              onError: () => haptics.error(),
            },
          );
        }}
      />
    </>
  );
}
