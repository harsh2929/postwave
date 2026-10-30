// SPDX-License-Identifier: AGPL-3.0-only
//
// Sequence-level goal / exit criteria + stuck threshold (desktop parity row
// automation-77). Collapsible strip under the performance panel so it never
// crowds the editor.
//
// Persistence is one version-pinned PATCH: the card reads goal/stuck for
// itself (voice-api's Sequence projection carries neither), edits a local
// draft, and saves under the page's current If-Match version. On success the
// server bumps the version and the page threads it back into its own draft so
// the next email save does not 412.
//
// Honest-UI notes rendered verbatim next to the controls: this build has no
// qualified sequence runtime, so goals are not evaluated, exit_on_goal cannot
// stop sends, and the stuck threshold does not monitor anyone yet.
"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Target } from "lucide-react";
import { toast } from "sonner";

import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, whoami, type MeResponse } from "@/lib/auth-api";
import {
  canWriteCampaigns,
  confirmFreshCampaignWriteAuthority,
} from "@/lib/campaign-write-authority";
import { exactPrincipalKey } from "@/lib/exact-principal";
import { newUUIDv7 } from "@/lib/http-fetch";
import { STALE, qk } from "@/lib/query-keys";
import { SEQUENCE_RUNTIME_AVAILABLE } from "@/lib/sequence-operational-availability";
import {
  EXIT_ON_GOAL_CAVEAT,
  GOAL_KIND_OPTIONS,
  STUCK_AFTER_DAYS_MAX,
  getSequenceSettings,
  goalKindCaveat,
  isSequenceGoalKind,
  parseStuckAfterDays,
  sequenceSettingsKey,
  updateSequenceSettings,
  type SequenceGoalKind,
  type SequenceSettings,
  type SequenceSettingsPatch,
} from "@/lib/sequence-settings-api";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

export const SEQUENCE_SETTINGS_READ_ONLY_MESSAGE =
  "Sequence settings are read-only for this session. Owner, admin, or editor access outside viewer mode is required to change a sequence's goal or stuck threshold.";

/** "" in the select means "no goal configured". */
type GoalKindDraft = SequenceGoalKind | "";

interface Props {
  sequenceId: string;
  /** The page's current server revision; threaded through If-Match. */
  version: number | undefined;
  /** Draft lifecycle authority (status + confirmed version) as the page computes it. */
  canEdit: boolean;
  editUnavailableReason: string;
  /** True while the page is saving email edits; the two PATCHes must not race. */
  busy: boolean;
  onSaved: (saved: SequenceSettings) => void;
  onSavingChange?: (saving: boolean) => void;
}

interface SettingsSaveOperation {
  controller: AbortController;
  idempotencyKey: string;
  openedIdentity: MeResponse;
  patch: SequenceSettingsPatch;
  principalKey: string;
  version: number;
}

function summarize(settings: SequenceSettings | undefined): string {
  if (!settings) return "";
  const goal = settings.goal
    ? (GOAL_KIND_OPTIONS.find((o) => o.value === settings.goal?.kind)?.label ??
      settings.goal.kind)
    : "none";
  const stuck =
    settings.stuckAfterDays > 0
      ? `${settings.stuckAfterDays} day${settings.stuckAfterDays === 1 ? "" : "s"}`
      : "off";
  return `Goal: ${goal} · Stuck after: ${stuck}`;
}

