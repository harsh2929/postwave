/**
 * VerificationJobDetailSheet — a bulk verification job, opened.
 *
 * The jobs panel answers "is something spending credits, and can I stop it".
 * This is the read that follows: where the money went (vendor calls vs cache
 * vs free local tier), and WHICH addresses came back unsendable. Both are
 * viewer reads that had no mobile client, so on a phone a job was a progress
 * count and nothing else.
 *
 * Defaults to the unsendable verdicts, because "which addresses failed" is the
 * question that brought anyone here — the toggle widens it to every result.
 * An empty failures page while the job is still running says so rather than
 * reading as an all-clear.
 *
 * Nothing here spends money: the credits were committed when the job was
 * created, and every request on this sheet is a GET.
 */
import { useState } from "react";
import { Text, View } from "react-native";

import { OpsAction, OpsCardBody } from "@/components/deliverability/OpsCard";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { Pill } from "@/components/Pill";
import { SegmentedControl } from "@/components/SegmentedControl";
import {
  useVerificationJobDetail,
  useVerificationJobResults,
} from "@/hooks/useVerificationJobDetail";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import {
  nextVerificationResultsLimit,
  VERIFICATION_RESULTS_MAX,
  VERIFICATION_RESULTS_PAGE_SIZE,
  VERIFICATION_UNSENDABLE_STATUSES,
  verificationJobOutcomeLine,
  verificationJobProgressLine,
  verificationJobResultLine,
  verificationJobResultsEmptyLine,
  verificationJobResultsPageLine,
  verificationJobSpendLine,
  verificationJobStatusCounts,
  type VerificationJobDetail,
  type VerificationJobResultItem,
} from "@/lib/verificationJobDetail";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const SCOPES = [
  { value: "failures", label: "Unsendable" },
  { value: "all", label: "All" },
];

export interface VerificationJobDetailSheetProps {
  /** Empty string keeps the sheet closed. */
  jobId: string;
  onClose: () => void;
}

export function VerificationJobDetailSheet({
  jobId,
  onClose,
}: VerificationJobDetailSheetProps) {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const [scope, setScope] = useState("failures");
  const [limit, setLimit] = useState(VERIFICATION_RESULTS_PAGE_SIZE);
  const open = jobId.trim().length > 0;
  const offline = !gate.enabled;

  const detailQuery = useVerificationJobDetail(jobId);
  const detail = detailQuery.data;
  const resultsQuery = useVerificationJobResults({
    jobId,
    statuses: scope === "failures" ? VERIFICATION_UNSENDABLE_STATUSES : [],
    enabled: open,
    limit,
  });
  // Array.isArray, not `?? []` -- a truthy non-array would reach .map.
  const results = Array.isArray(resultsQuery.data) ? resultsQuery.data : [];

  const heading = (label: string) => (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.bold,
        letterSpacing: 0.6,
        textTransform: "uppercase",
      }}
    >
      {label}
    </Text>
  );

  return (
    <KeyboardFormSheet
      visible={open}
      onClose={onClose}
      accessibilityLabel="Verification job detail"
    >
      <View style={{ gap: 10 }}>
        <Text
          {...typeCap("title")}
          style={{ color: t.fg, ...typeStyle("title"), fontFamily: FONT.bold }}
        >
          Verification job
        </Text>
        {offline ? (
          <OpsCardBody>
            This job&apos;s detail can&apos;t be read offline.
          </OpsCardBody>
        ) : detailQuery.isError ? (
          <OpsCardBody role="alert">
            This job&apos;s detail couldn&apos;t be loaded, so its progress and
            spend are unknown.
          </OpsCardBody>
        ) : !detail ? (
          <OpsCardBody>Loading this job…</OpsCardBody>
        ) : (
          <>
            <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
              <Pill
                label={detail.job.status || "running"}
                tone={
                  detail.job.status === "completed"
                    ? "success"
                    : detail.job.status === "failed"
                      ? "danger"
                      : "warning"
                }
              />
              {detail.job.provider ? (
                <Pill label={detail.job.provider} tone="neutral" />
              ) : null}
              {detail.job.source ? (
                <Pill label={detail.job.source} tone="neutral" />
              ) : null}
            </View>
            <OpsCardBody>{verificationJobOutcomeLine(detail)}</OpsCardBody>
            <OpsCardBody>{verificationJobProgressLine(detail)}</OpsCardBody>
            <OpsCardBody>{verificationJobSpendLine(detail)}</OpsCardBody>

            {heading("Verdicts so far")}
            {verificationJobStatusCounts(detail).length > 0 ? (
              <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                {verificationJobStatusCounts(detail).map((entry) => (
                  <Pill
                    key={entry.status}
                    label={`${entry.status.replace(/_/gu, " ")} ${entry.count}`}
                    tone={entry.unsendable ? "danger" : "neutral"}
                  />
                ))}
              </View>
            ) : (
              <OpsCardBody>
                No address has returned a verdict yet.
              </OpsCardBody>
            )}

            {heading("Addresses")}
            <SegmentedControl
              options={SCOPES}
              value={scope}
              onChange={(next) => {
                // Back to one page: the two scopes have different totals, and
                // carrying a grown limit across would silently ask for 400
                // rows of a list that has 12.
                setScope(next);
                setLimit(VERIFICATION_RESULTS_PAGE_SIZE);
              }}
              accessibilityLabel="Which addresses to list"
            />
            {resultsQuery.isError ? (
              <OpsCardBody role="alert">
                The per-address results couldn&apos;t be loaded, so which
                addresses failed is unknown.
              </OpsCardBody>
            ) : resultsQuery.isPending ? (
              <OpsCardBody>Loading addresses…</OpsCardBody>
            ) : results.length === 0 ? (
              <OpsCardBody>
                {verificationJobResultsEmptyLine(detail, scope === "failures")}
              </OpsCardBody>
            ) : (
              <ResultsPage
                detail={detail}
                results={results}
                failuresOnly={scope === "failures"}
                limit={limit}
                loading={resultsQuery.isFetching}
                onMore={() => setLimit(nextVerificationResultsLimit(limit))}
              />
            )}
          </>
        )}
      </View>
    </KeyboardFormSheet>
  );
}

