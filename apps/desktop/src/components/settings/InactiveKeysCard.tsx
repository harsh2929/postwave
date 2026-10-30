/**
 * InactiveKeysCard — alert card for the Settings API-keys area
 * wiring #23 (GET /api/v1/inactive-keys?days=).
 *
 * Honest copy: severity and idle days come from the server verbatim;
 * the empty state explicitly says all keys were used within the
 * threshold instead of hiding the card.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useState,
} from "react";

import {
  type InactiveKeyAlert,
  inactiveKeysApi,
} from "../../lib/api/inactive-keys";
import { useCanAdmin } from "../../lib/store";
import { SettingsSectionHeader } from "./SettingsNav";
import {
  inactiveKeyCopy,
  inactiveKeySeverityTone,
  inactiveKeysHeadline,
  sortInactiveKeys,
} from "./inactive-keys-helpers";

export function InactiveKeysCard(): ReactElement | null {
  const canAdmin = useCanAdmin();
  const [keys, setKeys] = useState<InactiveKeyAlert[] | null>(null);
  const [threshold, setThreshold] = useState<number | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    const res = await inactiveKeysApi.list();
    if (res.error) {
      setErr(res.error.message);
      setKeys(null);
      setThreshold(null);
    } else {
      setKeys(sortInactiveKeys(res.data?.keys ?? []));
      setThreshold(res.data?.threshold_days ?? null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (canAdmin) void load();
  }, [canAdmin, load]);

  // Admin-scoped endpoint; non-admins would only see a 403.
  if (!canAdmin) return null;

  return (
    <div className="settings-section">
      <SettingsSectionHeader
        title="Inactive API keys"
        description="Keys that haven't authenticated a request recently. Unused keys widen your attack surface — revoke what you don't need."
      />
      <div className="settings-section-body">
        {err ? (
          <div className="notice">
            <span>Couldn&apos;t check key activity: {err}</span>
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
          <div className="skel-row" />
        ) : (
          <>
            <div
              className="muted"
              style={{ fontSize: 12, marginBottom: (keys ?? []).length > 0 ? 8 : 0 }}
            >
              {inactiveKeysHeadline(
                (keys ?? []).length,
                threshold ?? 0,
              )}
            </div>
            {(keys ?? []).map((k) => (
              <div
                key={k.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "6px 0",
                  borderBottom: "1px solid var(--pw-border-soft)",
                  fontSize: 12,
                }}
              >
                <span className={`badge ${inactiveKeySeverityTone(k.severity)}`}>
                  {k.severity}
                </span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {k.label || "(unlabeled)"}{" "}
                  <span className="mono muted" style={{ fontSize: 11 }}>
                    {k.prefix}…
                  </span>
                </span>
                <span className="muted">{inactiveKeyCopy(k)}</span>
                <span className="muted">
                  created {new Date(k.created_at).toLocaleDateString()}
                </span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
