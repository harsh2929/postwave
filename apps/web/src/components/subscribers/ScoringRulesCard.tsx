// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * ScoringRulesCard — the lead-scoring rules editor on /scoring (parity row
 * audience-45; desktop reference components/subscribers/ScoringRulesCard).
 *
 * Web showed the weights and could not change them. This adds desktop's
 * editor: add / remove rules, weights and notes, a reviewed whole-set save,
 * and a refresh that keeps an unsaved draft.
 *
 * THE SAVE IS VERSION-BOUND. A draft is pinned to the rule-set version it was
 * started from — a background refetch never moves it — and the PUT echoes that
 * version. If another administrator saved in between, the server answers 409
 * and nothing is overwritten; "Keep draft and refresh" then re-pins to the
 * current server set so the review diff is recalculated against it.
 *
 * CUSTOM RULES REPLACE THE DEFAULTS ENTIRELY. With one custom rule saved, every
 * other event scores zero; removing the last rule switches back to the
 * defaults. The review sentence says which of those a save does.
 *
 * Every scoring route is ScopeAdmin: a non-admin sees the rules read-only with
 * the reason, never a Save that 403s.
 */

import { useId, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { apiErrorMessage, isApiError } from "@/lib/api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import { STALE } from "@/lib/query-keys";
import {
  describeScoringDiff,
  diffScoringDrafts,
  draftFromScoringRule,
  emptyScoringDraft,
  getScoringConfig,
  isScoringVersion,
  putScoringRules,
  SCORING_NOTE_MAX_CHARACTERS,
  SCORING_RULE_MAX_COUNT,
  SCORING_WEIGHT_MAX,
  SCORING_WEIGHT_MIN,
  scoringDraftsEqual,
  validateScoringDrafts,
  type ScoringConfig,
  type ScoringRuleDraft,
  type ScoringSaveReceipt,
} from "@/lib/scoring-taxonomy-api";
import { roleCanWrite } from "@/lib/use-admin-gate";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";

/** A draft and the server set/version it was started from. */
interface EditSession {
  baseline: ScoringRuleDraft[];
  version: string;
  drafts: ScoringRuleDraft[];
}

function sessionFrom(config: ScoringConfig): EditSession {
  const baseline = config.rules.map(draftFromScoringRule);
  return {
    baseline,
    version: config.version,
    drafts: baseline.map((draft) => ({ ...draft })),
  };
}

export function ScoringRulesCard({
  identity,
  queryKey,
}: {
  identity: MeResponse | null;
  /** The page's own scoring key, so both observers share one fetch. */
  queryKey: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const reasonId = useId();
  const statusId = useId();
  const canAdmin = Boolean(
    identity &&
    identity.viewer_mode !== true &&
    roleCanWrite(effectiveAuthRole(identity)),
  );

  const scoring = useQuery({
    queryKey: [...queryKey],
    queryFn: getScoringConfig,
    enabled: identity !== null,
    staleTime: STALE.reference,
  });
  const config = scoring.data;

  const [session, setSession] = useState<EditSession | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [conflict, setConflict] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [refreshOpen, setRefreshOpen] = useState(false);

  const baseline = session?.baseline ?? config?.rules.map(draftFromScoringRule) ?? [];
  const drafts = session?.drafts ?? baseline;
  const dirty = session !== null && !scoringDraftsEqual(session.baseline, session.drafts);
  useUnsavedChangesGuard(dirty);

  const catalog = useMemo(
    () => (Array.isArray(config?.event_catalog) ? config.event_catalog : []),
    [config?.event_catalog],
  );
  const allowed = useMemo(
    () => new Set(catalog.map((item) => item.event_type)),
    [catalog],
  );
  const diff = diffScoringDrafts(baseline, drafts);

  const edit = (next: (current: ScoringRuleDraft[]) => ScoringRuleDraft[]) => {
    if (!canAdmin || !config) return;
    setRowErrors({});
    setSession((current) => {
      const base = current ?? sessionFrom(config);
      return { ...base, drafts: next(base.drafts) };
    });
  };

  const discard = () => {
    setSession(null);
    setRowErrors({});
    setConflict(null);
  };

  const openReview = () => {
    const errors = validateScoringDrafts(drafts, allowed);
    setRowErrors(errors);
    if (Object.keys(errors).length > 0 || !dirty) return;
    setReviewOpen(true);
  };

  async function saveReviewed(): Promise<void> {
    if (!session || !identity) return;
    if (!isScoringVersion(session.version)) {
      throw new Error("Refresh scoring rules to obtain a valid save version.");
    }
    const submitted = session.drafts.map((draft) => ({ ...draft }));
    let receipt: ScoringSaveReceipt;
    try {
      await verifyFreshAdminAuthority(identity);
      receipt = await putScoringRules(submitted, session.version);
    } catch (error: unknown) {
      if (isApiError(error) && error.status === 409) {
        // Nothing was written. Close the review and say how to recover; the
        // draft is kept exactly as it was.
        setConflict(
          apiErrorMessage(
            error,
            "These rules changed elsewhere after this draft loaded.",
          ),
        );
        return;
      }
      throw new Error(
        apiErrorMessage(error, "The scoring rules could not be saved."),
      );
    }
    setConflict(null);
    setSession(null);
    queryClient.setQueryData<ScoringConfig>([...queryKey], (current) =>
      current
        ? {
            ...current,
            version: receipt.version,
            rules: submitted.map((draft) => ({
              id: "",
              event_type: draft.event_type.trim(),
              weight: Number(draft.weight),
              ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
            })),
          }
        : current,
    );
    void queryClient.invalidateQueries({ queryKey: [...queryKey] });
    toast.success(
      `Saved ${receipt.saved.toLocaleString()} scoring rule${receipt.saved === 1 ? "" : "s"}. Changed scores refresh automatically within 15 minutes.`,
    );
  }

  async function refreshKeepingDraft(): Promise<void> {
    const result = await scoring.refetch();
    if (result.isError || !result.data) {
      throw new Error(
        apiErrorMessage(result.error, "The scoring rules could not be refreshed."),
      );
    }
    const fresh = sessionFrom(result.data);
    setSession((current) =>
      current ? { ...fresh, drafts: current.drafts } : null,
    );
    setConflict(null);
  }

  if (!identity || scoring.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading the scoring rules editor…
      </p>
    );
  }
  if (scoring.isError || !config) {
    return (
      <p role="alert" className="text-sm text-destructive">
        The rules editor is unavailable because the scoring rules could not be
        loaded: {apiErrorMessage(scoring.error, "the request failed.")}
      </p>
    );
  }

  const busyDisabled = !canAdmin;
  return (
    <div data-testid="scoring-rules-editor" className="grid gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Each event in the last{" "}
          {(config.window_days ?? 90).toLocaleString()} days adds its weight to
          the subscriber&apos;s engagement score. Custom rules replace the
          defaults entirely. Saving replaces the whole rule set after a
          reviewed diff and version check.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={scoring.isFetching}
          aria-busy={scoring.isFetching}
          onClick={() => {
            if (dirty) setRefreshOpen(true);
            else {
              setSession(null);
              void scoring.refetch();
            }
          }}
        >
          <RefreshCw aria-hidden className="h-4 w-4" />
          {scoring.isFetching ? "Loading…" : "Refresh rules"}
        </Button>
      </div>

      <p role="note" className="rounded-md border bg-muted/40 p-3 text-xs">
        <strong>Automatic score refresh.</strong> Changed scores are recomputed
        by the production worker every 15 minutes. Manual workspace-wide
        recompute is withheld until it has preview, progress, cancellation, and
        a durable receipt.
      </p>

      {!canAdmin ? (
        <p id={reasonId} role="status" className="text-sm text-muted-foreground">
          {identity.viewer_mode === true
            ? "View as viewer is on, so lead-scoring rules are read-only."
            : "Lead-scoring rules need owner or admin access to change."}
        </p>
      ) : null}

      {conflict ? (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <p className="text-destructive">{conflict}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Save blocked by a newer server version. Refresh keeps this draft,
            loads the current baseline, and recalculates the review diff before
            you save again.
          </p>
        </div>
      ) : null}

      {drafts.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          No custom rules — the engine is using the default weights. Add a rule
          to override them (custom rules replace the defaults entirely).
        </p>
      ) : (
        <ul className="grid gap-2" aria-label="Lead-scoring rules">
          {drafts.map((draft, index) => {
            const errorId = `${statusId}-rule-${index}`;
            const describedBy =
              [!canAdmin ? reasonId : null, rowErrors[index] ? errorId : null]
                .filter(Boolean)
                .join(" ") || undefined;
            const chosen = new Set(
              drafts
                .filter((_, other) => other !== index)
                .map((other) => other.event_type.trim()),
            );
            return (
              <li key={index} className="grid gap-1">
                <div className="grid gap-2 sm:grid-cols-[8rem_10rem_minmax(0,1fr)_auto] sm:items-center">
                  <Select
                    aria-label={`Rule ${index + 1} event type`}
                    value={draft.event_type}
                    disabled={busyDisabled}
                    aria-describedby={describedBy}
                    aria-invalid={rowErrors[index] ? true : undefined}
                    onChange={(event) => {
                      const value = event.target.value;
                      edit((current) =>
                        current.map((row, at) =>
                          at === index ? { ...row, event_type: value } : row,
                        ),
                      );
                    }}
                  >
                    <option value="" disabled>
                      Choose an event…
                    </option>
                    {draft.event_type !== "" && !allowed.has(draft.event_type) ? (
                      <option value={draft.event_type} disabled>
                        Unsupported legacy event: {draft.event_type}
                      </option>
                    ) : null}
                    {catalog.map((item) => (
                      <option
                        key={item.event_type}
                        value={item.event_type}
                        disabled={chosen.has(item.event_type)}
                      >
                        {item.label || item.event_type} · {item.event_type}
                      </option>
                    ))}
                  </Select>
                  <Input
                    type="number"
                    inputMode="numeric"
                    aria-label={`Rule ${index + 1} weight`}
                    min={SCORING_WEIGHT_MIN}
                    max={SCORING_WEIGHT_MAX}
                    step={1}
                    value={draft.weight}
                    disabled={busyDisabled}
                    aria-describedby={describedBy}
                    aria-invalid={rowErrors[index] ? true : undefined}
                    onChange={(event) => {
                      const value = event.target.value;
                      edit((current) =>
                        current.map((row, at) =>
                          at === index ? { ...row, weight: value } : row,
                        ),
                      );
                    }}
                  />
                  <Input
                    aria-label={`Rule ${index + 1} note`}
                    placeholder="Note (optional)"
                    maxLength={SCORING_NOTE_MAX_CHARACTERS}
                    value={draft.note}
                    disabled={busyDisabled}
                    aria-describedby={describedBy}
                    onChange={(event) => {
                      const value = event.target.value;
                      edit((current) =>
                        current.map((row, at) =>
                          at === index ? { ...row, note: value } : row,
                        ),
                      );
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busyDisabled}
                    aria-describedby={describedBy}
                    aria-label={`Remove rule ${index + 1}`}
                    onClick={() =>
                      edit((current) => current.filter((_, at) => at !== index))
                    }
                  >
                    <X aria-hidden className="h-4 w-4" />
                  </Button>
                </div>
                {rowErrors[index] ? (
                  <p id={errorId} className="text-xs text-destructive">
                    {rowErrors[index]}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {rowErrors[SCORING_RULE_MAX_COUNT] ? (
        <p className="text-xs text-destructive">
          {rowErrors[SCORING_RULE_MAX_COUNT]}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={
            busyDisabled ||
            drafts.length >= Math.min(catalog.length, SCORING_RULE_MAX_COUNT)
          }
          aria-describedby={!canAdmin ? reasonId : undefined}
          onClick={() => edit((current) => [...current, emptyScoringDraft()])}
        >
          <Plus aria-hidden className="h-4 w-4" />
          Add rule
        </Button>
        {dirty ? (
          <Button type="button" variant="ghost" size="sm" onClick={discard}>
            Discard changes
          </Button>
        ) : null}
        <span className="flex-1" />
        <span id={statusId} role="status" className="text-xs text-muted-foreground">
          {dirty ? "Unsaved changes" : "All changes saved"}
        </span>
        <Button
          type="button"
          size="sm"
          disabled={busyDisabled || !dirty}
          aria-describedby={!canAdmin ? reasonId : statusId}
          onClick={openReview}
        >
          Review changes
        </Button>
      </div>

      <ConfirmDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        title="Replace the workspace scoring rules?"
        description={
          <>
            {describeScoringDiff(diff)}{" "}
            The server will reject this save if another administrator changed
            the rule-set version after you loaded it. Scores refresh
            automatically; this confirmation does not run a synchronous
            workspace sweep.
          </>
        }
        confirmLabel="Save reviewed rule set"
        confirmVariant="default"
        onConfirm={saveReviewed}
      />
      <ConfirmDialog
        open={refreshOpen}
        onOpenChange={setRefreshOpen}
        title="Refresh the scoring baseline?"
        description="This loads the current server version while preserving your local draft. Review the recalculated diff before saving; use Discard changes separately if you want to remove your edits."
        confirmLabel="Keep draft and refresh"
        confirmVariant="default"
        onConfirm={refreshKeepingDraft}
      />
    </div>
  );
}
