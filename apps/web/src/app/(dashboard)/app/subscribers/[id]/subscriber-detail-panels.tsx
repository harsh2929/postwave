// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";
import { useId, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  SUBSCRIBER_TIMELINE_CATEGORIES,
  type SubscriberTimeline,
  type SubscriberTimelineCategory,
} from "@/lib/subscriber-timeline-api";
import type { SubscriberAuthority } from "@/lib/subscriber-authority";
import type { Subscriber } from "@/lib/subscribers-api";

export const SUBSCRIBER_DETAIL_TAB_IDS = [
  "timeline",
  "profile",
  "lists",
  "engagement",
  "preferences",
  "notes",
  "consent",
  "audit",
] as const;
export type SubscriberDetailTabId = (typeof SUBSCRIBER_DETAIL_TAB_IDS)[number];

function PanelLoading({ label }: { label: string }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className="text-sm text-muted-foreground"
    >
      Loading {label}…
    </p>
  );
}

const TimelineList = dynamic(
  () => import("./_timeline").then((module) => module.SubscriberTimeline),
  { ssr: false, loading: () => <PanelLoading label="timeline" /> },
);
const SubscriberIdentityPanel = dynamic(
  () =>
    import("./_identity-panel").then(
      (module) => module.SubscriberIdentityPanel,
    ),
  { ssr: false, loading: () => <PanelLoading label="profile identity" /> },
);
const SubscriberPreferencesPanel = dynamic(
  () =>
    import("./_preferences-panel").then(
      (module) => module.SubscriberPreferencesPanel,
    ),
  { ssr: false, loading: () => <PanelLoading label="preferences" /> },
);
const ListsTagsPanel = dynamic(
  () => import("./_profile-panels").then((module) => module.ListsTagsPanel),
  { ssr: false, loading: () => <PanelLoading label="lists and tags" /> },
);
const NotesPanel = dynamic(
  () => import("./_profile-panels").then((module) => module.NotesPanel),
  { ssr: false, loading: () => <PanelLoading label="notes" /> },
);
const ConsentPanel = dynamic(
  () => import("./_profile-panels").then((module) => module.ConsentPanel),
  { ssr: false, loading: () => <PanelLoading label="consent" /> },
);
const AuditPanel = dynamic(
  () => import("./_profile-panels").then((module) => module.AuditPanel),
  { ssr: false, loading: () => <PanelLoading label="audit history" /> },
);
const ReceiptActions = dynamic(
  () => import("./_profile-panels").then((module) => module.ReceiptActions),
  {
    ssr: false,
    loading: () => <PanelLoading label="compliance receipts" />,
  },
);
const CrossChannelPanel = dynamic(
  () => import("./_profile-panels").then((module) => module.CrossChannelPanel),
  {
    ssr: false,
    loading: () => <PanelLoading label="cross-channel activity" />,
  },
);
const FrequencyPreferencePanel = dynamic(
  () =>
    import("./_frequency-panel").then(
      (module) => module.FrequencyPreferencePanel,
    ),
  { ssr: false, loading: () => <PanelLoading label="send frequency" /> },
);
const TrackingConsentPanel = dynamic(
  () =>
    import("./_consent-panels").then((module) => module.TrackingConsentPanel),
  { ssr: false, loading: () => <PanelLoading label="tracking preferences" /> },
);
const JurisdictionReconfirmPanel = dynamic(
  () =>
    import("./_consent-panels").then(
      (module) => module.JurisdictionReconfirmPanel,
    ),
  {
    ssr: false,
    loading: () => <PanelLoading label="jurisdiction re-confirmation" />,
  },
);
const GppSectionsPanel = dynamic(
  () => import("./_consent-panels").then((module) => module.GppSectionsPanel),
  { ssr: false, loading: () => <PanelLoading label="GPP sections" /> },
);
const ListMembershipsPanel = dynamic(
  () => import("./_data-panels").then((module) => module.ListMembershipsPanel),
  { ssr: false, loading: () => <PanelLoading label="list memberships" /> },
);
const CustomFieldValuesPanel = dynamic(
  () =>
    import("./_data-panels").then((module) => module.CustomFieldValuesPanel),
  { ssr: false, loading: () => <PanelLoading label="custom fields" /> },
);
const MergeFieldValuesPanel = dynamic(
  () => import("./_data-panels").then((module) => module.MergeFieldValuesPanel),
  { ssr: false, loading: () => <PanelLoading label="audience fields" /> },
);
const CustomObjectLinksPanel = dynamic(
  () =>
    import("./_data-panels").then((module) => module.CustomObjectLinksPanel),
  { ssr: false, loading: () => <PanelLoading label="custom objects" /> },
);
const SubscriberInsightsPanel = dynamic(
  () =>
    import("./_insights-panels").then(
      (module) => module.SubscriberInsightsPanel,
    ),
  { ssr: false, loading: () => <PanelLoading label="subscriber insights" /> },
);
const SubscriberDataExportButton = dynamic(
  () =>
    import("./_insights-panels").then(
      (module) => module.SubscriberDataExportButton,
    ),
  { ssr: false, loading: () => <PanelLoading label="data export" /> },
);
const ContactPerformanceSection = dynamic(
  () =>
    import("./_engagement-extras").then(
      (module) => module.ContactPerformanceSection,
    ),
  { ssr: false, loading: () => <PanelLoading label="contact performance" /> },
);
const SendTimesSection = dynamic(
  () =>
    import("./_engagement-extras").then((module) => module.SendTimesSection),
  { ssr: false, loading: () => <PanelLoading label="best send times" /> },
);
const PredictiveProfileSection = dynamic(
  () =>
    import("./_engagement-extras").then(
      (module) => module.PredictiveProfileSection,
    ),
  { ssr: false, loading: () => <PanelLoading label="predictive profile" /> },
);
const ActivityLogSection = dynamic(
  () =>
    import("./_engagement-extras").then((module) => module.ActivityLogSection),
  { ssr: false, loading: () => <PanelLoading label="event log" /> },
);
const SubscriberPiiFindingsPanel = dynamic(
  () =>
    import("./_pii-findings-panel").then(
      (module) => module.SubscriberPiiFindingsPanel,
    ),
  { ssr: false, loading: () => <PanelLoading label="PII findings" /> },
);

