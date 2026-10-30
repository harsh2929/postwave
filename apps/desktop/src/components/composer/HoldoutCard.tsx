/**
 * HoldoutCard — coverage item #12 (holdout).
 *
 * Pre-send: configure a holdout percentage (POST, 0..50) or remove it
 * (DELETE). The server partitions the audience deterministically at
 * send time using the stored seed.
 *
 * Post-send measurement is rendered once, by HoldoutLiftPanel on the campaign
 * page. Keeping this component configuration-only prevents a legacy renderer
 * from manufacturing a zero when the immutable result is underpowered.
 */

import { type ReactElement, useEffect, useId, useRef, useState } from "react";

import { type CampaignHoldout, holdoutApi } from "../../lib/api-client";
import { ConfirmModal } from "../ConfirmModal";
import { Notice } from "../Notice";
import { SectionHeader } from "../SectionHeader";
import { Skeleton } from "../Skeleton";
import { toast } from "../Toast";
import { clampHoldoutPercent } from "./holdout-helpers";

interface Props {
  campaignId: string | number;
  isDraft: boolean;
  canMutate: boolean;
  /** POST/DELETE .../holdout are ScopeAdmin server-side (holdout.go);
   *  the lift GET stays read-scoped. Editors see Set/Remove disabled
   *  with an honest title instead of buttons that always 403. */
  canAdmin: boolean;
}

export function HoldoutCard({
  campaignId,
  isDraft,
  canMutate,
  canAdmin,
}: Props): ReactElement {
  // Set/Remove are admin-scoped; write role alone isn't enough.
  const canConfigure = canMutate && canAdmin;
  const configureGateReason = !canMutate
    ? "Viewer role can't configure holdouts."
    : "Configuring holdouts needs an admin role.";
  const [holdout, setHoldout] = useState<CampaignHoldout | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [percent, setPercent] = useState(10);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  const setDescriptionId = useId();
  const removeDescriptionId = useId();
  const mutationInFlightRef = useRef<"create" | "remove" | null>(null);

  const load = async (isCancelled?: () => boolean): Promise<void> => {
    setLoading(true);
    setLoadErr(null);
    const res = await holdoutApi.get(campaignId);
    // campaignId can change in place — drop responses for a stale id.
    if (isCancelled?.()) return;
    setLoading(false);
    if (res.error) {
      if (res.error.status === 404) {
        setHoldout(null); // no holdout configured — a real state, not an error
        return;
      }
      setLoadErr(res.error.message);
      return;
    }
    setHoldout(res.data);
    setPercent(res.data.percent);
  };

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, isDraft]);

  const create = async (): Promise<void> => {
    if (!canConfigure || mutationInFlightRef.current) return;
    const pct = clampHoldoutPercent(percent);
    if (pct <= 0) {
      toast.error("Holdout percent must be between 1 and 50");
      return;
    }
    mutationInFlightRef.current = "create";
    setSaving(true);
    try {
      const res = await holdoutApi.create(campaignId, pct);
      if (res.error) {
        toast.error(`Couldn't set holdout: ${res.error.message}`);
        return;
      }
      toast.success(
        `Holdout set — ${res.data.percent}% of the audience held back`,
      );
      void load();
    } catch {
      toast.error("Couldn't set holdout. Check your connection and retry.");
    } finally {
      mutationInFlightRef.current = null;
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!canConfigure || mutationInFlightRef.current) return;
    mutationInFlightRef.current = "remove";
    setRemoving(true);
    try {
      const res = await holdoutApi.remove(campaignId);
      if (res.error) {
        toast.error(`Couldn't remove holdout: ${res.error.message}`);
        return;
      }
      setConfirmRemove(false);
      toast.success("Holdout removed");
      setHoldout(null);
    } catch {
      toast.error("Couldn't remove holdout. Check your connection and retry.");
    } finally {
      mutationInFlightRef.current = null;
      setRemoving(false);
    }
  };

  const setUnavailableReason = !canConfigure
    ? configureGateReason
    : saving
      ? "A holdout is already being configured."
      : percent <= 0
        ? "Enter a holdout percentage between 1 and 50."
        : null;
  const removeUnavailableReason = !canConfigure
    ? configureGateReason
    : removing
      ? "The holdout is already being removed."
      : null;

  return (
    <div style={{ marginTop: 16 }}>
      <SectionHeader
        title="Holdout group"
        description="Hold back a slice of the audience to measure what the campaign actually caused."
        helpText="The held-out subscribers never receive the campaign; comparing the frozen outcome rate between arms isolates incremental lift."
      />

      {loading ? (
        <Skeleton lines={2} aria-label="Loading holdout configuration" />
      ) : loadErr ? (
        <Notice
          tone="danger"
          title="Couldn't load holdout config"
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void load()}
            >
              Retry
            </button>
          }
        >
          {loadErr}
        </Notice>
      ) : holdout == null && isDraft ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label
            htmlFor="holdout-pct"
            className="muted"
            style={{ fontSize: 12 }}
          >
            Hold back
          </label>
          <input
            id="holdout-pct"
            type="number"
            className="input"
            min={1}
            max={50}
            value={percent}
            onChange={(e) =>
              setPercent(clampHoldoutPercent(Number(e.target.value)))
            }
            style={{ width: 70 }}
            disabled={!canConfigure}
          />
          <span className="muted" style={{ fontSize: 12 }}>
            % of the audience
          </span>
          <span className="spacer" style={{ flex: 1 }} />
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => void create()}
            aria-disabled={setUnavailableReason !== null || undefined}
            aria-describedby={setDescriptionId}
            aria-busy={saving || undefined}
          >
            {saving ? "Setting…" : "Set holdout"}
          </button>
          <span id={setDescriptionId} className="visually-hidden">
            {setUnavailableReason ??
              "Configure the percentage of this campaign's audience that will not receive it."}
          </span>
        </div>
      ) : holdout == null ? (
        <div className="muted" style={{ fontSize: 12 }}>
          No holdout was configured for this campaign, so there's no lift to
          report.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="badge accent">{holdout.percent}% held out</span>
            {!isDraft && holdout.decided_at ? (
              <span className="muted" style={{ fontSize: 11 }}>
                {holdout.held_out_count.toLocaleString()} held ·{" "}
                {holdout.sent_count.toLocaleString()} sent
              </span>
            ) : null}
            <span className="spacer" style={{ flex: 1 }} />
            {isDraft ? (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => {
                    if (!removeUnavailableReason) setConfirmRemove(true);
                  }}
                  aria-disabled={removeUnavailableReason !== null || undefined}
                  aria-describedby={removeDescriptionId}
                  aria-busy={removing || undefined}
                >
                  Remove
                </button>
                <span id={removeDescriptionId} className="visually-hidden">
                  {removeUnavailableReason ??
                    "Remove the holdout after confirming that the full audience should receive the campaign."}
                </span>
              </>
            ) : null}
          </div>
        </div>
      )}

      <ConfirmModal
        open={confirmRemove}
        title="Remove holdout?"
        description="The full audience will receive the campaign and no lift will be measurable."
        confirmLabel={removing ? "Removing…" : "Remove holdout"}
        danger
        busy={removing}
        onConfirm={() => void remove()}
        onClose={() => setConfirmRemove(false)}
      />
    </div>
  );
}
