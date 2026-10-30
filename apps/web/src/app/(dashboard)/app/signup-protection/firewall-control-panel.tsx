// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api";
import {
  effectiveAuthRole,
  whoamiFresh,
  type MeResponse,
} from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { base, STALE } from "@/lib/query-keys";
import {
  getFirewallSettings,
  listFirewallEvents,
  runFirewallSurgeDetection,
  updateFirewallSettings,
  validateFirewallPatch,
  type FirewallSettings,
  type FirewallSettingsPatch,
} from "@/lib/signup-protection-api";
import { roleCanWrite } from "@/lib/use-admin-gate";
import {
  EngagementEmpty,
  EngagementLoading,
  EngagementQueryError,
  EngagementSurface,
} from "../_engagement/engagement-ui";

interface FirewallDraft {
  attack_mode_enabled: boolean;
  auto_attack_mode: boolean;
  fingerprint_required: boolean;
  // A cleared number field is null, never 0. `Number("")` is 0, and 0 is a
  // legal risk threshold that rejects every signup once attack mode is on —
  // so one stray Backspace would otherwise be a valid, saveable outage.
  attack_mode_threshold: number | null;
  surge_multiplier: number | null;
  surge_min_per_hour: number | null;
}

const NUMERIC_FIELDS = [
  "attack_mode_threshold",
  "surge_multiplier",
  "surge_min_per_hour",
] as const;

class FirewallSettingsConflictError extends Error {
  constructor(readonly latest: FirewallSettings) {
    super(
      "Firewall settings changed after this form loaded. Your edits were kept; review the refreshed values before saving again.",
    );
    this.name = "FirewallSettingsConflictError";
  }
}

function toDraft(settings: FirewallSettings): FirewallDraft {
  return {
    attack_mode_enabled: settings.attack_mode_enabled,
    auto_attack_mode: settings.auto_attack_mode,
    fingerprint_required: settings.fingerprint_required,
    attack_mode_threshold: settings.attack_mode_threshold,
    surge_multiplier: settings.surge_multiplier,
    surge_min_per_hour: settings.surge_min_per_hour,
  };
}