interface SubscriberDetailPanelsProps {
  tab: SubscriberDetailTabId;
  onTabChange: (tab: SubscriberDetailTabId) => void;
  timeline: SubscriberTimeline;
  record: Subscriber | undefined;
  id: string;
  tenantId: string;
  role: string | null;
  authority: SubscriberAuthority | null;
  buckets: Array<{ date: string; opens: number; clicks: number }>;
  hasMore: boolean;
  onLoadMore: () => void;
  loadingMore: boolean;
  loadMoreError: string | null;
  category: SubscriberTimelineCategory;
  onCategoryChange: (category: SubscriberTimelineCategory) => void;
  onRecordRefetch: () => void;
}

export function SubscriberDetailPanels({
  tab,
  onTabChange,
  timeline,
  record,
  id,
  tenantId,
  role,
  authority,
  buckets,
  hasMore,
  onLoadMore,
  loadingMore,
  loadMoreError,
  category,
  onCategoryChange,
  onRecordRefetch,
}: SubscriberDetailPanelsProps) {
  const [crossChannel, setCrossChannel] = useState(false);
  const timelinePanel = (
    <TimelineTab
      timeline={timeline}
      id={id}
      tenantId={tenantId}
      role={role}
      crossChannel={crossChannel}
      onToggleCrossChannel={setCrossChannel}
      hasMore={hasMore}
      onLoadMore={onLoadMore}
      loadingMore={loadingMore}
      loadMoreError={loadMoreError}
      category={category}
      onCategoryChange={onCategoryChange}
    />
  );
  const missingProfile = (
    <p className="text-sm text-muted-foreground">
      The canonical profile record must load before advanced identity data can
      be verified.
    </p>
  );
  const identityPanel = record?.id ? (
    <SubscriberIdentityPanel
      enabled
      id={record.id}
      subscriber={record}
      tenantId={tenantId}
      role={role}
      authority={authority}
      onAggregateChanged={onRecordRefetch}
    />
  ) : (
    missingProfile
  );
  const profilePanel = (
    <ProfileTab
      id={id}
      email={timeline.email}
      record={record}
      tenantId={tenantId}
      role={role}
      authority={authority}
      onRecordRefetch={onRecordRefetch}
    >
      {identityPanel}
    </ProfileTab>
  );
  const engagementPanel = (
    <div className="space-y-6">
      <SubscriberInsightsPanel
        id={record?.id ?? id}
        tenantId={tenantId}
        role={role}
        authority={authority}
      />
      <div className="border-t pt-4">
        <ContactPerformanceSection
          id={record?.id ?? id}
          tenantId={tenantId}
          role={role}
        />
      </div>
      <div className="border-t pt-4">
        <h3 className="mb-2 text-sm font-medium">Opens and clicks (90 days)</h3>
        <Sparkline buckets={buckets} />
      </div>
      <div className="border-t pt-4">
        <SendTimesSection id={record?.id ?? id} tenantId={tenantId} role={role} />
      </div>
      <div className="border-t pt-4">
        <PredictiveProfileSection
          id={record?.id ?? id}
          email={record?.email ?? timeline.email}
          tenantId={tenantId}
          role={role}
        />
      </div>
      <div className="border-t pt-4">
        <ActivityLogSection
          id={record?.id ?? id}
          tenantId={tenantId}
          role={role}
        />
      </div>
    </div>
  );
  const piiFindingsPanel = (
    <div className="mt-4 border-t pt-4">
      <SubscriberPiiFindingsPanel
        id={record?.id ?? id}
        tenantId={tenantId}
        role={role}
        authority={authority}
      />
    </div>
  );
  const notesPanel = (
    <NotesPanel id={id} enabled tenantId={tenantId} role={role} />
  );
  const listsPanel = (
    <div className="space-y-6">
      <ListMembershipsPanel
        id={record?.id ?? id}
        email={timeline.email}
        tenantId={tenantId}
        role={role}
        authority={authority}
      />
      <div className="border-t pt-4">
        <ListsTagsPanel
          id={id}
          subscriber={record}
          enabled
          onTagsChanged={onRecordRefetch}
        />
      </div>
    </div>
  );

  return (
    <>
      <div className="hidden md:block">
        <Tabs
          value={tab}
          onValueChange={(value) => onTabChange(value as SubscriberDetailTabId)}
        >
          <TabsList aria-label="Subscriber details" className="flex-wrap">
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="lists">Lists & Tags</TabsTrigger>
            <TabsTrigger value="engagement">Engagement</TabsTrigger>
            <TabsTrigger value="preferences">Preferences</TabsTrigger>
            <TabsTrigger value="notes">Notes</TabsTrigger>
            <TabsTrigger value="consent">Consent</TabsTrigger>
            <TabsTrigger value="audit">Audit</TabsTrigger>
          </TabsList>
          <TabsContent value="timeline" className="mt-4">
            {tab === "timeline" ? timelinePanel : null}
          </TabsContent>
          <TabsContent value="profile" className="mt-4">
            {tab === "profile" ? profilePanel : null}
          </TabsContent>
          <TabsContent value="lists" className="mt-4">
            {tab === "lists" ? listsPanel : null}
          </TabsContent>
          <TabsContent value="engagement" className="mt-4">
            {tab === "engagement" ? engagementPanel : null}
          </TabsContent>
          <TabsContent value="preferences" className="mt-4">
            {tab === "preferences" ? (
              <PreferencesTab
                email={timeline.email}
                record={record}
                tenantId={tenantId}
                role={role}
                authority={authority}
                onRecordRefetch={onRecordRefetch}
              />
            ) : null}
          </TabsContent>
          <TabsContent value="notes" className="mt-4">
            {tab === "notes" ? notesPanel : null}
          </TabsContent>
          <TabsContent value="consent" className="mt-4">
            {tab === "consent" ? (
              <ConsentTab
                id={id}
                record={record}
                tenantId={tenantId}
                role={role}
                authority={authority}
                onRecordRefetch={onRecordRefetch}
              />
            ) : null}
          </TabsContent>
          <TabsContent value="audit" className="mt-4 space-y-6">
            {tab === "audit" ? (
              <>
                <AuditPanel id={id} enabled tenantId={tenantId} role={role} />
                <div className="border-t pt-4">
                  <h3 className="mb-2 text-sm font-medium">
                    Compliance receipts
                  </h3>
                  <ReceiptActions id={id} email={timeline.email} />
                  <div className="mt-4">
                    <SubscriberDataExportButton
                      id={record?.id ?? id}
                      authority={authority}
                    />
                  </div>
                </div>
                {piiFindingsPanel}
              </>
            ) : null}
          </TabsContent>
        </Tabs>
      </div>

      <div className="space-y-6 md:hidden">
        <CollapsibleSection title="Timeline" defaultOpen>
          {timelinePanel}
        </CollapsibleSection>
        <CollapsibleSection title="Profile">{profilePanel}</CollapsibleSection>
        <CollapsibleSection title="Lists & Tags">{listsPanel}</CollapsibleSection>
        <CollapsibleSection title="Engagement">
          {engagementPanel}
        </CollapsibleSection>
        <CollapsibleSection title="Preferences">
          <PreferencesTab
            email={timeline.email}
            record={record}
            tenantId={tenantId}
            role={role}
            authority={authority}
            onRecordRefetch={onRecordRefetch}
          />
        </CollapsibleSection>
        <CollapsibleSection title="Notes">{notesPanel}</CollapsibleSection>
        <CollapsibleSection title="Consent">
          <ConsentTab
            id={id}
            record={record}
            tenantId={tenantId}
            role={role}
            authority={authority}
            onRecordRefetch={onRecordRefetch}
          />
        </CollapsibleSection>
        <CollapsibleSection title="Audit & compliance">
          <AuditPanel id={id} enabled tenantId={tenantId} role={role} />
          <div className="mt-4 border-t pt-4">
            <ReceiptActions id={id} email={timeline.email} />
            <div className="mt-4">
              <SubscriberDataExportButton
                id={record?.id ?? id}
                authority={authority}
              />
            </div>
          </div>
          {piiFindingsPanel}
        </CollapsibleSection>
      </div>
    </>
  );
}

