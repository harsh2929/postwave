/**
 * CostLedgerSheet — the itemized metering entries behind the cost totals,
 * cursor-paged (GET /api/v1/costs/ledger, viewer).
 *
 * A SHEET RATHER THAN A ROUTE, for the same reason IncidentDetailSheet is
 * one: the rhythm is open → scan → done, and it keeps billing to a single
 * route file with no tab-layout registration.
 *
 * IT IS LAZY. Nothing is fetched until the sheet opens (desktop's drilldown
 * behaves the same), and it re-reads from page one on every open and on
 * every window change, because a ledger is append-only and a stale page is
 * a page missing the newest cost.
 *
 * PAGING lives in lib/apiUsageDashboard's ledgerReducer, not here: a failed
 * "load more" keeps the pages already on screen, a Retry asks for the page
 * that FAILED rather than page one again, and a re-served boundary row is
 * de-duplicated so it cannot read as double cost. A request sequence guards
 * against a slow page landing after the window changed or the sheet closed.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { fetchCostLedgerPage } from "@/api/apiUsage";
import {
  LedgerRow,
  MutedLine,
  SectionFailure,
} from "@/components/billing/ApiUsageParts";
import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { Skeleton, SkeletonGroup } from "@/components/Skeleton";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  LEDGER_INITIAL,
  LEDGER_OFFLINE_NOTE,
  ledgerEmptyCopy,
  ledgerLine,
  ledgerReducer,
  ledgerRetry,
  ledgerSubtitle,
} from "@/lib/apiUsageDashboard";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

export interface CostLedgerSheetProps {
  visible: boolean;
  /** The section's window; the sheet reads the same span. */
  days: number;
  onClose: () => void;
}

export function CostLedgerSheet({ visible, days, onClose }: CostLedgerSheetProps) {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const [state, dispatch] = useReducer(ledgerReducer, LEDGER_INITIAL);
  // Monotonic request id: a page that resolves after a newer request began
  // (window changed, sheet reopened, component unmounted) is dropped.
  const seq = useRef(0);

  const load = useCallback(
    async (cursor: string | null, append: boolean) => {
      const mine = ++seq.current;
      dispatch({ type: "load" });
      try {
        const page = await fetchCostLedgerPage(days, cursor);
        if (seq.current !== mine) return;
        dispatch({ type: "loaded", page, append });
      } catch (err) {
        if (seq.current !== mine) return;
        const p = errorPresentation(err);
        dispatch({
          type: "failed",
          error: { message: p.message, retryable: p.retryable },
        });
      }
    },
    [days],
  );

  useEffect(() => {
    if (!visible) return;
    dispatch({ type: "reset" });
    if (!gate.enabled) return;
    void load(null, false);
  }, [visible, gate.enabled, load]);

  useEffect(
    () => () => {
      seq.current += 1;
    },
    [],
  );

  const retry = ledgerRetry(state);
  const initialLoading = state.loading && state.rows.length === 0;
  const empty =
    state.loadedOnce &&
    !state.loading &&
    state.error === null &&
    state.rows.length === 0;

  return (
    <ReducedMotionModal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
      >
        <SheetHeader onClose={onClose} />
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 24 }}>
          <MutedLine style={{ marginBottom: 12 }}>{ledgerSubtitle(days)}</MutedLine>
          {!gate.enabled ? <MutedLine>{LEDGER_OFFLINE_NOTE}</MutedLine> : null}
          {state.error ? (
            <SectionFailure
              what="Cost ledger"
              message={state.error.message}
              retryable={state.error.retryable}
              onRetry={() => void load(retry.cursor, retry.append)}
            />
          ) : null}
          {initialLoading ? (
            <SkeletonGroup label="Loading the cost ledger">
              <View style={{ gap: 8 }}>
                <Skeleton height={56} radius={12} />
                <Skeleton height={56} radius={12} />
                <Skeleton height={56} radius={12} />
              </View>
            </SkeletonGroup>
          ) : null}
          {empty ? <MutedLine>{ledgerEmptyCopy(days)}</MutedLine> : null}
          {state.rows.map((entry) => (
            <LedgerRow key={entry.id} line={ledgerLine(entry)} />
          ))}
          {state.hasMore ? (
            <Pressable
              onPress={() => {
                haptics.tap();
                void load(state.cursor, true);
              }}
              disabled={state.loading}
              accessibilityRole="button"
              accessibilityLabel="Load more ledger entries"
              accessibilityState={{ disabled: state.loading }}
              style={{
                marginTop: 12,
                minHeight: 44,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: t.border,
                backgroundColor: t.surface,
                alignItems: "center",
                justifyContent: "center",
                opacity: state.loading ? 0.5 : 1,
              }}
            >
              <Text
                {...typeCap("callout")}
                style={{
                  color: t.accent,
                  fontFamily: FONT.semibold,
                  ...typeStyle("callout"),
                }}
              >
                {state.loading ? "Loading…" : "Load more"}
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

function SheetHeader({ onClose }: { onClose: () => void }) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomColor: t.borderSubtle,
        borderBottomWidth: 1,
        gap: 12,
      }}
    >
      <Text
        accessibilityRole="header"
        numberOfLines={maxLinesAtScale(2, fontScale)}
        {...typeCap("title")}
        style={{
          color: t.fg,
          ...typeStyle("title"),
          fontFamily: FONT.display,
          flexShrink: 1,
        }}
      >
        Cost ledger
      </Text>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close the cost ledger"
        style={{
          paddingHorizontal: 8,
          paddingVertical: 6,
          minHeight: 44,
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
          Done
        </Text>
      </Pressable>
    </View>
  );
}
