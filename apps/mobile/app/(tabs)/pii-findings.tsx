/**
 * PII findings — the workspace Shadow-PII review queue (SUB-071).
 *
 * Desktop reviews undeclared-personal-data findings in PIIFindingsModal; the
 * phone had only the masking labels, so the admin actually PAGED about a
 * sensitive-data detection could not read or decide it until a desk was
 * available. This screen is that queue: filter by state, open a finding,
 * commit the reviewed/dismissed receipt.
 *
 * ROLE. Owner/admin only — all three routes carry `session_minimum_role:
 * "admin"` in the routeauth manifest AND mount behind apikeys.ScopeAdmin
 * (pii_scanner/handlers.go:64). Below that floor the screen shows one scope
 * notice and issues NO requests; a stale-session 403 renders as the
 * permission rule it is, never a generic failure.
 *
 * PRIVACY SHAPE. Findings identify a FIELD and a detector classification —
 * the matched value never crosses the API, and the decision form refuses a
 * comment that tries to smuggle one in (lib/subscriberPiiFindings mirrors
 * the server's strong-PII refusal). Rows link to the subscriber profile,
 * where the admin-only findings card shows the same record in context.
 */
import { router } from "expo-router";
import { useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { Chip } from "@/components/Chip";
import { ErrorState } from "@/components/ErrorState";
import { EmptyState } from "@/components/EmptyState";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { PiiFindingDecisionSheet } from "@/components/subscriber/PiiFindingDecisionSheet";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  usePiiFindingsQueue,
  useReviewPiiFinding,
} from "@/hooks/useSubscriberPiiFindings";
import { useAuthStore } from "@/store/auth";
import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { goBackOrMore } from "@/lib/nav";
import {
  buildPiiDecisionBody,
  piiFailureMessage,
  piiReasonLabel,
  piiStatusLabel,
  piiTypeLabel,
  type PiiFindingRow,
} from "@/lib/subscriberPiiFindings";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export { AppErrorBoundary as ErrorBoundary };

const PER_PAGE = 50;

const STATUS_FILTERS = [
  { key: "pending", label: "Needs review" },
  { key: "reviewed", label: "Reviewed" },
  { key: "dismissed", label: "Dismissed" },
  { key: "", label: "All" },
] as const;

function QueueRow({
  row,
  canDecide,
  onDecide,
}: {
  row: PiiFindingRow;
  canDecide: boolean;
  onDecide: (row: PiiFindingRow) => void;
}) {
  const { t } = useTheme();
  const pending = row.status === "pending";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        borderBottomColor: t.borderSubtle,
        borderBottomWidth: 1,
        paddingVertical: 12,
        paddingHorizontal: 16,
      }}
    >
      <Pressable
        onPress={() => {
          if (!row.subscriberId) return;
          haptics.tap();
          router.push({
            pathname: "/(tabs)/subscribers/[id]",
            params: { id: row.subscriberId },
          });
        }}
        accessibilityRole="button"
        accessibilityLabel={`${piiTypeLabel(row.detectedType)} in ${row.fieldName}, ${piiStatusLabel(row.status)}. Opens the subscriber profile.`}
        // NativeWind v4: static style object only.
        style={{ flex: 1, minWidth: 0, gap: 2 }}
      >
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.semibold,
          }}
          numberOfLines={1}
        >
          {`${piiTypeLabel(row.detectedType)} · ${row.fieldName}`}
        </Text>
        <Text
          {...typeCap("label")}
          style={{
            color: pending ? t.warning : t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.medium,
          }}
          numberOfLines={1}
        >
          {[
            piiStatusLabel(row.status),
            row.createdAt ? relativeTime(row.createdAt) : "",
            row.receipt ? piiReasonLabel(row.receipt.reason) : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </Pressable>
      {canDecide && pending ? (
        <Chip
          label="Decide"
          active={false}
          onPress={() => {
            haptics.tap();
            onDecide(row);
          }}
          accessibilityLabel={`Decide the ${piiTypeLabel(row.detectedType)} finding in ${row.fieldName} — opens the review receipt form`}
        />
      ) : null}
    </View>
  );
}

