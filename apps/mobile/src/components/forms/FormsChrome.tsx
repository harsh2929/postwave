/**
 * FormsChrome — the KPI strip, controls and state ladder for the forms list.
 *
 * Split out of the screen so the screen body stays a readable data-flow and so
 * the empty/loading/error ORDER is stated once. The ordering is the part that
 * most often goes wrong on a list screen: a failed fetch must never render as
 * "nothing here", and an offline session must read as offline rather than as a
 * failure.
 */
import { Pressable, Text, View } from "react-native";

import {
  CachedSessionNotice,
  type CachedSessionNoticeContent,
} from "@/components/CachedSessionNotice";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { EmptyState } from "@/components/EmptyState";
import { SearchField } from "@/components/SearchField";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SkeletonList, SkeletonStatRow } from "@/components/Skeleton";
import { StatCard } from "@/components/StatCard";
import { compactNum, num, percent, plural } from "@/lib/format";
import { conversionCaption, type FormsKpis } from "@/lib/formMetrics";

/** The forms API reports conversion as 0..100, not a 0..1 ratio. */
const PERCENT_OPTS = { alreadyPercent: true, digits: 1 } as const;

export type FormFilter = "all" | "published" | "draft" | "archived";

export function FormsKpiStrip({ kpis }: { kpis: FormsKpis }) {
  const conv = kpis.conversion;
  const rate = conv.mode === "empty" ? null : conv.rate;
  const caption = conversionCaption(conv);
  const tile = { flexGrow: 1, flexBasis: "45%" } as const;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
      <StatCard
        style={tile}
        label="Forms"
        value={num(kpis.total)}
        numeric={kpis.total}
        delta={{
          dir: "flat",
          text: `${kpis.draft} draft · ${kpis.archived} archived`,
        }}
      />
      <StatCard
        style={tile}
        label="Published"
        value={num(kpis.published)}
        numeric={kpis.published}
        delta={{
          dir: kpis.published > 0 ? "up" : "down",
          text: kpis.published > 0 ? "capturing signups" : "nothing is live",
        }}
      />
      <StatCard
        style={tile}
        label="Signups 30d"
        value={compactNum(kpis.submissions30d)}
        exact={plural(kpis.submissions30d, "signup")}
        numeric={kpis.submissions30d}
      />
      <StatCard
        style={tile}
        label="Conversion"
        value={rate === null ? "—" : percent(rate, PERCENT_OPTS)}
        // A compacted or rounded number needs a full-precision spoken form,
        // and the MODE is part of the claim — "visit-weighted" and "unweighted
        // mean" are different statements about the same tenant.
        exact={
          rate === null
            ? "No conversion data"
            : `${percent(rate, PERCENT_OPTS)}, ${caption}`
        }
        delta={{ dir: "flat", text: caption }}
      />
    </View>
  );
}

export function FormsControls({
  kpis,
  query,
  onQuery,
  resultCount,
  filter,
  onFilter,
}: {
  kpis: FormsKpis;
  query: string;
  onQuery: (next: string) => void;
  resultCount: number | undefined;
  filter: FormFilter;
  onFilter: (next: FormFilter) => void;
}) {
  return (
    <>
      <SearchField
        value={query}
        onChangeText={onQuery}
        placeholder="Search forms"
        accessibilityLabel="Search forms by name or slug"
        resultCount={resultCount}
        resultNoun="form"
      />
      <SegmentedControl<FormFilter>
        options={[
          { value: "all", label: "All", badge: kpis.total },
          { value: "published", label: "Live", badge: kpis.published },
          { value: "draft", label: "Draft", badge: kpis.draft },
          { value: "archived", label: "Archived", badge: kpis.archived },
        ]}
        value={filter}
        onChange={onFilter}
        accessibilityLabel="Filter forms by status"
        scrollable
      />
    </>
  );
}

export function FormsLoadingStrip() {
  return <SkeletonStatRow tiles={4} label="Loading form metrics" />;
}

/** The header-right "New" entry to the create sheet. Role-gated by callers. */
export function FormsNewButton({ onPress }: { onPress: () => void }) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Create a new signup form"
      style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 8 }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: t.accent,
          ...typeStyle("callout"),
          fontFamily: FONT.semibold,
        }}
      >
        New
      </Text>
    </Pressable>
  );
}

export function FormsEmpty({
  loading,
  notice,
  unavailable,
  forbidden,
  failureMessage,
  onRetry,
  total,
}: {
  loading: boolean;
  notice: CachedSessionNoticeContent | null;
  unavailable: boolean;
  forbidden: boolean;
  failureMessage: string | null;
  onRetry: () => void;
  total: number;
}) {
  if (loading) return <SkeletonList rows={4} lines={2} />;
  if (notice) return <CachedSessionNotice notice={notice} />;
  if (unavailable) {
    return (
      <EmptyState
        title="Forms not available"
        description="This Moosewave deployment hasn't enabled the forms endpoints yet."
      />
    );
  }
  if (forbidden) {
    return (
      <EmptyState
        title="No access to forms"
        description="Your role can't read this workspace's forms. Ask an admin for campaign read access."
      />
    );
  }
  if (failureMessage) {
    return (
      <EmptyState
        title="Couldn't load forms"
        description={failureMessage}
        cta={{ label: "Try again", onPress: onRetry }}
      />
    );
  }
  if (total > 0) {
    return (
      <EmptyState
        title="No matching forms"
        description="Nothing matches this search and filter. Clear the search or switch filters."
      />
    );
  }
  // Deliberately bare. Creation DOES exist on mobile now (the role-gated
  // "New" button in the screen header opens the 4-field create sheet), but
  // this empty state cannot see the caller's role, so a "Create a form" CTA
  // here would render for viewers who cannot use it. The header button is the
  // single, correctly-gated entry point.
  return (
    <EmptyState
      title="No signup forms yet"
      description="Forms capture subscribers from your site, a hosted page, or a pop-up. If your role can create one, New in the header builds it here; this screen then tells you, from anywhere, whether it is actually capturing."
    />
  );
}
