// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * PreSendRefinePanel — pre-send audience refinement (parity row campaigns-34,
 * server SUB-067 apps/api/internal/subscribers/presend_refine.go).
 *
 * Subscribers whose cached churn score is at or above a threshold are ~2 days
 * from unsubscribing. Mailing them one more time is what tips them over, so
 * this holds them back from THIS send and gives them a cooling-off window
 * instead, after which they re-enter the eligible pool on their own.
 *
 * THE ONE THING TO GET RIGHT: preview and commit are the SAME endpoint, and
 * `dry_run` is the only difference. A preview must never write, so every call
 * states the flag explicitly (see campaign-send-checks-api.ts) and the panel
 * only ever previews while the controls are moving.
 *
 * THE SAVED SET AND THE PREVIEWED SET ARE DIFFERENT THINGS. The GET returns
 * what is currently committed for this campaign; the dry-run POST returns what
 * the controls WOULD commit. They are shown as separate readings — a badge for
 * the saved set, a preview block for the pending one — because conflating them
 * is how an operator comes to believe an exclusion set is in force when the
 * slider has merely been moved.
 *
 * "Clear exclusions" is a DELETE that drops every saved exclusion, so
 * everyone re-enters this send. It sends nothing — the button was labelled
 * "Send anyway", which read as a send sitting beside the real Send — and it is
 * not recoverable by re-reading the panel (the cooling-off rows are gone), so
 * it goes through a confirm that names the count and says what it does not do
 * (no subscriber is deleted, no churn score changes).
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, UserMinus } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Label } from "@/components/ui/label";
import { ApiError, apiErrorMessage } from "@/lib/api";
import { whoami } from "@/lib/auth-api";
import {
  CAMPAIGN_READ_ONLY_MESSAGE,
  canWriteCampaigns,
  confirmFreshCampaignWriteAuthority,
} from "@/lib/campaign-write-authority";
import {
  clearCampaignRefinement,
  getPresendRefinement,
  refineCampaignAudience,
  type PreSendRefineResult,
} from "@/lib/campaign-send-checks-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { qk, STALE, type RoleKey } from "@/lib/query-keys";

/** Slider bounds per SUB-067; the server's own default is 80. */
const MIN_THRESHOLD = 40;
const MAX_THRESHOLD = 100;
const DEFAULT_THRESHOLD = 80;
/** Highest-risk excluded subscribers surfaced inline. */
const SAMPLE_SHOWN = 3;
/** Dragging the slider must not fire a count query per pixel. */
const PREVIEW_DEBOUNCE_MS = 250;

interface Controls {
  threshold: number;
  excludeRecentlyPaused: boolean;
}