/**
 * Profile tab: identity, then the subscriber's stored data — custom-field
 * values, audience (merge) field values, and linked custom-object records —
 * the sections desktop's slide-over shows beside the profile.
 */
function ProfileTab({
  id,
  email,
  record,
  tenantId,
  role,
  authority,
  onRecordRefetch,
  children,
}: {
  id: string;
  email: string;
  record: Subscriber | undefined;
  tenantId: string;
  role: string | null;
  authority: SubscriberAuthority | null;
  onRecordRefetch: () => void;
  children: ReactNode;
}) {
  const subscriberId = record?.id ?? id;
  return (
    <div className="space-y-6">
      {children}
      <div className="border-t pt-4">
        <CustomFieldValuesPanel
          id={id}
          record={record}
          email={email}
          tenantId={tenantId}
          role={role}
          authority={authority}
          onRecordRefetch={onRecordRefetch}
        />
      </div>
      <div className="border-t pt-4">
        <MergeFieldValuesPanel
          id={subscriberId}
          tenantId={tenantId}
          role={role}
          authority={authority}
        />
      </div>
      <div className="border-t pt-4">
        <CustomObjectLinksPanel
          id={subscriberId}
          email={email}
          tenantId={tenantId}
          role={role}
          authority={authority}
        />
      </div>
    </div>
  );
}

