import type { ReactElement } from "react";

import { AnalyticsNlqBar } from "../../components/analytics/AnalyticsNlqBar";
import { ReportBuilderSection } from "../../components/analytics/ReportBuilderSection";
import { ScheduledReportsSection } from "../../components/analytics/ScheduledReportsSection";

/**
 * Report administration deliberately lives behind the Reports route tab.
 * It used to precede the route KPIs, which made operational configuration
 * look more important than the evidence the page exists to communicate.
 */
export function AnalyticsReportsPanels(): ReactElement {
  return (
    <div className="analytics-reports-workspace">
      <div className="analytics-command-card">
        <div className="analytics-command-copy">
          <strong>Build once, then distribute with an explicit receipt.</strong>
          <span>
            Preview the exact metric definition before saving it. Scheduled
            delivery remains a separate administrative action so reading a
            report can never send one.
          </span>
        </div>
        <span className="analytics-snapshot-badge">
          Timezone-aware schedules
        </span>
      </div>

      <ReportBuilderSection />
      <ScheduledReportsSection />

      <section aria-labelledby="analytics-assistant-heading">
        <div className="analytics-section-lead">
          <div className="analytics-section-copy">
            <span className="analytics-section-kicker">Optional assistant</span>
            <h2
              className="analytics-section-title"
              id="analytics-assistant-heading"
            >
              Ask a scoped question
            </h2>
            <p className="analytics-section-description">
              Use natural language to select a fixed, server-owned analytics
              query, then verify the result against the metric definition and
              source context shown with the answer.
            </p>
          </div>
        </div>
        <AnalyticsNlqBar />
      </section>
    </div>
  );
}