function isNotDeployed(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function PreSendRefinePanel({
  campaignId,
  enabled,
  role,
  tenantId,
}: {
  campaignId: string;
  enabled: boolean;
  role: RoleKey;
  tenantId: string;
}) {
  const queryClient = useQueryClient();
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [excludeRecentlyPaused, setExcludeRecentlyPaused] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [committed, setCommitted] = useState<Controls>({
    threshold: DEFAULT_THRESHOLD,
    excludeRecentlyPaused: false,
  });

  // Debounce the controls into the value the preview query is keyed on, so the
  // query key (not a timer inside the effect) is what decides when a request
  // goes out.
  useEffect(() => {
    const timer = setTimeout(
      () => setCommitted({ threshold, excludeRecentlyPaused }),
      PREVIEW_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [threshold, excludeRecentlyPaused]);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data ?? null;
  const canWrite = canWriteCampaigns(identity);

  const activeKey = useMemo(
    () => [...qk.campaign(tenantId, role, campaignId), "presend-refine"],
    [campaignId, role, tenantId],
  );
  const activeQuery = useQuery({
    queryKey: activeKey,
    queryFn: ({ signal }) => getPresendRefinement(campaignId, { signal }),
    enabled,
    staleTime: STALE.detail,
    retry: false,
  });

  const previewQuery = useQuery({
    queryKey: [
      ...qk.campaign(tenantId, role, campaignId),
      "presend-refine-preview",
      committed.threshold,
      committed.excludeRecentlyPaused,
    ],
    queryFn: ({ signal }) =>
      refineCampaignAudience(
        campaignId,
        {
          churn_threshold: committed.threshold,
          exclude_recently_paused: committed.excludeRecentlyPaused,
          dry_run: true,
        },
        { signal },
      ),
    enabled,
    staleTime: STALE.detail,
    retry: false,
  });

  const applyMutation = useMutation({
    mutationFn: async (controls: Controls): Promise<PreSendRefineResult> => {
      // The panel may have been open across a role or workspace change.
      await confirmFreshCampaignWriteAuthority(identity);
      return refineCampaignAudience(campaignId, {
        churn_threshold: controls.threshold,
        exclude_recently_paused: controls.excludeRecentlyPaused,
        dry_run: false,
      });
    },
    onSuccess: (result) => {
      queryClient.setQueryData(activeKey, result);
      toast.success(
        `Refinement applied — ${result.excluded_count.toLocaleString()} subscriber${
          result.excluded_count === 1 ? "" : "s"
        } excluded from this send.`,
      );
    },
    onError: (error: unknown) => {
      toast.error(
        apiErrorMessage(error, "The refinement could not be applied."),
      );
    },
  });

  const clearMutation = useMutation({
    mutationFn: async (): Promise<number> => {
      await confirmFreshCampaignWriteAuthority(identity);
      return clearCampaignRefinement(campaignId);
    },
    onSuccess: (cleared) => {
      setConfirmClearOpen(false);
      void queryClient.invalidateQueries({ queryKey: activeKey });
      toast.success(
        `${cleared.toLocaleString()} exclusion${
          cleared === 1 ? "" : "s"
        } cleared — everyone re-enters this send.`,
      );
    },
    onError: (error: unknown) => {
      toast.error(
        apiErrorMessage(error, "The exclusions could not be cleared."),
      );
    },
  });

  if (!enabled) return null;

  // A 404 on either read means this deployment does not mount SUB-067 at all.
  // Say so once rather than rendering controls that cannot work.
  if (isNotDeployed(activeQuery.error) || isNotDeployed(previewQuery.error)) {
    return (
      <p
        data-testid="presend-refine-panel"
        data-state="unavailable"
        className="text-xs text-muted-foreground"
      >
        Pre-send audience refinement is not available in this deployment.
      </p>
    );
  }

  const active = activeQuery.data ?? null;
  const preview = previewQuery.data ?? null;
  const activeCount = active?.excluded_count ?? 0;
  // The server echoes the window it would actually apply; never assume 24h.
  const coolingHours = preview?.cooling_off_hours ?? active?.cooling_off_hours;
  const sample = (preview?.affected_subscribers_sample ?? []).slice(
    0,
    SAMPLE_SHOWN,
  );
  const previewError = previewQuery.isError
    ? apiErrorMessage(previewQuery.error, "The preview request failed.")
    : null;
  const activeError = activeQuery.isError
    ? apiErrorMessage(
        activeQuery.error,
        "The saved refinement could not be read.",
      )
    : null;
  const busy = applyMutation.isPending || clearMutation.isPending;
  // The controls have moved but the debounced preview has not caught up: the
  // number on screen does not describe what Apply would commit.
  const controlsAhead =
    threshold !== committed.threshold ||
    excludeRecentlyPaused !== committed.excludeRecentlyPaused;

  // Gates both verbs share: who you are, whether the saved set is known, and
  // whether a change is already running.
  const sharedBlockedReason = meQuery.isPending
    ? "Checking your access…"
    : !canWrite
      ? CAMPAIGN_READ_ONLY_MESSAGE
      : activeQuery.isPending
        ? "Wait while the saved exclusion set is read."
        : activeError
          ? "Retry the saved-state read before applying or clearing exclusions."
          : busy
            ? "An exclusion change is already running."
            : null;
  // Apply additionally needs a preview that describes THESE controls: without
  // it, the committed set would not be the set anyone reviewed.
  const applyBlockedReason =
    sharedBlockedReason ??
    (previewError
      ? "The preview failed, so there is no reviewed set to commit."
      : controlsAhead || previewQuery.isFetching || !preview
        ? "Wait for the preview so the committed set matches these controls."
        : null);
  const clearBlockedReason =
    sharedBlockedReason ??
    (activeCount === 0
      ? "Nothing is excluded, so there is nothing to clear."
      : null);

  return (
    <div
      className="rounded-md border p-3"
      data-testid="presend-refine-panel"
      data-state={activeCount > 0 ? "applied" : "not-applied"}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <UserMinus className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Audience refinement
        </span>
        {activeQuery.isPending ? (
          <Badge variant="secondary">Checking saved state…</Badge>
        ) : activeError ? (
          <Badge variant="destructive">Saved state unavailable</Badge>
        ) : activeCount > 0 ? (
          <Badge>{activeCount.toLocaleString()} excluded</Badge>
        ) : (
          <Badge variant="secondary">Not applied</Badge>
        )}
      </div>

      {activeError ? (
        <p
          role="alert"
          className="mb-2 flex flex-wrap items-center gap-2 text-xs text-destructive"
        >
          {activeError}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => void activeQuery.refetch()}
          >
            Retry saved state
          </Button>
        </p>
      ) : null}

      <p className="mb-3 text-xs text-muted-foreground">
        Hold back likely-unsubscribers and give them a cooling-off window
        instead of one more email. Subscribers scoring {threshold} or above are
        excluded from this send
        {typeof coolingHours === "number" && coolingHours > 0
          ? ` for ${coolingHours} hour${coolingHours === 1 ? "" : "s"}`
          : ""}
        , then re-enter the eligible pool on their own.
      </p>

      <div className="mb-3 grid gap-1.5">
        <Label
          htmlFor="presend-refine-threshold"
          className="flex justify-between text-xs text-muted-foreground"
        >
          <span>Churn-risk threshold</span>
          <span className="font-semibold tabular-nums">≥ {threshold}</span>
        </Label>
        <input
          id="presend-refine-threshold"
          type="range"
          min={MIN_THRESHOLD}
          max={MAX_THRESHOLD}
          step={1}
          value={threshold}
          disabled={busy}
          onChange={(event) => setThreshold(Number(event.target.value))}
          className="w-full accent-primary"
          aria-valuetext={`Churn score ${threshold} and above`}
        />
        <div className="flex justify-between text-[10px] tabular-nums text-muted-foreground">
          <span>{MIN_THRESHOLD} (broad)</span>
          <span>{MAX_THRESHOLD} (only highest risk)</span>
        </div>
      </div>

      <label className="mb-3 flex items-start gap-2 text-xs">
        <Checkbox
          checked={excludeRecentlyPaused}
          disabled={busy}
          onChange={(event) => setExcludeRecentlyPaused(event.target.checked)}
          className="mt-0.5"
        />
        <span>
          Also exclude subscribers already cooling off under another campaign
        </span>
      </label>

      {previewError ? (
        <p
          role="alert"
          className="mb-2 flex flex-wrap items-center gap-2 text-xs text-destructive"
        >
          Couldn&apos;t preview refinement: {previewError}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => void previewQuery.refetch()}
          >
            Retry preview
          </Button>
        </p>
      ) : (
        <dl
          className="mb-2 flex flex-wrap gap-6 text-xs"
          data-testid="presend-refine-preview"
        >
          <div>
            <dt className="text-[11px] text-muted-foreground">Would exclude</dt>
            <dd className="text-base font-semibold tabular-nums">
              {previewQuery.isPending || controlsAhead
                ? "…"
                : (preview?.excluded_count ?? 0).toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] text-muted-foreground">
              Cooling off
              {typeof coolingHours === "number" && coolingHours > 0
                ? ` (${coolingHours}h)`
                : ""}
            </dt>
            <dd className="text-base font-semibold tabular-nums">
              {previewQuery.isPending || controlsAhead
                ? "…"
                : (preview?.cooling_off_count ?? 0).toLocaleString()}
            </dd>
          </div>
          {active?.cooling_off_until ? (
            <div>
              <dt className="text-[11px] text-muted-foreground">
                Saved set re-enters
              </dt>
              <dd className="text-xs">
                {formatWireTimestamp(
                  active.cooling_off_until,
                  "at an unknown time",
                )}
              </dd>
            </div>
          ) : null}
        </dl>
      )}

      {sample.length > 0 && !controlsAhead ? (
        <ul className="mb-2 space-y-0.5 text-xs text-muted-foreground">
          {sample.map((subscriber) => (
            <li key={subscriber.subscriber_id} className="truncate">
              {subscriber.email || subscriber.subscriber_id} —{" "}
              <span className="tabular-nums">{subscriber.churn_score}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <p
        id="presend-refine-guidance"
        role="status"
        aria-live="polite"
        className="mb-2 text-[11px] text-muted-foreground"
      >
        {applyBlockedReason ??
          (activeCount === 0
            ? "Apply saves this exclusion set for this campaign's send."
            : "Apply replaces the saved exclusion set. Clear exclusions puts everyone back into this send.")}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={applyBlockedReason !== null}
          aria-describedby="presend-refine-guidance"
          onClick={() => applyMutation.mutate(committed)}
        >
          {applyMutation.isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Applying…
            </>
          ) : (
            "Apply refinement"
          )}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={clearBlockedReason !== null}
          aria-describedby="presend-refine-guidance"
          onClick={() => setConfirmClearOpen(true)}
        >
          {clearMutation.isPending ? "Clearing…" : "Clear exclusions"}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmClearOpen}
        onOpenChange={(open) => {
          if (!clearMutation.isPending) setConfirmClearOpen(open);
        }}
        title="Clear audience refinement?"
        description={`All ${activeCount.toLocaleString()} saved exclusion${
          activeCount === 1 ? "" : "s"
        } re-enter this send immediately, and the cooling-off rows are deleted rather than paused. No subscriber is deleted and no churn score changes.`}
        confirmLabel="Clear exclusions"
        cancelLabel="Keep refinement"
        onConfirm={async () => {
          await clearMutation.mutateAsync();
        }}
      />
    </div>
  );
}