/**
 * Preferences tab: the subscriber's own send-frequency preference (an
 * operator pause of sends, SUB-132) above the administrative topic overrides.
 */
function PreferencesTab({
  email,
  record,
  tenantId,
  role,
  authority,
  onRecordRefetch,
}: {
  email: string;
  record: Subscriber | undefined;
  tenantId: string;
  role: string | null;
  authority: SubscriberAuthority | null;
  onRecordRefetch: () => void;
}) {
  return (
    <div className="space-y-6">
      <FrequencyPreferencePanel
        record={record}
        authority={authority}
        onRecordRefetch={onRecordRefetch}
      />
      <div className="border-t pt-4">
        <h3 className="mb-2 text-sm font-medium">Topic preferences</h3>
        <SubscriberPreferencesPanel
          email={email}
          tenantId={tenantId}
          role={role}
          authority={authority}
          enabled
        />
      </div>
    </div>
  );
}

/**
 * Consent tab: per-channel consent, then the one-time jurisdiction
 * re-confirmation (only while a drift is pending), tracking-pixel consent,
 * and the read-only GPP sections — the same sections desktop's slide-over
 * shows, in the same order.
 */
function ConsentTab({
  id,
  record,
  tenantId,
  role,
  authority,
  onRecordRefetch,
}: {
  id: string;
  record: Subscriber | undefined;
  tenantId: string;
  role: string | null;
  authority: SubscriberAuthority | null;
  onRecordRefetch: () => void;
}) {
  const subscriberId = record?.id ?? id;
  return (
    <div className="space-y-6">
      <section aria-label="Channel consent">
        <h3 className="mb-2 text-sm font-medium">Channel consent</h3>
        <ConsentPanel
          id={subscriberId}
          enabled
          tenantId={tenantId}
          role={role}
          authority={authority}
          country={record?.country}
          onAggregateChanged={onRecordRefetch}
        />
      </section>
      <JurisdictionReconfirmPanel
        record={record}
        authority={authority}
        onRecordRefetch={onRecordRefetch}
      />
      <section className="border-t pt-4">
        <h3 className="mb-2 text-sm font-medium">Tracking preferences</h3>
        <TrackingConsentPanel
          id={subscriberId}
          tenantId={tenantId}
          role={role}
          authority={authority}
          enabled
        />
      </section>
      <section className="border-t pt-4">
        <h3 className="mb-2 text-sm font-medium">Privacy (GPP)</h3>
        <GppSectionsPanel
          id={subscriberId}
          tenantId={tenantId}
          role={role}
          enabled
        />
      </section>
    </div>
  );
}

