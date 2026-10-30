import { CardBoundary } from "@/components/dashboard/CardBoundary";
import { SavedReportsSection } from "@/components/analytics/SavedReportsSection";
import { ScheduledReportsSection } from "@/components/analytics/ScheduledReportsSection";

/**
 * The two report sections that sit BELOW the analytics window selector.
 *
 * They are grouped here for one reason they genuinely share: neither is a
 * measurement of the chosen range, so neither may sit inside the selector.
 *
 * Scheduled reports: a schedule is not a measurement. It lives on this screen
 * rather than its own route because the question it answers — "this digest is
 * emailing the exec team at the wrong time, stop it" — is asked while looking
 * at the numbers it reports. Self-gating: renders nothing below owner/admin,
 * because every one of its routes is ScopeAdmin.
 *
 * Saved reports (DASHBOARD#33): a saved definition carries its OWN time range,
 * so applying the screen's window to it would be a control that appears to
 * apply and does not. Unlike the schedules above it, this section is READABLE
 * by any role (definition and run reads are ScopeReadReports) and self-gates
 * only its Run control, which is ScopeAdmin.
 *
 * Extracted from app/(tabs)/analytics.tsx so the screen's own function stays
 * under its 300-line ceiling; the markup is unchanged.
 */
export function AnalyticsReportSections({
  now,
  boundaryColors,
}: {
  now: number;
  boundaryColors: React.ComponentProps<typeof CardBoundary>["colors"];
}) {
  return (
    <>
      <CardBoundary label="Scheduled reports" colors={boundaryColors}>
        <ScheduledReportsSection now={now} />
      </CardBoundary>

      <CardBoundary label="Saved reports" colors={boundaryColors}>
        <SavedReportsSection />
      </CardBoundary>
    </>
  );
}
