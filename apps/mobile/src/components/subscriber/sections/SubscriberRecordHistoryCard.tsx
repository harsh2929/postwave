/**
 * SubscriberRecordHistoryCard — "who changed what on this record", and the
 * consent receipts behind the opt-in.
 *
 * The profile's activity timeline shows what the PERSON did. These two are
 * what WE did, and what we can prove — the two questions a support agent gets
 * while the person is still on the line ("someone changed my email"; "I never
 * signed up for this").
 *
 * Both start COLLAPSED and fetch only when opened. Consent receipts in
 * particular read a compliance ledger, and pulling one on every profile open
 * would put a PII read in the audit log for every casual glance.
 *
 * The two have DIFFERENT authorization and are gated separately:
 *   history  read:subscribers (read-only scope) → any authenticated role
 *   receipts admin scope                        → owner|admin only
 * A viewer therefore sees the history section and no receipts section at all,
 * rather than a receipts section that can only ever render a 403.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { SkeletonList } from "@/components/Skeleton";
import {
  Card,
  Label,
} from "@/components/subscriber/SubscriberDetailPrimitives";
import {
  useSubscriberConsentReceipts,
  useSubscriberRecordHistory,
} from "@/hooks/useSubscriberRecordHistory";
import { FONT } from "@/lib/fonts";
import { dateTime, relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import {
  attributeFieldLabel,
  changedByLabel,
  changeVerb,
  displayValue,
  isPiiField,
  NO_RECEIPTS_MESSAGE,
  receiptEvidence,
  receiptHeadline,
  type ConsentReceipt,
  type RecordHistoryEvent,
} from "@/lib/subscriberRecordHistory";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { transitionLabel } from "@/lib/direction";

function Disclosure({
  title,
  hint,
  open,
  count,
  onToggle,
  children,
}: {
  title: string;
  hint: string;
  open: boolean;
  /** Loaded row count, or null while unknown. Never rendered as 0 when unknown. */
  count: number | null;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTheme();
  return (
    <Card style={{ marginTop: 12 }}>
      <Pressable
        onPress={() => {
          haptics.tap();
          onToggle();
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={
          count == null ? title : `${title}, ${count} entries`
        }
        accessibilityHint={hint}
        // NativeWind v4: static style object only.
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          minHeight: 44,
          gap: 12,
        }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label>{title}</Label>
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
              marginTop: 2,
            }}
          >
            {hint}
          </Text>
        </View>
        <Text
          allowFontScaling={false}
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{ color: t.fgMuted, fontFamily: FONT.medium, fontSize: 16 }}
        >
          {open ? "▾" : "▸"}
        </Text>
      </Pressable>
      {open ? <View style={{ marginTop: 12 }}>{children}</View> : null}
    </Card>
  );
}

function EmptyLine({ text }: { text: string }) {
  const { t } = useTheme();
  return (
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
  );
}

function HistoryRow({ event }: { event: RecordHistoryEvent }) {
  const { t } = useTheme();
  const field = attributeFieldLabel(event.field);
  const verb = changeVerb(event);
  const when = relativeTime(event.changedAt ?? undefined, { fallback: "" });
  const exact = dateTime(event.changedAt ?? undefined, "");
  const from = displayValue(event.oldValue);
  const to = displayValue(event.newValue);
  return (
    <View
      accessible
      accessibilityLabel={[
        `${verb} ${field}`,
        isPiiField(event.field) ? "personal data" : "",
        `from ${from} to ${to}`,
        `by ${changedByLabel(event)}`,
        exact ? `on ${exact}` : "",
      ]
        .filter(Boolean)
        .join(", ")}
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        paddingVertical: 10,
        gap: 2,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.semibold,
          }}
        >
          {`${verb} ${field}`}
        </Text>
        {isPiiField(event.field) ? (
          <Text
            {...typeCap("badgeSmall")}
            style={{
              color: t.warning,
              ...typeStyle("badgeSmall"),
              fontFamily: FONT.bold,
              letterSpacing: 0.4,
            }}
          >
            PII
          </Text>
        ) : null}
      </View>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        {transitionLabel(from, to)}
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        {[changedByLabel(event), when].filter(Boolean).join(" · ")}
      </Text>
    </View>
  );
}

