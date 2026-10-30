import type { ReactElement } from "react";

import { AccessibleChartData } from "../../components/charts/AccessibleChartData";
import { Donut } from "../../components/charts/Donut";
import { ComputedFrom } from "../../components/common/Provenance";
import { ExternalLink } from "../../components/ExternalLink";
import { InlineHelp } from "../../components/InlineHelp";
import type { AnalyticsDashboardProps } from "./analytics-dashboard-types";

function formatAudienceCount(value: number): string {
  return Math.abs(value) >= 1000 ? value.toLocaleString() : String(value);
}

function MailClientPanel({ dashboard }: AnalyticsDashboardProps): ReactElement {
  const { allCampaigns, campaigns } = dashboard.controller;
  const slices = dashboard.view.mailClientSlices;
  return (
    <div className="card pw-chart-card">
      <div className="pw-chart-head">
        <div className="section-title" style={{ marginBottom: 0 }}>
          Mail clients
          <InlineHelp text="Breakdown of which mail apps your subscribers used to open recent campaigns. Inferred from the user-agent on each open beacon." />
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          <ComputedFrom
            n={campaigns.length}
            m={allCampaigns.length}
            unit="recent campaigns"
          />
        </div>
      </div>
      {slices.some((slice) => slice.value > 0) ? (
        <Donut
          slices={slices}
          centerLabel="opens"
          title="Mail-client open mix"
          valueLabel="Opens"
          provenance={{
            source: "Moosewave analytics mail-client API",
            asOf:
              dashboard.controller.lastUpdated != null
                ? new Date(dashboard.controller.lastUpdated).toISOString()
                : null,
            scope: `${campaigns.length} of ${allCampaigns.length} recent campaigns`,
            note: "Mail client is inferred from open-beacon user-agent data.",
          }}
          exportFileName="mail-client-open-mix.csv"
          exportPrivacy="confidential"
        />
      ) : (
        <div className="pw-chart-empty">
          No mail-client signals captured yet
        </div>
      )}
    </div>
  );
}

function GeographyPanel({ dashboard }: AnalyticsDashboardProps): ReactElement {
  const { allCampaigns, campaigns, geography } = dashboard.controller;
  return (
    <div className="card pw-chart-card">
      <div className="pw-chart-head">
        <div className="section-title" style={{ marginBottom: 0 }}>
          Top countries
          <InlineHelp text="Where opens are coming from, by country. Derived from the IP address attached to each open event." />
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          By opens ·{" "}
          <ComputedFrom
            n={campaigns.length}
            m={allCampaigns.length}
            unit="recent campaigns"
          />
        </div>
      </div>
      {geography.length > 0 ? (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {geography.slice(0, 7).map((row, index) => {
              const maximum = geography[0]?.opens ?? 1;
              const width = maximum > 0 ? (row.opens / maximum) * 100 : 0;
              return (
                <div
                  key={index}
                  className="analytics-ranked-row analytics-ranked-row--country"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "110px 1fr 100px",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12,
                  }}
                >
                  <div
                    className="muted"
                    style={{
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {row.country || "Unknown"}
                  </div>
                  <div
                    aria-hidden="true"
                    style={{
                      position: "relative",
                      height: 18,
                      background: "var(--pw-bg-elev-2)",
                      borderRadius: 4,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: `${width}%`,
                        background: "var(--pw-accent)",
                        opacity: 0.8,
                        transition: "width 200ms ease-out",
                      }}
                    />
                  </div>
                  <div
                    className="tabular"
                    style={{
                      textAlign: "right",
                      fontSize: 11,
                      color: "var(--pw-fg-muted)",
                    }}
                  >
                    {formatAudienceCount(row.opens)} ·{" "}
                    {formatAudienceCount(row.clicks)} clk
                  </div>
                </div>
              );
            })}
          </div>
          <AccessibleChartData
            title="Top countries by opens"
            summary={`${geography.length} country rows returned; the visual ranking shows the top ${Math.min(7, geography.length)}.`}
            rowHeaderLabel="Country"
            columns={[
              { key: "opens", label: "Opens" },
              { key: "clicks", label: "Clicks" },
            ]}
            rows={geography.map((row, index) => ({
              key: `${index}-${row.country}`,
              label: row.country || "Unknown",
              values: {
                opens: row.opens.toLocaleString(),
                clicks: row.clicks.toLocaleString(),
              },
              exportValues: { opens: row.opens, clicks: row.clicks },
            }))}
            provenance={{
              source: "Moosewave analytics geography API",
              asOf:
                dashboard.controller.lastUpdated != null
                  ? new Date(dashboard.controller.lastUpdated).toISOString()
                  : null,
              scope: `${campaigns.length} of ${allCampaigns.length} recent campaigns`,
              note: "Country is derived from the IP address recorded with each open event.",
            }}
            exportFileName="top-countries-by-opens.csv"
            exportPrivacy="confidential"
          />
        </>
      ) : (
        <div className="pw-chart-empty">No country signals captured yet</div>
      )}
    </div>
  );
}

