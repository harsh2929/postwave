/**
 * LandingPageDetailSheet — the public link, and the leads the page captured.
 *
 * A SHEET RATHER THAN A ROUTE, for the reasons AgentRoutineDetailSheet is one:
 * the rhythm is open → read → maybe copy the link → close, a pushed screen
 * charges a navigation animation each way, and it keeps this surface to ONE
 * route file (one tab-layout registration instead of two).
 *
 * THE LINK IS OFFERED ONLY WHEN IT RESOLVES. `Repo.PublicLandingPage` serves
 * `status = 'published'` rows and nothing else, so a draft's URL is a 404.
 * `publicLandingUrl` returns null for anything not live and the sheet then
 * explains the absence instead of handing over a link that would be pasted
 * into an ad and quietly fail. The `domain` column is shown as a recorded fact
 * rather than turned into a URL, because no resolver in the API reads it.
 *
 * THE LEAD COUNT IS ONLY CLAIMED ONCE IT IS KNOWN. Until the leads request
 * settles the count is an em-dash, never 0 — and a FAILED request renders as an
 * error, never as "no leads", which would read as a working page nobody filled
 * in.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useCallback, useMemo, type ReactNode } from "react";
import {
  FlatList,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { LandingPageAdminActions } from "@/components/landing-pages/LandingPageAdminActions";
import { Pill } from "@/components/Pill";
import { QueryStates, type QueryLike } from "@/components/QueryStates";
import { SkeletonList } from "@/components/Skeleton";
import { LandingLeadRow } from "@/components/landing-pages/LandingLeadRow";
import { LandingPublicLinkCard } from "@/components/landing-pages/LandingPublicLinkCard";
import { FONT } from "@/lib/fonts";
import { dateTime, EMDASH, exact, num, plural, relativeTime } from "@/lib/format";
import {
  hasAnyMetric,
  landingMetrics,
  landingStatusPresentation,
  leadsTruncated,
  LEADS_LIMIT,
  type MobileLandingPage,
  type MobileLead,
} from "@/lib/landingPages";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

export interface LandingPageDetailSheetProps {
  page: MobileLandingPage | null;
  leads: readonly MobileLead[];
  leadsQuery: QueryLike;
  /** The online/auth gate, so the leads list can say "offline", not "empty". */
  gate: { enabled: boolean };
  now: number;
  onClose: () => void;
  /** Absolute public URL, or null when the page is not served publicly. */
  publicUrl: string | null;
  onCopyUrl: (url: string) => void;
  /**
   * Admin-and-up sessions get the status verb and the soft archive (every
   * landing write is ScopeAdmin server-side). False hides the affordances
   * entirely and keeps the read-only explanation in the footer.
   */
  canWrite?: boolean;
}

/**
 * A stable empty array. A fresh `[]` literal would be a new identity on every
 * render and would make FlatList re-diff its (empty) data each time.
 */
const EMPTY_LEADS: LandingPageDetailSheetProps["leads"] = [];

/** Module constant so the separator is not a new component type per render. */
function LeadSeparator() {
  return <View style={{ height: 8 }} />;
}

