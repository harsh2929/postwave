/**
 * SavedAnalyticsViews — named window + breakdown presets, at the top of the
 * Analytics screen.
 *
 * The screen already remembers the LAST window and breakdown you used. What it
 * could not do is remember the three you switch between: the Monday
 * "last 7 days, clicks by campaign" check, the monthly "90 days, bounces by
 * domain" review, and whatever you were looking at before someone asked a
 * question. Desktop has had that since SavedViewsMenu.tsx.
 *
 * WHERE IT SITS, AND WHY NOT IN THE HEADER BAR. The register says the header;
 * on a 390pt screen the header bar already carries a back control, a two-line
 * title and the export button, and a fourth control there would either
 * truncate the title or hide behind an overflow. The row sits immediately
 * under the window selector instead — beside the control it saves, above every
 * card it changes — which is the same reading order the desktop menu has.
 *
 * NO SERVER CALL. There is no saved-views route in routeauth/manifest.json,
 * and desktop's implementation is client-side too. Presets live in
 * `useListPreferences`, which is scoped to origin + tenant + user, so a preset
 * saved in one workspace cannot appear in another.
 *
 * NativeWind v4: every style object here is static (house rule 1).
 */
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { SettingsTextInput } from "@/components/settings/FormControls";
import { useToast } from "@/components/Toast";
import { useListPreferences } from "@/hooks/useListPreferences";
import { rangeLabelFor } from "@/hooks/useAnalytics";
import { DASHBOARD_RANGES, type DashboardRange } from "@/hooks/useDashboard";
import { FONT } from "@/lib/fonts";
import {
  GROUPED_DIMENSIONS,
  GROUPED_METRICS,
  dimensionLabel,
  type GroupedDimension,
  type GroupedMetric,
} from "@/lib/groupedTimeseries";
import { haptics } from "@/lib/haptics";
import {
  MAX_VIEW_NAME,
  SAVED_VIEWS_EMPTY,
  deleteViewConfirm,
  parseSavedViews,
  removeSavedView,
  savedViewNameError,
  savedViewSpoken,
  savedViewSummary,
  serializeSavedViews,
  upsertSavedView,
  viewIsActive,
  type SavedAnalyticsView,
} from "@/lib/savedAnalyticsViews";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const VOCABULARY = {
  ranges: DASHBOARD_RANGES as readonly string[],
  dimensions: GROUPED_DIMENSIONS as readonly string[],
  metrics: GROUPED_METRICS as readonly string[],
};

export interface AnalyticsViewState {
  range: DashboardRange;
  dimension: GroupedDimension;
  metric: GroupedMetric;
}

export interface SavedAnalyticsViewsProps {
  current: AnalyticsViewState;
  onApply: (view: AnalyticsViewState) => void;
}

/** Labels for one preset, taken from the controls the screen already renders. */
function labelsFor(view: {
  range: string;
  metric: string;
  dimension: string;
}) {
  return {
    range: rangeLabelFor(view.range as DashboardRange),
    metric: view.metric,
    dimension: dimensionLabel(view.dimension as GroupedDimension),
  };
}

