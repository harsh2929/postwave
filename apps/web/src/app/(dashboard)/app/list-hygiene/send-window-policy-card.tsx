// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * SendWindowPolicyCard — the send-window editor (parity row campaigns-33).
 *
 * Web could READ this policy and never change it: /list-hygiene rendered one
 * sentence off GET /api/v1/send-window, and /preflight can check a candidate
 * time against it, but PUT and DELETE were reachable from no web file. Desktop
 * has had the editor since composer/SendWindowPolicyModal.
 *
 * THREE THINGS THIS SCREEN HAS TO KEEP STRAIGHT:
 *
 * 1. NO POLICY IS THE PERMISSIVE STATE. `{"policy": null}` means sending is
 *    unrestricted — not that a feature is missing. So the empty state offers to
 *    CREATE a restriction and says plainly that nothing restricts sending yet.
 *
 * 2. "OFF" IS NOT "REMOVED". Enforcement `off` keeps the declared hours on the
 *    record while enforcing nothing; DELETE throws the hours away. Both leave
 *    sending unrestricted today and they differ entirely in what survives, so
 *    they are separate controls and the confirm says which one this is.
 *
 * 3. THE WEEKDAY BITMAP IS GO's WEEKDAY NUMBERING (bit 0 = Sunday). The bit
 *    maths lives in list-hygiene-api.ts and nothing here recomputes it — an
 *    ISO 1..7 index would shift every window by a day and still look right.
 *
 * PUT/DELETE are ScopeAdmin server-side, a stricter gate than the read. A
 * non-admin gets the form read-only with the reason, never a Save that 403s.
 */

import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import {
  bitmapHasDay,
  deleteSendWindow,
  DEFAULT_WEEKDAY_BITMAP,
  getSendWindow,
  putSendWindow,
  SEND_WINDOW_ENFORCEMENTS,
  toggleWeekday,
  validateSendWindowDraft,
  WEEKDAY_LABELS,
  weekdaysLabel,
  type SendWindowEnforcement,
  type SendWindowPolicy,
} from "@/lib/list-hygiene-api";
import { STALE } from "@/lib/query-keys";
import { isKnownTimeZone } from "@/lib/timezones";
import { roleCanWrite } from "@/lib/use-admin-gate";

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

interface Draft {
  start_local: string;
  end_local: string;
  timezone: string;
  weekday_bitmap: number;
  enforcement: SendWindowEnforcement;
}

function draftFrom(policy: SendWindowPolicy | null): Draft {
  if (!policy) {
    return {
      start_local: "09:00",
      end_local: "17:00",
      timezone: localTimezone(),
      weekday_bitmap: DEFAULT_WEEKDAY_BITMAP,
      enforcement: "warn",
    };
  }
  const enforcement = SEND_WINDOW_ENFORCEMENTS.find(
    (option) => option.value === policy.enforcement,
  );
  return {
    start_local: policy.start_local,
    end_local: policy.end_local,
    timezone: policy.timezone || "UTC",
    weekday_bitmap: policy.weekday_bitmap,
    enforcement: enforcement?.value ?? "warn",
  };
}