export default function PiiFindings() {
  const { t } = useTheme();
  const { toast } = useToast();
  useScreenViewed("pii-findings");
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  const isAdmin = canAccessMinimumRole("admin", gate.effectiveRole, mode);

  const [status, setStatus] = useState<string>("pending");
  const [page, setPage] = useState(1);
  const [deciding, setDeciding] = useState<PiiFindingRow | null>(null);

  const queue = usePiiFindingsQueue(
    { status, page, perPage: PER_PAGE },
    isAdmin,
  );
  const review = useReviewPiiFinding();

  const rows = queue.data?.items ?? [];
  const total = queue.data?.total ?? 0;
  const hasNext = page * PER_PAGE < total;
  // Decisions commit an immutable receipt — online-only, never queued.
  const canDecide = isAdmin && gate.enabled;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="PII findings"
        subtitle={queue.data ? `${total} in this view` : undefined}
        onBack={goBackOrMore}
      />

      {!isAdmin ? (
        <View style={{ paddingHorizontal: 16 }}>
          <MobileScopeNotice
            title="Needs an owner or admin session"
            body="Shadow-PII evidence is restricted to workspace administrators on the server, so this queue can't be loaded or acted on with your role."
          />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row) => row.id}
          renderItem={({ item }) => (
            <QueueRow row={item} canDecide={canDecide} onDecide={setDeciding} />
          )}
          {...MOBILE_LIST_PERF_PROPS}
          ListHeaderComponent={
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                gap: 6,
                paddingHorizontal: 16,
                paddingBottom: 8,
              }}
            >
              {STATUS_FILTERS.map((f) => (
                <Chip
                  key={f.key || "all"}
                  label={f.label}
                  active={status === f.key}
                  onPress={() => {
                    setStatus(f.key);
                    setPage(1);
                  }}
                  accessibilityLabel={`Show ${f.label} findings`}
                />
              ))}
            </View>
          }
          ListEmptyComponent={
            queue.isError ? (
              <ErrorState
                message={piiFailureMessage(
                  (queue.error as { status?: number } | null)?.status,
                )}
                onRetry={() => void queue.refetch()}
              />
            ) : queue.isLoading ? (
              <View style={{ paddingHorizontal: 16 }}>
                <SkeletonList rows={6} />
              </View>
            ) : (
              <EmptyState
                title={
                  status === "pending"
                    ? "Nothing needs review"
                    : "No findings in this view"
                }
                description="The scanner records a finding whenever undeclared personal data appears in a custom field. Matched values never leave the server."
              />
            )
          }
          ListFooterComponent={
            hasNext ? (
              <View style={{ padding: 16 }}>
                <Chip
                  label={`Next page (${page + 1})`}
                  active={false}
                  onPress={() => setPage((p) => p + 1)}
                  accessibilityLabel="Load the next page of findings"
                />
              </View>
            ) : null
          }
        />
      )}

      <PiiFindingDecisionSheet
        finding={deciding}
        busy={review.isPending}
        submitError={
          review.error
            ? piiFailureMessage((review.error as { status?: number }).status)
            : undefined
        }
        onClose={() => {
          if (!review.isPending) setDeciding(null);
        }}
        onSubmit={(draft) => {
          if (!deciding) return;
          const body = buildPiiDecisionBody(draft, deciding.updatedAt);
          if (!body) return;
          haptics.warning();
          review.mutate(
            {
              findingId: deciding.id,
              subscriberId: deciding.subscriberId,
              body,
            },
            {
              onSuccess: () => {
                haptics.success();
                setDeciding(null);
                toast({
                  kind: "success",
                  message: "Decision recorded. The receipt is permanent.",
                });
              },
              // The sheet stays open with the refusal under the form — a
              // refused receipt must never look recorded.
              onError: () => haptics.error(),
            },
          );
        }}
      />
    </SafeAreaView>
  );
}
