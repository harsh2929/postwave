/**
 * SmsQuietHoursCard — CRUD editor for tenant SMS quiet-hours windows
 * (GAP-LS-145).
 *
 * Backend (verified against apps/api/internal/sms/quiet_hours.go):
 *   GET    /api/v1/sms/quiet-hours          → {tenantId,items}
 *   POST   /api/v1/sms/quiet-hours          → 201 row | 422 validation_failed
 *   PATCH  /api/v1/sms/quiet-hours/{id}     → CAS 200 row | 409 policy_changed
 *   DELETE /api/v1/sms/quiet-hours/{id}     → CAS {ok,tenantId,id}
 *
 * Valid enabled tenant-wide rows are enforced by the internal eligibility
 * gate when it is invoked. Hosted SMS dispatch and scheduling remain
 * release-held, so a configured row is not evidence that traffic is live.
 *
 * Window semantics (mirrors the Go window math):
 *   - `days` are LOCAL weekdays, 0=Sunday .. 6=Saturday, the window
 *     STARTS on.
 *   - start > end is a valid overnight window (e.g. 21:00 → 09:00)
 *     that crosses midnight into the next day.
 *   - start == end holds the whole listed day.
 *
 * Mutations require the admin scope server-side, so the buttons gate
 * on useCanAdmin (not the looser useCanWrite).
 */

import { useEffect, useId, useRef, useState, type ReactElement } from "react";

import { ConfirmModal } from "../ConfirmModal";
import { FieldError, FormField, useFormErrors } from "../FormField";
import { Modal, ModalFooter } from "../Modal";
import { Notice } from "../Notice";
import { toast } from "../Toast";
import {
  SENDING_TIMEZONES,
  type SmsQuietHoursInput,
  type SmsQuietHoursRow,
  smsQuietHoursApi,
} from "../../lib/api-client";
import { useCanAdmin, useMe } from "../../lib/store";
import {
  QUIET_DAY_OPTIONS,
  formatQuietDays,
  hhmmToMinute,
  isSafeSmsOperatorText,
  isValidSmsTimezone,
  minuteToHHMM,
  parseSmsPolicyDeleteReceipt,
  parseSmsQuietHoursRows,
  quietWindowLabel,
} from "./sms-settings-helpers";

const COLS = "1.2fr 170px 1fr 1fr 64px 110px";

/** Sentinel select value that reveals the free-text IANA input. */
const CUSTOM_TZ = "__custom__";

interface Draft {
  label: string;
  country_code: string;
  /** "HH:MM" strings driven by `<input type="time">`. */
  start: string;
  end: string;
  /** 0=Sun .. 6=Sat (backend convention). */
  days: number[];
  /** Curated SENDING_TIMEZONES value, or CUSTOM_TZ. */
  tzSelect: string;
  /** Free-text IANA name, used when tzSelect === CUSTOM_TZ. */
  tzCustom: string;
  enabled: boolean;
}

/** Matches the server-side column defaults: 21:00 → 09:00, every day. */
const EMPTY_DRAFT: Draft = {
  label: "",
  country_code: "",
  start: "21:00",
  end: "09:00",
  days: [0, 1, 2, 3, 4, 5, 6],
  tzSelect: "Etc/UTC",
  tzCustom: "",
  enabled: true,
};

function draftFromRow(row: SmsQuietHoursRow): Draft {
  const curated = SENDING_TIMEZONES.some((tz) => tz.value === row.timezone);
  return {
    label: row.label ?? "",
    country_code: row.country_code ?? "",
    start: minuteToHHMM(row.start_minute),
    end: minuteToHHMM(row.end_minute),
    days: [...(row.days ?? [])],
    tzSelect: curated ? row.timezone : CUSTOM_TZ,
    tzCustom: curated ? "" : row.timezone,
    enabled: row.enabled,
  };
}

function safeQuietHoursFailure(
  operation: "load" | "save" | "toggle" | "delete",
  status?: number,
): string {
  if (status === 401 || status === 403) {
    return "Admin authorization for stored quiet-hours policy is no longer available.";
  }
  if (status === 400 || status === 409 || status === 422) {
    return operation === "load"
      ? "The quiet-hours service rejected this request. Retry from a current workspace session."
      : "The quiet-hours service rejected this policy change. Review the current record and form values, then retry.";
  }
  if (status === 404 || status === 405) {
    return operation === "load"
      ? "Stored quiet-hours policy is unavailable on this deployment."
      : "This quiet-hours record or policy route is no longer available. Refresh before making another change.";
  }
  return operation === "load"
    ? "Stored quiet-hours policy could not be loaded."
    : "The quiet-hours policy change outcome is unverified. Refresh the current policy list and exact row, if present, before retrying; do not assume nothing changed.";
}