export function SendWindowPolicyCard({
  identity,
  queryKey,
}: {
  /** The page's resolved identity; null while it is still unknown. */
  identity: MeResponse | null;
  /** The page's own send-window key, so both observers share one fetch. */
  queryKey: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const startId = useId();
  const endId = useId();
  const tzId = useId();
  const enforcementId = useId();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(null));
  const [seeded, setSeeded] = useState(false);

  const role = identity ? effectiveAuthRole(identity) : null;
  const canAdmin = Boolean(
    identity && identity.viewer_mode !== true && roleCanWrite(role),
  );

  const windowQuery = useQuery({
    queryKey: [...queryKey],
    queryFn: getSendWindow,
    enabled: identity !== null,
    staleTime: STALE.reference,
  });
  const policy = windowQuery.data?.policy ?? null;

  // Seed the form from the server ONCE, when the first read lands. The `seeded`
  // latch is deliberate: a background refetch must never overwrite an edit in
  // progress. The two write paths re-seed explicitly from their own response,
  // which is the only other moment the server's copy is newer than the draft.
  useEffect(() => {
    if (!windowQuery.isSuccess || seeded) return;
    setDraft(draftFrom(windowQuery.data.policy));
    setSeeded(true);
  }, [seeded, windowQuery.data, windowQuery.isSuccess]);

  const saveMutation = useMutation({
    mutationFn: async (next: Draft) => {
      if (!identity) throw new Error("Workspace identity is not resolved yet.");
      await verifyFreshAdminAuthority(identity);
      return putSendWindow(next);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKey, { policy: saved });
      setDraft(draftFrom(saved));
      toast.success(
        saved
          ? `Send window saved — ${saved.start_local}–${saved.end_local} ${saved.timezone}, ${weekdaysLabel(saved.weekday_bitmap)}, ${saved.enforcement}.`
          : "Send window saved.",
      );
    },
    onError: (error: unknown) => {
      toast.error(apiErrorMessage(error, "The send window could not be saved."));
    },
  });

  const removeMutation = useMutation({
    mutationFn: async () => {
      if (!identity) throw new Error("Workspace identity is not resolved yet.");
      await verifyFreshAdminAuthority(identity);
      await deleteSendWindow();
    },
    onSuccess: () => {
      queryClient.setQueryData(queryKey, { policy: null });
      setDraft(draftFrom(null));
      toast.success(
        "Send window removed — sending is no longer restricted by time of day.",
      );
    },
    onError: (error: unknown) => {
      toast.error(
        apiErrorMessage(error, "The send window could not be removed."),
      );
    },
  });

  const busy = saveMutation.isPending || removeMutation.isPending;
  // validateSendWindowDraft covers the times and the weekday bitmap only. An
  // emptied timezone box is the one input the server does not push back on: it
  // substitutes UTC rather than rejecting, so 09:00–17:00 meant as local hours
  // would be stored as UTC and, under `block`, refuse every send during the
  // intended morning. Refuse it here, where the browser knows the IANA names.
  const validationError =
    validateSendWindowDraft(draft) ??
    (isKnownTimeZone(draft.timezone)
      ? null
      : "Enter a valid IANA timezone, for example Europe/Stockholm.");
  const saveBlockedReason = !identity
    ? "Workspace identity is still resolving."
    : !canAdmin
      ? "Changing the send window needs owner or admin access outside viewer mode."
      : windowQuery.isPending
        ? "Wait while the current policy is read."
        : busy
          ? "A send-window change is already running."
          : validationError;
  const removeBlockedReason = !identity
    ? "Workspace identity is still resolving."
    : !canAdmin
      ? "Changing the send window needs owner or admin access outside viewer mode."
      : busy
        ? "A send-window change is already running."
        : !policy
          ? "There is no send window to remove."
          : null;

  return (
    <section
      aria-labelledby="lh-window"
      className="rounded-lg border p-4 sm:p-6"
      data-testid="send-window-policy"
      data-state={policy ? "configured" : "none"}
    >
      <h2 id="lh-window" className="text-base font-medium">
        Send window
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {windowQuery.isPending
          ? "Loading…"
          : windowQuery.isError
            ? "Could not load the send window — this is a failed request, not an absent policy."
            : policy
              ? `${policy.start_local}–${policy.end_local} ${policy.timezone} on ${weekdaysLabel(policy.weekday_bitmap)}; enforcement ${policy.enforcement}.`
              : // null is permissive, not missing.
                "No send window configured — sending is not restricted by time of day."}
      </p>
      {policy?.updated_at ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Last changed {formatWireTimestamp(policy.updated_at, "at an unknown time")}.
        </p>
      ) : null}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={startId}>Window opens (local)</Label>
          <Input
            id={startId}
            type="time"
            value={draft.start_local}
            disabled={!canAdmin || busy}
            onChange={(event) =>
              setDraft((d) => ({ ...d, start_local: event.target.value }))
            }
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={endId}>Window closes (local)</Label>
          <Input
            id={endId}
            type="time"
            value={draft.end_local}
            disabled={!canAdmin || busy}
            onChange={(event) =>
              setDraft((d) => ({ ...d, end_local: event.target.value }))
            }
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={tzId}>Timezone (IANA)</Label>
          <Input
            id={tzId}
            value={draft.timezone}
            placeholder="Europe/Stockholm"
            disabled={!canAdmin || busy}
            onChange={(event) =>
              setDraft((d) => ({ ...d, timezone: event.target.value }))
            }
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={enforcementId}>Enforcement</Label>
          <Select
            id={enforcementId}
            value={draft.enforcement}
            disabled={!canAdmin || busy}
            onChange={(event) =>
              setDraft((d) => ({
                ...d,
                enforcement: event.target.value as SendWindowEnforcement,
              }))
            }
          >
            {SEND_WINDOW_ENFORCEMENTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">
            {
              SEND_WINDOW_ENFORCEMENTS.find(
                (option) => option.value === draft.enforcement,
              )?.hint
            }
          </p>
        </div>
      </div>

      <fieldset className="mt-4">
        <legend className="text-sm font-medium">Days</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {WEEKDAY_LABELS.map((label, day) => {
            const on = bitmapHasDay(draft.weekday_bitmap, day);
            return (
              <Button
                key={label}
                type="button"
                size="sm"
                variant={on ? "default" : "outline"}
                aria-pressed={on}
                disabled={!canAdmin || busy}
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    weekday_bitmap: toggleWeekday(d.weekday_bitmap, day),
                  }))
                }
              >
                {label}
              </Button>
            );
          })}
        </div>
      </fieldset>

      <p
        id="send-window-guidance"
        role="status"
        aria-live="polite"
        className="mt-3 text-xs text-muted-foreground"
      >
        {saveBlockedReason ??
          "Saving replaces the whole policy — one send window exists per workspace."}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={saveBlockedReason !== null}
          aria-describedby="send-window-guidance"
          onClick={() => saveMutation.mutate(draft)}
        >
          {saveMutation.isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Saving…
            </>
          ) : policy ? (
            "Save send window"
          ) : (
            "Create send window"
          )}
        </Button>
        <ConfirmDialog
          trigger={
            <Button
              type="button"
              variant="outline"
              disabled={removeBlockedReason !== null}
              aria-describedby="send-window-guidance"
            >
              {removeMutation.isPending ? "Removing…" : "Remove send window"}
            </Button>
          }
          title="Remove the send window?"
          description="The declared hours, timezone and weekdays are deleted, and sending stops being restricted by time of day for this whole workspace. To keep the hours on record but stop enforcing them, set enforcement to Off and save instead."
          confirmLabel="Remove send window"
          cancelLabel="Keep the window"
          onConfirm={() => removeMutation.mutateAsync()}
        />
      </div>
    </section>
  );
}
