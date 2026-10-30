/**
 * Forms — signup-form monitoring, plus the lifecycle verbs.
 *
 * "Did the new pop-up actually capture anything?" is the highest-frequency
 * did-it-work-today check in a marketing tool, and it needed no surface on the
 * phone at all: a complete forms CRUD + submissions + analytics API shipped
 * with zero mobile references.
 *
 * The monitoring-only scope was deliberate and then OUTGREW itself: the thing
 * you learn from monitoring ("this popup is being spammed", "the launch form
 * is still a draft") demands a status verb on the spot. So this screen now
 * carries, for editor-and-up sessions:
 *  - LONG-PRESS on a row → publish / move-to-draft / archive (online-only by
 *    queue policy — lib/formLifecycle has the argument);
 *  - "New" in the header → the same 4-field create desktop ships. Creates
 *    are DRAFTS by server rule, so the create queues offline safely.
 * Field-schema editing stays on a big screen, as before.
 *
 * All four headline KPIs come from the list response alone (forms.FormListItem
 * already carries submissions30d / visits30d / conversionRate), so the strip
 * paints on the same request that fills the list — no second round trip.
 */
import { Link } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  FlatList,
  type ListRenderItem,
  Pressable,
  RefreshControl,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";

import {
  listForms,
  normalizeFormListResponse,
  type FormListItem,
} from "@/api/forms";
import {
  CachedSessionNotice,
  cachedSessionNotice,
} from "@/components/CachedSessionNotice";
import { Pill } from "@/components/Pill";
import { ScreenHeader } from "@/components/ScreenHeader";
import { StaleDataBanner } from "@/components/StaleDataBanner";
import {
  FormsControls,
  FormsEmpty,
  FormsKpiStrip,
  FormsLoadingStrip,
  FormsNewButton,
  type FormFilter,
} from "@/components/forms/FormsChrome";
import { FormCreateSheet } from "@/components/forms/FormCreateSheet";
import { FormQuickActionsSheet } from "@/components/forms/FormLifecycleActions";
import {
  FORM_LIFECYCLE_MINIMUM_ROLE,
  lifecycleTargetFromListItem,
} from "@/lib/formLifecycle";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useAuthStore } from "@/store/auth";
import { FONT } from "@/lib/fonts";
import { compactNum, percent, plural, relativeTime } from "@/lib/format";
import { computeFormsKpis, type FormMetricRow } from "@/lib/formMetrics";
import { formStatusPresentation, matchesFormQuery } from "@/lib/formStatus";
import { haptics } from "@/lib/haptics";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOrMore } from "@/lib/nav";
import { useCreateParam } from "@/hooks/useCreateParam";
import { useDebounced } from "@/hooks/useDebounced";
import { useListPreferences } from "@/hooks/useListPreferences";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

// The forms API reports conversion as 0..100, not as a 0..1 ratio. Both
// conventions appear in this backend, so state it rather than guess.
const PERCENT_ROUGH = { alreadyPercent: true, digits: 0 } as const;

type FormPrefs = { filter: FormFilter };
const DEFAULT_PREFS: FormPrefs = { filter: "all" };

