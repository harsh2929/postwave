/**
 * FromNameSuggestions — coverage item #5 (from_name_picker).
 *
 * Renders the tenant's top-performing from names (GET
 * /from-name-picker) as click-to-apply chips under the slideover's
 * from-name field. The server already enforces the min_campaigns
 * floor (names with too few sends never come back), so when the
 * response is empty the whole strip hides — no fake suggestions, no
 * empty chrome.
 *
 * Errors render as a single muted line with a Retry; a fetch failure
 * here must never block the editor.
 */

import { type ReactElement, useEffect, useId, useState } from "react";

import { type FromNameRow, fromNamePickerApi } from "../../lib/api-client";
import { Skeleton } from "../Skeleton";

interface Props {
  /** Applies the picked from name to the draft field. */
  onApply: (fromName: string) => void;
  disabled?: boolean;
}

const MAX_CHIPS = 5;

export function FromNameSuggestions({
  onApply,
  disabled,
}: Props): ReactElement | null {
  const [rows, setRows] = useState<FromNameRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const descriptionBaseId = useId();

  const load = async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    const res = await fromNamePickerApi.list();
    setLoading(false);
    if (res.error) {
      setErr(res.error.message);
      return;
    }
    setRows(res.data.from_names ?? []);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <Skeleton
        width="60%"
        height={20}
        aria-label="Loading from-name suggestions"
      />
    );
  }

  if (err) {
    return (
      <div className="muted" style={{ fontSize: 11 }}>
        From-name suggestions unavailable: {err}{" "}
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void load()}
        >
          Retry
        </button>
      </div>
    );
  }

  // Below the min_campaigns floor for every name → nothing to show.
  if (!rows || rows.length === 0) return null;

  return (
    <div style={{ display: "grid", gap: 4 }}>
      <span className="muted" style={{ fontSize: 11 }}>
        Top performers (by historical engagement):
      </span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {rows.slice(0, MAX_CHIPS).map((r, index) => {
          const descriptionId = `${descriptionBaseId}-${index}`;
          return (
            <span key={r.from_name}>
              <button
                type="button"
                className="chip"
                onClick={() => {
                  if (!disabled) onApply(r.from_name);
                }}
                aria-disabled={disabled || undefined}
                aria-describedby={descriptionId}
              >
                {r.from_name}
                <span className="muted" style={{ marginLeft: 6, fontSize: 10 }}>
                  {(r.open_rate * 100).toFixed(1)}%
                </span>
              </button>
              <span id={descriptionId} className="visually-hidden">
                Historical performance: {(r.open_rate * 100).toFixed(1)}% open,
                {(r.click_rate * 100).toFixed(1)}% click, {r.campaigns_using}
                {r.campaigns_using === 1 ? " campaign" : " campaigns"}, and
                {(r.confidence * 100).toFixed(0)}% confidence.
                {disabled
                  ? " This suggestion can't be applied while the editor is read-only or saving."
                  : " Activate to apply this from name."}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