function settingsPatch(
  baseline: FirewallSettings,
  draft: FirewallDraft,
): FirewallSettingsPatch | null {
  const patch: FirewallSettingsPatch = {};
  for (const key of [
    "attack_mode_enabled",
    "auto_attack_mode",
    "fingerprint_required",
  ] as const) {
    if (baseline[key] !== draft[key]) {
      Object.assign(patch, { [key]: draft[key] });
    }
  }
  for (const key of NUMERIC_FIELDS) {
    // An empty field is an unfinished edit, not a value: it never reaches the
    // wire. `validationMessage` blocks Save while one is empty and says which.
    const value = draft[key];
    if (value !== null && baseline[key] !== value) {
      Object.assign(patch, { [key]: value });
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

function clearedNumericFields(draft: FirewallDraft): Partial<FirewallDraft> {
  const cleared: Partial<FirewallDraft> = {};
  for (const key of NUMERIC_FIELDS) {
    if (draft[key] === null) cleared[key] = null;
  }
  return cleared;
}

function validationMessage(draft: FirewallDraft): string | null {
  const { attack_mode_threshold, surge_multiplier, surge_min_per_hour } = draft;
  if (attack_mode_threshold === null) return "Risk threshold is required.";
  if (surge_multiplier === null) return "Surge multiplier is required.";
  if (surge_min_per_hour === null) return "Hourly surge floor is required.";
  try {
    validateFirewallPatch({
      attack_mode_enabled: draft.attack_mode_enabled,
      auto_attack_mode: draft.auto_attack_mode,
      fingerprint_required: draft.fingerprint_required,
      attack_mode_threshold,
      surge_multiplier,
      surge_min_per_hour,
    });
    return null;
  } catch (error) {
    return apiErrorMessage(error, "Firewall settings are invalid.");
  }
}

function eventTone(action: string): "success" | "warning" | "secondary" {
  if (action === "accepted") return "success";
  if (action === "rejected") return "warning";
  return "secondary";
}

export function FirewallControlPanel({
  identity,
  settings,
  onSettingsUpdated,
  onRefresh,
}: {
  identity: MeResponse;
  settings: FirewallSettings;
  onSettingsUpdated: (settings: FirewallSettings) => void;
  onRefresh: () => void;
}) {
  const role = effectiveAuthRole(identity);
  const canAdmin = !identity.viewer_mode && roleCanWrite(role);
  const authorityKey = [identity.tenant_id, identity.user_id, role, identity.viewer_mode ? "viewer" : "member"].join(":");
  const authorityKeyRef = useRef(authorityKey);
  const actionRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const baselineRef = useRef(settings);
  const [draft, setDraft] = useState<FirewallDraft>(() => toDraft(settings));
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRejectAllOpen, setConfirmRejectAllOpen] = useState(false);
  const saveButtonRef = useRef<HTMLButtonElement>(null);

  // Identity changes only. A refreshed `settings` prop must NOT reach here:
  // resetting on it would discard the operator's in-progress edits and wipe
  // the banner that just explained why the save failed — including the
  // conflict path, which feeds the newer settings back through this prop and
  // promises the local edits were kept. The merge effect below is the single
  // owner of prop-to-draft reconciliation.
  useEffect(() => {
    authorityKeyRef.current = authorityKey;
    controllerRef.current?.abort();
    controllerRef.current = null;
    actionRef.current = false;
    setConfirmRejectAllOpen(false);
    setDraft(toDraft(baselineRef.current));
    setMessage(null);
    setError(null);
  }, [authorityKey]);

  useEffect(() => {
    const previous = baselineRef.current;
    setDraft((current) => ({
      ...toDraft(settings),
      ...(settingsPatch(previous, current) ?? {}),
      // A field the operator has cleared stays cleared. Refilling it from the
      // server would put a value back under a cursor that is mid-edit.
      ...clearedNumericFields(current),
    }));
    baselineRef.current = settings;
  }, [settings]);

  const patch = useMemo(
    () => settingsPatch(baselineRef.current, draft),
    [draft],
  );
  const invalid = validationMessage(draft);
  // A cleared field is a change too, and can never be part of a patch — so
  // Discard reads this rather than `patch`, or it would sit disabled with an
  // emptied field on screen and no way to put the saved value back.
  const dirty =
    Boolean(patch) || NUMERIC_FIELDS.some((key) => draft[key] === null);
  const eventsKey = useMemo(
    () => base("signup-firewall-events", identity.tenant_id, role),
    [identity.tenant_id, role],
  );
  const events = useQuery({
    queryKey: eventsKey,
    queryFn: ({ signal }) => listFirewallEvents({ limit: 20, signal }),
    staleTime: STALE.list,
  });

  async function verifyAuthority(signal: AbortSignal): Promise<void> {
    const fresh = await whoamiFresh(signal);
    if (
      fresh.tenant_id !== identity.tenant_id ||
      fresh.user_id !== identity.user_id
      || effectiveAuthRole(fresh) !== role
      || fresh.viewer_mode !== identity.viewer_mode
    ) {
      throw new Error(
        "Workspace identity changed. Reload before changing firewall policy.",
      );
    }
    if (!roleCanWrite(effectiveAuthRole(fresh))) {
      throw new Error("An owner or admin role is required.");
    }
  }

  const save = useMutation({
    mutationKey: ["signup-firewall", identity.tenant_id, "save"],
    mutationFn: async () => {
      const nextPatch = settingsPatch(baselineRef.current, draft);
      if (!nextPatch) throw new Error("No firewall changes to save.");
      validateFirewallPatch(nextPatch);
      const controller = new AbortController();
      controllerRef.current = controller;
      const openedAuthority = authorityKey;
      await verifyAuthority(controller.signal);
      // The route has no ETag/version precondition. Re-read immediately before
      // PUT and fail on a changed timestamp so the UI does not knowingly
      // overwrite another operator. The server remains the final authority.
      const latest = await getFirewallSettings({
        tenantId: identity.tenant_id, signal: controller.signal,
      });
      if (latest.updated_at !== baselineRef.current.updated_at) {
        throw new FirewallSettingsConflictError(latest);
      }
      const saved = await updateFirewallSettings(nextPatch, identity.tenant_id, { signal: controller.signal, idempotencyKey: `firewall-save:${crypto.randomUUID()}` });
      if (controller.signal.aborted || authorityKeyRef.current !== openedAuthority) throw new DOMException("Stale authority", "AbortError");
      return saved;
    },
    onMutate: () => {
      setError(null);
      setMessage(null);
    },
    onSuccess: (next) => {
      baselineRef.current = next;
      setDraft(toDraft(next));
      onSettingsUpdated(next);
      setMessage("Firewall settings saved.");
    },
    onError: (failure) => {
      if (failure instanceof DOMException && failure.name === "AbortError") return;
      if (failure instanceof FirewallSettingsConflictError) {
        onSettingsUpdated(failure.latest);
      }
      setError(
        apiErrorMessage(failure, "Firewall settings could not be saved."),
      );
    },
    onSettled: () => {
      actionRef.current = false;
      controllerRef.current = null;
    },
  });

  const detect = useMutation({
    mutationKey: ["signup-firewall", identity.tenant_id, "detect"],
    mutationFn: async () => {
      const controller = new AbortController();
      controllerRef.current = controller;
      const openedAuthority = authorityKey;
      await verifyAuthority(controller.signal);
      const result = await runFirewallSurgeDetection({ signal: controller.signal, idempotencyKey: `firewall-detect:${crypto.randomUUID()}` });
      if (controller.signal.aborted || authorityKeyRef.current !== openedAuthority) throw new DOMException("Stale authority", "AbortError");
      return result;
    },
    onMutate: () => {
      setError(null);
      setMessage(null);
    },
    onSuccess: (result) => {
      setMessage(
        result.flipped
          ? "A signup surge was verified and attack mode was engaged."
          : "The surge check completed and did not change attack mode.",
      );
      onRefresh();
      void events.refetch();
    },
    onError: (failure) => {
      if (failure instanceof DOMException && failure.name === "AbortError") return;
      setError(apiErrorMessage(failure, "The surge check could not be run."));
    },
    onSettled: () => {
      actionRef.current = false;
      controllerRef.current = null;
    },
  });

  const busy = save.isPending || detect.isPending;
  // Attack mode at threshold 0 rejects every signup, legitimate ones included
  // (the server evaluates `risk >= threshold`). It is a legal setting, so it is
  // confirmed rather than blocked.
  const rejectsEverySignup =
    draft.attack_mode_enabled && draft.attack_mode_threshold === 0;

  function startSave() {
    if (actionRef.current) return;
    actionRef.current = true;
    save.mutate();
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <EngagementSurface
        id="sp-firewall-controls"
        title="Firewall controls"
        description="Admin-only policy for signup risk, automatic surge containment, and browser fingerprint enforcement."
      >
        {!canAdmin ? (
          <p role="note" className="mb-4 rounded-lg border p-3 text-sm">
            You can inspect firewall policy, but only an owner or admin can
            change it or run a surge check.
          </p>
        ) : null}

        <div className="space-y-4">
          {(
            [
              {
                key: "attack_mode_enabled",
                label: "Attack mode",
                description:
                  "Reject signup submissions at or above the configured risk threshold.",
              },
              {
                key: "auto_attack_mode",
                label: "Automatic attack mode",
                description:
                  "Let the server engage attack mode when its hourly surge rule is met.",
              },
              {
                key: "fingerprint_required",
                label: "Require browser fingerprint",
                description:
                  "Treat a missing host-page browser fingerprint as a high-risk signal.",
              },
            ] as const
          ).map((item) => (
            <div
              key={item.key}
              className="flex items-start justify-between gap-4 rounded-lg border p-3"
            >
              <div>
                <Label htmlFor={`firewall-${item.key}`}>{item.label}</Label>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {item.description}
                </p>
              </div>
              <Checkbox
                id={`firewall-${item.key}`}
                checked={draft[item.key]}
                disabled={!canAdmin || busy}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    [item.key]: event.target.checked,
                  }))
                }
              />
            </div>
          ))}

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="firewall-risk-threshold">Risk threshold</Label>
              <Input
                id="firewall-risk-threshold"
                type="number"
                min={0}
                max={100}
                value={draft.attack_mode_threshold ?? ""}
                disabled={!canAdmin || busy}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    attack_mode_threshold:
                      event.target.value === ""
                        ? null
                        : Number(event.target.value),
                  }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="firewall-surge-multiplier">
                Surge multiplier
              </Label>
              <Input
                id="firewall-surge-multiplier"
                type="number"
                min={2}
                max={100}
                value={draft.surge_multiplier ?? ""}
                disabled={!canAdmin || busy}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    surge_multiplier:
                      event.target.value === ""
                        ? null
                        : Number(event.target.value),
                  }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="firewall-surge-floor">Hourly surge floor</Label>
              <Input
                id="firewall-surge-floor"
                type="number"
                min={1}
                max={100_000}
                value={draft.surge_min_per_hour ?? ""}
                disabled={!canAdmin || busy}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    surge_min_per_hour:
                      event.target.value === ""
                        ? null
                        : Number(event.target.value),
                  }))
                }
              />
            </div>
          </div>

          {invalid ? (
            <p role="alert" className="text-sm text-destructive">
              {invalid}
            </p>
          ) : null}
          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
            >
              {error}
            </p>
          ) : null}
          {message ? (
            <p role="status" className="rounded-lg border p-3 text-sm">
              {message}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              ref={saveButtonRef}
              type="button"
              disabled={!canAdmin || !patch || Boolean(invalid) || busy}
              loading={save.isPending}
              onClick={() => {
                if (actionRef.current) return;
                if (rejectsEverySignup) {
                  setConfirmRejectAllOpen(true);
                  return;
                }
                startSave();
              }}
            >
              Save firewall settings
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!canAdmin || !dirty || busy}
              onClick={() => {
                setDraft(toDraft(baselineRef.current));
                setError(null);
                setMessage(null);
              }}
            >
              Discard changes
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={!canAdmin || busy}
              loading={detect.isPending}
              onClick={() => {
                if (actionRef.current) return;
                actionRef.current = true;
                detect.mutate();
              }}
            >
              Check for surge
            </Button>
          </div>

          <ConfirmDialog
            open={confirmRejectAllOpen}
            onOpenChange={setConfirmRejectAllOpen}
            returnFocusRef={saveButtonRef}
            title="Reject every signup?"
            description="Attack mode with a risk threshold of 0 rejects every signup submission — real subscribers included — until someone raises the threshold or turns attack mode off. New signups stop arriving from every form, landing page, and API caller."
            confirmLabel="Save and reject every signup"
            onConfirm={startSave}
          />

          <p className="text-xs leading-relaxed text-muted-foreground">
            Last updated {formatWireTimestamp(settings.updated_at, "unknown")}.
            The server does not expose an ETag for this policy; Moosewave
            performs a fresh identity and timestamp check immediately before
            saving and refuses a known conflict.
          </p>
          {settings.attack_mode_auto_enabled_at ? (
            <p className="text-xs text-muted-foreground">
              Last engaged automatically{" "}
              {formatWireTimestamp(
                settings.attack_mode_auto_enabled_at,
                "an unknown time",
              )}
              .
            </p>
          ) : null}
          {settings.attack_mode_auto_cooldown_until ? (
            <p className="text-xs text-muted-foreground">
              Automatic re-engagement is held until{" "}
              {formatWireTimestamp(
                settings.attack_mode_auto_cooldown_until,
                "an unknown time",
              )}
              .
            </p>
          ) : null}
        </div>
      </EngagementSurface>

      <EngagementSurface
        id="sp-firewall-events"
        title="Recent firewall decisions"
        description="The latest 20 risk decisions. IP addresses and user-agent strings are deliberately not retained in browser state."
      >
        {events.isPending ? (
          <EngagementLoading label="Loading recent firewall decisions" />
        ) : events.isError ? (
          <EngagementQueryError
            title="Firewall decisions could not be loaded"
            description="A failed event query is not represented as a quiet firewall."
            retrying={events.isFetching}
            onRetry={() => void events.refetch()}
          />
        ) : (events.data?.events?.length ?? 0) === 0 ? (
          <EngagementEmpty
            title="No firewall decisions recorded"
            description="The event request completed successfully and returned no recent decisions."
          />
        ) : (
          <ol
            className="divide-y rounded-lg border"
            aria-label="Firewall events"
          >
            {events.data?.events?.map((event) => (
              <li
                key={event.id}
                className="flex flex-wrap items-center justify-between gap-3 p-3"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <Badge variant={eventTone(event.action)}>
                      {event.action}
                    </Badge>
                    <span className="text-sm font-medium tabular-nums">
                      Risk {event.riskScore}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatWireTimestamp(event.at, "an unknown time")}
                    {event.formId ? ` · form ${event.formId}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </EngagementSurface>
    </div>
  );
}