export function SequenceSettingsCard({
  sequenceId,
  version,
  canEdit,
  editUnavailableReason,
  busy,
  onSaved,
  onSavingChange,
}: Props) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [goalKind, setGoalKind] = useState<GoalKindDraft>("");
  const [exitOnGoal, setExitOnGoal] = useState(false);
  const [stuckDays, setStuckDays] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const panelId = useId();
  const goalId = useId();
  const exitId = useId();
  const stuckId = useId();
  const saveDescriptionId = useId();

  // Role the way the flows page reads it: the server-resolved identity.
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const canWrite = canWriteCampaigns(meQuery.data);
  const principalKey = exactPrincipalKey(meQuery.data);
  const principalKeyRef = useRef(principalKey);
  principalKeyRef.current = principalKey;
  const operationRef = useRef<SettingsSaveOperation | null>(null);

  const settingsKey = sequenceSettingsKey(
    tenantId,
    role,
    sequenceId,
    meQuery.data?.user_id,
    meQuery.data?.viewer_mode === true,
  );
  const settingsQuery = useQuery({
    queryKey: settingsKey,
    queryFn: ({ signal }) => getSequenceSettings(sequenceId, { signal }),
    enabled:
      meQuery.isSuccess && Boolean(meQuery.data) && Boolean(sequenceId.trim()),
    staleTime: STALE.detail,
  });
  const stored = settingsQuery.data;

  // Re-seed the local draft whenever the stored row changes (initial GET,
  // post-save cache write).
  useEffect(() => {
    if (!stored) return;
    setGoalKind(stored.goal?.kind ?? "");
    setExitOnGoal(stored.goal?.exit_on_goal ?? false);
    setStuckDays(
      stored.stuckAfterDays > 0 ? String(stored.stuckAfterDays) : "0",
    );
    setError(null);
  }, [stored]);

  useEffect(() => {
    const scopedPrincipal = principalKey;
    return () => {
      const operation = operationRef.current;
      if (operation?.principalKey === scopedPrincipal) {
        operation.controller.abort();
        operationRef.current = null;
      }
    };
  }, [principalKey]);

  const mutation = useMutation({
    mutationKey: ["sequence-settings", principalKey, sequenceId, "save"],
    mutationFn: async (operation: SettingsSaveOperation) => {
      await confirmFreshCampaignWriteAuthority(
        operation.openedIdentity,
        operation.controller.signal,
      );
      const saved = await updateSequenceSettings(
        sequenceId,
        operation.version,
        operation.patch,
        {
          signal: operation.controller.signal,
          idempotencyKey: operation.idempotencyKey,
        },
      );
      if (principalKeyRef.current !== operation.principalKey) {
        throw new Error(
          "Workspace identity changed while the settings save was in flight. Reload the sequence before making another change.",
        );
      }
      return { operation, saved };
    },
    onSuccess: ({ operation, saved }) => {
      if (principalKeyRef.current !== operation.principalKey) return;
      queryClient.setQueryData(settingsKey, saved);
      setError(null);
      onSaved(saved);
      toast.success("Sequence settings saved.");
    },
    onError: (err: unknown, operation) => {
      if (principalKeyRef.current !== operation.principalKey) return;
      // A 412 or a role denial renders the server's own sentence.
      setError(apiErrorMessage(err, "Sequence settings couldn't be saved."));
    },
    onSettled: (_data, _error, operation) => {
      if (operationRef.current === operation) operationRef.current = null;
    },
  });
  const saving = mutation.isPending;
  useEffect(() => {
    onSavingChange?.(saving);
  }, [onSavingChange, saving]);

  const stuckParsed = parseStuckAfterDays(stuckDays);
  const storedStuck =
    stored && stored.stuckAfterDays > 0 ? String(stored.stuckAfterDays) : "0";
  const dirty =
    stored !== undefined &&
    (goalKind !== (stored.goal?.kind ?? "") ||
      (goalKind !== "" &&
        exitOnGoal !== (stored.goal?.exit_on_goal ?? false)) ||
      stuckDays !== storedStuck);
  useUnsavedChangesGuard(dirty || saving);

  const controlsDisabled = !canWrite || !canEdit || busy || saving || !stored;
  const saveUnavailableReason = meQuery.isPending
    ? "Checking write access…"
    : meQuery.isError || !meQuery.data
      ? "Workspace identity could not be verified, so sequence settings were not loaded and cannot be changed."
      : !canWrite
        ? SEQUENCE_SETTINGS_READ_ONLY_MESSAGE
        : !canEdit
          ? editUnavailableReason
          : !stored
            ? "Sequence settings are still loading."
            : busy
              ? "Wait for the current save to finish before changing settings."
              : saving
                ? "Sequence settings are already being saved."
                : !stuckParsed.ok
                  ? stuckParsed.message
                  : !dirty
                    ? "No changes to save."
                    : null;

  const save = () => {
    if (
      saveUnavailableReason !== null ||
      !stuckParsed.ok ||
      operationRef.current ||
      !meQuery.data
    ) {
      return;
    }
    const operation: SettingsSaveOperation = {
      controller: new AbortController(),
      idempotencyKey: newUUIDv7(),
      openedIdentity: meQuery.data,
      patch: {
        goal:
          goalKind === "" ? null : { kind: goalKind, exit_on_goal: exitOnGoal },
        stuck_after_days: stuckParsed.value,
      },
      principalKey,
      version: version ?? 0,
    };
    operationRef.current = operation;
    setError(null);
    mutation.mutate(operation);
  };

  return (
    <section
      aria-label="Sequence goal and stuck settings"
      className="border-b bg-muted/20 px-4 py-3"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex min-h-8 w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <Target className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="text-sm font-medium">Goal &amp; exit criteria</span>
        {stored ? (
          <span className="text-xs text-muted-foreground">
            {summarize(stored)}
          </span>
        ) : null}
        <ChevronDown
          className={cn(
            "ml-auto h-4 w-4 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      {open ? (
        <div id={panelId} className="mt-3 space-y-3">
          {!SEQUENCE_RUNTIME_AVAILABLE ? (
            <p
              role="status"
              className="rounded-md border border-warning-subtle bg-warning-subtle/40 px-3 py-2 text-xs text-muted-foreground"
            >
              Planning metadata only — this build does not evaluate goals, exit
              participants, or generate stuck-participant reports. Settings are
              stored with the draft for a future runtime.
            </p>
          ) : null}

          {meQuery.isError || (!meQuery.isPending && !meQuery.data) ? (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs"
            >
              <p>
                {apiErrorMessage(
                  meQuery.error,
                  "Workspace identity could not be verified, so sequence settings were not requested.",
                )}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void meQuery.refetch()}
              >
                Retry identity
              </Button>
            </div>
          ) : settingsQuery.isError ? (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs"
            >
              <p>
                {apiErrorMessage(
                  settingsQuery.error,
                  "Couldn't load sequence settings.",
                )}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void settingsQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : !stored ? (
            <p role="status" className="text-xs text-muted-foreground">
              Loading sequence settings…
            </p>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="space-y-1.5">
              <Label htmlFor={goalId} className="text-xs text-muted-foreground">
                Goal
              </Label>
              <Select
                id={goalId}
                value={goalKind}
                disabled={controlsDisabled}
                onChange={(e) => {
                  setError(null);
                  const next = e.target.value;
                  setGoalKind(isSequenceGoalKind(next) ? next : "");
                }}
              >
                <option value="">No goal</option>
                {GOAL_KIND_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              {goalKind !== "" ? (
                <p className="text-[11px] leading-snug text-muted-foreground">
                  {goalKindCaveat(goalKind)}
                </p>
              ) : null}
              {goalKind !== "" ? (
                <div className="space-y-1 pt-1">
                  <label
                    htmlFor={exitId}
                    className="inline-flex items-center gap-2 text-sm"
                  >
                    <Checkbox
                      id={exitId}
                      checked={exitOnGoal}
                      disabled={controlsDisabled}
                      onChange={(e) => {
                        setError(null);
                        setExitOnGoal(e.target.checked);
                      }}
                    />
                    Exit the sequence when the goal is met
                  </label>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    {EXIT_ON_GOAL_CAVEAT}
                  </p>
                </div>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label
                htmlFor={stuckId}
                className="text-xs text-muted-foreground"
              >
                Mark participants stuck after
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id={stuckId}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={STUCK_AFTER_DAYS_MAX}
                  step={1}
                  className="w-24"
                  value={stuckDays}
                  disabled={controlsDisabled}
                  aria-invalid={!stuckParsed.ok || undefined}
                  onChange={(e) => {
                    setError(null);
                    setStuckDays(e.target.value);
                  }}
                />
                <span className="text-xs text-muted-foreground">
                  days idle (0 = off, max {STUCK_AFTER_DAYS_MAX})
                </span>
              </div>
              <p className="text-[11px] leading-snug text-muted-foreground">
                {SEQUENCE_RUNTIME_AVAILABLE
                  ? "Powers the stuck-participant report for participants whose last sequence activity exceeds this threshold."
                  : "Stored with the draft for future runtime planning; it does not currently monitor participants."}
              </p>
            </div>
          </div>

          {!stuckParsed.ok ? (
            <p role="alert" className="text-xs text-destructive">
              {stuckParsed.message}
            </p>
          ) : error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={save}
              disabled={saveUnavailableReason !== null}
              aria-describedby={saveDescriptionId}
              aria-busy={saving || undefined}
            >
              {saving ? "Saving…" : "Save settings"}
            </Button>
            <span
              id={saveDescriptionId}
              className={cn(
                "text-xs text-muted-foreground",
                saveUnavailableReason === null && "sr-only",
              )}
            >
              {saveUnavailableReason ??
                "Save goal and stuck-threshold settings."}
            </span>
          </div>
        </div>
      ) : null}
    </section>
  );
}