function ReceiptRow({ receipt }: { receipt: ConsentReceipt }) {
  const { t } = useTheme();
  const when = relativeTime(receipt.at ?? undefined, { fallback: "" });
  const exact = dateTime(receipt.at ?? undefined, "");
  return (
    <View
      accessible
      accessibilityLabel={[
        receiptHeadline(receipt),
        receiptEvidence(receipt),
        exact ? `on ${exact}` : "",
      ]
        .filter(Boolean)
        .join(", ")}
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        paddingVertical: 10,
        gap: 2,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.semibold,
        }}
      >
        {receiptHeadline(receipt)}
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        {receiptEvidence(receipt)}
      </Text>
      {when ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {when}
        </Text>
      ) : null}
    </View>
  );
}

export function SubscriberRecordHistoryCard({
  subscriberId,
  email,
  canReadConsent,
}: {
  subscriberId: string;
  email: string;
  /** canAccessMinimumRole("admin", …) — the receipts route is admin-scoped. */
  canReadConsent: boolean;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  const history = useSubscriberRecordHistory(subscriberId, historyOpen);
  const receipts = useSubscriberConsentReceipts(
    email,
    receiptsOpen && canReadConsent,
  );

  const events = Array.isArray(history.data?.events) ? history.data?.events : [];
  const receiptRows = Array.isArray(receipts.data?.receipts) ? receipts.data?.receipts : [];

  return (
    <>
      <Disclosure
        title="Record history"
        hint="Who changed what on this profile"
        open={historyOpen}
        count={history.data ? events.length : null}
        onToggle={() => setHistoryOpen((v) => !v)}
      >
        {history.isLoading ? (
          <SkeletonList rows={3} />
        ) : history.isError ? (
          <ErrorState
            error={history.error}
            onRetry={() => void history.refetch()}
          />
        ) : events.length === 0 ? (
          <EmptyLine text="No field changes have been recorded for this profile." />
        ) : (
          <>
            {events.map((event) => (
              <HistoryRow key={event.id} event={event} />
            ))}
            {history.data?.nextCursor ? (
              // The endpoint pages by cursor. Rather than build paging into a
              // collapsed card, say what the reader is looking at — a silent
              // truncation would read as a complete history.
              <EmptyLine text="Showing the most recent changes. Older entries are on the web admin." />
            ) : null}
          </>
        )}
      </Disclosure>

      {/* Admin-only: the receipts route is RequireScope(ScopeAdmin), so for
          anyone else the section is absent rather than permanently 403. */}
      {canReadConsent ? (
        <Disclosure
          title="Loaded consent evidence"
          hint="Recorded receipt and proof rows—not complete or current-state proof"
          open={receiptsOpen}
          count={receipts.data ? receiptRows.length : null}
          onToggle={() => setReceiptsOpen((v) => !v)}
        >
          {receipts.isLoading ? (
            <SkeletonList rows={3} />
          ) : receipts.isError ? (
            <ErrorState
              error={receipts.error}
              onRetry={() => void receipts.refetch()}
            />
          ) : receiptRows.length === 0 ? (
            <EmptyLine text={NO_RECEIPTS_MESSAGE} />
          ) : (
            <>
              {receiptRows.map((receipt) => (
                <ReceiptRow
                  key={`${receipt.kind}:${receipt.id}`}
                  receipt={receipt}
                />
              ))}
              {receipts.data?.hasMore ? (
                <EmptyLine text="Showing a contract-validated recent page. Older receipt/proof rows remain available in the desktop consent register." />
              ) : null}
            </>
          )}
        </Disclosure>
      ) : null}

      {/* Portable consent export remains release-held until the backend can
          prove complete cross-ledger coverage. Do not surface a lossy copy or
          download affordance as a subject-access document. */}
    </>
  );
}
