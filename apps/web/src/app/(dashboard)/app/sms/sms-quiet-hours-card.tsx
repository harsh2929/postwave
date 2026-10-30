// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { qk } from "@/lib/query-keys";
import {
  createSmsQuietHours,
  deleteSmsQuietHours,
  listSmsQuietHours,
  updateSmsQuietHours,
  type SmsQuietHoursMutationInput,
  type SmsQuietHoursProjection,
} from "@/lib/sms-scheduling-api";
import { SMS_TIMEZONES, isValidIanaTimeZone } from "./page-helpers";
import { CardLoadError } from "./sms-card-states";
import { smsKnownWriteRefusalMessage } from "./sms-write-outcome";

const DAYS = [
  { value: 0, short: "Sun", long: "Sunday" },
  { value: 1, short: "Mon", long: "Monday" },
  { value: 2, short: "Tue", long: "Tuesday" },
  { value: 3, short: "Wed", long: "Wednesday" },
  { value: 4, short: "Thu", long: "Thursday" },
  { value: 5, short: "Fri", long: "Friday" },
  { value: 6, short: "Sat", long: "Saturday" },
] as const;

const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}]/u;

interface QuietHoursDraft {
  label: string;
  start: string;
  end: string;
  days: number[];
  timezone: string;
  enabled: boolean;
}

interface EditorState {
  row: SmsQuietHoursProjection | null;
  draft: QuietHoursDraft;
  baseline: QuietHoursDraft;
}

const EMPTY_DRAFT: QuietHoursDraft = {
  label: "",
  start: "21:00",
  end: "09:00",
  days: DAYS.map((day) => day.value),
  timezone: "UTC",
  enabled: true,
};

