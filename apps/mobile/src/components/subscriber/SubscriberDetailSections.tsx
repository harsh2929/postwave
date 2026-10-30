/**
 * SubscriberDetailOverview — the profile above the activity timeline.
 *
 * This file used to inline the header card, the action row, the stats grid,
 * the sparkline, the tags card, the custom-fields card and both timeline
 * notices behind a single 17-prop signature, so every profile addition made
 * it worse. It is now a composition of ./sections/*, each of which takes
 * only the slice it needs.
 *
 * Formatting is delegated to src/lib/format.ts and status wording to
 * src/lib/subscriberStatus.ts. Before that this file carried its own
 * fmtDate / fmtNum / fmtPercent / relTime / statusTone — of which relTime
 * and statusTone were duplicated (divergently) elsewhere in the cluster, so
 * the header's "Last active" and the timeline's own top event could describe
 * the same instant differently, and a status pill could disagree with the
 * list it was opened from.
 */
import { View } from "react-native";

import { Label } from "@/components/subscriber/SubscriberDetailPrimitives";
import { SubscriberListsCard } from "@/components/subscriber/SubscriberListsCard";
import { WebHandoffRow } from "@/components/WebHandoffRow";
import {
  SubscriberConsentCard,
  SubscriberDetailsCard,
  type SubscriberProfileFields,
} from "@/components/subscriber/SubscriberProfileCards";
import { SubscriberAccountCard } from "@/components/subscriber/sections/SubscriberAccountCard";
import { SubscriberActionRow } from "@/components/subscriber/sections/SubscriberActionRow";
import { SubscriberChannelConsentsCard } from "@/components/subscriber/sections/SubscriberChannelConsentsCard";
import { SubscriberDataClusterCards } from "@/components/subscriber/sections/SubscriberDataClusterCards";
import { SubscriberEmailsCard } from "@/components/subscriber/sections/SubscriberEmailsCard";
import { SubscriberFrequencyCard } from "@/components/subscriber/sections/SubscriberFrequencyCard";
import { SubscriberGppCard } from "@/components/subscriber/sections/SubscriberGppCard";
import { SubscriberTrackingCard } from "@/components/subscriber/sections/SubscriberTrackingCard";
import {
  SubscriberEngagementSpark,
  SubscriberLifetimeStats,
  TimelineErrorCard,
  TimelineUnavailableCard,
  type SubscriberTimelineStats,
} from "@/components/subscriber/sections/SubscriberActivityCards";
import { SubscriberHeaderCard } from "@/components/subscriber/sections/SubscriberHeaderCard";
import { SubscriberArchivedCard } from "@/components/subscriber/sections/SubscriberArchivedCard";
import { SubscriberBestSendTimeCard } from "@/components/subscriber/sections/SubscriberBestSendTimeCard";
import { SubscriberEmailHealthCard } from "@/components/subscriber/sections/SubscriberEmailHealthCard";
import { SubscriberNotesCard } from "@/components/subscriber/sections/SubscriberNotesCard";
import { SubscriberPredictionCard } from "@/components/subscriber/sections/SubscriberPredictionCard";
import { PortableReceiptCard } from "@/components/subscriber/sections/PortableReceiptCard";
import { SubscriberPiiFindingsCard } from "@/components/subscriber/sections/SubscriberPiiFindingsCard";
import { SubscriberRecordHistoryCard } from "@/components/subscriber/sections/SubscriberRecordHistoryCard";
import { SubscriberSuppressionCard } from "@/components/subscriber/sections/SubscriberSuppressionCard";
import { SubscriberTopicsCard } from "@/components/subscriber/sections/SubscriberTopicsCard";
import { SubscriberTagsCard } from "@/components/subscriber/sections/SubscriberTagsCard";
import { subscriberStatusLabel } from "@/lib/subscriberStatus";

export type { SubscriberTimelineStats };
export { SubscriberTimelineFooter } from "./SubscriberTimelineFooter";

/**
 * Everything the profile renders. Widened well past the original six
 * fields — identity, localisation, consent and the engagement score all
 * arrive on the SAME detail GET and were being dropped at this boundary.
 */
