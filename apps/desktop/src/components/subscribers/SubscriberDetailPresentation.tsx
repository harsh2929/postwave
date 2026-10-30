import {
  type ReactElement,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { fmtDate } from "../../lib/format-date";
import { requestDesktopRouteNavigation } from "../../lib/desktop-router";
import { isExactSubscriberVersion } from "../../lib/api-client";
import type {
  SubscriberDetail,
  SubscriberTimelineStats,
} from "../../lib/api-client";
import type {
  SubscriberDetailProps,
  SubscriberDetailTabId,
} from "../subscriber-detail-types";
import { EngagementSparkline } from "../charts/EngagementSparkline";
import { ChoiceGroup, type ChoiceGroupOption } from "../ChoiceGroup";
import { ConfirmModal } from "../ConfirmModal";
import { FormField } from "../FormField";
import { Notice } from "../Notice";
import { ReferralProgressPanel } from "../referrals/ReferralProgressPanel";
import { SlideoverShell } from "../SlideoverShell";
import { AttributeHistoryTimeline } from "../subscriber/AttributeHistoryTimeline";
import { PIIFindingsPanel } from "../subscriber/PIIFindingsPanel";
import { SegmentDecisionsPanel } from "../subscriber/SegmentDecisionsPanel";
import { SubscriberCustomObjectLinks } from "../subscriber/SubscriberCustomObjectLinks";
import { Timeline } from "../subscriber/Timeline";
import { TimelineEvent } from "../subscriber/TimelineEvent";
import { ContactPerformanceCard } from "./ContactPerformanceCard";
import { CrossChannelTimeline } from "./CrossChannelTimeline";
import { DSARModal } from "./DSARModal";
import { PreferencesPanel } from "./PreferencesPanel";
import { RFMProfileCard } from "./RFMProfileCard";
import { SubscriberInsightsPanel } from "./SubscriberInsightsPanel";
import { SubscriberListsPanel } from "./SubscriberListsPanel";
import { SubscriberNotesPanel } from "./SubscriberNotesPanel";
import { SubscriberProfilePanel } from "./SubscriberProfilePanel";
import { SubscriberStatusConsentModal } from "./SubscriberStatusConsentModal";
import { SubscriberEmailHealthCard } from "./SubscriberEmailHealthCard";
import { subscriberHistoryDisplay } from "./subscriber-history-display";
import { engineStatusToUi } from "./subscriber-status";
import {
  regimeForJurisdiction,
  regulationsForJurisdiction,
  type SubscriberDetailMutationController,
} from "./useSubscriberDetailMutations";
import type {
  SubscriberDetailDataController,
  SubscriberNavigationState,
} from "./useSubscriberDetailData";
import { useTabsInteraction } from "../../hooks/useTabsInteraction";

interface PresentationProps {
  source: SubscriberDetailProps;
  navigation: SubscriberNavigationState;
  data: SubscriberDetailDataController;
  mutations: SubscriberDetailMutationController;
  canMutate: boolean;
  canAdmin: boolean;
}

type SubscriberDetailGroupId =
  | "summary"
  | "activity"
  | "data"
  | "consent"
  | "governance";

interface SubscriberDetailLeaf {
  id: SubscriberDetailTabId;
  label: string;
}

interface SubscriberDetailGroup {
  id: SubscriberDetailGroupId;
  label: string;
  description: string;
  items: readonly SubscriberDetailLeaf[];
}

const SUBSCRIBER_DETAIL_GROUPS: readonly SubscriberDetailGroup[] = [
  {
    id: "summary",
    label: "Summary",
    description: "Identity, engagement health, and predictive value.",
    items: [
      { id: "profile", label: "Profile" },
      { id: "engagement", label: "Engagement" },
      { id: "predictive", label: "Predictive" },
    ],
  },
  {
    id: "activity",
    label: "Activity",
    description: "Message history and referral progress.",
    items: [
      { id: "timeline", label: "Timeline" },
      { id: "referrals", label: "Referrals" },
    ],
  },
  {
    id: "data",
    label: "Data",
    description: "Memberships, connected records, and attribute changes.",
    items: [
      { id: "lists", label: "Lists & Tags" },
      { id: "customObjects", label: "Custom Objects" },
      { id: "attributeHistory", label: "Attribute History" },
    ],
  },
  {
    id: "consent",
    label: "Consent",
    description: "Privacy requests and communication preferences.",
    items: [
      { id: "privacy", label: "Privacy" },
      { id: "preferences", label: "Preferences" },
    ],
  },
  {
    id: "governance",
    label: "Governance",
    description: "Operator notes, audit history, findings, and decisions.",
    items: [
      { id: "notes", label: "Notes" },
      { id: "history", label: "History" },
      { id: "piiFindings", label: "PII Findings" },
      { id: "decisions", label: "Segment Decisions" },
    ],
  },
];

const DEFAULT_GROUP_TABS: Record<
  SubscriberDetailGroupId,
  SubscriberDetailTabId
> = {
  summary: "profile",
  activity: "timeline",
  data: "lists",
  consent: "privacy",
  governance: "notes",
};

const SUBSCRIBER_DETAIL_GROUP_TAB_ITEMS = SUBSCRIBER_DETAIL_GROUPS.map(
  (group) => ({ value: group.id }),
);

export function relativeSubscriberTime(
  value: string | undefined | null,
): string {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

export function subscriberInitials(email: string): string {
  const local = email.split("@")[0] ?? email;
  const parts = local.split(/[._\-+]/).filter(Boolean);
  if (parts.length === 0) return (email[0] ?? "?").toUpperCase();
  if (parts.length === 1) {
    return ((parts[0] ?? "").slice(0, 2) || "?").toUpperCase();
  }
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}

function avatarHue(email: string): number {
  let hash = 0;
  for (let index = 0; index < email.length; index += 1) {
    hash = (hash * 31 + email.charCodeAt(index)) >>> 0;
  }
  return hash % 360;
}

function statusBadge(status: string | undefined): ReactElement {
  const normalized = (status ?? "").toLowerCase();
  if (["bounced", "blocklisted", "suppressed"].includes(normalized)) {
    return <span className="badge danger">Suppressed</span>;
  }
  if (["unsubscribed", "disabled"].includes(normalized)) {
    return <span className="badge warning">Unsubscribed</span>;
  }
  if (["subscribed", "active", "enabled"].includes(normalized)) {
    return <span className="badge success">Subscribed</span>;
  }
  if (normalized === "unconfirmed") {
    return <span className="badge warning">Unconfirmed</span>;
  }
  return <span className="badge">{status ?? "—"}</span>;
}

function formatPercent(rate: number | undefined): string {
  if (
    typeof rate !== "number" ||
    !Number.isFinite(rate) ||
    rate < 0 ||
    rate > 1
  ) {
    return "Unavailable";
  }
  return `${Math.round(rate * 100)}%`;
}

function formatCount(value: number | undefined): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value.toLocaleString()
    : "Unavailable";
}

function isSuppressedStatus(status: string | undefined): boolean {
  return ["bounced", "blocklisted", "suppressed"].includes(
    (status ?? "").trim().toLowerCase(),
  );
}

export function SubscriberDetailPresentation(
  presentation: PresentationProps,
): ReactElement {
  const { source, navigation, data, mutations } = presentation;
  const initialFocusRef = useRef<HTMLButtonElement | null>(null);
  const [statusConsentOpen, setStatusConsentOpen] = useState(false);
  const [statusConsentBusy, setStatusConsentBusy] = useState(false);
  const operationBusy =
    mutations.actionBusy ||
    mutations.dsarBusy ||
    mutations.jurisdictionBusy ||
    statusConsentBusy;
  navigation.setInteractionBlocked?.(operationBusy);
  const subscriberVersion = data.detail.version?.trim();
  const statusConsentTarget =
    statusConsentOpen && data.id != null && subscriberVersion
      ? { ...data.detail, id: data.id, version: subscriberVersion }
      : null;
  return (
    <>
      <SlideoverShell
        open
        onClose={source.onClose}
        size="md"
        eyebrow="Subscriber"
        title={data.detail.email || "Unknown subscriber"}
        subtitle="Profile, engagement, consent, preferences, and governed subscriber actions."
        headerActions={
          <SubscriberNavigation
            source={source}
            navigation={navigation}
            operationBusy={operationBusy}
          />
        }
        initialFocusRef={initialFocusRef}
        busy={operationBusy}
        footer={
          <SubscriberActions
            presentation={presentation}
            onOpenStatusConsent={() => setStatusConsentOpen(true)}
          />
        }
      >
        {data.detailError ? (
          <Notice
            tone="warning"
            title="Some subscriber details couldn't be refreshed"
            action={
              <button
                type="button"
                className="btn btn-sm"
                onClick={data.reloadDetail}
                disabled={data.loadingDetail}
              >
                Retry
              </button>
            }
          >
            {data.detailError} The durable subscriber record remains visible.
          </Notice>
        ) : null}
        {data.loadingDetail ? (
          <div role="status" aria-busy="true" className="muted">
            Refreshing subscriber details… You can close this panel while it
            loads.
          </div>
        ) : null}
        <SubscriberHeader presentation={presentation} />
        <SubscriberTabShell
          presentation={presentation}
          initialFocusRef={initialFocusRef}
        />
      </SlideoverShell>
      <SubscriberDetailModals data={data} mutations={mutations} />
      <SubscriberStatusConsentModal
        target={statusConsentTarget}
        defaultJurisdiction={
          data.detail.detected_jurisdiction ?? data.detail.country
        }
        onBusyChange={setStatusConsentBusy}
        onClose={() => setStatusConsentOpen(false)}
        onEnabled={(updated) => {
          data.setDetail(updated);
          source.onChange?.(updated, {
            kind: "patch",
            delta: { status: "enabled" },
          });
        }}
      />
    </>
  );
}

function SubscriberNavigation({
  source,
  navigation,
  operationBusy,
}: Pick<PresentationProps, "source" | "navigation"> & {
  operationBusy: boolean;
}): ReactElement | null {
  if (!navigation.enabled) return null;
  return (
    <div
      role="group"
      aria-label="Subscriber navigation"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
      }}
    >
      <button
        type="button"
        className="btn btn-xs btn-ghost"
        onClick={() => source.onNavigate?.(-1)}
        disabled={operationBusy || !navigation.canPrev}
        aria-label="Previous subscriber (Left Arrow)"
      >
        ‹
      </button>
      <span
        className="muted"
        style={{ fontSize: 11, minWidth: 38, textAlign: "center" }}
      >
        {(source.navIndex as number) + 1} / {source.navTotal}
      </span>
      <button
        type="button"
        className="btn btn-xs btn-ghost"
        onClick={() => source.onNavigate?.(1)}
        disabled={operationBusy || !navigation.canNext}
        aria-label="Next subscriber (Right Arrow)"
      >
        ›
      </button>
    </div>
  );
}