export function LandingPageDetailSheet(props: LandingPageDetailSheetProps) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  const page = props.page;
  const status = page ? landingStatusPresentation(page.status) : null;
  const metrics = page ? landingMetrics(page) : null;

  // The count is a claim about the page, so it waits for the request that can
  // back it. `isSuccess` (not "we have an array") is the discriminator.
  const settled = props.leadsQuery.isSuccess === true;

  /**
   * VIRTUALIZE, AND STOP THE CLOCK FROM TOUCHING EVERY ROW.
   *
   * These leads used to be a `.map()` inside a ScrollView. The server caps the
   * query at LIMIT 5000 with no cursor (lib/landingPages.ts), so a busy page
   * mounted five thousand row components at once, none of which could be
   * recycled. `LandingLeadRow` is already React.memo'd — but it takes `now`,
   * and `now` moved every second, so the memo never held and all 5,000 rows
   * re-rendered at 1 Hz.
   *
   * The clock is bucketed to the minute here for the same reason
   * `useDiscountsScreen` does it: `relativeTime` output does not change more
   * often than that for anything older than a minute, so a per-second identity
   * bought nothing and cost a full re-render. With the bucket, `renderLead` is
   * stable for 60 seconds and the memo actually works.
   */
  const nowMinute = Math.floor(props.now / 60_000) * 60_000;
  const leadRows = settled && props.leads.length > 0 ? props.leads : EMPTY_LEADS;
  const renderLead = useCallback(
    ({ item, index }: { item: MobileLead; index: number }) => (
      <LandingLeadRow key={`${item.email}-${item.at ?? index}`} lead={item} now={nowMinute} />
    ),
    [nowMinute],
  );
  const leadKey = useCallback(
    (lead: MobileLead, index: number) =>
      `${lead.email}-${lead.at ?? index}`,
    [],
  );
  const canWrite = props.canWrite === true;
  const leadsFooter = useMemo(
    () => (
      <View style={{ gap: 12, paddingTop: 12 }}>
        {leadsTruncated(props.leads.length) ? (
          <Footnote>
            Showing the {num(LEADS_LIMIT)} most recent leads — the server caps
            this list and offers no further pages.
          </Footnote>
        ) : null}
        <Footnote>
          Every lead here was also added to your audience as an unconfirmed
          subscriber at the moment it was captured.
        </Footnote>
        {canWrite ? (
          <Footnote>
            Blocks, SEO and tracking are edited in the block editor on the web
            app. Exporting leads as a CSV is a browser download — use the web
            app for it.
          </Footnote>
        ) : (
          <MobileScopeNotice
            title="Read-only for your role"
            body="Publishing, archiving and editing a page are admin-only on the server, so this app only reads for your session. Exporting leads as a CSV is a browser download and this app has no file-share sheet — use the web app for it."
          />
        )}
      </View>
    ),
    [canWrite, props.leads.length],
  );
  const countLabel = settled ? plural(props.leads.length, "lead") : EMDASH;
  const countSpoken = settled
    ? exact(props.leads.length, "leads")
    : "The lead count hasn't loaded yet.";

  return (
    <ReducedMotionModal
      visible={page !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 8,
            gap: 12,
          }}
        >
          <Text
            numberOfLines={maxLinesAtScale(2, fontScale)}
            {...typeCap("title")}
            style={{
              color: t.fg,
              ...typeStyle("title"),
              fontFamily: FONT.display,
              flexShrink: 1,
            }}
          >
            {page?.name || "Landing page"}
          </Text>
          <Pressable
            onPress={props.onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={12}
            style={{
              minHeight: 44,
              minWidth: 44,
              alignItems: "flex-end",
              justifyContent: "center",
            }}
          >
            <Text
              {...typeCap("callout")}
              style={{
                color: t.accent,
                ...typeStyle("callout"),
                fontFamily: FONT.semibold,
              }}
            >
              Close
            </Text>
          </Pressable>
        </View>

        <FlatList
          data={leadRows}
          keyExtractor={leadKey}
          renderItem={renderLead}
          ItemSeparatorComponent={LeadSeparator}
          ListFooterComponent={leadsFooter}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={7}
          removeClippedSubviews
          ListHeaderComponent={
            <View style={{ gap: 12, paddingBottom: 12 }}>
          {page && status ? (
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 6,
              }}
            >
              <Pill
                label={status.label}
                tone={status.tone}
                accessibilityLabel={
                  status.live
                    ? "Published: this page is served publicly and can capture leads."
                    : `${status.label}: this page is not served publicly, so it cannot capture leads.`
                }
              />
              {page.template ? (
                <Pill label={page.template} tone="neutral" />
              ) : null}
            </View>
          ) : null}

          {page ? (
            <SummaryLine
              label="Last edited"
              // Compacted for the eye, absolute for a screen reader — the
              // compaction is exactly what "2d ago" throws away.
              value={
                page.updatedAt
                  ? relativeTime(page.updatedAt, { now: props.now })
                  : EMDASH
              }
              spoken={
                page.updatedAt
                  ? dateTime(page.updatedAt)
                  : "No update time was recorded."
              }
            />
          ) : null}

          {page ? (
            <LandingPublicLinkCard
              page={page}
              url={props.publicUrl}
              onCopy={props.onCopyUrl}
            />
          ) : null}

          {/* Publish / unpublish / restore + the soft archive — admin only.
              This is the P1 verb: a live page with a broken offer can be
              pulled from the phone that noticed it. */}
          {page && canWrite ? <LandingPageAdminActions page={page} /> : null}

          {/*
            VIEWS ONLY, and only if the server ever measures them. `metrics` is
            `'{}'` for every row today (nothing in the API writes that column),
            so this block is normally absent rather than three em-dashes. The
            metrics-derived CONVERSION count is deliberately never rendered:
            the leads list below is the authoritative answer to "how many", and
            two different numbers for one question is worse than one number.
          */}
          {page && metrics && hasAnyMetric(metrics) && metrics.views !== null ? (
            <SummaryLine
              label="Views"
              value={num(metrics.views)}
              spoken={exact(metrics.views, "views")}
            />
          ) : null}

          <View
            style={{
              flexDirection: "row",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: 12,
              marginTop: 4,
            }}
          >
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.semibold,
                letterSpacing: 0.6,
                textTransform: "uppercase",
              }}
            >
              Leads
            </Text>
            <Text
              accessibilityLabel={countSpoken}
              {...typeCap("numeric")}
              style={{
                color: t.fgMuted,
                ...typeStyle("numeric"),
                fontFamily: FONT.medium,
              }}
            >
              {countLabel}
            </Text>
          </View>

          <QueryStates
            query={props.leadsQuery}
            gate={props.gate}
            isEmpty={props.leads.length === 0}
            offlineMessage="You're offline, so this page's leads can't be loaded. Reconnect and pull to refresh."
            skeleton={<SkeletonList rows={3} />}
            empty={emptyCopyFor(page)}
          >
            {/* QueryStates owns the loading / empty / error / offline UI and
                renders its children only in the terminal success state. The
                rows themselves are the FlatList's data, so there is nothing
                left for it to render here. */}
            {null}
          </QueryStates>
            </View>
          }
        />
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

/** Empty-state copy that distinguishes "not served" from "nobody signed up". */
function emptyCopyFor(page: MobileLandingPage | null): {
  title: string;
  description: string;
} {
  if (page && !landingStatusPresentation(page.status).live) {
    return {
      title: "Nothing captured yet",
      description:
        "This page isn't published, so Moosewave doesn't serve it and its form can't be submitted. Publish it from the web app and submissions will show up here.",
    };
  }
  return {
    title: "No leads yet",
    description:
      "Nobody has submitted this page's form. Each submission appears here as soon as it is recorded.",
  };
}

function SummaryLine({
  label,
  value,
  spoken,
}: {
  label: string;
  value: string;
  spoken: string;
}) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${spoken}`}
      style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.medium,
          flexShrink: 1,
          textAlign: "right",
        }}
      >
        {value}
      </Text>
    </View>
  );
}

function Footnote({ children }: { children: ReactNode }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
      }}
    >
      {children}
    </Text>
  );
}