export type SubscriberDetailSummary = SubscriberProfileFields & {
  email: string;
  status?: string;
  created_at?: string;
  tags?: string[];
  custom_fields?: Record<string, unknown>;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  display_name?: string | null;
  /** Pointer server-side: absent means "not scored", never zero. */
  engagement_score?: number | null;
  /**
   * AUDIENCE#28 — the predictive projection the detail GET already sends and
   * this boundary used to drop on the floor.
   *
   * `unknown` rather than a mirrored struct on purpose: every field is
   * `omitempty` on the Go side, so the shape that arrives is genuinely
   * partial, and src/lib/subscriberPrediction.ts is the one place allowed to
   * decide what a partial payload means. Typing it structurally here would
   * push that decision into a dozen render sites.
   */
  prediction?: unknown;
  /** SUB-061 replenishment cadence (types.go:225). Absent = no order history. */
  expected_next_order_at?: string | null;
  /** SUB-062 repeat-purchase projection (types.go:231). */
  order_cadence_metrics?: unknown;
  /** SUB-010 model lineage (types.go:205) — shown only when present. */
  prediction_model_version?: string | null;
  /**
   * AUDIENCE#56 — SUB-009 soft delete (types.go:163). Absent = active.
   */
  archived_at?: string | null;
  /**
   * The strong optimistic-concurrency token (types.go:157). Carried on EVERY
   * subscriber representation, and required verbatim as `If-Match` by the
   * archive/unarchive endpoints.
   */
  version?: string | null;
  /** SUB-012 — the linked B2B account FK, null/absent when unlinked. */
  account_id?: string | null;
};

/**
 * The gauge used to require the SEPARATE /timeline payload, so a timeline
 * outage hid a score that was sitting unused on the detail object. A helper
 * (not inline) so the ternary chain doesn't count against the Overview's
 * complexity budget.
 */
function subscriberGaugeScore(
  stats: SubscriberTimelineStats | undefined,
  statsUsable: boolean,
  subscriber: SubscriberDetailSummary,
): number | null {
  if (statsUsable) return stats?.engagement_score ?? 0;
  return typeof subscriber.engagement_score === "number"
    ? subscriber.engagement_score
    : null;
}