export function SavedAnalyticsViews({
  current,
  onApply,
}: SavedAnalyticsViewsProps) {
  const { t } = useTheme();
  const confirm = useConfirm();
  const { toast } = useToast();
  // The SAME store the screen's window preference uses, under its own key:
  // identity-scoped, hydrated asynchronously, written through on change.
  const [prefs, setPrefs] = useListPreferences("analytics-saved-views", {
    views: "[]",
  });
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const views = useMemo(
    () => parseSavedViews(prefs.views, VOCABULARY),
    [prefs.views],
  );

  const write = useCallback(
    (next: SavedAnalyticsView[]) => {
      setPrefs({ views: serializeSavedViews(next) });
    },
    [setPrefs],
  );

  const onSave = useCallback(() => {
    const problem = savedViewNameError(draft);
    if (problem) {
      setError(problem);
      return;
    }
    const name = draft.trim();
    write(
      upsertSavedView(views, {
        id: `${Date.now().toString(36)}-${name.toLowerCase()}`,
        name,
        range: current.range,
        dimension: current.dimension,
        metric: current.metric,
      }),
    );
    haptics.success();
    setNaming(false);
    setDraft("");
    setError(null);
    toast({ kind: "success", message: `Saved “${name}”` });
  }, [current, draft, toast, views, write]);

  const onDelete = useCallback(
    async (view: SavedAnalyticsView) => {
      const copy = deleteViewConfirm(view);
      const ok = await confirm({
        title: copy.title,
        message: copy.message,
        confirmLabel: copy.confirmLabel,
        destructive: true,
      });
      if (!ok) return;
      write(removeSavedView(views, view.id));
      haptics.tap();
    },
    [confirm, views, write],
  );

  return (
    <View style={{ marginTop: 10, gap: 6 }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
        }}
      >
        {views.map((view) => (
          <ViewChip
            key={view.id}
            view={view}
            active={viewIsActive(view, current)}
            onApply={() => {
              haptics.tap();
              onApply({
                range: view.range as DashboardRange,
                dimension: view.dimension as GroupedDimension,
                metric: view.metric as GroupedMetric,
              });
            }}
            onDelete={() => void onDelete(view)}
          />
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save this view"
          accessibilityHint={`Names the current window and breakdown: ${savedViewSummary(labelsFor(current))}`}
          onPress={() => {
            setDraft("");
            setError(null);
            setNaming(true);
          }}
          style={{
            minHeight: 44,
            paddingHorizontal: 12,
            borderRadius: 999,
            borderWidth: 1,
            borderStyle: "dashed",
            borderColor: t.border,
            justifyContent: "center",
          }}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgMuted,
              fontFamily: FONT.medium,
              ...typeStyle("label"),
            }}
          >
            + Save view
          </Text>
        </Pressable>
      </ScrollView>

      {views.length === 0 ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            fontFamily: FONT.regular,
            ...typeStyle("caption"),
          }}
        >
          {SAVED_VIEWS_EMPTY}
        </Text>
      ) : null}

      <KeyboardFormSheet
        visible={naming}
        onClose={() => setNaming(false)}
        accessibilityLabel="Name this view"
      >
        <Text
          accessibilityRole="header"
          {...typeCap("title")}
          style={{ color: t.fg, fontFamily: FONT.bold, ...typeStyle("title") }}
        >
          Name this view
        </Text>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            fontFamily: FONT.regular,
            ...typeStyle("bodySmall"),
            marginTop: 4,
          }}
        >
          {`Saves ${savedViewSummary(labelsFor(current))}. Presets are kept on this device for this workspace.`}
        </Text>
        <View style={{ gap: 12, marginTop: 16 }}>
          <SettingsTextInput
            label="Name"
            value={draft}
            onChangeText={(value) => {
              setDraft(value);
              setError(null);
            }}
            autoCapitalize="sentences"
            maxLength={MAX_VIEW_NAME}
          />
          {error ? (
            <Text
              accessibilityRole="alert"
              {...typeCap("caption")}
              style={{
                color: t.danger,
                fontFamily: FONT.regular,
                ...typeStyle("caption"),
              }}
            >
              {error}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save view"
            onPress={onSave}
            style={{
              minHeight: 44,
              borderRadius: 10,
              backgroundColor: t.accent,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              {...typeCap("label")}
              style={{
                color: t.accentFg,
                fontFamily: FONT.semibold,
                ...typeStyle("label"),
              }}
            >
              Save view
            </Text>
          </Pressable>
        </View>
      </KeyboardFormSheet>
    </View>
  );
}

/** One preset: tap applies it, press-and-hold deletes it. */
function ViewChip({
  view,
  active,
  onApply,
  onDelete,
}: {
  view: SavedAnalyticsView;
  active: boolean;
  onApply: () => void;
  onDelete: () => void;
}) {
  const { t } = useTheme();
  const labels = labelsFor(view);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={savedViewSpoken(view, labels, active)}
      onPress={onApply}
      onLongPress={onDelete}
      hitSlop={6}
      style={{
        minHeight: 44,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: active ? t.accent : t.border,
        backgroundColor: active ? t.accent : t.surface,
        justifyContent: "center",
      }}
    >
      <Text
        numberOfLines={1}
        {...typeCap("label")}
        style={{
          color: active ? t.accentFg : t.fg,
          fontFamily: FONT.medium,
          ...typeStyle("label"),
        }}
      >
        {view.name}
      </Text>
      <Text
        numberOfLines={1}
        {...typeCap("caption")}
        // Decorative: the chip's own accessibilityLabel already speaks it.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          color: active ? t.accentFg : t.fgSubtle,
          fontFamily: FONT.regular,
          ...typeStyle("caption"),
        }}
      >
        {savedViewSummary(labels)}
      </Text>
    </Pressable>
  );
}
