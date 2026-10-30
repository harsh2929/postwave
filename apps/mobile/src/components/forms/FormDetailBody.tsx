/**
 * FormDetailBody — the loaded state of the form-detail screen.
 *
 * Split from the route so the screen file stays a data-flow and this stays a
 * layout. Three claims this file is careful about:
 *
 *  - Conversion over a window with ZERO hosted-page views is undefined, not
 *    0%. Rendering 0% would read as "nobody converts" instead of "nobody
 *    visited", so the tile shows an em dash and says why.
 *  - Embedded forms submit WITHOUT producing a hosted-page view, so a flat
 *    zero visit curve alongside real signups is normal, not a bug. Say so.
 *  - Submission rows are admin-scoped server-side because they carry PII. The
 *    non-admin branch explains the boundary instead of showing a bare 403.
 */
import {
  Linking,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from "react-native";

import { Card } from "@/components/Card";
import { Pill } from "@/components/Pill";
import { SkeletonList } from "@/components/Skeleton";
import { StatCard } from "@/components/StatCard";
import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart";
import type { FormDetail, FormSubmission } from "@/api/forms";
import { canResendConfirmation } from "@/lib/formSubmissions";
import { FONT } from "@/lib/fonts";
import {
  compactNum,
  date,
  dateTime,
  num,
  percent,
  plural,
  relativeTime,
} from "@/lib/format";
import {
  formFieldCount,
  formStepCount,
  windowConversion,
} from "@/lib/formMetrics";
import { formStatusPresentation } from "@/lib/formStatus";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

const PERCENT_OPTS = { alreadyPercent: true, digits: 1 } as const;
const TILE = { flexGrow: 1, flexBasis: "45%" } as const;

export interface FormDetailBodyProps {
  detail: FormDetail;
  visitSeries: number[];
  visitLabels: string[];
  visitsTotal: number;
  analyticsLoading: boolean;
  analyticsError: string | null;
  hostedUrl: string | null;
  isAdmin: boolean;
  submissions: FormSubmission[] | null;
  submissionsLoading: boolean;
  submissionsError: string | null;
  /**
   * Null below admin or offline. The submissions list is already admin-only
   * (it carries PII); the resend route is admin too, so the control tracks the
   * list it sits in. Offline it is withheld rather than queued — a queued
   * resend claims an email was sent that was not.
   */
  onResendConfirmation?: ((row: FormSubmission) => void) | null;
  resendingConfirmation?: boolean;
  /**
   * Null below admin or offline — same gate as the list itself. Shares the
   * server's CSV (bounded, injection-neutralised) through the OS share sheet.
   */
  onExportSubmissions?: (() => void) | null;
  exportingSubmissions?: boolean;
}

export function FormDetailBody(props: FormDetailBodyProps) {
  const { detail, visitsTotal } = props;
  const subs30 = detail.submissions30d ?? 0;
  const windowRate = windowConversion(subs30, visitsTotal);
  const fieldCount = formFieldCount(detail.structure);
  return (
    <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        <StatCard
          style={TILE}
          label="Signups 30d"
          value={compactNum(subs30)}
          exact={plural(subs30, "signup")}
          numeric={subs30}
        />
        <StatCard
          style={TILE}
          label="Page views 30d"
          value={compactNum(visitsTotal)}
          exact={plural(visitsTotal, "hosted page view")}
          numeric={visitsTotal}
          loading={props.analyticsLoading}
        />
        <StatCard
          style={TILE}
          label="Conversion 30d"
          value={windowRate === null ? "—" : percent(windowRate, PERCENT_OPTS)}
          exact={
            windowRate === null
              ? "No hosted-page views in this window, so conversion is undefined"
              : `${percent(windowRate, PERCENT_OPTS)} of hosted page views`
          }
          delta={{
            dir: "flat",
            text:
              windowRate === null
                ? "no hosted views to divide by"
                : "hosted page views only",
          }}
        />
        {/* `stepCount` on the wire is len(steps) — multi-step PAGES, not
            fields. Labelling it "Fields" reported a number about the form that
            was not that number, and a single-step form said "0 fields" while
            collecting an email address. Count the real inputs when the
            structure is present; otherwise say what we actually know. */}
        <StatCard
          style={TILE}
          label={fieldCount === null ? "Pages" : "Fields"}
          value={num(fieldCount ?? formStepCount(detail.stepCount))}
          exact={
            fieldCount === null
              ? `${plural(formStepCount(detail.stepCount), "page")}; the field list was not returned`
              : plural(fieldCount, "input field")
          }
          delta={{
            dir: "flat",
            text: `${detail.optInMode === "double" ? "Double" : "Single"} opt-in`,
          }}
        />
      </View>

      <IdentityCard
        detail={detail}
        hostedUrl={props.hostedUrl}
      />
      <VisitsCard
        error={props.analyticsError}
        total={visitsTotal}
        series={props.visitSeries}
        labels={props.visitLabels}
      />
      <SubmissionsCard
        isAdmin={props.isAdmin}
        rows={props.submissions}
        loading={props.submissionsLoading}
        errorMessage={props.submissionsError}
        onResend={props.onResendConfirmation ?? null}
        resending={props.resendingConfirmation ?? false}
        onExport={props.onExportSubmissions ?? null}
        exporting={props.exportingSubmissions ?? false}
      />
    </>
  );
}

function IdentityCard({
  detail,
  hostedUrl,
}: {
  detail: FormDetail;
  hostedUrl: string | null;
}) {
  const { t } = useTheme();
  const presented = formStatusPresentation(detail.status);
  return (
    <Card style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          {...typeCap("body")}
          numberOfLines={2}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
            flex: 1,
          }}
        >
          {detail.slug ? `/${detail.slug}` : "No slug"}
        </Text>
        <Pill label={presented.label} tone={presented.tone} />
      </View>
      {detail.createdAt ? <Meta>Created {date(detail.createdAt)}</Meta> : null}
      {hostedUrl ? (
        <Text
          accessibilityRole="link"
          accessibilityLabel={`Open the hosted form page at ${hostedUrl}`}
          onPress={() => void Linking.openURL(hostedUrl)}
          {...typeCap("callout")}
          style={{
            color: t.accent,
            ...typeStyle("callout"),
            // 44pt tap target for a text-shaped control.
            paddingVertical: 12,
            fontFamily: FONT.semibold,
            fontWeight: "600",
          }}
        >
          Open hosted page {"\u2197\uFE0E"}
        </Text>
      ) : null}
    </Card>
  );
}