export function SubscriberDetailOverview({
  subscriberId,
  subscriber,
  stats,
  unavailable,
  timelineFailed,
  isOnline,
  canMutate,
  canAddToList,
  addToListUnavailableReason,
  unavailableReason,
  isUpdatingTags,
  isSettingStatus,
  isSuppressing,
  isTimelineFetching,
  canReadConsent,
  onCopyEmail,
  onShareEmail,
  onEditTags,
  onAddToList,
  onUnsubscribe,
  onResubscribe,
  onRemoveTag,
  onBackToSubscribers,
  onRetryTimeline,
}: {
  subscriberId: string;
  subscriber: SubscriberDetailSummary;
  stats: SubscriberTimelineStats | undefined;
  unavailable: boolean;
  timelineFailed: boolean;
  isOnline: boolean;
  /** Online AND holding at least an editor role. */
  canMutate: boolean;
  /**
   * AUDIENCE#33: "Add to list" is queueable offline (the handler only adds and
   * the route is idempotent by construction), so it has its own gate. Omitted
   * → falls back to `canMutate`.
   */
  canAddToList?: boolean | undefined;
  addToListUnavailableReason?: string | undefined;
  /** Spoken + printed explanation when canMutate is false. */
  unavailableReason?: string | undefined;
  isUpdatingTags: boolean;
  isSettingStatus: boolean;
  isSuppressing: boolean;
  isTimelineFetching: boolean;
  /**
   * Whether this role may read the consent ledger. The receipts route is
   * admin-scoped while the record history is read-only-scoped, so the two
   * cannot share `canMutate` or each other's gate.
   */
  canReadConsent: boolean;
  onCopyEmail: () => void;
  onShareEmail: () => void;
  onEditTags: () => void;
  onAddToList: () => void;
  onUnsubscribe: () => void;
  onResubscribe: () => void;
  onRemoveTag: (tag: string) => void;
  onBackToSubscribers: () => void;
  onRetryTimeline: () => void;
}) {
  const currentStatus = stats?.current_status ?? subscriber.status;
  const busy = isUpdatingTags || isSettingStatus || isSuppressing;
  const statsUsable = Boolean(stats) && !unavailable;
  const gaugeScore = subscriberGaugeScore(stats, statsUsable, subscriber);

  return (
    <>
      <SubscriberHeaderCard
        subscriberId={subscriberId}
        subscriber={subscriber}
        status={currentStatus}
        joinedAt={
          stats?.subscribed_at ??
          subscriber.created_at ??
          subscriber.consent_timestamp
        }
        lastActiveAt={stats?.last_active_at}
        engagementScore={gaugeScore}
        onCopyEmail={onCopyEmail}
        onShareEmail={onShareEmail}
      />

      {/* Soft-deleted rows say so at the TOP of the profile, above the verbs
          — every action below is being taken on a hidden contact. */}
      <SubscriberArchivedCard
        subscriberId={subscriberId}
        archivedAt={subscriber.archived_at}
        version={subscriber.version}
        canMutate={canMutate}
        disabledReason={unavailableReason}
      />

      <SubscriberEmailHealthCard
        email={subscriber.email}
        subscriberId={subscriberId}
      />

      {/* SUB-016: "also reach me at my work address" — alternate addresses
          with per-address consent + suppression, under the header card. */}
      <SubscriberEmailsCard subscriberId={subscriberId} canMutate={canMutate} />

      {/* SUB-012: which company this contact belongs to — header-adjacent,
          the way desktop mounts AccountSection. */}
      <SubscriberAccountCard
        subscriberId={subscriberId}
        accountId={subscriber.account_id}
        version={subscriber.version}
        canMutate={canMutate}
      />

      <SubscriberActionRow
        canMutate={canMutate}
        {...(canAddToList === undefined ? {} : { canAddToList })}
        {...(unavailableReason ? { unavailableReason } : {})}
        {...(addToListUnavailableReason ? { addToListUnavailableReason } : {})}
        busy={busy}
        isSettingStatus={isSettingStatus}
        isSubscribed={subscriberStatusLabel(currentStatus) === "Subscribed"}
        onEditTags={onEditTags}
        onAddToList={onAddToList}
        onUnsubscribe={onUnsubscribe}
        onResubscribe={onResubscribe}
      />

      {statsUsable && stats ? <SubscriberLifetimeStats stats={stats} /> : null}

      {/* Predicted value / churn / repeat-purchase cadence. Renders nothing
          at all for an address the predictive worker has never scored, which
          is the common case on a young workspace. */}
      <SubscriberPredictionCard
        prediction={subscriber.prediction}
        expectedNextOrderAt={subscriber.expected_next_order_at}
        orderCadenceMetrics={subscriber.order_cadence_metrics}
        modelVersion={subscriber.prediction_model_version}
      />

      {/* "When does this person actually read mail?" — admin-only, because
          the route's session gate resolves to owner/admin (see the hook). */}
      <SubscriberBestSendTimeCard subscriberId={subscriberId} />

      {!unavailable && !timelineFailed ? (
        <SubscriberEngagementSpark daily={stats?.engagement_daily_30d} />
      ) : null}

      <SubscriberTagsCard
        tags={subscriber.tags}
        canMutate={canMutate}
        {...(unavailableReason ? { unavailableReason } : {})}
        isUpdatingTags={isUpdatingTags}
        onRemoveTag={onRemoveTag}
      />

      <SubscriberListsCard
        subscriberId={subscriberId}
        canMutate={canMutate}
        {...(unavailableReason ? { disabledReason: unavailableReason } : {})}
      />

      {/* Reads the deliverability suppression TABLE, not the subscriber's
          status: a bounce-driven hold never touches `status`, so the two can
          disagree and only this card can say which. Renders nothing when the
          address is clean. */}
      <SubscriberSuppressionCard
        subscriberId={subscriberId}
        email={subscriber.email}
        currentStatus={currentStatus}
        canMutate={canMutate}
        {...(unavailableReason ? { disabledReason: unavailableReason } : {})}
      />

      {/* The preference centre: the one consent surface the SUBSCRIBER
          controls. Sits above the consent card because it answers "what did
          they choose?" while that one answers "how did they arrive?". Renders
          nothing on a workspace with no topic catalogue. */}
      <SubscriberTopicsCard
        email={subscriber.email}
        canMutate={canMutate}
        // Passed straight through rather than spread-when-present: the prop
        // accepts `undefined` explicitly, and a conditional spread here would
        // be the branch that tips this function's complexity budget.
        disabledReason={unavailableReason}
      />

      {/* Per-CHANNEL permission (SUB-042): which of email/SMS/push/WhatsApp/
          RCS this person consented to, with provenance, and the evidence-
          reviewed verb to correct one. Sits between "what did they choose?"
          (topics) and "how did they arrive?" (consent card) because it
          answers "where may we reach them?". */}
      <SubscriberChannelConsentsCard
        subscriberId={subscriberId}
        email={subscriber.email}
        canMutate={canMutate}
      />

      <SubscriberConsentCard subscriber={subscriber} />

      {/* "Email me less often", for THIS person (SUB-132). The summary
          sentence is the truth (a future pause expiry silences every
          cadence); the verbs exist only for canMutate. */}
      <SubscriberFrequencyCard
        subscriberId={subscriberId}
        subscriber={subscriber}
        canMutate={canMutate}
      />

      {/* "Stop tracking me", honored per dimension with GPC kept visible
          and never overridable from here. */}
      <SubscriberTrackingCard
        subscriberId={subscriberId}
        canMutate={canMutate}
      />

      {/* The CMP-reported GPP strings (SUB-120), verbatim — read-only like
          desktop; edits stay on the admin PATCH path out of band. */}
      <SubscriberGppCard subscriberId={subscriberId} />

      <SubscriberDetailsCard subscriber={subscriber} />

      <SubscriberDataClusterCards
        subscriberId={subscriberId}
        customFields={subscriber.custom_fields}
        canMutate={canMutate}
      />

      {/* Operator memos (SUB-097). The most phone-native thing a profile can
          carry: the note you write sixty seconds after the conversation. */}
      <SubscriberNotesCard
        subscriberId={subscriberId}
        email={subscriber.email}
        canMutate={canMutate}
        {...(unavailableReason ? { disabledReason: unavailableReason } : {})}
      />

      {/* "What did WE do to this record", and "prove they opted in" — the two
          questions the activity timeline cannot answer. Both collapsed and
          lazy: opening a profile must not fire a compliance-ledger read. */}
      <SubscriberRecordHistoryCard
        subscriberId={subscriberId}
        email={subscriber.email}
        canReadConsent={canReadConsent}
      />

      {/* The subject-facing ISO 27560 export complements the internal record
          history above. It owns its collapsed/lazy state and renders nothing
          for roles that cannot call the admin-scoped export route. */}
      <PortableReceiptCard
        subscriberId={subscriberId}
        canReadConsent={canReadConsent}
      />

      {/* Shadow-PII findings on THIS profile (SUB-071). Admin-floored on the
          server (routeauth manifest), so the card exists only behind the same
          boundary as the consent ledger; deciding one commits an immutable
          receipt and is online-only, hence the canMutate conjunction. */}
      {canReadConsent ? (
        <SubscriberPiiFindingsCard
          subscriberId={subscriberId}
          canDecide={canReadConsent && canMutate}
        />
      ) : null}

      {/* Mobile keeps profile EDITING on the web by design, so a detail
          screen must offer a way across rather than being a dead end. Copy
          leads over Open because the in-app browser does not carry this app's
          session — see WebHandoffRow. */}
      <WebHandoffRow
        entity="subscriber"
        id={subscriberId}
        label={subscriber.email || "this subscriber"}
      />

      {unavailable ? (
        <TimelineUnavailableCard onBackToSubscribers={onBackToSubscribers} />
      ) : null}

      <View style={{ marginTop: 16 }}>
        <Label style={{ marginBottom: 8 }}>Activity</Label>
        {timelineFailed && !unavailable ? (
          <TimelineErrorCard
            isOnline={isOnline}
            isFetching={isTimelineFetching}
            onRetry={onRetryTimeline}
          />
        ) : null}
      </View>
    </>
  );
}
