/**
 * RevenueAttributionSection — the Analytics page's campaign-only revenue
 * report. The API provides both the top-campaign attribution table and a
 * zero-filled daily series; presentation lives in focused card components.
 *
 * Honest-reporting rules:
 * - attributed and unattributed revenue remain separate;
 * - mixed currencies are disclosed without pretending they were converted;
 * - unsupported per-sequence attribution is stated explicitly;
 * - changing the date window resets a campaign filter, so a hidden stale
 *   campaign can never keep constraining the chart.
 */

import { type ReactElement, useEffect, useState } from "react";

import {
  type CampaignAttributionResponse,
  type RevenueTimeseriesResponse,
  revenueAttributionApi,
} from "../../lib/api-client";
import { remoteFailureFromError } from "../../lib/remote-resource";
import {
  RevenueAttributionCard,
  RevenueTimeseriesCard,
} from "./RevenueAttributionCards";

interface Props {
  /** Window in days — follows the page's range chips. */
  days: number;
}

/** Keying the controller resets its campaign selection before a new window loads. */
export function RevenueAttributionSection({ days }: Props): ReactElement {
  return <RevenueAttributionController key={days} days={days} />;
}

function RevenueAttributionController({ days }: Props): ReactElement {
  const [attribution, setAttribution] =
    useState<CampaignAttributionResponse | null>(null);
  const [attribErr, setAttribErr] = useState<string | null>(null);
  const [attribLoading, setAttribLoading] = useState(true);
  const [timeseries, setTimeseries] =
    useState<RevenueTimeseriesResponse | null>(null);
  const [tsErr, setTsErr] = useState<string | null>(null);
  const [tsLoading, setTsLoading] = useState(true);
  const [campaignFilter, setCampaignFilter] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    void (async (): Promise<void> => {
      setAttribLoading(true);
      setAttribErr(null);
      try {
        const response = await revenueAttributionApi.campaigns({ days });
        if (!active) return;
        if (response.error) {
          setAttribErr(remoteFailureFromError(response.error).message);
          setAttribution(null);
          setCampaignFilter("");
        } else {
          setAttribution(response.data);
        }
      } catch {
        if (!active) return;
        setAttribErr(remoteFailureFromError({ kind: "network" }).message);
        setAttribution(null);
        setCampaignFilter("");
      }
      setAttribLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [days, reloadKey]);

  useEffect(() => {
    let active = true;
    void (async (): Promise<void> => {
      setTsLoading(true);
      setTsErr(null);
      try {
        const response = await revenueAttributionApi.timeseries({
          days,
          ...(campaignFilter ? { campaignId: campaignFilter } : {}),
        });
        if (!active) return;
        if (response.error) {
          setTsErr(remoteFailureFromError(response.error).message);
          setTimeseries(null);
        } else {
          setTimeseries(response.data);
        }
      } catch {
        if (!active) return;
        setTsErr(remoteFailureFromError({ kind: "network" }).message);
        setTimeseries(null);
      }
      setTsLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [campaignFilter, days, reloadKey]);

  useEffect(() => {
    if (!campaignFilter || !attribution) return;
    const filterStillVisible = attribution.items.some(
      (item) => item.campaign_id === campaignFilter,
    );
    if (!filterStillVisible) setCampaignFilter("");
  }, [attribution, campaignFilter]);

  const retry = (): void => setReloadKey((current) => current + 1);

  return (
    <>
      <RevenueAttributionCard
        attribution={attribution}
        days={days}
        error={attribErr}
        loading={attribLoading}
        onRetry={retry}
      />
      <RevenueTimeseriesCard
        attribution={attribution}
        campaignFilter={campaignFilter}
        days={days}
        error={tsErr}
        loading={tsLoading}
        onCampaignFilterChange={setCampaignFilter}
        onRetry={retry}
        timeseries={timeseries}
      />
    </>
  );
}