export default function FormsIndex() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  useScreenViewed("forms");
  const notice = cachedSessionNotice({
    gateEnabled: gate.enabled,
    hasTenant: Boolean(gate.tenantId),
    surface: "campaigns",
  });
  const [prefs, setPrefs] = useListPreferences("forms", DEFAULT_PREFS);
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, 200);

  // Editor floor for both the lifecycle PATCH and the create POST; API-key
  // sessions fail closed (scopes are not visible to mobile).
  const mode = useAuthStore((s) => s.mode);
  const canWrite = canAccessMinimumRole(
    FORM_LIFECYCLE_MINIMUM_ROLE,
    gate.effectiveRole,
    mode,
  );
  const [quickForm, setQuickForm] = useState<FormListItem | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  // The palette's "New form" arrives with ?new=1 — the same flag and idiom
  // as campaigns/index.tsx, written once in hooks/useCreateParam.
  useCreateParam(() => setCreateOpen(true));

  const forms = useQuery({
    queryKey: ["forms", gate.tenantId],
    queryFn: () => listForms(),
    enabled: gate.enabled && Boolean(gate.tenantId),
  });
  const refetch = forms.refetch;

  const result = forms.data;
  const allItems = useMemo(
    () => normalizeFormListResponse(result?.data),
    [result?.data],
  );
  // KPIs are computed over the WHOLE tenant, never the filtered view — a
  // headline that silently reflects the active chip is a headline that lies.
  const kpis = useMemo(
    () => computeFormsKpis(allItems as FormMetricRow[]),
    [allItems],
  );
  const rows = useMemo(() => {
    const needle = debounced.trim();
    return allItems.filter((f) => {
      const status = (f.status ?? "draft").trim().toLowerCase();
      if (prefs.filter !== "all" && status !== prefs.filter) return false;
      return matchesFormQuery(f, needle);
    });
  }, [allItems, prefs.filter, debounced]);

  const status = result?.error?.status ?? 0;
  const unavailable = status === 404 || status === 405 || status === 501;
  const forbidden = status === 401 || status === 403;
  const loadFailed = Boolean(forms.error || result?.error);
  // STALE-WHILE-ERROR. `loadFailed` used to be a term here, so a failed
  // BACKGROUND refetch — which leaves TanStack holding the last successful
  // rows next to a live error — deleted the search field, the filter chips and
  // the KPI strip from a screen that was still painting those rows. And
  // `ListEmptyComponent` never renders while rows exist, so the failure had
  // nowhere to be said either: the operator watched the controls vanish, was
  // told nothing, and read stale numbers as current. The rows are real; what
  // they need is the banner below, not the loss of the tools that search them.
  const showControls = !forms.isLoading && kpis.total > 0;
  const staleAfterFailure = loadFailed && kpis.total > 0;

  const onRefresh = useCallback(() => {
    if (notice) return;
    haptics.tap();
    void refetch();
  }, [notice, refetch]);
  const onFilter = useCallback(
    (next: FormFilter) => {
      haptics.tap();
      setPrefs({ filter: next });
    },
    [setPrefs],
  );

  const keyExtractor = useCallback(
    (f: FormListItem, idx: number) => String(f.id ?? idx),
    [],
  );

  const canQuickAct = canWrite && gate.enabled;
  const onQuickActions = useCallback(
    (item: FormListItem) => {
      haptics.tap();
      setQuickForm(item);
    },
    [],
  );
  const renderForm = useCallback<ListRenderItem<FormListItem>>(
    ({ item }) => (
      <FormRow
        item={item}
        onLongPress={canQuickAct ? onQuickActions : null}
      />
    ),
    [canQuickAct, onQuickActions],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Forms"
        subtitle={
          showControls && !forms.isFetching
            ? `Loaded ${relativeTime(forms.dataUpdatedAt)}`
            : undefined
        }
        onBack={goBackOrMore}
        right={
          canQuickAct ? (
            <FormsNewButton
              onPress={() => {
                haptics.tap();
                setCreateOpen(true);
              }}
            />
          ) : undefined
        }
      />
      <FlatList
        {...MOBILE_LIST_PERF_PROPS}
        data={rows}
        keyExtractor={keyExtractor}
        contentContainerStyle={{ padding: 16, gap: 8 }}
        refreshControl={
          <RefreshControl
            refreshing={forms.isFetching && !forms.isLoading}
            onRefresh={onRefresh}
            enabled={!notice}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        ListHeaderComponent={
          <View style={{ gap: 10, marginBottom: 4 }}>
            {notice && kpis.total > 0 ? (
              <CachedSessionNotice notice={notice} variant="stale" />
            ) : null}
            {staleAfterFailure && !notice ? (
              <StaleDataBanner onRetry={() => void refetch()} />
            ) : null}
            {forms.isLoading ? <FormsLoadingStrip /> : null}
            {showControls ? (
              <>
                <FormsKpiStrip kpis={kpis} />
                <FormsControls
                  kpis={kpis}
                  query={query}
                  onQuery={setQuery}
                  resultCount={query.trim() ? rows.length : undefined}
                  filter={prefs.filter}
                  onFilter={onFilter}
                />
              </>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          <FormsEmpty
            loading={forms.isLoading}
            notice={notice}
            unavailable={unavailable}
            forbidden={forbidden}
            failureMessage={
              loadFailed
                ? (result?.error?.message ??
                  (forms.error instanceof Error
                    ? forms.error.message
                    : "Pull down to retry."))
                : null
            }
            onRetry={() => void refetch()}
            total={kpis.total}
          />
        }
        renderItem={renderForm}
      />

      {/* Long-press lifecycle sheet + the 4-field create. Both render only
          for editor-and-up online sessions (the affordances that open them
          are withheld otherwise). */}
      <FormQuickActionsSheet
        form={quickForm ? lifecycleTargetFromListItem(quickForm) : null}
        onClose={() => setQuickForm(null)}
      />
      <FormCreateSheet visible={createOpen} onClose={() => setCreateOpen(false)} />
    </SafeAreaView>
  );
}

function FormRow({
  item,
  onLongPress = null,
}: {
  item: FormListItem;
  /** Null below editor/offline — the row then has no long-press affordance. */
  onLongPress?: ((item: FormListItem) => void) | null;
}) {
  const { t } = useTheme();
  const presented = formStatusPresentation(item.status);
  const subs = item.submissions30d ?? 0;
  const visits = item.visits30d ?? 0;
  const rate = typeof item.conversionRate === "number" ? item.conversionRate : null;
  const spoken = `${item.name ?? item.slug ?? "Untitled form"}. ${presented.label}. ${plural(subs, "signup")} in 30 days${rate === null ? "" : `, ${percent(rate, PERCENT_ROUGH)} conversion`}.`;

  return (
    <Link
      href={{
        pathname: "/(tabs)/forms/[id]",
        params: { id: String(item.id ?? "") },
      }}
      asChild
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={spoken}
        {...(onLongPress
          ? {
              onLongPress: () => onLongPress(item),
              accessibilityHint:
                "Long press for publish, draft and archive actions.",
            }
          : {})}
        style={{
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 14,
          padding: 14,
          minHeight: 64,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text
            numberOfLines={2}
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
              flex: 1,
            }}
          >
            {item.name ?? item.slug ?? "Untitled form"}
          </Text>
          <Pill label={presented.label} tone={presented.tone} />
        </View>
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            marginTop: 8,
            gap: 12,
          }}
        >
          <Meta>{plural(subs, "signup")} · 30d</Meta>
          {visits > 0 ? <Meta>{compactNum(visits)} views</Meta> : null}
          {rate !== null ? <Meta>{percent(rate, PERCENT_ROUGH)} convert</Meta> : null}
        </View>
      </Pressable>
    </Link>
  );
}

function Meta({ children }: { children: React.ReactNode }) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  return (
    <Text
      numberOfLines={maxLinesAtScale(1, fontScale)}
      {...typeCap("label")}
      style={{
        color: t.fgMuted,
        ...typeStyle("label"),
        fontFamily: FONT.regular,
      }}
    >
      {children}
    </Text>
  );
}