function SubscriberHeader({
  presentation,
}: {
  presentation: PresentationProps;
}): ReactElement {
  const { data, mutations, canMutate } = presentation;
  const stats = data.timeline?.stats;
  const hue = avatarHue(data.detail.email ?? "");
  return (
    <>
      <div className="sub-detail-header">
        <div
          className="sub-detail-avatar"
          style={{
            background: `hsl(${hue} 60% 22%)`,
            color: `hsl(${hue} 70% 75%)`,
          }}
          aria-hidden="true"
        >
          {subscriberInitials(data.detail.email ?? "?")}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <SubscriberStatusLine detail={data.detail} stats={stats} />
        </div>
        {stats &&
        typeof stats.engagement_score === "number" &&
        Number.isFinite(stats.engagement_score) &&
        stats.engagement_score >= 0 &&
        stats.engagement_score <= 1 ? (
          <EngagementGauge score={stats.engagement_score} />
        ) : stats ? (
          <div className="muted" style={{ fontSize: 11, textAlign: "right" }}>
            Engagement
            <br />
            Unavailable
          </div>
        ) : null}
      </div>
      <SubscriberInsightsPanel
        subscriberId={data.id}
        detail={data.detail}
        canMutate={canMutate}
        onHistoryChange={data.replaceHistory}
        formatRelativeTime={relativeSubscriberTime}
      />
      {data.detail.email ? (
        <SubscriberEmailHealthCard email={data.detail.email} />
      ) : null}
      {stats ? (
        <StatsGrid stats={stats} />
      ) : data.timelineLoading ? (
        <div className="skel" style={{ height: 56, margin: "8px 0" }} />
      ) : null}
      <JurisdictionBanner
        detail={data.detail}
        canMutate={canMutate}
        mutations={mutations}
      />
    </>
  );
}

