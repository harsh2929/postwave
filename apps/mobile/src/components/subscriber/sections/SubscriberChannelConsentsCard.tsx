/**
 * SubscriberChannelConsentsCard — which CHANNELS this person has consented
 * to, and the verb to correct one, mid-support-call.
 *
 * Desktop's ChannelConsentsPanel, translated: all five channels (email / SMS /
 * push / WhatsApp / RCS) in one card, each with its recorded status and
 * provenance. A channel with no row reads "No consent recorded" — never
 * "opted out" — because "we never asked" and "they said no" are different
 * facts in both compliance directions (lib/subscriberChannelConsents.ts).
 *
 * Collapsed and lazy like the rest of the compliance cluster: opening a
 * profile must not fire a consent read for every casual glance.
 *
 * WRITES GO THROUGH THE EVIDENCE REVIEW. Opting a channel in (or out)
 * reuses ConsentEvidenceSheet, so a phone grant carries the same envelope —
 * who decided, on what evidence, under which jurisdiction — as desktop's.
 * The verb is editor-scoped and ABSENT (not disabled) for viewers; a revoke
 * does not demand a durable opt-in artifact, a grant does.
 */
import { useState } from "react";
import { View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { SkeletonList } from "@/components/Skeleton";
import { Chip } from "@/components/Chip";
import { ConsentEvidenceSheet } from "@/components/subscriber/ConsentEvidenceSheet";
import {
  DisclosureEmptyLine,
  SubscriberDisclosureCard,
} from "@/components/subscriber/sections/SubscriberDisclosureCard";
import { useToast } from "@/components/Toast";
import {
  useSetSubscriberChannelConsent,
  useSubscriberChannelConsents,
} from "@/hooks/useSubscriberChannelConsents";
import { FONT } from "@/lib/fonts";
import { dateTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import {
  channelConsentAction,
  channelConsentChannelLabel,
  channelConsentProvenance,
  channelConsentStatusLabel,
  mergeChannelConsentRows,
  type ChannelConsentRow,
} from "@/lib/subscriberChannelConsents";
import { useTheme } from "@/lib/theme";
import { Text } from "react-native";
import { typeCap, typeStyle } from "@/lib/typeScale";

interface PendingWrite {
  channel: string;
  nextStatus: "opted_in" | "opted_out";
  label: string;
}

function ChannelRow({
  row,
  canMutate,
  busy,
  onAction,
}: {
  row: ChannelConsentRow;
  canMutate: boolean;
  busy: boolean;
  onAction: (write: PendingWrite) => void;
}) {
  const { t } = useTheme();
  const action = channelConsentAction(row.status);
  const statusLabel = channelConsentStatusLabel(row.status);
  const provenance = channelConsentProvenance(row);
  const when = dateTime(row.consentTimestamp ?? undefined, "");
  const optedIn = row.status === "opted_in";
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
        accessibilityLabel={[
          `${channelConsentChannelLabel(row.channel)}: ${statusLabel}`,
          provenance,
          when ? `recorded ${when}` : "",
        ]
          .filter(Boolean)
          .join(", ")}
        style={{ flex: 1, minWidth: 0, gap: 2 }}
      >
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.semibold,
          }}
        >
          {channelConsentChannelLabel(row.channel)}
        </Text>
        <Text
          {...typeCap("label")}
          style={{
            // Colour reinforces, the words carry the state.
            color: optedIn ? t.success : t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.medium,
          }}
        >
          {statusLabel}
        </Text>
        {provenance || when ? (
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
            }}
          >
            {[provenance, when].filter(Boolean).join(" · ")}
          </Text>
        ) : null}
      </View>
      {canMutate && action ? (
        <Chip
          label={action.label}
          active={false}
          onPress={() => {
            if (busy) return;
            haptics.tap();
            onAction({
              channel: row.channel,
              nextStatus: action.nextStatus,
              label: action.label,
            });
          }}
          accessibilityLabel={`${action.label} of ${channelConsentChannelLabel(row.channel)} for this subscriber — opens a consent review`}
        />
      ) : null}
    </View>
  );
}

export function SubscriberChannelConsentsCard({
  subscriberId,
  email,
  canMutate,
}: {
  subscriberId: string;
  email: string;
  /** Online AND editor+ AND un-gated — consent writes never queue offline. */
  canMutate: boolean;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<PendingWrite | null>(null);
  const consents = useSubscriberChannelConsents(subscriberId, open);
  const write = useSetSubscriberChannelConsent();

  const rows = mergeChannelConsentRows(consents.data ?? []);
  const isGrant = pending?.nextStatus === "opted_in";

  return (
    <>
      <SubscriberDisclosureCard
        title="Channel consents"
        hint="Per-channel marketing permission — email, SMS, push, WhatsApp, RCS"
        open={open}
        count={consents.data ? consents.data.length : null}
        onToggle={() => setOpen((v) => !v)}
      >
        {consents.isLoading ? (
          <SkeletonList rows={3} />
        ) : consents.isError ? (
          <ErrorState
            error={consents.error}
            onRetry={() => void consents.refetch()}
          />
        ) : (
          <>
            {rows.map((row) => (
              <ChannelRow
                key={row.channel}
                row={row}
                canMutate={canMutate}
                busy={write.isPending}
                onAction={setPending}
              />
            ))}
            {consents.data && consents.data.length === 0 ? (
              <DisclosureEmptyLine text="No channel has a recorded consent decision yet. The profile status still governs email sending." />
            ) : null}
          </>
        )}
      </SubscriberDisclosureCard>

      <ConsentEvidenceSheet
        visible={pending !== null}
        title={
          pending
            ? `${pending.label}: ${channelConsentChannelLabel(pending.channel)}`
            : ""
        }
        subtitle={
          isGrant
            ? `Records a reviewed ${pending ? channelConsentChannelLabel(pending.channel) : ""} marketing consent for ${email}. Independent suppressions still apply.`
            : `Records an opt-out of ${pending ? channelConsentChannelLabel(pending.channel) : ""} marketing for ${email}, with the decision's provenance.`
        }
        requireEvidence={isGrant}
        submitLabel={isGrant ? "Record consent" : "Record opt-out"}
        busy={write.isPending}
        submitError={
          write.error instanceof Error ? write.error.message : undefined
        }
        onClose={() => {
          if (!write.isPending) setPending(null);
        }}
        onSubmit={(draft) => {
          if (!pending) return;
          haptics.warning();
          write.mutate(
            {
              subscriberId,
              channel: pending.channel,
              nextStatus: pending.nextStatus,
              draft,
            },
            {
              onSuccess: () => {
                haptics.success();
                const done = pending;
                setPending(null);
                toast({
                  kind: "success",
                  message: `${channelConsentChannelLabel(done.channel)} consent recorded for ${email}.`,
                });
              },
              // The sheet stays open with the server's sentence under the
              // form — a failed consent change must never look recorded.
              onError: () => haptics.error(),
            },
          );
        }}
      />
    </>
  );
}