function minuteFromTime(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function draftFromRow(row: SmsQuietHoursProjection): QuietHoursDraft {
  return {
    label: row.label,
    start: row.start_local,
    end: row.end_local,
    days: [...row.days],
    timezone: row.timezone,
    enabled: row.enabled,
  };
}

function sameDraft(left: QuietHoursDraft, right: QuietHoursDraft): boolean {
  return (
    left.label === right.label &&
    left.start === right.start &&
    left.end === right.end &&
    left.timezone === right.timezone &&
    left.enabled === right.enabled &&
    left.days.length === right.days.length &&
    left.days.every((day, index) => day === right.days[index])
  );
}

function mutationInputFromDraft(
  draft: QuietHoursDraft,
): SmsQuietHoursMutationInput | null {
  const start = minuteFromTime(draft.start);
  const end = minuteFromTime(draft.end);
  const label = draft.label.trim();
  const timezone = draft.timezone.trim();
  if (
    start === null ||
    end === null ||
    draft.days.length < 1 ||
    draft.days.length > 7 ||
    draft.days.some(
      (day, index) =>
        !Number.isInteger(day) ||
        day < 0 ||
        day > 6 ||
        (index > 0 && day <= draft.days[index - 1]!),
    ) ||
    [...label].length > 128 ||
    new TextEncoder().encode(label).length > 512 ||
    UNSAFE_TEXT.test(label) ||
    !isValidIanaTimeZone(timezone)
  ) {
    return null;
  }
  return {
    label,
    country_code: "",
    start_minute: start,
    end_minute: end,
    days: [...draft.days],
    timezone,
    enabled: draft.enabled,
  };
}

function daysLabel(days: number[]): string {
  const key = days.join(",");
  if (key === "0,1,2,3,4,5,6") return "Every day";
  if (key === "1,2,3,4,5") return "Weekdays";
  if (key === "0,6") return "Weekends";
  return days.map((day) => DAYS[day]?.short ?? String(day)).join(", ");
}

function windowLabel(row: SmsQuietHoursProjection): string {
  if (row.start_minute === row.end_minute) return "All day";
  const suffix = row.start_minute > row.end_minute ? " · overnight" : "";
  return `${row.start_local}–${row.end_local}${suffix}`;
}

function rowMutationInput(
  row: SmsQuietHoursProjection,
  overrides: Partial<SmsQuietHoursMutationInput>,
): SmsQuietHoursMutationInput {
  return {
    label: row.label,
    country_code: "",
    start_minute: row.start_minute,
    end_minute: row.end_minute,
    days: [...row.days],
    timezone: row.timezone,
    enabled: row.enabled,
    ...overrides,
  };
}

interface SmsQuietHoursCardProps {
  baseKey: readonly unknown[];
  enabled: boolean;
  tenantId: string;
  userId: string;
}

export function SmsQuietHoursCard({
  baseKey,
  enabled,
  tenantId,
  userId,
}: SmsQuietHoursCardProps) {
  const queryClient = useQueryClient();
  const key = useMemo(() => [...baseKey, "quiet-hours"] as const, [baseKey]);
  const lifecycle = useRef(0);
  const writes = useRef(new Set<AbortController>());
  const mutationBusyRef = useRef(false);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const operationTriggerRef = useRef<HTMLElement | null>(null);

  const [mutationBusy, setMutationBusy] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [disableTarget, setDisableTarget] =
    useState<SmsQuietHoursProjection | null>(null);
  const [deleteTarget, setDeleteTarget] =
    useState<SmsQuietHoursProjection | null>(null);
  const [repairTarget, setRepairTarget] =
    useState<SmsQuietHoursProjection | null>(null);

  useEffect(() => {
    const ownedWrites = writes.current;
    lifecycle.current += 1;
    const generation = lifecycle.current;
    return () => {
      if (lifecycle.current === generation) lifecycle.current += 1;
      for (const controller of ownedWrites) controller.abort();
      ownedWrites.clear();
      mutationBusyRef.current = false;
      void queryClient.cancelQueries({ queryKey: key, exact: true });
      queryClient.removeQueries({ queryKey: key, exact: true });
    };
  }, [enabled, key, queryClient, tenantId, userId]);

  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => listSmsQuietHours(tenantId, { signal }),
    enabled,
  });
  const rows = Array.isArray(query.data) ? query.data : [];
  const verifiedCurrent = Boolean(
    enabled &&
    query.isSuccess &&
    !query.isError &&
    !query.isFetching &&
    Array.isArray(query.data),
  );
  const dialogOpen = Boolean(
    editor || discardOpen || disableTarget || deleteTarget || repairTarget,
  );

  const refetch = () =>
    queryClient.invalidateQueries({ queryKey: key, exact: true });

  const assertCurrentLifecycle = (generation: number) => {
    if (!enabled || lifecycle.current !== generation) {
      throw new DOMException("SMS quiet-hours operation retired", "AbortError");
    }
  };

  const reauthorize = async (generation: number) => {
    assertCurrentLifecycle(generation);
    const current = await whoami();
    assertCurrentLifecycle(generation);
    queryClient.setQueryData(qk.authMe(), current);
    const role = effectiveAuthRole(current);
    if (
      current.tenant_id !== tenantId ||
      current.user_id !== userId ||
      current.viewer_mode === true ||
      (role !== "owner" && role !== "admin")
    ) {
      throw new Error("SMS quiet-hours mutation reauthorization failed");
    }
  };

  const withWrite = async <T,>(
    generation: number,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    assertCurrentLifecycle(generation);
    const controller = new AbortController();
    writes.current.add(controller);
    try {
      const result = await run(controller.signal);
      assertCurrentLifecycle(generation);
      return result;
    } finally {
      writes.current.delete(controller);
    }
  };

  const retireForIdentityChange = async () => {
    await queryClient.cancelQueries({ queryKey: key, exact: true });
    queryClient.removeQueries({ queryKey: key, exact: true });
    await queryClient.invalidateQueries({ queryKey: qk.authMe() });
  };

  const acquireMutation = (): boolean => {
    if (!verifiedCurrent || mutationBusyRef.current) return false;
    mutationBusyRef.current = true;
    setMutationBusy(true);
    return true;
  };

  const releaseMutation = () => {
    mutationBusyRef.current = false;
    setMutationBusy(false);
  };

  const openCreate = () => {
    if (!verifiedCurrent || mutationBusy || dialogOpen) return;
    const draft = { ...EMPTY_DRAFT, days: [...EMPTY_DRAFT.days] };
    setEditor({
      row: null,
      draft,
      baseline: { ...draft, days: [...draft.days] },
    });
    setEditorError(null);
  };

  const openEdit = (row: SmsQuietHoursProjection) => {
    if (!verifiedCurrent || mutationBusy || dialogOpen || row.country_code) {
      return;
    }
    const draft = draftFromRow(row);
    setEditor({ row, draft, baseline: { ...draft, days: [...draft.days] } });
    setEditorError(null);
  };

  const requestEditorClose = () => {
    if (!editor || mutationBusy) return;
    if (!sameDraft(editor.draft, editor.baseline)) {
      setDiscardOpen(true);
      return;
    }
    setEditor(null);
    setEditorError(null);
  };

  const saveEditor = async () => {
    if (!editor) return;
    const input = mutationInputFromDraft(editor.draft);
    if (!input) {
      setEditorError(
        "Enter valid 24-hour times, at least one weekday, a safe label of at most 128 characters, and a valid IANA timezone.",
      );
      return;
    }
    if (!verifiedCurrent) {
      setEditorError(
        "Reload the current policy inventory before saving; stale rows are orientation only.",
      );
      return;
    }
    if (!acquireMutation()) return;
    const target = editor.row;
    const generation = lifecycle.current;
    let requestStarted = false;
    let receiptConfirmed = false;
    setEditorError(null);
    try {
      await reauthorize(generation);
      requestStarted = true;
      await withWrite(generation, (signal) =>
        target
          ? updateSmsQuietHours(
              target.id,
              input,
              target.updated_at,
              tenantId,
              signal,
            )
          : createSmsQuietHours(input, tenantId, signal),
      );
      receiptConfirmed = true;
      try {
        await reauthorize(generation);
      } catch {
        await retireForIdentityChange();
        setEditor(null);
        toast.error(
          "Quiet-hours change was confirmed before identity changed",
          {
            description:
              "The server receipt is valid, but this workspace view was retired. Reload the original workspace before relying on displayed state.",
          },
        );
        return;
      }
      setEditor(null);
      toast.success(
        target ? "Quiet-hours window updated" : "Quiet-hours window added",
      );
      await refetch();
    } catch (error: unknown) {
      if (lifecycle.current !== generation) return;
      const refusal = requestStarted
        ? smsKnownWriteRefusalMessage(error)
        : null;
      setEditorError(
        refusal ??
          (requestStarted
            ? "The save outcome is unknown because no valid receipt was available. Reload the exact policy before retrying."
            : "Reauthorization failed before the write request; no change was sent."),
      );
      if (requestStarted && !receiptConfirmed) await refetch();
    } finally {
      if (lifecycle.current === generation) releaseMutation();
    }
  };

  const updateRow = async (
    row: SmsQuietHoursProjection,
    input: SmsQuietHoursMutationInput,
    success: string,
  ) => {
    if (!verifiedCurrent || !acquireMutation()) return;
    const generation = lifecycle.current;
    let requestStarted = false;
    let receiptConfirmed = false;
    try {
      await reauthorize(generation);
      requestStarted = true;
      await withWrite(generation, (signal) =>
        updateSmsQuietHours(row.id, input, row.updated_at, tenantId, signal),
      );
      receiptConfirmed = true;
      try {
        await reauthorize(generation);
      } catch {
        await retireForIdentityChange();
        toast.error(
          "Quiet-hours update was confirmed before identity changed",
          {
            description:
              "The server receipt is valid, but this workspace view was retired. Reload the original workspace before relying on displayed state.",
          },
        );
        return;
      }
      toast.success(success);
      await refetch();
    } catch (error: unknown) {
      if (lifecycle.current !== generation) return;
      const refusal = requestStarted
        ? smsKnownWriteRefusalMessage(error)
        : null;
      toast.error("Could not update quiet-hours policy", {
        description:
          refusal ??
          (requestStarted
            ? "The update outcome is unknown because no valid receipt was available. Reload the exact policy before retrying."
            : "Reauthorization failed before the write request; no change was sent."),
      });
      if (requestStarted && !receiptConfirmed) await refetch();
    } finally {
      if (lifecycle.current === generation) releaseMutation();
    }
  };

  const removeRow = async (row: SmsQuietHoursProjection) => {
    if (!verifiedCurrent || !acquireMutation()) return;
    const generation = lifecycle.current;
    let requestStarted = false;
    let receiptConfirmed = false;
    try {
      await reauthorize(generation);
      requestStarted = true;
      await withWrite(generation, (signal) =>
        deleteSmsQuietHours(row.id, row.updated_at, tenantId, signal),
      );
      receiptConfirmed = true;
      try {
        await reauthorize(generation);
      } catch {
        await retireForIdentityChange();
        toast.error(
          "Quiet-hours deletion was confirmed before identity changed",
          {
            description:
              "The deletion receipt is valid, but this workspace view was retired. Reload the original workspace before relying on displayed state.",
          },
        );
        return;
      }
      toast.success("Quiet-hours window deleted");
      await refetch();
    } catch (error: unknown) {
      if (lifecycle.current !== generation) return;
      const refusal = requestStarted
        ? smsKnownWriteRefusalMessage(error)
        : null;
      toast.error("Could not delete quiet-hours policy", {
        description:
          refusal ??
          (requestStarted
            ? "The deletion outcome is unknown because no valid receipt was available. Reload the exact policy before retrying."
            : "Reauthorization failed before the write request; no deletion was sent."),
      });
      if (requestStarted && !receiptConfirmed) await refetch();
    } finally {
      if (lifecycle.current === generation) releaseMutation();
    }
  };

  const controlsLocked = !verifiedCurrent || mutationBusy || dialogOpen;

  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle className="text-base">SMS quiet hours</CardTitle>
          <CardDescription>
            Valid enabled tenant-wide windows defer otherwise eligible internal
            SMS requests. Hosted scheduling and provider dispatch remain
            release-held, so a stored window is not send or delivery evidence.
          </CardDescription>
        </div>
        <Button
          ref={addButtonRef}
          type="button"
          size="sm"
          className="shrink-0"
          disabled={controlsLocked}
          onClick={openCreate}
        >
          <Plus aria-hidden />
          Add window
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isFetching && query.data ? (
          <Alert>
            <AlertTitle>Refreshing stored policy</AlertTitle>
            <AlertDescription>
              Rows are temporarily read-only until the complete tenant inventory
              is verified again.
            </AlertDescription>
          </Alert>
        ) : null}

        {query.isPending && !query.data ? (
          <div
            aria-label="Loading SMS quiet-hours policy"
            role="status"
            className="space-y-3"
          >
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : query.isError && !query.data ? (
          <CardLoadError
            message="The complete SMS quiet-hours inventory could not be verified. No empty state or mutation controls are shown."
            onRetry={() => void refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Clock3}
            title="No stored quiet-hours windows"
            description="This verified empty inventory does not mean provider dispatch is available or that messages can send at every hour."
          />
        ) : (
          <div className="space-y-3" aria-label="Stored SMS quiet-hours policy">
            {query.isError ? (
              <CardLoadError
                message="The refresh failed. Previously verified rows are shown as stale and cannot be changed."
                onRetry={() => void refetch()}
              />
            ) : null}
            {rows.map((row) => (
              <article key={row.id} className="rounded-lg border p-4">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium">
                        <bdi
                          dir="auto"
                          className="[unicode-bidi:isolate] [overflow-wrap:anywhere]"
                        >
                          {row.label || "Untitled window"}
                        </bdi>
                      </h3>
                      <Badge variant={row.enabled ? "default" : "secondary"}>
                        {row.enabled ? "Gate enabled" : "Gate disabled"}
                      </Badge>
                      {row.country_code ? (
                        <Badge variant="destructive">
                          Legacy {row.country_code} scope · fail closed
                        </Badge>
                      ) : (
                        <Badge variant="outline">Tenant-wide</Badge>
                      )}
                    </div>
                    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                      <div>
                        <dt className="text-xs text-muted-foreground">
                          Window
                        </dt>
                        <dd className="font-medium tabular-nums">
                          {windowLabel(row)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">
                          Starts on
                        </dt>
                        <dd>{daysLabel(row.days)}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-xs text-muted-foreground">
                          Timezone
                        </dt>
                        <dd className="break-all">{row.timezone}</dd>
                      </div>
                    </dl>
                    {row.country_code ? (
                      <p className="text-xs text-destructive">
                        +1 phone identity cannot prove US versus Canada. This
                        historical scope must be atomically cleared and disabled
                        before the rule can be edited or enabled.
                      </p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {row.country_code ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={controlsLocked}
                        onClick={(event) => {
                          operationTriggerRef.current = event.currentTarget;
                          setRepairTarget(row);
                        }}
                      >
                        Retire legacy scope
                      </Button>
                    ) : (
                      <label className="flex min-h-10 items-center gap-2 rounded-md border px-3 text-xs">
                        <Checkbox
                          checked={row.enabled}
                          disabled={controlsLocked}
                          aria-label={`${row.enabled ? "Disable" : "Enable"} ${row.label || "untitled quiet-hours window"}`}
                          onChange={(event) => {
                            if (row.enabled) {
                              operationTriggerRef.current = event.currentTarget;
                              setDisableTarget(row);
                            } else {
                              void updateRow(
                                row,
                                rowMutationInput(row, { enabled: true }),
                                "Quiet-hours gate enabled",
                              );
                            }
                            event.currentTarget.checked = row.enabled;
                          }}
                        />
                        Enabled
                      </label>
                    )}
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      disabled={controlsLocked || Boolean(row.country_code)}
                      aria-label={`Edit ${row.label || "untitled quiet-hours window"}`}
                      onClick={() => openEdit(row)}
                    >
                      <Pencil aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      disabled={controlsLocked}
                      aria-label={`Delete ${row.label || "untitled quiet-hours window"}`}
                      onClick={(event) => {
                        operationTriggerRef.current = event.currentTarget;
                        setDeleteTarget(row);
                      }}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open) requestEditorClose();
        }}
      >
        <DialogContent closeDisabled={mutationBusy}>
          <DialogHeader>
            <DialogTitle>
              {editor?.row
                ? "Edit quiet-hours window"
                : "Add quiet-hours window"}
            </DialogTitle>
            <DialogDescription>
              Weekdays are local days on which the window starts. An end time
              earlier than the start continues overnight; equal times cover the
              whole selected day.
            </DialogDescription>
          </DialogHeader>
          {editor ? (
            <form
              className="space-y-4"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void saveEditor();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="sms-quiet-label">Label</Label>
                <Input
                  id="sms-quiet-label"
                  maxLength={128}
                  value={editor.draft.label}
                  disabled={mutationBusy}
                  onChange={(event) => {
                    const label = event.target.value;
                    setEditor((current) =>
                      current
                        ? { ...current, draft: { ...current.draft, label } }
                        : current,
                    );
                    setEditorError(null);
                  }}
                  placeholder="Customer local night"
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="sms-quiet-start">Start</Label>
                  <Input
                    id="sms-quiet-start"
                    type="time"
                    required
                    value={editor.draft.start}
                    disabled={mutationBusy}
                    onChange={(event) => {
                      const start = event.target.value;
                      setEditor((current) =>
                        current
                          ? { ...current, draft: { ...current.draft, start } }
                          : current,
                      );
                      setEditorError(null);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sms-quiet-end">End</Label>
                  <Input
                    id="sms-quiet-end"
                    type="time"
                    required
                    value={editor.draft.end}
                    disabled={mutationBusy}
                    onChange={(event) => {
                      const end = event.target.value;
                      setEditor((current) =>
                        current
                          ? { ...current, draft: { ...current.draft, end } }
                          : current,
                      );
                      setEditorError(null);
                    }}
                  />
                </div>
              </div>
              <fieldset className="space-y-2" disabled={mutationBusy}>
                <legend className="text-sm font-medium">
                  Days the window starts
                </legend>
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
                  {DAYS.map((day) => (
                    <label
                      key={day.value}
                      className="flex min-h-11 items-center justify-center gap-1.5 rounded-md border px-2 text-xs"
                      title={day.long}
                    >
                      <Checkbox
                        checked={editor.draft.days.includes(day.value)}
                        aria-label={day.long}
                        onChange={() => {
                          setEditor((current) => {
                            if (!current) return current;
                            const days = current.draft.days.includes(day.value)
                              ? current.draft.days.filter(
                                  (value) => value !== day.value,
                                )
                              : [...current.draft.days, day.value].sort(
                                  (a, b) => a - b,
                                );
                            return {
                              ...current,
                              draft: { ...current.draft, days },
                            };
                          });
                          setEditorError(null);
                        }}
                      />
                      {day.short}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="space-y-2">
                <Label htmlFor="sms-quiet-timezone">IANA timezone</Label>
                <Input
                  id="sms-quiet-timezone"
                  list="sms-quiet-timezones"
                  maxLength={128}
                  required
                  value={editor.draft.timezone}
                  disabled={mutationBusy}
                  onChange={(event) => {
                    const timezone = event.target.value;
                    setEditor((current) =>
                      current
                        ? { ...current, draft: { ...current.draft, timezone } }
                        : current,
                    );
                    setEditorError(null);
                  }}
                  placeholder="America/New_York"
                />
                <datalist id="sms-quiet-timezones">
                  {SMS_TIMEZONES.map((timezone) => (
                    <option key={timezone} value={timezone} />
                  ))}
                </datalist>
              </div>
              <label className="flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm">
                <Checkbox
                  checked={editor.draft.enabled}
                  disabled={mutationBusy}
                  onChange={(event) => {
                    const next = event.currentTarget.checked;
                    setEditor((current) =>
                      current
                        ? {
                            ...current,
                            draft: { ...current.draft, enabled: next },
                          }
                        : current,
                    );
                    setEditorError(null);
                  }}
                />
                Enable this internal eligibility gate after saving
              </label>
              {editorError ? (
                <Alert variant="destructive">
                  <AlertTitle>Quiet-hours policy was not saved</AlertTitle>
                  <AlertDescription>{editorError}</AlertDescription>
                </Alert>
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={mutationBusy}
                  onClick={requestEditorClose}
                >
                  Cancel
                </Button>
                <Button type="submit" loading={mutationBusy}>
                  {editor.row ? "Save changes" : "Add window"}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>

      {discardOpen ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setDiscardOpen(false);
          }}
          title="Discard quiet-hours changes?"
          description="The edited label, schedule, timezone, weekdays, or enabled state has not been saved."
          confirmLabel="Discard changes"
          onConfirm={() => {
            setDiscardOpen(false);
            setEditor(null);
            setEditorError(null);
          }}
        />
      ) : null}

      {disableTarget ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setDisableTarget(null);
          }}
          title="Disable this quiet-hours gate?"
          description={`Disable “${disableTarget.label || "Untitled window"}”? Otherwise eligible internal requests would no longer be deferred by this policy. Hosted scheduling and dispatch remain release-held.`}
          confirmLabel="Disable gate"
          returnFocusRef={operationTriggerRef}
          onConfirm={async () => {
            const target = disableTarget;
            setDisableTarget(null);
            await updateRow(
              target,
              rowMutationInput(target, { enabled: false }),
              "Quiet-hours gate disabled",
            );
          }}
        />
      ) : null}

      {repairTarget ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setRepairTarget(null);
          }}
          title="Retire unsupported country scope?"
          description={`Atomically clear the historical ${repairTarget.country_code} scope from “${repairTarget.label || "Untitled window"}” and disable the resulting tenant-wide rule? +1 identity cannot prove US versus Canada, so the existing policy is currently fail-closed.`}
          confirmLabel="Clear scope and disable"
          returnFocusRef={operationTriggerRef}
          onConfirm={async () => {
            const target = repairTarget;
            setRepairTarget(null);
            await updateRow(
              target,
              rowMutationInput(target, { country_code: "", enabled: false }),
              "Legacy scope retired and gate disabled",
            );
          }}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          title="Delete this quiet-hours policy?"
          description={`Delete “${deleteTarget.label || "Untitled window"}” (${windowLabel(deleteTarget)} ${deleteTarget.timezone})? This deletes a stored gate policy only and makes no claim about live dispatch or delivery.`}
          confirmLabel="Delete window"
          returnFocusRef={operationTriggerRef}
          fallbackFocusRef={addButtonRef}
          onConfirm={async () => {
            const target = deleteTarget;
            setDeleteTarget(null);
            await removeRow(target);
          }}
        />
      ) : null}
    </Card>
  );
}