function isKnownQuietHoursMutationRejection(status?: number): boolean {
  return [400, 401, 403, 404, 405, 409, 422].includes(status ?? 0);
}

function SmsQuietHoursCardIdentity({
  expectedTenantId,
}: {
  expectedTenantId: string;
}): ReactElement {
  const canMutate = useCanAdmin();

  const [rows, setRows] = useState<SmsQuietHoursRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  /* Editor modal (create when editTarget is null). */
  const [editorOpen, setEditorOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SmsQuietHoursRow | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [editorConflict, setEditorConflict] = useState(false);
  const errors = useFormErrors();
  const editorBaselineRef = useRef<Draft>(EMPTY_DRAFT);
  const [discardEditorOpen, setDiscardEditorOpen] = useState(false);

  /* Per-row enabled toggle + delete confirm. */
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SmsQuietHoursRow | null>(
    null,
  );
  const [disableTarget, setDisableTarget] = useState<SmsQuietHoursRow | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const deleteReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const disableReturnFocusRef = useRef<HTMLInputElement | null>(null);
  const addDescriptionId = useId();
  const rowDescriptionBaseId = useId();
  const operationInFlightRef = useRef(false);
  const activeRef = useRef(true);
  const loadSequenceRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const mutationAbortRef = useRef<AbortController | null>(null);

  const load = async (): Promise<void> => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const requestId = ++loadSequenceRef.current;
    setLoading(true);
    setErr(null);
    try {
      const res = await smsQuietHoursApi.list({ signal: controller.signal });
      if (!activeRef.current || requestId !== loadSequenceRef.current) return;
      if (res.error) {
        setErr(safeQuietHoursFailure("load", res.error.status));
      } else {
        const parsed = parseSmsQuietHoursRows(res.data, expectedTenantId);
        if (!parsed) {
          setErr(
            "The quiet-hours response failed its private tenant and row contract. No unverified rows were shown.",
          );
          setRows(null);
        } else {
          setRows(parsed);
        }
      }
    } catch {
      if (activeRef.current && requestId === loadSequenceRef.current) {
        setErr(safeQuietHoursFailure("load"));
      }
    } finally {
      if (activeRef.current && requestId === loadSequenceRef.current) {
        setLoading(false);
      }
      if (loadAbortRef.current === controller) loadAbortRef.current = null;
    }
  };

  useEffect(() => {
    activeRef.current = true;
    void load();
    return () => {
      activeRef.current = false;
      loadSequenceRef.current += 1;
      loadAbortRef.current?.abort();
      loadAbortRef.current = null;
      mutationAbortRef.current?.abort();
      mutationAbortRef.current = null;
      operationInFlightRef.current = false;
    };
  }, []);

  const authorityCurrent =
    canMutate && rows !== null && !loading && err === null;
  const dialogActive =
    editorOpen ||
    discardEditorOpen ||
    deleteTarget !== null ||
    disableTarget !== null;

  const openCreate = (): void => {
    if (!authorityCurrent || operationInFlightRef.current || dialogActive)
      return;
    setEditTarget(null);
    setDraft(EMPTY_DRAFT);
    editorBaselineRef.current = EMPTY_DRAFT;
    setEditorConflict(false);
    errors.clear();
    setEditorOpen(true);
  };

  const openEdit = (row: SmsQuietHoursRow): void => {
    if (!authorityCurrent || operationInFlightRef.current || dialogActive)
      return;
    if (row.enabled && row.country_code) {
      toast.error({
        message: "Disable before repairing legacy scope",
        detail:
          "This enabled scoped row is fail-closed. Disabling requires its separate confirmation; after that, edit the disabled row to clear unsupported country metadata before enabling it again.",
      });
      return;
    }
    setEditTarget(row);
    const next = draftFromRow(row);
    setDraft(next);
    editorBaselineRef.current = next;
    setEditorConflict(false);
    errors.clear();
    setEditorOpen(true);
  };

  const closeEditor = (): void => {
    if (saving) return;
    if (JSON.stringify(draft) !== JSON.stringify(editorBaselineRef.current)) {
      setEditorOpen(false);
      setDiscardEditorOpen(true);
      return;
    }
    setEditorOpen(false);
  };

  const toggleDay = (day: number): void => {
    setDraft((d) => ({
      ...d,
      days: d.days.includes(day)
        ? d.days.filter((v) => v !== day)
        : [...d.days, day].sort((a, b) => a - b),
    }));
  };

  const submitEditor = async (): Promise<void> => {
    if (!authorityCurrent || operationInFlightRef.current || editorConflict)
      return;
    errors.clear();
    const startMinute = hhmmToMinute(draft.start);
    const endMinute = hhmmToMinute(draft.end);
    const timezone =
      draft.tzSelect === CUSTOM_TZ ? draft.tzCustom.trim() : draft.tzSelect;
    let bad = false;
    if (startMinute == null) {
      errors.set("start", "Use 24-hour HH:MM (e.g. 21:00).");
      bad = true;
    }
    if (endMinute == null) {
      errors.set("end", "Use 24-hour HH:MM (e.g. 09:00).");
      bad = true;
    }
    if (draft.days.length === 0) {
      errors.set("days", "Pick at least one weekday.");
      bad = true;
    }
    if (!timezone) {
      errors.set("timezone", "Pick a timezone (IANA name).");
      bad = true;
    }
    if (bad || startMinute == null || endMinute == null) return;

    const label = draft.label.trim();
    // Country is not evaluated by the gate and +1 cannot prove US vs CA.
    // Every new/edit mutation therefore writes the only supported tenant-wide
    // value. Editing a historical scoped row explicitly retires that metadata.
    const countryCode = "";
    if (!isSafeSmsOperatorText(label, 128, 512)) {
      errors.set(
        "_form",
        "Label must be at most 128 visible Unicode characters without control or bidi-format characters.",
      );
      return;
    }
    if (!isValidSmsTimezone(timezone)) {
      errors.set("timezone", "Enter a bounded, valid IANA timezone name.");
      return;
    }
    const input: SmsQuietHoursInput = {
      label,
      country_code: countryCode,
      start_minute: startMinute,
      end_minute: endMinute,
      days: draft.days,
      timezone,
      enabled: draft.enabled,
    };

    operationInFlightRef.current = true;
    setSaving(true);
    const controller = new AbortController();
    mutationAbortRef.current = controller;
    try {
      const res = editTarget
        ? await smsQuietHoursApi.update(
            editTarget.id,
            { ...input, expected_updated_at: editTarget.updated_at },
            {
              signal: controller.signal,
            },
          )
        : await smsQuietHoursApi.create(input, { signal: controller.signal });
      if (!activeRef.current) return;
      if (res.error?.code === "identity_changed") {
        errors.set(
          "_form",
          "Workspace identity changed while this policy save was in flight. Its server outcome is unknown; return to the original workspace and verify the row before retrying. Your draft is not proof that the save failed.",
        );
        return;
      }
      if (
        editTarget &&
        res.error?.status === 409 &&
        res.error.code === "policy_changed"
      ) {
        setEditorConflict(true);
        errors.set(
          "_form",
          "This policy changed after you opened it. Nothing was overwritten. Your draft is preserved for copying; close it and reopen the refreshed row before saving.",
        );
        await load();
        return;
      }
      if (res.error) {
        errors.set("_form", safeQuietHoursFailure("save", res.error.status));
        return;
      }
      const confirmed = parseSmsQuietHoursRows(
        { tenantId: expectedTenantId, items: [res.data] },
        expectedTenantId,
      )?.[0];
      if (
        !confirmed ||
        (editTarget !== null &&
          (confirmed.id !== editTarget.id ||
            confirmed.updated_at === editTarget.updated_at)) ||
        confirmed.label !== input.label ||
        confirmed.country_code !== input.country_code ||
        confirmed.start_minute !== input.start_minute ||
        confirmed.end_minute !== input.end_minute ||
        confirmed.timezone !== input.timezone ||
        confirmed.enabled !== input.enabled ||
        JSON.stringify(confirmed.days) !== JSON.stringify(input.days)
      ) {
        errors.set(
          "_form",
          "The service returned an unverified quiet-hours mutation receipt. Refresh the current policy list and exact row, if present, before retrying; do not assume nothing changed.",
        );
        return;
      }
      editorBaselineRef.current = { ...draft };
      setEditorOpen(false);
      toast.success(
        editTarget ? "Quiet-hours window updated" : "Quiet-hours window added",
      );
      await load();
    } catch {
      if (activeRef.current && !controller.signal.aborted) {
        errors.set(
          "_form",
          "The quiet-hours save outcome is unverified. Refresh the current policy list and exact row, if present, before retrying; do not assume nothing changed.",
        );
      }
    } finally {
      if (mutationAbortRef.current === controller) {
        mutationAbortRef.current = null;
      }
      operationInFlightRef.current = false;
      if (activeRef.current) setSaving(false);
    }
  };

  const toggleEnabled = async (row: SmsQuietHoursRow): Promise<boolean> => {
    if (!authorityCurrent || operationInFlightRef.current) return false;
    operationInFlightRef.current = true;
    setTogglingId(row.id);
    const controller = new AbortController();
    mutationAbortRef.current = controller;
    try {
      const res = await smsQuietHoursApi.update(
        row.id,
        {
          enabled: !row.enabled,
          ...(row.enabled && row.country_code ? { country_code: "" } : {}),
          expected_updated_at: row.updated_at,
        },
        { signal: controller.signal },
      );
      if (!activeRef.current) return false;
      if (res.error?.code === "identity_changed") {
        toast.error({
          message: "Window outcome unknown",
          detail:
            "Workspace identity changed while the update was in flight. Return to the original workspace and verify the current row before retrying.",
        });
        setDisableTarget(null);
        return false;
      }
      if (res.error?.status === 409 && res.error.code === "policy_changed") {
        toast.error({
          message: "Couldn't update window",
          detail:
            "This policy changed since it was loaded. Nothing was overwritten; the current rows were refreshed for review.",
        });
        setDisableTarget(null);
        await load();
        return false;
      }
      if (res.error) {
        toast.error({
          message: isKnownQuietHoursMutationRejection(res.error.status)
            ? "Couldn't update window"
            : "Window update outcome unverified",
          detail: safeQuietHoursFailure("toggle", res.error.status),
        });
        return false;
      }
      const updated = parseSmsQuietHoursRows(
        { tenantId: expectedTenantId, items: [res.data] },
        expectedTenantId,
      )?.[0];
      if (
        !updated ||
        updated.id !== row.id ||
        updated.updated_at === row.updated_at ||
        updated.enabled !== !row.enabled ||
        (row.enabled && row.country_code && updated.country_code !== "")
      ) {
        toast.error({
          message: "Window update outcome unverified",
          detail:
            "The service returned an unverified policy receipt. Refresh this exact row before retrying; do not assume nothing changed.",
        });
        return false;
      }
      setRows((prev) =>
        (prev ?? []).map((r) => (r.id === row.id && updated ? updated : r)),
      );
      return true;
    } catch {
      if (activeRef.current && !controller.signal.aborted) {
        toast.error({
          message: "Window update outcome unverified",
          detail:
            "Refresh this exact row before retrying; do not assume nothing changed.",
        });
      }
      return false;
    } finally {
      if (mutationAbortRef.current === controller) {
        mutationAbortRef.current = null;
      }
      operationInFlightRef.current = false;
      if (activeRef.current) setTogglingId(null);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (!authorityCurrent || !deleteTarget || operationInFlightRef.current)
      return;
    const target = deleteTarget;
    operationInFlightRef.current = true;
    setDeleting(true);
    const controller = new AbortController();
    mutationAbortRef.current = controller;
    try {
      const res = await smsQuietHoursApi.remove(
        target.id,
        { expected_updated_at: target.updated_at },
        {
          signal: controller.signal,
        },
      );
      if (!activeRef.current) return;
      if (res.error?.code === "identity_changed") {
        toast.error({
          message: "Window deletion outcome unknown",
          detail:
            "Workspace identity changed while deletion was in flight. Return to the original workspace and verify the current row before retrying.",
        });
        setDeleteTarget(null);
        return;
      }
      if (res.error?.status === 409 && res.error.code === "policy_changed") {
        toast.error({
          message: "Couldn't delete window",
          detail:
            "This policy changed since the confirmation opened. Nothing was deleted; the current rows were refreshed for review.",
        });
        setDeleteTarget(null);
        await load();
        return;
      }
      if (res.error) {
        toast.error({
          message: isKnownQuietHoursMutationRejection(res.error.status)
            ? "Couldn't delete window"
            : "Window deletion outcome unverified",
          detail: safeQuietHoursFailure("delete", res.error.status),
        });
        return;
      }
      if (!parseSmsPolicyDeleteReceipt(res.data, expectedTenantId, target.id)) {
        toast.error({
          message: "Window deletion outcome unverified",
          detail:
            "The service returned an unverified deletion receipt. Refresh this exact row before retrying; do not assume it remains or was deleted.",
        });
        return;
      }
      toast.success("Quiet-hours window deleted");
      setRows((prev) => (prev ?? []).filter((r) => r.id !== target.id));
      deleteReturnFocusRef.current = addButtonRef.current;
      setDeleteTarget(null);
    } catch {
      if (activeRef.current && !controller.signal.aborted) {
        toast.error({
          message: "Window deletion outcome unverified",
          detail:
            "Refresh this exact row before retrying; do not assume it remains or was deleted.",
        });
      }
    } finally {
      if (mutationAbortRef.current === controller) {
        mutationAbortRef.current = null;
      }
      operationInFlightRef.current = false;
      if (activeRef.current) setDeleting(false);
    }
  };

  const requestToggle = (
    row: SmsQuietHoursRow,
    trigger: HTMLInputElement,
  ): void => {
    if (!authorityCurrent || operationInFlightRef.current || dialogActive)
      return;
    if (!row.enabled && row.country_code) {
      toast.error({
        message: "Repair legacy scope before enabling",
        detail:
          "Edit this disabled row to clear unsupported country metadata before enabling the tenant-wide policy.",
      });
      return;
    }
    if (row.enabled) {
      disableReturnFocusRef.current = trigger;
      setDisableTarget(row);
      return;
    }
    void toggleEnabled(row);
  };

  const requestDelete = (
    row: SmsQuietHoursRow,
    trigger: HTMLButtonElement,
  ): void => {
    if (!authorityCurrent || operationInFlightRef.current || dialogActive)
      return;
    deleteReturnFocusRef.current = trigger;
    setDeleteTarget(row);
  };

  const operationActive = saving || togglingId !== null || deleting;
  const interactionLocked = operationActive || dialogActive;
  const mutationUnavailableReason = !canMutate
    ? "Admin role required."
    : !authorityCurrent
      ? "Changes unlock only after the current tenant policy list is verified."
      : interactionLocked
        ? "Another quiet-hours change is already in progress."
        : null;

  return (
    <div className="card">
      <div className="card-header">
        <div className="sms-policy-card-header">
          <div>
            <div className="card-title">SMS quiet hours</div>
            <div className="card-subtitle muted">
              Internal eligibility gating is active for valid enabled
              tenant-wide windows: a match defers an otherwise eligible request
              for re-evaluation after the window. Hosted scheduling and dispatch
              remain held, so this is not evidence of a scheduled, sent, or
              delivered message.
            </div>
          </div>
          <button
            ref={addButtonRef}
            type="button"
            className={`btn btn-sm btn-primary${mutationUnavailableReason ? " pw-discoverable-unavailable" : ""}`}
            onClick={() => {
              if (!mutationUnavailableReason) openCreate();
            }}
            aria-disabled={mutationUnavailableReason !== null}
            aria-describedby={addDescriptionId}
          >
            Add window
          </button>
          <span id={addDescriptionId} className="pw-action-status">
            {mutationUnavailableReason ?? "Add a recurring stored gate window."}
          </span>
        </div>
      </div>
      <div className="card-body">
        <QuietHoursList
          canMutate={authorityCurrent}
          error={err}
          loading={loading}
          operationActive={interactionLocked}
          rows={rows}
          rowDescriptionBaseId={rowDescriptionBaseId}
          togglingId={togglingId}
          onDelete={requestDelete}
          onEdit={openEdit}
          onRetry={() => void load()}
          onToggle={requestToggle}
        />
      </div>

      <QuietHoursEditorModal
        draft={draft}
        editTarget={editTarget}
        errors={errors}
        conflicted={editorConflict}
        open={editorOpen}
        saving={saving}
        onChange={setDraft}
        onClose={closeEditor}
        onSubmit={() => void submitEditor()}
        onToggleDay={toggleDay}
      />

      <ConfirmModal
        open={disableTarget != null}
        title="Disable quiet-hours gate policy?"
        description={
          disableTarget
            ? disableTarget.country_code
              ? `Disable the stored gate policy “${disableTarget.label || "Untitled window"}” and retire its unsupported ${disableTarget.country_code} metadata? This atomically replaces a fail-closed invalid policy with a disabled tenant-wide row, so an otherwise eligible internal request may no longer be held. Hosted scheduling and dispatch remain release-held.`
              : `Disable the stored gate policy “${disableTarget.label || "Untitled window"}”? The internal eligibility evaluator would no longer defer an otherwise eligible request for this window; hosted scheduling and dispatch remain release-held.`
            : ""
        }
        confirmLabel="Disable gate policy"
        danger
        busy={togglingId === disableTarget?.id}
        confirmDisabled={!authorityCurrent}
        returnFocusRef={disableReturnFocusRef}
        onClose={() => {
          if (togglingId === null) setDisableTarget(null);
        }}
        onConfirm={async () => {
          const target = disableTarget;
          if (target && (await toggleEnabled(target))) setDisableTarget(null);
        }}
      />
      <ConfirmModal
        open={deleteTarget != null}
        title="Delete quiet-hours window?"
        description={
          deleteTarget
            ? `Delete the stored policy “${deleteTarget.label || "Untitled window"}” (${quietWindowLabel(
                deleteTarget.start_minute,
                deleteTarget.end_minute,
              )} ${deleteTarget.timezone})? This changes a policy record only; it does not prove a live dispatch changed.`
            : ""
        }
        confirmLabel="Delete window"
        danger
        busy={deleting}
        confirmDisabled={!authorityCurrent}
        returnFocusRef={deleteReturnFocusRef}
        onClose={() => (deleting ? undefined : setDeleteTarget(null))}
        onConfirm={confirmDelete}
      />
      <ConfirmModal
        open={discardEditorOpen}
        title="Discard quiet-hours policy changes?"
        description="The stored label, window, days, timezone, country, or enabled state has not been saved."
        confirmLabel="Discard changes"
        danger
        onConfirm={() => {
          setDiscardEditorOpen(false);
        }}
        onClose={() => {
          setDiscardEditorOpen(false);
          setEditorOpen(true);
        }}
      />
    </div>
  );
}

function QuietHoursList({
  canMutate,
  error,
  loading,
  operationActive,
  rows,
  rowDescriptionBaseId,
  togglingId,
  onDelete,
  onEdit,
  onRetry,
  onToggle,
}: {
  canMutate: boolean;
  error: string | null;
  loading: boolean;
  operationActive: boolean;
  rows: SmsQuietHoursRow[] | null;
  rowDescriptionBaseId: string;
  togglingId: string | null;
  onDelete: (row: SmsQuietHoursRow, trigger: HTMLButtonElement) => void;
  onEdit: (row: SmsQuietHoursRow) => void;
  onRetry: () => void;
  onToggle: (row: SmsQuietHoursRow, trigger: HTMLInputElement) => void;
}): ReactElement {
  const retryDescriptionId = `${rowDescriptionBaseId}-retry`;
  if (error && rows === null) {
    return (
      <div className="notice" role="alert">
        <span>{error}</span>
        <button
          type="button"
          className="btn btn-sm"
          style={{ marginLeft: 8 }}
          onClick={onRetry}
        >
          Retry
        </button>
      </div>
    );
  }
  if (loading && rows === null) {
    return (
      <>
        <div className="skel-row" />
        <div className="skel-row" />
      </>
    );
  }
  if (!rows || rows.length === 0) {
    return (
      <div
        className="muted"
        style={{ padding: 20, textAlign: "center", fontSize: 13 }}
      >
        No stored quiet-hours windows are configured. This is not evidence that
        hosted SMS dispatch is available or that messages send at every hour.
      </div>
    );
  }
  const unavailableReason = !canMutate
    ? "Admin role required."
    : operationActive
      ? "Another quiet-hours change is already in progress."
      : null;
  return (
    <>
      {error ? (
        <div className="notice sms-policy-held-note" role="alert">
          <span>
            {error} The last verified policy rows are stale and cannot be
            changed.
          </span>
          <button
            type="button"
            className={`btn btn-sm${loading ? " pw-discoverable-unavailable" : ""}`}
            onClick={() => {
              if (!loading) onRetry();
            }}
            aria-disabled={loading || undefined}
            aria-describedby={retryDescriptionId}
          >
            Retry
          </button>
          <span id={retryDescriptionId} className="visually-hidden">
            {loading
              ? "Stored quiet-hours policy is already refreshing."
              : "Retry the stored quiet-hours policy read."}
          </span>
        </div>
      ) : null}
      <div
        className="list"
        role="table"
        aria-label="Stored SMS quiet-hours policy"
        aria-busy={loading || undefined}
      >
        <div
          className="list-header sms-quiet-hours-list-header"
          style={{ gridTemplateColumns: COLS }}
          role="row"
        >
          <div role="columnheader">Label</div>
          <div role="columnheader">Window (local)</div>
          <div role="columnheader">Days</div>
          <div role="columnheader">Timezone</div>
          <div role="columnheader">On</div>
          <div role="columnheader" className="visually-hidden">
            Actions
          </div>
        </div>
        {rows.map((row, index) => {
          const toggleDescriptionId = `${rowDescriptionBaseId}-${index}-toggle`;
          const actionDescriptionId = `${rowDescriptionBaseId}-${index}-actions`;
          return (
            <div
              key={row.id}
              className="list-row sms-quiet-hours-row"
              style={{ gridTemplateColumns: COLS }}
              role="row"
            >
              <div
                style={{
                  fontWeight: 500,
                  minWidth: 0,
                  overflowWrap: "anywhere",
                }}
                role="cell"
                data-label="Label"
              >
                <div>{row.label || "Untitled window"}</div>
                {row.country_code ? (
                  <span
                    className="badge warning"
                    style={{
                      display: "inline-flex",
                      marginTop: 4,
                      fontSize: 11,
                      whiteSpace: "normal",
                    }}
                  >
                    {row.enabled
                      ? `Legacy ${row.country_code} metadata · gate-invalid/fail-closed`
                      : `Unsupported legacy ${row.country_code} scope · repair before enabling`}
                  </span>
                ) : null}
              </div>
              <div
                className="tabular"
                style={{ fontSize: 12 }}
                role="cell"
                data-label="Window"
              >
                {quietWindowLabel(row.start_minute, row.end_minute)}
              </div>
              <div
                className="muted"
                style={{ fontSize: 12 }}
                role="cell"
                data-label="Days"
              >
                {formatQuietDays(row.days ?? [])}
              </div>
              <div
                className="muted tabular"
                style={{
                  fontSize: 12,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                role="cell"
                data-label="Timezone"
              >
                {row.timezone}
              </div>
              <div role="cell" data-label="Enabled">
                <input
                  type="checkbox"
                  checked={row.enabled}
                  aria-label={`${row.label || "Window"} enabled`}
                  className={
                    unavailableReason ? "pw-discoverable-unavailable" : undefined
                  }
                  aria-disabled={unavailableReason !== null}
                  aria-describedby={toggleDescriptionId}
                  aria-busy={togglingId === row.id || undefined}
                  onChange={(event) => {
                    if (!unavailableReason) onToggle(row, event.currentTarget);
                  }}
                />
                <span id={toggleDescriptionId} className="visually-hidden">
                  {unavailableReason ??
                    (row.enabled
                      ? "Enabled stored gate policy. Hosted dispatch remains release-held."
                      : "Disabled stored gate policy.")}
                </span>
              </div>
              <div
                style={{ textAlign: "right" }}
                role="cell"
                data-label="Actions"
              >
                <button
                  type="button"
                  className={`btn btn-sm btn-ghost${unavailableReason ? " pw-discoverable-unavailable" : ""}`}
                  onClick={() => {
                    if (!unavailableReason) onEdit(row);
                  }}
                  aria-disabled={unavailableReason !== null}
                  aria-describedby={actionDescriptionId}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className={`btn btn-sm btn-ghost${unavailableReason ? " pw-discoverable-unavailable" : ""}`}
                  onClick={(event) => {
                    if (!unavailableReason) onDelete(row, event.currentTarget);
                  }}
                  aria-disabled={unavailableReason !== null}
                  aria-describedby={actionDescriptionId}
                >
                  Delete
                </button>
                <span id={actionDescriptionId} className="visually-hidden">
                  {unavailableReason ??
                    "Edit this stored window, or delete the policy record after confirmation."}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {loading && rows !== null ? (
        <p className="muted small" role="status">
          Refreshing stored quiet-hours policy; changes are paused.
        </p>
      ) : null}
    </>
  );
}

function QuietHoursEditorModal({
  conflicted,
  draft,
  editTarget,
  errors,
  open,
  saving,
  onChange,
  onClose,
  onSubmit,
  onToggleDay,
}: {
  conflicted: boolean;
  draft: Draft;
  editTarget: SmsQuietHoursRow | null;
  errors: ReturnType<typeof useFormErrors>;
  open: boolean;
  saving: boolean;
  onChange: (draft: Draft) => void;
  onClose: () => void;
  onSubmit: () => void;
  onToggleDay: (day: number) => void;
}): ReactElement {
  const actionDescriptionId = useId();
  const actionsUnavailable = saving || conflicted;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editTarget ? "Edit quiet-hours window" : "Add quiet-hours window"}
      description="Stores a tenant gate window used by the active internal eligibility evaluator. A valid enabled match defers an otherwise eligible request for re-evaluation; hosted dispatch and scheduling remain release-held."
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!saving && !conflicted) onSubmit();
        }}
        onKeyDownCapture={(event) => {
          if (
            event.key === "Enter" &&
            (event.nativeEvent.isComposing || event.keyCode === 229)
          ) {
            event.preventDefault();
          }
        }}
      >
        <FormField
          label="Label"
          htmlFor="qh-label"
          help="Operator-facing name, e.g. “US overnight”."
        >
          <input
            id="qh-label"
            className="input"
            placeholder="US overnight"
            value={draft.label}
            onChange={(event) =>
              onChange({ ...draft, label: event.target.value })
            }
          />
        </FormField>
        <div className="sms-quiet-time-grid">
          <FormField
            label="Start (24-hour)"
            required
            htmlFor="qh-start"
            error={errors.get("start")}
          >
            <input
              id="qh-start"
              type="time"
              className="input tabular"
              value={draft.start}
              onChange={(event) => {
                onChange({ ...draft, start: event.target.value });
                errors.clear("start");
              }}
            />
          </FormField>
          <FormField
            label="End (24-hour)"
            required
            htmlFor="qh-end"
            error={errors.get("end")}
          >
            <input
              id="qh-end"
              type="time"
              className="input tabular"
              value={draft.end}
              onChange={(event) => {
                onChange({ ...draft, end: event.target.value });
                errors.clear("end");
              }}
            />
          </FormField>
        </div>
        <div className="muted" style={{ fontSize: 12, margin: "2px 0 10px" }}>
          End earlier than start is a valid overnight window — 21:00 → 09:00
          crosses midnight into the next day. Start equal to end holds the whole
          day.
        </div>
        <FormField
          label="Days the window starts on"
          required
          error={errors.get("days")}
          helpTooltip="An overnight window started on a checked day stays active past midnight into the next day, even if that next day isn't checked."
        >
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {QUIET_DAY_OPTIONS.map((day) => (
              <label
                key={day.value}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 13,
                }}
              >
                <input
                  type="checkbox"
                  checked={draft.days.includes(day.value)}
                  onChange={() => {
                    onToggleDay(day.value);
                    errors.clear("days");
                  }}
                />
                <span aria-hidden="true">{day.short}</span>
                <span className="visually-hidden">{day.long}</span>
              </label>
            ))}
          </div>
        </FormField>
        <FormField
          label="Timezone"
          required
          htmlFor="qh-tz"
          error={errors.get("timezone")}
          helpTooltip="IANA timezone used by the stored-policy evaluator. Verify local daylight-saving transition behavior before relying on a boundary; hosted dispatch and scheduling remain release-held."
        >
          <select
            id="qh-tz"
            className="input"
            value={draft.tzSelect}
            onChange={(event) => {
              onChange({ ...draft, tzSelect: event.target.value });
              errors.clear("timezone");
            }}
          >
            {SENDING_TIMEZONES.map((timezone) => (
              <option key={timezone.value} value={timezone.value}>
                {timezone.label} · {timezone.value}
              </option>
            ))}
            <option value={CUSTOM_TZ}>Other (type an IANA name)…</option>
          </select>
        </FormField>
        {draft.tzSelect === CUSTOM_TZ ? (
          <FormField
            label="Custom IANA timezone"
            required
            htmlFor="qh-tz-custom"
            help="Exact IANA name, e.g. America/Halifax. Unknown zones are rejected by the server."
          >
            <input
              id="qh-tz-custom"
              className="input"
              placeholder="America/Halifax"
              value={draft.tzCustom}
              onChange={(event) => {
                onChange({ ...draft, tzCustom: event.target.value });
                errors.clear("timezone");
              }}
            />
          </FormField>
        ) : null}
        {editTarget?.country_code ? (
          <Notice tone="warning" announcement="polite">
            Legacy {editTarget.country_code} country metadata is not evaluated
            and is inert while this row is disabled. Saving clears that
            unsupported value before the tenant-wide rule can be enabled. Hosted
            dispatch and scheduling remain release-held.
          </Notice>
        ) : (
          <Notice tone="neutral" announcement="polite">
            Stored rule scope is tenant-wide. This editor does not offer a
            country selector because a +1 number cannot reliably prove US or CA
            jurisdiction.
          </Notice>
        )}
        {editTarget ? (
          <Notice tone="neutral" announcement="polite">
            Status is unchanged in this editor. Use the row status control so an
            enabled gate policy cannot be disabled without its separate
            confirmation.
          </Notice>
        ) : (
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 6,
              fontSize: 13,
            }}
          >
            <input
              type="checkbox"
              aria-label="Create quiet-hours policy enabled"
              checked={draft.enabled}
              onChange={(event) =>
                onChange({ ...draft, enabled: event.target.checked })
              }
            />
            <span>
              Create enabled stored gate policy (hosted dispatch remains
              release-held)
            </span>
          </label>
        )}
        {errors.get("_form") ? (
          <FieldError>{errors.get("_form")}</FieldError>
        ) : null}
        <ModalFooter>
          <button
            type="button"
            className={`btn${saving ? " pw-discoverable-unavailable" : ""}`}
            onClick={() => {
              if (!saving) onClose();
            }}
            aria-disabled={saving || undefined}
            aria-describedby={actionDescriptionId}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={`btn btn-primary${actionsUnavailable ? " pw-discoverable-unavailable" : ""}`}
            aria-disabled={actionsUnavailable || undefined}
            aria-describedby={actionDescriptionId}
          >
            {saving
              ? "Saving…"
              : conflicted
                ? "Reopen refreshed row"
                : editTarget
                  ? "Save changes"
                  : "Add window"}
          </button>
          <span id={actionDescriptionId} className="visually-hidden">
            {saving
              ? "The quiet-hours policy request is in progress."
              : conflicted
                ? "The row changed remotely. Close and reopen the refreshed row before saving."
                : "Cancel returns to the list; save submits the validated policy."}
          </span>
        </ModalFooter>
      </form>
    </Modal>
  );
}

export function SmsQuietHoursCard(): ReactElement {
  const me = useMe();
  if (!me) {
    return (
      <div className="card">
        <div className="card-header">
          <div className="card-title">SMS quiet hours</div>
        </div>
        <div className="card-body">
          <div className="notice" role="status">
            Resolve a canonical workspace identity before loading private
            quiet-hours policy.
          </div>
        </div>
      </div>
    );
  }
  const identityScope = `${me.user}\u0000${me.tenant}\u0000${me.effectiveRole}`;
  return (
    <SmsQuietHoursCardIdentity
      key={identityScope}
      expectedTenantId={me.tenant}
    />
  );
}