function TopLinksPanel({ dashboard }: AnalyticsDashboardProps): ReactElement {
  const { allCampaigns, campaigns, topLinks } = dashboard.controller;
  return (
    <div className="card pw-chart-card" style={{ marginTop: 12 }}>
      <div className="pw-chart-head">
        <div className="section-title" style={{ marginBottom: 0 }}>
          Top links
          <InlineHelp text="The most-clicked URLs across recent campaigns. The secondary count sums campaign-level unique clickers, so a person who clicked the same URL in two campaigns can be counted twice." />
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          <ComputedFrom
            n={campaigns.length}
            m={allCampaigns.length}
            unit="recent campaigns"
          />
        </div>
      </div>
      {topLinks.length > 0 ? (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {topLinks.map((link, index) => {
              const maximum = topLinks[0]?.clicks ?? 1;
              const width = maximum > 0 ? (link.clicks / maximum) * 100 : 0;
              return (
                <div
                  key={index}
                  className="analytics-ranked-row analytics-ranked-row--link"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 120px",
                    alignItems: "center",
                    gap: 12,
                    fontSize: 12,
                  }}
                >
                  <ExternalLink
                    href={link.url}
                    style={{
                      color: "var(--pw-fg)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      textDecoration: "none",
                    }}
                    title={link.url}
                  >
                    {link.url}
                  </ExternalLink>
                  <div
                    aria-hidden="true"
                    style={{
                      position: "relative",
                      height: 16,
                      background: "var(--pw-bg-elev-2)",
                      borderRadius: 4,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: `${width}%`,
                        background: "var(--pw-accent)",
                        opacity: 0.85,
                      }}
                    />
                  </div>
                  <div
                    className="tabular"
                    style={{
                      textAlign: "right",
                      fontSize: 11,
                      color: "var(--pw-fg-muted)",
                    }}
                  >
                    {formatAudienceCount(link.clicks)} ·{" "}
                    {formatAudienceCount(link.unique_clickers)} campaign-uniq
                  </div>
                </div>
              );
            })}
          </div>
          <AccessibleChartData
            title="Top links by clicks"
            summary={`${topLinks.length} ranked links across the selected recent campaigns.`}
            rowHeaderLabel="URL"
            columns={[
              { key: "clicks", label: "Clicks" },
              {
                key: "unique",
                label: "Summed campaign-unique clickers",
              },
            ]}
            rows={topLinks.map((link, index) => ({
              key: `${index}-${link.url}`,
              label: link.url,
              values: {
                clicks: link.clicks.toLocaleString(),
                unique: link.unique_clickers.toLocaleString(),
              },
              exportValues: {
                clicks: link.clicks,
                unique: link.unique_clickers,
              },
            }))}
            provenance={{
              source: "Moosewave analytics link-click API",
              asOf:
                dashboard.controller.lastUpdated != null
                  ? new Date(dashboard.controller.lastUpdated).toISOString()
                  : null,
              scope: `${campaigns.length} of ${allCampaigns.length} recent campaigns`,
              note: "Unique clickers are deduplicated within each campaign and then summed across campaigns; they are not a workspace-wide distinct-person count.",
            }}
            exportFileName="top-links-by-clicks.csv"
            exportPrivacy="confidential"
          />
        </>
      ) : (
        <div className="pw-chart-empty">No clicks recorded yet</div>
      )}
    </div>
  );
}

export function AnalyticsAudiencePanels({
  dashboard,
}: AnalyticsDashboardProps): ReactElement {
  return (
    <>
      <div className="dash-grid" style={{ marginTop: 12 }}>
        <MailClientPanel dashboard={dashboard} />
        <GeographyPanel dashboard={dashboard} />
      </div>
      <TopLinksPanel dashboard={dashboard} />
    </>
  );
}