/**
 * The page of addresses, plus the sentence that stops it lying.
 *
 * A capped failure list with nothing under it reads as the complete answer to
 * "which addresses failed" — the same lie as an empty one on an unfinished
 * run. So whenever the server's summary says there are more than this page
 * holds, the count says so and a verb widens it.
 */
function ResultsPage({
  detail,
  results,
  failuresOnly,
  limit,
  loading,
  onMore,
}: {
  detail: VerificationJobDetail;
  results: VerificationJobResultItem[];
  failuresOnly: boolean;
  limit: number;
  loading: boolean;
  onMore: () => void;
}) {
  const { t } = useTheme();
  const truncation = verificationJobResultsPageLine({
    detail,
    shown: results.length,
    failuresOnly,
  });
  // Only when the page came back FULL is there plausibly another one, and the
  // server refuses to page past its own ceiling.
  const canLoadMore =
    truncation !== "" &&
    results.length >= limit &&
    limit < VERIFICATION_RESULTS_MAX;

  return (
    <>
      {results.map((item, index) => (
                <View
                  key={`${item.email}:${index}`}
                  accessible
                  accessibilityLabel={`${item.email}: ${verificationJobResultLine(item)}`}
                  style={{
                    borderTopColor: t.borderSubtle,
                    borderTopWidth: 1,
                    paddingTop: 8,
                    gap: 2,
                  }}
                >
                  <Text
                    {...typeCap("bodySmall")}
                    numberOfLines={1}
                    style={{
                      color: t.fg,
                      ...typeStyle("bodySmall"),
                      fontFamily: FONT.medium,
                    }}
                  >
                    {item.email}
                  </Text>
                  <Text
                    {...typeCap("caption")}
                    style={{
                      color: t.fgSubtle,
                      ...typeStyle("caption"),
                      fontFamily: FONT.regular,
                    }}
                  >
                    {verificationJobResultLine(item)}
                  </Text>
                </View>
      ))}
      {truncation ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            marginTop: 8,
          }}
        >
          {truncation}
        </Text>
      ) : null}
      {canLoadMore ? (
        <OpsAction
          label={loading ? "Loading…" : "Show more addresses"}
          accessibilityLabel="Show more addresses from this verification job"
          disabled={loading}
          onPress={onMore}
        />
      ) : null}
    </>
  );
}