function VisitsCard({
  error,
  total,
  series,
  labels,
}: {
  error: string | null;
  total: number;
  series: number[];
  labels: string[];
}) {
  if (error) {
    return (
      <Card>
        <Meta>{error}</Meta>
      </Card>
    );
  }
  if (total <= 0) {
    return (
      <Card>
        <Meta>
          No hosted-page views recorded in the last 30 days. Embedded forms
          submit without a hosted page view, so signups can still arrive with
          this at zero.
        </Meta>
      </Card>
    );
  }
  return (
    <Card>
      <TimeSeriesChart
        series={[{ id: "visits", label: "Page views", values: series }]}
        labels={labels}
        title="Hosted page views · 30 days"
        area
        valueNoun="views"
      />
    </Card>
  );
}

function SubmissionsCard({
  isAdmin,
  rows,
  loading,
  errorMessage,
  onResend = null,
  resending = false,
  onExport = null,
  exporting = false,
}: {
  isAdmin: boolean;
  rows: FormSubmission[] | null;
  loading: boolean;
  errorMessage: string | null;
  /** Null offline: a queued resend claims an email was sent that was not. */
  onResend?: ((row: FormSubmission) => void) | null;
  resending?: boolean;
  /** Null below admin/offline. Opens the share sheet with the bounded CSV. */
  onExport?: (() => void) | null;
  exporting?: boolean;
}) {
  const { t } = useTheme();
  // An email address truncated to "alexandra.moreno-…" identifies nobody, so
  // at a raised OS text size the row gets a second line instead.
  const { fontScale } = useWindowDimensions();
  if (!isAdmin) {
    return (
      <Card style={{ gap: 6 }}>
        <SectionTitle>Recent signups</SectionTitle>
        <Meta>
          Submission rows contain email addresses and request metadata, so the
          server keeps them at admin scope. Ask an admin, or open this form on
          desktop with an admin account.
        </Meta>
      </Card>
    );
  }
  const hasRows = (rows ?? []).length > 0;
  return (
    <Card style={{ gap: 8 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <SectionTitle>Recent signups</SectionTitle>
        {/* Only beside rows that exist: sharing an empty CSV is a no-op the
            toast would then have to apologise for. */}
        {onExport && hasRows ? (
          <Pressable
            onPress={onExport}
            disabled={exporting}
            accessibilityRole="button"
            accessibilityLabel="Share this form's submissions as a CSV"
            accessibilityState={{ disabled: exporting }}
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: exporting ? t.fgSubtle : t.accent,
                ...typeStyle("control"),
                fontFamily: FONT.semibold,
              }}
            >
              {exporting ? "Preparing…" : "Share CSV"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {/* The shared skeleton, not a bare "Loading…" string: the rows that are
          about to arrive are a list, and a skeleton says how many and how tall
          where a word says only "wait". */}
      {loading ? <SkeletonList rows={3} lines={2} /> : null}
      {!loading && errorMessage ? <Meta>{errorMessage}</Meta> : null}
      {!loading && !errorMessage && (rows ?? []).length === 0 ? (
        <Meta>No submissions recorded yet.</Meta>
      ) : null}
      {!loading && !errorMessage
        ? (rows ?? []).map((row) => (
            <View
              key={row.id}
              accessible
              accessibilityLabel={`${row.email ?? "unknown address"}, ${row.status ?? "unknown status"}${row.submittedAt ? `, ${dateTime(row.submittedAt)}` : ""}`}
              style={{
                paddingVertical: 8,
                borderTopWidth: 1,
                borderTopColor: t.borderSubtle,
                gap: 2,
              }}
            >
              <Text
                numberOfLines={maxLinesAtScale(1, fontScale)}
                {...typeCap("bodySmall")}
                style={{
                  color: t.fg,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.regular,
                }}
              >
                {row.email ?? "(no address)"}
              </Text>
              <Meta>
                {(row.status ?? "unknown") +
                  (row.submittedAt ? ` · ${relativeTime(row.submittedAt)}` : "")}
              </Meta>
              {/* The status above has always been visible; this is the verb
                  that answers it. Only for `pending` — the server 409s on an
                  already-confirmed row, and a guaranteed refusal should not sit
                  beside a real action. */}
              {onResend && canResendConfirmation(row) ? (
                <Pressable
                  onPress={() => onResend(row)}
                  disabled={resending}
                  accessibilityRole="button"
                  accessibilityLabel={`Resend the confirmation email to ${row.email ?? "this address"}`}
                  accessibilityState={{ disabled: resending }}
                  // NativeWind v4: static style object only.
                  style={{ minHeight: 44, justifyContent: "center" }}
                >
                  <Text
                    {...typeCap("control")}
                    style={{
                      color: resending ? t.fgSubtle : t.accent,
                      ...typeStyle("control"),
                      fontFamily: FONT.semibold,
                    }}
                  >
                    {resending ? "Sending…" : "Resend confirmation"}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ))
        : null}
    </Card>
  );
}

function SectionTitle({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <Text
      accessibilityRole="header"
      {...typeCap("heading")}
      style={{
        color: t.fg,
        ...typeStyle("heading"),
        fontWeight: "600",
        fontFamily: FONT.semibold,
      }}
    >
      {children}
    </Text>
  );
}

function Meta({ children }: { children: React.ReactNode }) {
  const { t } = useTheme();
  return (
    <Text
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
