/**
 * RegionSection — small read-only Settings card wiring #57
 * (/api/regions + /api/regions/current — public endpoints OUTSIDE
 * /api/v1, no auth required).
 *
 * Shows the deployment region this workspace is served from
 * (EU/US + SDK host) and the list of available regions.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useState,
} from "react";

import {
  type CurrentRegionInfo,
  type RegionInfo,
  regionsApi,
} from "../../lib/api-client";
import { SettingsSectionHeader } from "./SettingsNav";
import {
  describeCurrentRegion,
  regionZoneLabel,
  sortRegions,
} from "./region-helpers";

export function RegionSection(): ReactElement {
  const [current, setCurrent] = useState<CurrentRegionInfo | null>(null);
  const [regions, setRegions] = useState<RegionInfo[] | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    const [cur, list] = await Promise.all([
      regionsApi.current(),
      regionsApi.list(),
    ]);
    const firstErr = cur.error ?? list.error;
    if (firstErr) {
      setErr(firstErr.message);
      setCurrent(null);
      setRegions(null);
      setLoading(false);
      return;
    }
    setCurrent(cur.data ?? null);
    setRegions(
      sortRegions(list.data?.regions ?? [], cur.data?.region),
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="settings-section">
      <SettingsSectionHeader
        title="Region"
        description="Where this Moosewave deployment runs and which regions are available. Read-only — region is fixed per deployment."
      />
      <div className="settings-section-body">
        {err ? (
          <div className="notice">
            <span>Couldn&apos;t load region info: {err}</span>
            <span className="spacer" />
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void load()}
              disabled={loading}
            >
              Retry
            </button>
          </div>
        ) : loading ? (
          <>
            <div className="skel-row" />
            <div className="skel-row" />
          </>
        ) : (
          <>
            {current ? (
              <div className="settings-row">
                <div>
                  <div className="row" style={{ gap: 8, alignItems: "center" }}>
                    <span>Current region</span>
                    <span className="badge accent">
                      {regionZoneLabel(current)}
                    </span>
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {describeCurrentRegion(current)}
                  </div>
                </div>
                <span className="mono muted" style={{ fontSize: 12 }}>
                  {current.sdk_host}
                </span>
              </div>
            ) : null}
            <div className="settings-row" style={{ alignItems: "flex-start" }}>
              <div>
                <div>Available regions</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  Regions Moosewave can be deployed to.
                </div>
              </div>
              <div style={{ minWidth: 260, textAlign: "right" }}>
                {(regions ?? []).length === 0 ? (
                  <span className="muted" style={{ fontSize: 12 }}>
                    No regions advertised by this deployment.
                  </span>
                ) : (
                  <div style={{ display: "grid", gap: 6 }}>
                    {(regions ?? []).map((r) => (
                      <div key={r.region} style={{ fontSize: 12 }}>
                        <span className="badge" style={{ marginRight: 6 }}>
                          {regionZoneLabel(r)}
                        </span>
                        <span>{r.region}</span>{" "}
                        <span className="mono muted">{r.sdk_host}</span>
                        {current && r.region === current.region ? (
                          <span className="muted"> · current</span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