function SubscriberStatusLine({
  detail,
  stats,
}: {
  detail: SubscriberDetail;
  stats?: SubscriberTimelineStats;
}): ReactElement {
  const pausedUntil =
    detail.paused_until && new Date(detail.paused_until).getTime() > Date.now();
  return (
    <div className="muted" style={{ fontSize: 12 }}>
      {statusBadge(stats?.current_status ?? detail.status)}
      {pausedUntil ? (
        <>
          {" "}
          <span className="badge warning">
            Paused until {fmtDate(detail.paused_until)} · excluded from new
            queue admission
          </span>
        </>
      ) : detail.frequency_preference === "paused" ? (
        <>
          {" "}
          <span className="badge warning">
            Paused · excluded from new queue admission until reactivated
          </span>
        </>
      ) : null}{" "}
      · Profile added{" "}
      {fmtDate(stats?.subscribed_at ?? detail.created_at ?? detail.joined_at)}
      {stats?.last_active_at ? (
        <>
          {" · "}Last active {relativeSubscriberTime(stats.last_active_at)}
        </>
      ) : null}
    </div>
  );
}

function JurisdictionBanner({
  detail,
  canMutate,
  mutations,
}: {
  detail: SubscriberDetail;
  canMutate: boolean;
  mutations: SubscriberDetailMutationController;
}): ReactElement | null {
  const [decision, setDecision] = useState<"accepted" | "declined" | null>(
    null,
  );
  const [policyVersion, setPolicyVersion] = useState("");
  const [capturedText, setCapturedText] = useState("");
  const [evidenceConfirmed, setEvidenceConfirmed] = useState(false);
  if (!detail.jurisdiction_reconfirm_required) return null;
  const regime = regimeForJurisdiction(
    detail.detected_jurisdiction,
    detail.region,
  );
  const policyRunes = Array.from(policyVersion.trim()).length;
  const policyBytes = new TextEncoder().encode(policyVersion.trim()).length;
  const capturedRunes = Array.from(capturedText).length;
  const capturedBytes = new TextEncoder().encode(capturedText).length;
  const forbiddenPolicyControl = /[\p{Cc}\p{Cf}]/u.test(policyVersion);
  const forbiddenCapturedControl =
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}]/u.test(
      capturedText,
    );
  const reviewedSubscriberVersion = isExactSubscriberVersion(detail.version)
    ? detail.version
    : null;
  const policyError =
    policyVersion.trim() === ""
      ? "Enter the exact reviewed privacy-policy version."
      : policyRunes > 100 || policyBytes > 100
        ? "Use no more than 100 characters and 100 UTF-8 bytes."
        : forbiddenPolicyControl
          ? "Remove control or invisible formatting characters."
          : null;
  const capturedError =
    capturedText.trim() === ""
      ? "Paste the exact consent copy shown to the subject."
      : capturedRunes > 8192 || capturedBytes > 16 * 1024
        ? "Use no more than 8,192 characters and 16 KiB of UTF-8 text."
        : forbiddenCapturedControl
          ? "Remove control or invisible formatting characters; line breaks and tabs are allowed."
          : null;
  const stateError =
    regime === "unknown"
      ? "The detected jurisdiction does not map to a supported strict consent regime. Refresh the profile or contact support."
      : !detail.jurisdiction_changed_at
        ? "The one-time jurisdiction-change timestamp is missing. Refresh the profile before recording evidence."
        : !reviewedSubscriberVersion
          ? "The exact subscriber revision is missing or invalid. Refresh the profile before recording evidence."
          : null;
  const canSubmit =
    canMutate &&
    decision != null &&
    !policyError &&
    !capturedError &&
    !stateError &&
    evidenceConfirmed &&
    !mutations.jurisdictionBusy;
  return (
    <div
      role="alert"
      style={{
        border: "1px solid var(--pw-warning)",
        borderRadius: 6,
        padding: 10,
        margin: "4px 0 10px",
        background: "color-mix(in srgb, var(--pw-warning) 10%, transparent)",
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          marginBottom: 4,
          color: "var(--pw-fg)",
        }}
      >
        Jurisdiction changed — re-confirmation required
      </div>
      <p
        style={{
          fontSize: 12,
          margin: "0 0 8px",
          color: "var(--pw-fg-muted)",
        }}
      >
        {detail.detected_jurisdiction
          ? `Jurisdiction changed to ${detail.detected_jurisdiction}. `
          : "Jurisdiction changed. "}
        Re-confirmation required for{" "}
        {regulationsForJurisdiction(
          detail.detected_jurisdiction,
          detail.region,
        )}
        .
      </p>
      {stateError ? (
        <Notice tone="warning" title="Evidence cannot be recorded safely">
          {stateError}
        </Notice>
      ) : decision == null ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setDecision("accepted")}
            disabled={!canMutate || mutations.jurisdictionBusy}
          >
            Record subject acceptance
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setDecision("declined")}
            disabled={!canMutate || mutations.jurisdictionBusy}
          >
            Record subject decline
          </button>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gap: 10,
            paddingTop: 8,
            borderTop: "1px solid var(--pw-border)",
          }}
        >
          <Notice
            tone={decision === "accepted" ? "neutral" : "warning"}
            title={
              decision === "accepted"
                ? "Record acceptance evidence"
                : "Record decline evidence"
            }
          >
            This records the subject&apos;s decision; it does not let an
            operator consent on their behalf. Paste the exact disclosure they
            reviewed.
          </Notice>
          <FormField
            label="Privacy-policy version"
            required
            help="Use the immutable version or release identifier for the disclosure shown."
            error={policyError}
          >
            <input
              className="input"
              value={policyVersion}
              autoComplete="off"
              disabled={mutations.jurisdictionBusy}
              onChange={(event) => setPolicyVersion(event.target.value)}
              placeholder="e.g. privacy-2026-07-01"
            />
          </FormField>
          <FormField
            label="Exact consent disclosure shown to the subject"
            required
            help={`${capturedRunes.toLocaleString()} / 8,192 characters · ${capturedBytes.toLocaleString()} / 16,384 UTF-8 bytes`}
            error={capturedError}
          >
            <textarea
              className="input"
              rows={6}
              value={capturedText}
              spellCheck={false}
              disabled={mutations.jurisdictionBusy}
              onChange={(event) => setCapturedText(event.target.value)}
              placeholder="Paste the precise consent copy, including material purpose and channel terms."
            />
          </FormField>
          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              fontSize: 12,
            }}
          >
            <input
              type="checkbox"
              checked={evidenceConfirmed}
              disabled={mutations.jurisdictionBusy}
              onChange={(event) => setEvidenceConfirmed(event.target.checked)}
            />
            <span>
              I verified that this exact copy was shown to the subject and the
              selected decision reflects their explicit response.
            </span>
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className={decision === "accepted" ? "btn btn-primary" : "btn"}
              disabled={!canSubmit}
              onClick={() => {
                if (!canSubmit || regime === "unknown") return;
                void mutations.reconfirmJurisdiction({
                  decision,
                  regime,
                  privacy_policy_version: policyVersion.trim(),
                  captured_text: capturedText,
                  // Preserve the raw server precision for the one-time CAS.
                  expected_jurisdiction_changed_at:
                    detail.jurisdiction_changed_at!,
                  // Bind the legal copy and decision to the exact profile,
                  // including its canonical email, that the operator reviewed.
                  expected_subscriber_version: reviewedSubscriberVersion!,
                });
              }}
            >
              {mutations.jurisdictionBusy
                ? "Recording evidence…"
                : decision === "accepted"
                  ? "Record accepted decision"
                  : "Record declined decision"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={mutations.jurisdictionBusy}
              onClick={() => {
                setDecision(null);
                setEvidenceConfirmed(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {!canMutate ? (
        <p className="muted" style={{ fontSize: 11, margin: "6px 0 0" }}>
          A write-enabled role is required to record a fresh consent decision.
        </p>
      ) : (
        <p className="muted" style={{ fontSize: 11, margin: "6px 0 0" }}>
          Acceptance can restore send eligibility; decline removes email
          consent. Both decisions create immutable consent and audit evidence.
        </p>
      )}
    </div>
  );
}

function subscriberDetailGroupFor(
  tabId: SubscriberDetailTabId,
): SubscriberDetailGroup {
  return (
    SUBSCRIBER_DETAIL_GROUPS.find((group) =>
      group.items.some((item) => item.id === tabId),
    ) ?? SUBSCRIBER_DETAIL_GROUPS[0]!
  );
}

function subscriberTabUnavailableReason(
  tabId: SubscriberDetailTabId,
  presentation: PresentationProps,
): string | null {
  const { data, source } = presentation;
  if (tabId === "referrals" && source.subscriber.id == null) {
    return "A durable subscriber ID is required for referral progress.";
  }
  if (
    ["attributeHistory", "customObjects", "piiFindings", "decisions"].includes(
      tabId,
    ) &&
    data.id == null
  ) {
    return "A durable subscriber ID is required for this section.";
  }
  if (tabId === "attributeHistory" && data.attrHistoryUnavailable) {
    return "Attribute history isn't supported by this deployment.";
  }
  if (tabId === "customObjects" && data.customObjectsUnavailable) {
    return "Custom objects aren't supported by this deployment.";
  }
  if (tabId === "piiFindings" && data.piiFindingsUnavailable) {
    return "PII findings aren't supported by this deployment.";
  }
  if (tabId === "decisions" && data.decisionsUnavailable) {
    return "Segment decisions aren't supported by this deployment.";
  }
  return null;
}

function firstAvailableGroupTab(
  group: SubscriberDetailGroup,
  presentation: PresentationProps,
): SubscriberDetailTabId {
  return (
    group.items.find(
      (item) => subscriberTabUnavailableReason(item.id, presentation) == null,
    )?.id ?? group.items[0]!.id
  );
}

function SubscriberTabShell({
  presentation,
  initialFocusRef,
}: {
  presentation: PresentationProps;
  initialFocusRef: RefObject<HTMLButtonElement | null>;
}): ReactElement {
  const { data } = presentation;
  const rememberedTabs = useRef({ ...DEFAULT_GROUP_TABS });
  const activeGroup = subscriberDetailGroupFor(data.tab);
  const activeTabUnavailable = subscriberTabUnavailableReason(
    data.tab,
    presentation,
  );
  useEffect(() => {
    if (activeTabUnavailable == null) {
      rememberedTabs.current[activeGroup.id] = data.tab;
    }
  }, [activeGroup.id, activeTabUnavailable, data.tab]);
  const groupTabs = useTabsInteraction<SubscriberDetailGroupId>({
    value: activeGroup.id,
    items: SUBSCRIBER_DETAIL_GROUP_TAB_ITEMS,
    onChange: (groupId) => {
      const group =
        SUBSCRIBER_DETAIL_GROUPS.find(
          (candidate) => candidate.id === groupId,
        ) ?? SUBSCRIBER_DETAIL_GROUPS[0]!;
      const remembered = rememberedTabs.current[group.id];
      const next = group.items.some(
        (item) =>
          item.id === remembered &&
          subscriberTabUnavailableReason(item.id, presentation) == null,
      )
        ? remembered
        : firstAvailableGroupTab(group, presentation);
      rememberedTabs.current[group.id] = next;
      data.setTab(next);
    },
    activation: "manual",
  });
  return (
    <>
      <div
        ref={groupTabs.listRef}
        {...groupTabs.listProps}
        className="tabs subscriber-detail-group-tabs"
        aria-label="Subscriber detail groups"
        style={{ margin: "12px 0 8px", overflowX: "auto" }}
      >
        {SUBSCRIBER_DETAIL_GROUPS.map((group) => (
          <button
            key={group.id}
            type="button"
            {...groupTabs.getTabProps(group.id)}
            className={`tab ${activeGroup.id === group.id ? "is-active" : ""}`}
            style={{ minHeight: 34 }}
          >
            {group.label}
          </button>
        ))}
      </div>
      {SUBSCRIBER_DETAIL_GROUPS.map((group) => (
        <section
          key={group.id}
          {...groupTabs.getPanelProps(group.id)}
          tabIndex={-1}
        >
          <SubscriberLeafTabs
            presentation={presentation}
            group={group}
            active={activeGroup.id === group.id}
            rememberedTab={rememberedTabs.current[group.id]}
            initialFocusRef={initialFocusRef}
            onTabChange={(tabId) => {
              rememberedTabs.current[group.id] = tabId;
              data.setTab(tabId);
            }}
          />
        </section>
      ))}
    </>
  );
}

function SubscriberLeafTabs({
  presentation,
  group,
  active,
  rememberedTab,
  initialFocusRef,
  onTabChange,
}: {
  presentation: PresentationProps;
  group: SubscriberDetailGroup;
  active: boolean;
  rememberedTab: SubscriberDetailTabId;
  initialFocusRef: RefObject<HTMLButtonElement | null>;
  onTabChange: (tabId: SubscriberDetailTabId) => void;
}): ReactElement {
  const { data } = presentation;
  const availabilityId = useId();
  const leafListRef = useRef<HTMLDivElement | null>(null);
  const items = group.items.map((item) => ({
    value: item.id,
    disabled: subscriberTabUnavailableReason(item.id, presentation) != null,
  }));
  const requestedTab = active ? data.tab : rememberedTab;
  const selectedTab = items.some(
    (item) => item.value === requestedTab && !item.disabled,
  )
    ? requestedTab
    : firstAvailableGroupTab(group, presentation);
  useLayoutEffect(() => {
    if (!active || data.tab === selectedTab) return;
    const focusWasInLeafList =
      document.activeElement instanceof HTMLElement &&
      leafListRef.current?.contains(document.activeElement);
    data.setTab(selectedTab);
    if (focusWasInLeafList) {
      leafListRef.current
        ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        ?.focus();
    }
  }, [active, data.setTab, data.tab, selectedTab]);
  const tabs = useTabsInteraction<SubscriberDetailTabId>({
    value: selectedTab,
    items,
    onChange: onTabChange,
    activation: "manual",
  });
  return (
    <>
      <div className="subscriber-detail-group-context">
        <div className="label">{group.label}</div>
        <div className="muted" style={{ fontSize: 11 }}>
          {group.description}
        </div>
      </div>
      <div
        ref={(node) => {
          leafListRef.current = node;
          tabs.listRef(node);
        }}
        {...tabs.listProps}
        className="tabs subscriber-detail-tabs"
        aria-label={`${group.label} sections`}
        style={{ margin: "8px 0", overflowX: "auto" }}
      >
        {group.items.map((item) => {
          const unavailableReason = subscriberTabUnavailableReason(
            item.id,
            presentation,
          );
          const reasonId = `${availabilityId}-${item.id}`;
          return (
            <button
              key={item.id}
              ref={
                active && selectedTab === item.id ? initialFocusRef : undefined
              }
              type="button"
              {...tabs.getTabProps(item.id)}
              disabled={unavailableReason != null}
              aria-describedby={unavailableReason ? reasonId : undefined}
              className={`tab ${selectedTab === item.id ? "is-active" : ""}`}
              style={{ flex: "0 0 auto", minHeight: 32 }}
            >
              {item.label}
              {unavailableReason ? (
                <span className="muted"> · Unavailable</span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="visually-hidden">
        {group.items.map((item) => {
          const unavailableReason = subscriberTabUnavailableReason(
            item.id,
            presentation,
          );
          return unavailableReason ? (
            <span key={item.id} id={`${availabilityId}-${item.id}`}>
              {unavailableReason}
            </span>
          ) : null;
        })}
      </div>
      {group.items.map((item) => {
        const unavailableReason = subscriberTabUnavailableReason(
          item.id,
          presentation,
        );
        return (
          <section key={item.id} {...tabs.getPanelProps(item.id)}>
            {unavailableReason ? (
              <div className="pw-chart-empty">{unavailableReason}</div>
            ) : (
              <SubscriberTabContent
                presentation={presentation}
                tabId={item.id}
              />
            )}
          </section>
        );
      })}
    </>
  );
}

function EngagementGauge({ score }: { score: number }): ReactElement {
  const clamped = Math.max(0, Math.min(1, score));
  const percentage = Math.round(clamped * 100);
  const band = clamped >= 0.6 ? "high" : clamped >= 0.3 ? "moderate" : "low";
  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  const dash = circumference * clamped;
  const tone =
    clamped >= 0.6
      ? "var(--pw-success)"
      : clamped >= 0.3
        ? "var(--pw-warning)"
        : "var(--pw-danger)";
  return (
    <div
      role="meter"
      aria-label="Engagement score"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percentage}
      aria-valuetext={`${percentage}%, ${band} engagement`}
      style={{ width: 56, height: 56 }}
    >
      <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">
        <circle
          cx="28"
          cy="28"
          r={radius}
          fill="none"
          stroke="var(--pw-border)"
          strokeWidth="5"
        />
        <circle
          cx="28"
          cy="28"
          r={radius}
          fill="none"
          stroke={tone}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          transform="rotate(-90 28 28)"
        />
        <text
          x="28"
          y="32"
          textAnchor="middle"
          fontSize="13"
          fill="currentColor"
          fontWeight={600}
        >
          {percentage}
        </text>
      </svg>
    </div>
  );
}

function StatsGrid({
  stats,
}: {
  stats: SubscriberTimelineStats;
}): ReactElement {
  const cells = [
    ["Sent", formatCount(stats.sent_count)],
    ["Opened", formatCount(stats.opened_count), formatPercent(stats.open_rate)],
    [
      "Clicked",
      formatCount(stats.clicked_count),
      formatPercent(stats.click_rate),
    ],
    ["Replied", formatCount(stats.replied_count)],
    ["Bounced", formatCount(stats.bounced_count)],
  ];
  return (
    <div
      className="stat-grid"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(64px, 1fr))",
        gap: 8,
        margin: "8px 0",
      }}
    >
      {cells.map(([label, value, sub]) => (
        <div key={label} className="stat-cell">
          <div className="muted" style={{ fontSize: 11 }}>
            {label}
          </div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{value}</div>
          {sub ? (
            <div className="muted" style={{ fontSize: 11 }}>
              {sub}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function SubscriberTabContent({
  presentation,
  tabId,
}: {
  presentation: PresentationProps;
  tabId: SubscriberDetailTabId;
}): ReactElement | null {
  const { source, data, canMutate, canAdmin } = presentation;
  if (tabId === "profile") {
    return (
      <SubscriberProfilePanel
        active={data.tab === "profile"}
        subscriberId={data.id}
        detail={data.detail}
        canMutate={canMutate}
        onPersistedDetailChange={(updated) => {
          data.setDetail(updated);
          source.onChange?.(updated);
        }}
        onRefreshDetail={data.reloadDetail}
        formatRelativeTime={relativeSubscriberTime}
      />
    );
  }
  if (tabId === "lists") {
    return (
      <SubscriberListsPanel
        active={data.tab === "lists"}
        subscriberId={data.id}
        subscriberEmail={data.detail.email}
        detail={data.detail}
        canMutate={canMutate}
        onDetailChange={data.setDetail}
        onPersistedDetailChange={(updated, patch) => {
          source.onChange?.(
            updated,
            patch ? { kind: "patch", delta: patch } : undefined,
          );
        }}
      />
    );
  }
  if (tabId === "notes") {
    return (
      <SubscriberNotesPanel
        active={data.tab === "notes"}
        subscriberId={data.id}
        canMutate={canMutate}
        canAdmin={canAdmin}
        formatRelativeTime={relativeSubscriberTime}
      />
    );
  }
  if (data.tab !== tabId) return null;
  return <ActiveTabPanel presentation={presentation} />;
}

function ActiveTabPanel({
  presentation,
}: {
  presentation: PresentationProps;
}): ReactElement | null {
  const { source, data, canMutate, canAdmin } = presentation;
  switch (data.tab) {
    case "timeline":
      return <TimelineTab data={data} />;
    case "privacy":
      return <PrivacyTab presentation={presentation} />;
    case "history":
      return <HistoryTab data={data} />;
    case "attributeHistory":
      return data.id == null ? null : (
        <div>
          <div className="label">Attribute history</div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
            Before/after log of changes to status, custom fields, and other
            mutable attributes. Tag changes live in the History tab.
          </div>
          <AttributeHistoryTimeline
            subscriberId={data.id}
            onUnavailable={() => data.setAttrHistoryUnavailable(true)}
          />
        </div>
      );
    case "customObjects":
      return data.id == null ? null : (
        <div>
          <div className="label">Custom objects</div>
          <SubscriberCustomObjectLinks
            subscriberId={data.id}
            canMutate={canMutate}
            onUnavailable={() => data.setCustomObjectsUnavailable(true)}
          />
        </div>
      );
    case "piiFindings":
      return data.id == null ? null : (
        <PIIFindingsPanel
          subscriberId={String(data.id)}
          canAdmin={canAdmin}
          onUnavailable={() => data.setPiiFindingsUnavailable(true)}
        />
      );
    case "decisions":
      return data.id == null ? null : (
        <SegmentDecisionsPanel
          subscriberId={String(data.id)}
          onUnavailable={() => data.setDecisionsUnavailable(true)}
        />
      );
    case "engagement":
      return <EngagementTab data={data} />;
    case "predictive":
      return data.detail.email ? (
        <RFMProfileCard email={data.detail.email} />
      ) : (
        <div className="pw-chart-empty">
          This subscriber has no email address, so no predictive profile can be
          looked up.
        </div>
      );
    case "referrals":
      return source.subscriber.id == null ? null : (
        <ReferralProgressPanel subscriberId={source.subscriber.id} />
      );
    case "preferences":
      return (
        <PreferencesPanel
          email={data.detail.email}
          topics={data.detail.preference_topics}
          canMutate={canMutate}
        />
      );
    case "profile":
    case "lists":
    case "notes":
      return null;
  }
}

function TimelineTab({
  data,
}: {
  data: SubscriberDetailDataController;
}): ReactElement {
  const channelOptions: readonly ChoiceGroupOption<"all" | "email">[] = [
    {
      value: "all",
      label: "All channels",
      description: data.crossChannelUnavailable
        ? "Cross-channel timeline isn't available on this deployment."
        : "Merge email and SMS activity, newest first.",
      ...(data.crossChannelUnavailable ? { unavailable: true } : {}),
    },
    {
      value: "email",
      label: "Email only",
      description: "Show only email activity for this subscriber.",
    },
  ];
  return (
    <div>
      <ChoiceGroup
        legend="Timeline channels"
        value={data.channelMode}
        options={channelOptions}
        onChange={data.setChannelMode}
        className="chips"
        optionClassName="chip"
        style={{ marginBottom: 8 }}
      />
      {data.crossChannelUnavailable ? (
        <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
          Cross-channel timeline unavailable — showing email events only.
        </div>
      ) : null}
      {data.channelMode === "all" && !data.crossChannelUnavailable ? (
        <CrossChannelTimeline
          subscriberIdOrEmail={
            data.id != null ? String(data.id) : (data.detail.email ?? "")
          }
          onUnavailable={() => {
            data.setCrossChannelUnavailable(true);
            data.setChannelMode("email");
          }}
        />
      ) : data.timelineUnavailable ? (
        <LegacyTimeline data={data} />
      ) : data.id != null ? (
        <Timeline
          subscriberId={data.id}
          onUnavailable={() => data.setTimelineUnavailable(true)}
        />
      ) : null}
    </div>
  );
}

function LegacyTimeline({
  data,
}: {
  data: SubscriberDetailDataController;
}): ReactElement {
  return (
    <>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
        Activity timeline unavailable — showing legacy view.
      </div>
      {data.legacyActivityLoading ? (
        <div role="status" className="muted" style={{ fontSize: 12 }}>
          Loading legacy activity…
        </div>
      ) : data.legacyActivity && data.legacyActivity.length > 0 ? (
        <ol className="timeline">
          {data.legacyActivity.slice(0, 25).map((event, index) => (
            <TimelineEvent
              key={String(event.id ?? `${event.type}-${event.at}-${index}`)}
              event={{
                type: event.type,
                occurred_at: event.at,
                campaign_id: event.campaign_id,
                subject: event.campaign_name,
                source: "activity",
                detail: event.link_url
                  ? { link_url: event.link_url }
                  : undefined,
              }}
            />
          ))}
        </ol>
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>
          No activity recorded.
        </div>
      )}
    </>
  );
}

function PrivacyTab({
  presentation,
}: {
  presentation: PresentationProps;
}): ReactElement {
  const { data, mutations, canAdmin } = presentation;
  const normalizedEmail = (data.detail.email ?? "").trim().toLowerCase();
  const erasureConfirmed =
    mutations.eraseConfirm.trim().toLowerCase() === normalizedEmail;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {!canAdmin ? (
        <Notice tone="neutral" title="Admin access required">
          Exporting or permanently erasing subscriber data requires an
          admin-scoped session. The controls remain visible so the restriction
          is explicit.
        </Notice>
      ) : null}
      <section>
        <div className="label">
          Subject Access Request (GDPR Article 15 / CCPA)
        </div>
        <p className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
          Build a Moosewave access bundle and read matching records from
          connected stores. This is read-only: provider auto-delete policies are
          ignored.
        </p>
        <button
          type="button"
          className="btn"
          onClick={() => mutations.openDsarModal("access")}
          disabled={!canAdmin}
        >
          <span aria-hidden="true" style={{ marginRight: 6 }}>
            ⬇
          </span>
          Export this subscriber&apos;s data
        </button>
      </section>
      <section>
        <div className="label">Right to Erasure (GDPR Article 17)</div>
        <p className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
          Permanently anonymize or delete Moosewave-managed subscriber data.
          Connected commerce stores are not changed by this action and must be
          handled separately. This cannot be undone.
        </p>
        <div style={{ marginBottom: 8 }}>
          <FormField
            label={`Type the email to confirm: ${data.detail.email ?? ""}`}
            error={null}
          >
            <input
              className="input"
              value={mutations.eraseConfirm}
              disabled={!canAdmin}
              placeholder={data.detail.email ?? ""}
              autoComplete="off"
              onChange={(event) =>
                mutations.setEraseConfirm(event.target.value)
              }
            />
          </FormField>
        </div>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            mutations.openDsarModal("erase");
            mutations.setEraseConfirm("");
          }}
          disabled={!canAdmin || !erasureConfirmed}
        >
          Permanently erase Moosewave data
        </button>
        {!canAdmin ? (
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            Erasure is restricted to admin-scoped sessions.
          </div>
        ) : null}
      </section>
    </div>
  );
}

function HistoryTab({
  data,
}: {
  data: SubscriberDetailDataController;
}): ReactElement {
  return (
    <div>
      <div className="label">Contact history</div>
      {data.historyError ? (
        <Notice
          tone="warning"
          title="Contact history unavailable"
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={data.reloadHistory}
              disabled={data.historyLoading}
            >
              Retry
            </button>
          }
        >
          {data.historyError}
        </Notice>
      ) : data.historyLoading || data.history == null ? (
        <div
          className="muted"
          style={{ fontSize: 12 }}
          role="status"
          aria-busy="true"
        >
          Loading contact history…
        </div>
      ) : data.history.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          No history events recorded.
        </div>
      ) : (
        <>
          <ol
            className="timeline"
            style={{ display: "flex", flexDirection: "column", gap: 6 }}
          >
            {data.history.map((event) => {
              const display = subscriberHistoryDisplay(event);
              return (
                <li
                  key={event.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr) auto",
                    gap: 8,
                    padding: "8px 10px",
                    background: "var(--pw-bg-elev-2)",
                    borderRadius: 4,
                    fontSize: 12,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600 }}>{display.title}</div>
                    {display.details.length > 0 ? (
                      <dl
                        className="muted"
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "2px 12px",
                          margin: "3px 0 0",
                          fontSize: 11,
                        }}
                      >
                        {display.details.map((detail) => (
                          <div
                            key={detail.label}
                            style={{ display: "flex", gap: 4 }}
                          >
                            <dt>{detail.label}:</dt>
                            <dd style={{ margin: 0 }}>{detail.value}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                    {display.detailsHidden ? (
                      <div
                        className="muted"
                        style={{ fontSize: 11, marginTop: 3 }}
                      >
                        Additional event details are hidden by the privacy
                        policy.
                      </div>
                    ) : null}
                  </div>
                  <time
                    className="muted tabular"
                    style={{ fontSize: 11, whiteSpace: "nowrap" }}
                    dateTime={event.at}
                  >
                    {relativeSubscriberTime(event.at)}
                  </time>
                </li>
              );
            })}
          </ol>
          {data.historyLoadMoreError ? (
            <Notice tone="warning" title="Older history could not be loaded">
              {data.historyLoadMoreError}
            </Notice>
          ) : null}
          {data.historyHasMore ? (
            <button
              type="button"
              className="btn btn-sm"
              style={{ marginTop: 8 }}
              onClick={() => void data.loadMoreHistory()}
              disabled={data.historyLoadingMore}
              aria-busy={data.historyLoadingMore}
            >
              {data.historyLoadingMore
                ? "Loading older events…"
                : "Load older events"}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function EngagementTab({
  data,
}: {
  data: SubscriberDetailDataController;
}): ReactElement {
  const lastEngagementDate = data.sparkPoints.at(-1)?.date;
  return (
    <div>
      <div className="label">Last 90 days</div>
      <EngagementSparkline
        points={data.sparkPoints}
        provenance={{
          source: "Moosewave subscriber engagement timeline",
          asOf: lastEngagementDate ?? null,
          scope: "Selected subscriber · trailing 90 days",
        }}
        exportFileName="subscriber-engagement-90d.csv"
        exportPrivacy="confidential"
      />
      {data.contactPerfState !== "unavailable" ? (
        <ContactPerformance data={data} />
      ) : (
        <Notice
          tone="warning"
          title="Contact performance unavailable"
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={data.reloadContactPerformance}
            >
              Retry
            </button>
          }
        >
          The last verified engagement chart remains visible. Retry to load
          recipient-level counters and revenue evidence.
        </Notice>
      )}
    </div>
  );
}

function ContactPerformance({
  data,
}: {
  data: SubscriberDetailDataController;
}): ReactElement {
  const performance = data.contactPerf;
  if (data.contactPerfState === "loading" || data.contactPerfState === "idle") {
    return <div className="skel" style={{ height: 64, marginTop: 6 }} />;
  }
  return performance ? (
    <ContactPerformanceCard performance={performance} />
  ) : (
    <></>
  );
}

function SubscriberActions({
  presentation,
  onOpenStatusConsent,
}: {
  presentation: PresentationProps;
  onOpenStatusConsent: () => void;
}): ReactElement {
  const { data, mutations, canMutate, canAdmin } = presentation;
  const guidanceId = "subscriber-action-guidance";
  const suppressed = isSuppressedStatus(data.detail.status);
  const uiStatus = engineStatusToUi(data.detail.status);
  const canReviewEnable =
    uiStatus !== "subscribed" &&
    uiStatus !== "unknown" &&
    !data.detail.archived_at &&
    data.id != null;
  return (
    <div
      className="sub-detail-actions"
      style={{ borderTop: 0, paddingTop: 0, flexWrap: "wrap" }}
    >
      <button
        type="button"
        className="btn"
        disabled={
          mutations.actionBusy || !canMutate || data.loadingDetail || suppressed
        }
        onClick={() => mutations.setConfirmSuppressOpen(true)}
        aria-describedby={guidanceId}
      >
        {suppressed ? "Suppressed" : "Suppress"}
      </button>
      {canReviewEnable ? (
        <button
          type="button"
          className="btn btn-primary"
          disabled={
            mutations.actionBusy ||
            !canMutate ||
            data.loadingDetail ||
            !data.detail.version?.trim()
          }
          onClick={onOpenStatusConsent}
          aria-describedby={guidanceId}
        >
          {uiStatus === "unconfirmed"
            ? "Review consent & confirm"
            : "Review consent & enable"}
        </button>
      ) : null}
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => {
          void requestDesktopRouteNavigation({
            section: "suppressions",
            query: data.detail.email ?? "",
          });
        }}
      >
        Manage suppressions
      </button>
      {canAdmin ? (
        <button
          type="button"
          className="btn"
          disabled={mutations.dsarBusy || data.loadingDetail || data.id == null}
          onClick={() => void mutations.exportDsar()}
          aria-describedby={guidanceId}
        >
          {mutations.dsarBusy ? "Exporting…" : "Export DSAR"}
        </button>
      ) : null}
      {data.detail.archived_at ? (
        <button
          type="button"
          className="btn"
          disabled={mutations.actionBusy || !canMutate || data.loadingDetail}
          onClick={() => void mutations.unarchiveSubscriber()}
          aria-describedby={guidanceId}
        >
          {mutations.actionBusy ? "Restoring…" : "Restore"}
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-danger"
          disabled={mutations.actionBusy || !canMutate || data.loadingDetail}
          onClick={() => mutations.setConfirmDeleteOpen(true)}
          aria-describedby={guidanceId}
        >
          Archive
        </button>
      )}
      <p
        id={guidanceId}
        className="muted"
        style={{ flexBasis: "100%", fontSize: 11, margin: 0 }}
      >
        {!canMutate
          ? "A write-enabled role is required for subscriber state changes."
          : data.detail.archived_at
            ? "Suppress blocks all sends and is reversible from Suppressions. Restore returns this subscriber to the active list."
            : "Suppress blocks all sends and is reversible from Suppressions. Archive hides the subscriber but preserves the row and history."}
        {canReviewEnable
          ? data.detail.version?.trim()
            ? " Enabling requires a reviewed, exact-address email-consent record and never clears independent suppressions."
            : " Refresh this profile before enabling so its latest exact revision can be verified."
          : ""}
        {canAdmin
          ? " DSAR export downloads a confidential ZIP and can take about 30 seconds."
          : ""}
      </p>
    </div>
  );
}

function SubscriberDetailModals({
  data,
  mutations,
}: Pick<PresentationProps, "data" | "mutations">): ReactElement {
  return (
    <>
      <ConfirmModal
        open={mutations.confirmSuppressOpen}
        title="Suppress this subscriber?"
        description={`${data.detail.email ?? "This subscriber"} will be blocked from all future sends in this workspace. Their profile and history remain intact, and an authorized operator can reverse this from Suppressions.`}
        confirmLabel="Suppress subscriber"
        danger
        busy={mutations.actionBusy}
        onClose={() => mutations.setConfirmSuppressOpen(false)}
        onConfirm={() => void mutations.suppress()}
      />
      <ConfirmModal
        open={mutations.confirmDeleteOpen}
        title="Archive subscriber?"
        description="Reversibly hides this subscriber from the active list. The row and its history are preserved (audit-join keys survive) and can be restored later from the archived view. This is NOT a permanent erase."
        confirmLabel="Archive subscriber"
        danger
        busy={mutations.actionBusy}
        onClose={() => mutations.setConfirmDeleteOpen(false)}
        onConfirm={() => void mutations.archiveSubscriber()}
      />
      {mutations.dsarModal && data.id != null ? (
        <DSARModal
          key={mutations.dsarModalNonce}
          open
          operation={mutations.dsarModal}
          subscriberId={String(data.id)}
          email={data.detail.email ?? ""}
          onClose={mutations.closeDsarModal}
        />
      ) : null}
    </>
  );
}
