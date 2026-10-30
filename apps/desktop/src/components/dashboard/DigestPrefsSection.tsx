/**
 * DigestPrefsSection — Settings card for the dashboard email digest.
 * Refined Dashboard PR 3.
 *
 * Three options: off / daily / weekly. The actual sender is a follow-
 * up — for now we ship the preference so users can opt in and so the
 * sender PR has something to read.
 */

import { type ReactElement, useCallback, useEffect, useState } from "react";

import {
  type DashboardDigestPrefs,
  apiSendTimeAssets as api,
} from "../../lib/api-client";
import { toast } from "../Toast";

type Frequency = DashboardDigestPrefs["frequency"];

const OPTIONS: { value: Frequency; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "Don't email me." },
  { value: "daily", label: "Daily", hint: "Every morning, weekdays only." },
  { value: "weekly", label: "Weekly", hint: "Monday morning." },
];

export function DigestPrefsSection(): ReactElement {
  const [prefs, setPrefs] = useState<DashboardDigestPrefs | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (api as any).getDashboardDigestPrefs();
    // D14-settings-misc#5: the api-client already resolves 404/501 to an
    // "off" default; a res.error here therefore means a genuine outage
    // (500/timeout). Fabricating "off" would present that outage as a
    // healthy saved preference — surface the error and keep the radios
    // disabled instead (matches the sibling AlertPrefsSection).
    if (res.error) {
      setErr(res.error.message);
      setLoading(false);
      return;
    }
    setPrefs(res.data ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const change = async (next: Frequency): Promise<void> => {
    if (!prefs || saving || prefs.frequency === next) return;
    setSaving(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (api as any).putDashboardDigestPrefs({ frequency: next });
    setSaving(false);
    if (res.error) {
      toast.error(`Couldn't save: ${res.error.message}`);
      return;
    }
    setPrefs({ ...prefs, frequency: next });
    toast.success(
      next === "off" ? "Digest turned off." : `Digest set to ${next}.`,
    );
  };

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <div>
          <h2 className="settings-section-title" style={{ marginBottom: 4 }}>
            Dashboard email digest
          </h2>
          <div className="muted" style={{ fontSize: 12 }}>
            How often you&apos;d like a summary of your workspace&apos;s key
            metrics emailed to you.
          </div>
        </div>
      </div>
      <div className="settings-section-body">
        {err ? (
          <div
            className="notice"
            role="alert"
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <span style={{ flex: 1 }}>
              Couldn&apos;t load your digest preference: {err}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void load()}
              disabled={loading}
            >
              {loading ? "Retrying…" : "Retry"}
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {OPTIONS.map((o) => (
              <label
                key={o.value}
                className="radio-row"
                style={{ display: "flex", alignItems: "center", gap: 8 }}
              >
                <input
                  type="radio"
                  name="dashboard-digest"
                  checked={prefs?.frequency === o.value}
                  onChange={() => void change(o.value)}
                  disabled={!prefs || saving}
                />
                <span style={{ fontWeight: 500 }}>{o.label}</span>
                <span className="muted" style={{ fontSize: 11 }}>
                  — {o.hint}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