function TimelineTab({
  timeline,
  id,
  tenantId,
  role,
  crossChannel,
  onToggleCrossChannel,
  hasMore,
  onLoadMore,
  loadingMore,
  loadMoreError,
  category,
  onCategoryChange,
}: {
  timeline: SubscriberTimeline;
  id: string;
  tenantId: string;
  role: string | null;
  crossChannel: boolean;
  onToggleCrossChannel: (next: boolean) => void;
  hasMore: boolean;
  onLoadMore: () => void;
  loadingMore: boolean;
  loadMoreError: string | null;
  category: SubscriberTimelineCategory;
  onCategoryChange: (category: SubscriberTimelineCategory) => void;
}) {
  const categoryId = useId();
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        {!crossChannel ? (
          <div className="flex min-w-0 items-center gap-2">
            <label
              htmlFor={categoryId}
              className="shrink-0 text-sm text-muted-foreground"
            >
              Activity type
            </label>
            <Select
              id={categoryId}
              className="w-full sm:w-44"
              value={category}
              onChange={(event) =>
                onCategoryChange(
                  event.target.value as SubscriberTimelineCategory,
                )
              }
            >
              {SUBSCRIBER_TIMELINE_CATEGORIES.map((item) => (
                <option key={item} value={item}>
                  {item === "all"
                    ? "All activity"
                    : item[0]?.toUpperCase() + item.slice(1)}
                </option>
              ))}
            </Select>
          </div>
        ) : (
          <span />
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-pressed={crossChannel}
          onClick={() => onToggleCrossChannel(!crossChannel)}
        >
          {crossChannel ? "Email activity" : "Cross-channel (email + SMS)"}
        </Button>
      </div>
      {crossChannel ? (
        <CrossChannelPanel id={id} enabled tenantId={tenantId} role={role} />
      ) : (
        <TimelineList
          events={timeline.events}
          hasMore={hasMore}
          onLoadMore={onLoadMore}
          loadingMore={loadingMore}
          loadMoreError={loadMoreError}
        />
      )}
    </div>
  );
}

function Sparkline({
  buckets,
}: {
  buckets: Array<{ date: string; opens: number; clicks: number }>;
}) {
  if (buckets.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No engagement events in the last 90 days.
      </p>
    );
  }
  const width = 720;
  const height = 120;
  const maxY = Math.max(
    1,
    ...buckets.map((bucket) => Math.max(bucket.opens, bucket.clicks)),
  );
  const stepX = buckets.length > 1 ? width / (buckets.length - 1) : 0;
  const path = (key: "opens" | "clicks") =>
    buckets
      .map((point, index) => {
        const x = index * stepX;
        const y = height - (point[key] / maxY) * height;
        return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  return (
    <div data-testid="engagement-sparkline" className="w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-32 w-full"
        role="img"
        aria-label="90-day engagement sparkline"
      >
        <path
          d={path("opens")}
          stroke="hsl(var(--info))"
          strokeWidth="2"
          fill="none"
        />
        <path
          d={path("clicks")}
          stroke="hsl(var(--success))"
          strokeWidth="2"
          fill="none"
        />
      </svg>
      <div className="mt-1 flex gap-4 text-xs text-muted-foreground">
        <span style={{ color: "hsl(var(--info))" }}>● Opens</span>
        <span style={{ color: "hsl(var(--success))" }}>● Clicks</span>
      </div>
    </div>
  );
}

function CollapsibleSection({
  title,
  children,
  defaultOpen,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const contentId = useId();
  return (
    <section className="rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls={contentId}
        className="flex min-h-11 w-full items-center justify-between p-3 text-left text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span>{title}</span>
        <span aria-hidden>{open ? "−" : "+"}</span>
      </button>
      {open ? (
        <div id={contentId} className="px-3 pb-3">
          {children}
        </div>
      ) : null}
    </section>
  );
}
