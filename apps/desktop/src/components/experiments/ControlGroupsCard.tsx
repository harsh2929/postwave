/**
 * ControlGroupsCard (#13, full-surface wiring 2026-06-11)
 *
 * Tenant-wide experiment control groups — a seeded percent of the
 * audience that is held back from sends so incremental lift can be
 * measured. Collapsible section on the Campaigns page:
 *
 *   - list groups (lazy: first expand fetches);
 *   - create (name / description / percent 0..50) — percent + name are
 *     immutable after create (re-bucketing would shuffle membership),
 *     so the edit modal only offers description + status;
 *   - edit (description / status active|paused|dissolved);
 *   - delete behind ConfirmModal;
 *   - per-group report drill-down (GET /control-groups/{id}/report)
 *     rendering control vs treated engagement + incremental lift, with
 *     an honest "cohorts are empty" state instead of fake zeros.
 *
 * Mutations follow the Campaigns page's permission pattern: gated on
 * useCanWrite() (backend scope is write_campaigns) with persistent viewer
 * guidance; the server stays the final authority.
 */

import { type ReactElement, useEffect, useId, useRef, useState } from "react";

import { ConfirmModal } from "../ConfirmModal";
import { FormField, useFormErrors } from "../FormField";
import { InlineHelp } from "../InlineHelp";
import { Modal, ModalFooter } from "../Modal";
import { Notice } from "../Notice";
import { toast } from "../Toast";
import {
  type ControlGroup,
  type ControlGroupReport,
  controlGroupsApi,
} from "../../lib/api-client";
import { useCanWrite } from "../../lib/store";
import { fmtDayMonth } from "../../lib/format-date";
import { DataTable, type DataTableColumn } from "../table/DataTable";
import {
  CONTROL_GROUP_STATUSES,
  DEFAULT_REPORT_WINDOW,
  REPORT_WINDOW_OPTIONS,
  fmtEngagementRate,
  liftSummary,
  reportHasCohorts,
  statusBadgeClass,
  validateControlGroupDraft,
  type ControlGroupDraft,
} from "./control-groups-helpers";

const EMPTY_DRAFT: ControlGroupDraft = {
  name: "",
  description: "",
  percent: "5",
};

// The current dispatch path does not exclude configured control cohorts.
// Preserve historical configuration/report visibility, but block mutations
// until send-time enforcement and exposure-ledger evidence exist.
const CONTROL_GROUP_DISPATCH_ENFORCED = false;

interface ReportState {
  loading: boolean;
  err: string | null;
  data: ControlGroupReport | null;
}

function useControlGroupRemoteData() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ControlGroup[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reportFor, setReportFor] = useState<string | null>(null);
  const [reportWindow, setReportWindow] = useState<number>(
    DEFAULT_REPORT_WINDOW,
  );
  const [report, setReport] = useState<ReportState>({
    loading: false,
    err: null,
    data: null,
  });
  const reportSeq = useRef(0);
  const listSeq = useRef(0);
  const listFlightRef = useRef<Promise<void> | null>(null);
  const reportFlightRef = useRef<{
    key: string;
    promise: Promise<void>;
  } | null>(null);
  const activeRef = useRef(true);

  const load = async (): Promise<void> => {
    if (listFlightRef.current) return listFlightRef.current;
    const seq = ++listSeq.current;
    setLoading(true);
    setErr(null);
    const request = (async (): Promise<void> => {
      await Promise.resolve();
      try {
        const res = await controlGroupsApi.list();
        if (!activeRef.current || seq !== listSeq.current) return;
        if (res.error) setErr(res.error.message);
        else setItems(res.data.items ?? []);
      } catch {
        if (activeRef.current && seq === listSeq.current) {
          setErr("Moosewave couldn't load control groups.");
        }
      } finally {
        if (activeRef.current && seq === listSeq.current) setLoading(false);
        if (seq === listSeq.current) listFlightRef.current = null;
      }
    })();
    listFlightRef.current = request;
    return request;
  };

  const loadReport = async (
    groupId: string,
    windowDays: number,
  ): Promise<void> => {
    const requestKey = `${groupId}:${windowDays}`;
    if (reportFlightRef.current?.key === requestKey) {
      return reportFlightRef.current.promise;
    }
    const seq = ++reportSeq.current;
    setReport({ loading: true, err: null, data: null });
    const request = (async (): Promise<void> => {
      await Promise.resolve();
      try {
        const res = await controlGroupsApi.report(groupId, windowDays);
        if (!activeRef.current || seq !== reportSeq.current) return;
        if (res.error) {
          setReport({ loading: false, err: res.error.message, data: null });
        } else setReport({ loading: false, err: null, data: res.data });
      } catch {
        if (activeRef.current && seq === reportSeq.current) {
          setReport({
            loading: false,
            err: "Moosewave couldn't load this lift report.",
            data: null,
          });
        }
      } finally {
        if (seq === reportSeq.current) reportFlightRef.current = null;
      }
    })();
    reportFlightRef.current = { key: requestKey, promise: request };
    return request;
  };

  const closeReportFor = (groupId: string): void => {
    if (reportFor !== groupId) return;
    reportSeq.current += 1;
    reportFlightRef.current = null;
    setReportFor(null);
    setReport({ loading: false, err: null, data: null });
  };

  const toggleOpen = (): void => {
    const next = !open;
    setOpen(next);
    if (next && items == null && !loading) void load();
  };

  const toggleReport = (group: ControlGroup): void => {
    if (reportFor === group.id) {
      closeReportFor(group.id);
      return;
    }
    setReportFor(group.id);
    setReportWindow(DEFAULT_REPORT_WINDOW);
    void loadReport(group.id, DEFAULT_REPORT_WINDOW);
  };

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      listSeq.current += 1;
      reportSeq.current += 1;
      listFlightRef.current = null;
      reportFlightRef.current = null;
    };
  }, []);

  return {
    activeRef,
    closeReportFor,
    err,
    items,
    load,
    loading,
    loadReport,
    open,
    report,
    reportFor,
    reportWindow,
    setItems,
    setReportWindow,
    toggleOpen,
    toggleReport,
  };
}

function useControlGroupsController() {
  const canMutate = useCanWrite() && CONTROL_GROUP_DISPATCH_ENFORCED;
  const {
    activeRef,
    closeReportFor,
    err,
    items,
    load,
    loading,
    loadReport,
    open,
    report,
    reportFor,
    reportWindow,
    setItems,
    setReportWindow,
    toggleOpen,
    toggleReport,
  } = useControlGroupRemoteData();

  // Create modal
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<ControlGroupDraft>(EMPTY_DRAFT);
  const errors = useFormErrors();
  const [saving, setSaving] = useState(false);

  // Edit modal (description + status only — see header comment)
  const [editTarget, setEditTarget] = useState<ControlGroup | null>(null);
  const [editDescription, setEditDescription] = useState("");
  const [editStatus, setEditStatus] = useState<string>("active");
  const [editErr, setEditErr] = useState<string | null>(null);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<ControlGroup | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const [discardEditor, setDiscardEditor] = useState<"create" | "edit" | null>(
    null,
  );

  const mutationFlightRef = useRef<Promise<void> | null>(null);
  const permissionReasonId = useId();
  const editStatusId = useId();

  useEffect(() => {
    return () => {
      mutationFlightRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!canMutate && !deleting && !mutationFlightRef.current) {
      setDeleteTarget(null);
      setDeleteErr(null);
    }
  }, [canMutate, deleting]);

  const openCreate = (): void => {
    if (!canMutate || mutationFlightRef.current) return;
    setDraft(EMPTY_DRAFT);
    errors.clear();
    setCreateOpen(true);
  };

  const submitCreate = async (): Promise<void> => {
    if (!canMutate || mutationFlightRef.current) return;
    errors.clear();
    const v = validateControlGroupDraft(draft);
    if (!v.ok) {
      if (v.errors.name) errors.set("name", v.errors.name);
      if (v.errors.percent) errors.set("percent", v.errors.percent);
      window.setTimeout(() => {
        document
          .getElementById(v.errors.name ? "cg-name" : "cg-percent")
          ?.focus({ preventScroll: true });
      }, 0);
      return;
    }
    const input = {
      name: draft.name.trim(),
      description: draft.description.trim() || undefined,
      percent: v.percent!,
    };
    setSaving(true);
    const request = (async (): Promise<void> => {
      await Promise.resolve();
      try {
        const res = await controlGroupsApi.create(input);
        if (!activeRef.current) return;
        if (res.error) {
          errors.set("_form", res.error.message);
          return;
        }
        if (!res.data?.id) {
          errors.set(
            "_form",
            "The server did not return the created control group. Refresh the list before retrying.",
          );
          return;
        }
        setCreateOpen(false);
        toast.success(`Control group "${res.data.name}" created`);
        setItems((current) =>
          current && !current.some((group) => group.id === res.data.id)
            ? [...current, res.data]
            : current,
        );
        void load();
      } catch (error) {
        if (activeRef.current) {
          errors.set(
            "_form",
            error instanceof Error && error.message
              ? error.message
              : "The control group could not be created. Check your connection and retry.",
          );
        }
      } finally {
        if (activeRef.current) setSaving(false);
        mutationFlightRef.current = null;
      }
    })();
    mutationFlightRef.current = request;
    return request;
  };

  const openEdit = (group: ControlGroup): void => {
    if (!canMutate || mutationFlightRef.current) return;
    setEditTarget(group);
    setEditDescription(group.description ?? "");
    setEditStatus(group.status);
    setEditErr(null);
  };

  const submitEdit = async (): Promise<void> => {
    if (!canMutate || !editTarget || mutationFlightRef.current) return;
    const target = editTarget;
    const input = {
      description: editDescription.trim(),
      status: editStatus,
    };
    setSaving(true);
    setEditErr(null);
    const request = (async (): Promise<void> => {
      await Promise.resolve();
      try {
        const res = await controlGroupsApi.update(target.id, input);
        if (!activeRef.current) return;
        if (res.error) {
          setEditErr(res.error.message);
          return;
        }
        if (!res.data?.id) {
          setEditErr(
            "The server did not return the updated control group. Refresh the list before retrying.",
          );
          return;
        }
        setEditTarget(null);
        toast.success(`Control group "${target.name}" updated`);
        setItems(
          (current) =>
            current?.map((group) =>
              group.id === target.id ? res.data : group,
            ) ?? current,
        );
        void load();
      } catch (error) {
        if (activeRef.current) {
          setEditErr(
            error instanceof Error && error.message
              ? error.message
              : "The control group could not be updated. Check your connection and retry.",
          );
        }
      } finally {
        if (activeRef.current) setSaving(false);
        mutationFlightRef.current = null;
      }
    })();
    mutationFlightRef.current = request;
    return request;
  };

  const submitDelete = async (): Promise<void> => {
    if (!canMutate || !deleteTarget || mutationFlightRef.current) return;
    const target = deleteTarget;
    setDeleting(true);
    setDeleteErr(null);
    const request = (async (): Promise<void> => {
      await Promise.resolve();
      try {
        const res = await controlGroupsApi.remove(target.id);
        if (!activeRef.current) return;
        if (res.error) {
          setDeleteErr(res.error.message);
          return;
        }
        closeReportFor(target.id);
        setDeleteTarget(null);
        toast.success(`Control group "${target.name}" deleted`);
        setItems(
          (current) =>
            current?.filter((group) => group.id !== target.id) ?? current,
        );
        void load();
      } catch (error) {
        if (activeRef.current) {
          setDeleteErr(
            error instanceof Error && error.message
              ? error.message
              : "The control group could not be deleted. Check your connection and retry.",
          );
        }
      } finally {
        if (activeRef.current) setDeleting(false);
        mutationFlightRef.current = null;
      }
    })();
    mutationFlightRef.current = request;
    return request;
  };

  const createDirty =
    draft.name !== EMPTY_DRAFT.name ||
    draft.description !== EMPTY_DRAFT.description ||
    draft.percent !== EMPTY_DRAFT.percent;
  const editDirty = Boolean(
    editTarget &&
    (editDescription !== (editTarget.description ?? "") ||
      editStatus !== editTarget.status),
  );

  return {
    canMutate,
    createDirty,
    createOpen,
    deleteErr,
    deleteTarget,
    deleting,
    discardEditor,
    draft,
    editDescription,
    editDirty,
    editErr,
    editStatus,
    editStatusId,
    editTarget,
    err,
    errors,
    items,
    load,
    loading,
    loadReport,
    mutationFlightRef,
    open,
    openCreate,
    openEdit,
    permissionReasonId,
    report,
    reportFor,
    reportWindow,
    saving,
    setCreateOpen,
    setDeleteErr,
    setDeleteTarget,
    setDiscardEditor,
    setDraft,
    setEditDescription,
    setEditErr,
    setEditStatus,
    setEditTarget,
    setReportWindow,
    submitCreate,
    submitDelete,
    submitEdit,
    toggleOpen,
    toggleReport,
  };
}

type ControlGroupsController = ReturnType<typeof useControlGroupsController>;

function ControlGroupCreateModal({
  controller,
}: {
  controller: ControlGroupsController;
}): ReactElement {
  const {
    canMutate,
    createDirty,
    createOpen,
    draft,
    errors,
    mutationFlightRef,
    saving,
    setCreateOpen,
    setDiscardEditor,
    setDraft,
    submitCreate,
  } = controller;
  const requestClose = (): void => {
    if (mutationFlightRef.current) return;
    if (createDirty) setDiscardEditor("create");
    else setCreateOpen(false);
  };
  return (
    <Modal
      open={createOpen}
      onClose={requestClose}
      title="New control group"
      description="Holds back a deterministic slice of your audience from sends so lift can be measured. Name and percent are fixed after creation."
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!mutationFlightRef.current) void submitCreate();
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
        {!canMutate ? (
          <Notice tone="neutral" announcement="polite">
            Your role changed to read-only. Copy any unsaved values before
            closing; an editor must create this control group.
          </Notice>
        ) : null}
        <FormField
          label="Name"
          required
          htmlFor="cg-name"
          error={errors.get("name")}
        >
          <input
            id="cg-name"
            type="text"
            className="input"
            placeholder="Global 5% holdback"
            value={draft.name}
            disabled={!canMutate || saving}
            onChange={(event) => {
              errors.clear("name");
              errors.clear("_form");
              setDraft({ ...draft, name: event.target.value });
            }}
          />
        </FormField>
        <FormField
          label="Holdback percent (0–50)"
          required
          htmlFor="cg-percent"
          error={errors.get("percent")}
        >
          <input
            id="cg-percent"
            type="number"
            className="input"
            min={0}
            max={50}
            step="0.5"
            value={draft.percent}
            disabled={!canMutate || saving}
            onChange={(event) => {
              errors.clear("percent");
              errors.clear("_form");
              setDraft({ ...draft, percent: event.target.value });
            }}
          />
        </FormField>
        <FormField label="Description" htmlFor="cg-description">
          <input
            id="cg-description"
            type="text"
            className="input"
            placeholder="What is this group for?"
            value={draft.description}
            disabled={!canMutate || saving}
            onChange={(event) => {
              errors.clear("_form");
              setDraft({ ...draft, description: event.target.value });
            }}
          />
        </FormField>
        {errors.get("_form") ? (
          <div className="field-error" role="alert">
            {errors.get("_form")}
          </div>
        ) : null}
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={requestClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving}
            aria-disabled={!canMutate || saving}
          >
            {saving ? "Creating…" : "Create"}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function ControlGroupEditModal({
  controller,
}: {
  controller: ControlGroupsController;
}): ReactElement {
  const {
    canMutate,
    editDescription,
    editDirty,
    editErr,
    editStatus,
    editStatusId,
    editTarget,
    mutationFlightRef,
    saving,
    setDiscardEditor,
    setEditDescription,
    setEditErr,
    setEditStatus,
    setEditTarget,
    submitEdit,
  } = controller;
  const requestClose = (): void => {
    if (mutationFlightRef.current) return;
    if (editDirty) setDiscardEditor("edit");
    else setEditTarget(null);
  };
  return (
    <Modal
      open={editTarget != null}
      onClose={requestClose}
      title={`Edit "${editTarget?.name ?? ""}"`}
      description="Name and holdback percent are fixed after creation — changing them would re-shuffle who's in the control bucket."
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (editDirty && !mutationFlightRef.current) void submitEdit();
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
        {!canMutate ? (
          <Notice tone="neutral" announcement="polite">
            Your role changed to read-only. Copy any unsaved values before
            closing; an editor must save this control group.
          </Notice>
        ) : null}
        <FormField label="Description" htmlFor="cg-edit-description">
          <input
            id="cg-edit-description"
            type="text"
            className="input"
            value={editDescription}
            disabled={!canMutate || saving}
            onChange={(event) => {
              setEditErr(null);
              setEditDescription(event.target.value);
            }}
          />
        </FormField>
        <FormField label="Status" htmlFor="cg-edit-status">
          <select
            id="cg-edit-status"
            className="input"
            value={editStatus}
            disabled={!canMutate || saving}
            onChange={(event) => {
              setEditErr(null);
              setEditStatus(event.target.value);
            }}
          >
            {CONTROL_GROUP_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </FormField>
        <p className="muted" style={{ fontSize: 12, marginTop: -4 }}>
          Active groups hold back their cohort. Paused groups keep membership
          but stop enforcement. Dissolved groups end the experiment and should
          only be used when measurement is complete.
        </p>
        {!editDirty ? (
          <p id={editStatusId} className="muted" style={{ fontSize: 12 }}>
            No unsaved control-group changes.
          </p>
        ) : null}
        {editErr ? (
          <div className="field-error" role="alert">
            {editErr}
          </div>
        ) : null}
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={requestClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving}
            aria-disabled={!canMutate || saving || !editDirty}
            aria-describedby={!editDirty ? editStatusId : undefined}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function ControlGroupConfirmations({
  controller,
}: {
  controller: ControlGroupsController;
}): ReactElement {
  const {
    deleteErr,
    deleteTarget,
    deleting,
    discardEditor,
    mutationFlightRef,
    setCreateOpen,
    setDeleteErr,
    setDeleteTarget,
    setDiscardEditor,
    setEditTarget,
    submitDelete,
  } = controller;
  return (
    <>
      <ConfirmModal
        open={deleteTarget != null}
        title={`Delete "${deleteTarget?.name ?? ""}"?`}
        description="The group and its seed are removed permanently. Held-back subscribers become eligible for sends again immediately."
        confirmLabel="Delete"
        danger
        typeToConfirm={deleteTarget?.name}
        busy={deleting}
        onConfirm={submitDelete}
        onClose={() => {
          if (!mutationFlightRef.current) {
            setDeleteTarget(null);
            setDeleteErr(null);
          }
        }}
      >
        {deleteErr ? (
          <div className="field-error" role="alert">
            Couldn&apos;t delete this control group: {deleteErr}
          </div>
        ) : null}
      </ConfirmModal>
      <ConfirmModal
        open={discardEditor != null}
        title="Discard control-group changes?"
        description={
          discardEditor === "create"
            ? "The new control-group name, holdback, or description has not been created."
            : "The control-group description or status change has not been saved."
        }
        confirmLabel="Discard changes"
        danger
        onConfirm={() => {
          if (discardEditor === "create") setCreateOpen(false);
          else setEditTarget(null);
          setDiscardEditor(null);
        }}
        onClose={() => setDiscardEditor(null)}
      />
    </>
  );
}

function ControlGroupsSurface({
  controller,
}: {
  controller: ControlGroupsController;
}): ReactElement {
  const {
    canMutate,
    err,
    items,
    load,
    loading,
    loadReport,
    mutationFlightRef,
    open,
    openCreate,
    openEdit,
    permissionReasonId,
    report,
    reportFor,
    reportWindow,
    setDeleteErr,
    setDeleteTarget,
    setReportWindow,
    toggleOpen,
    toggleReport,
  } = controller;
  return (
    <section className="card" style={{ marginTop: 16, padding: 16 }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
        }}
      >
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={toggleOpen}
          aria-expanded={open}
          aria-controls="control-groups-body"
          style={{ fontWeight: 600, fontSize: 13 }}
        >
          {open ? "▾" : "▸"} Control groups
        </button>
        <InlineHelp text="Recorded deterministic cohorts for incremental-lift analysis. Cohort exclusion is not enforced by campaign dispatch yet." />
        {items != null ? (
          <span className="muted tabular" style={{ fontSize: 12 }}>
            {items.length} {items.length === 1 ? "group" : "groups"}
          </span>
        ) : null}
        <span className="spacer" />
        {open ? (
          <>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void load()}
              disabled={loading}
            >
              Refresh
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={openCreate}
              disabled={!canMutate}
              aria-disabled={!canMutate || undefined}
              aria-describedby={!canMutate ? permissionReasonId : undefined}
            >
              New control group
            </button>
          </>
        ) : null}
      </div>

      {open ? (
        <div id="control-groups-body" style={{ marginTop: 12 }}>
          {!CONTROL_GROUP_DISPATCH_ENFORCED ? (
            <div id={permissionReasonId}>
              <Notice
                tone="warning"
                announcement="polite"
                style={{ marginBottom: 8 }}
                title="Control groups are reporting-only"
              >
                Dispatch does not currently exclude these cohorts, so creating,
                editing, and deleting control groups is disabled. Existing
                configurations and explicitly unenforced reports remain
                available for review.
              </Notice>
            </div>
          ) : !canMutate ? (
            <div id={permissionReasonId}>
              <Notice
                tone="neutral"
                announcement="polite"
                style={{ marginBottom: 8 }}
              >
                Viewer access is read-only. Reports remain available; an editor
                can create, edit, or delete control groups.
              </Notice>
            </div>
          ) : null}
          {err ? (
            <Notice
              tone="danger"
              announcement="assertive"
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
              Couldn&apos;t load control groups: {err}
            </Notice>
          ) : null}
          <ControlGroupsTable
            items={items}
            loading={loading}
            error={err}
            canMutate={canMutate}
            permissionReasonId={permissionReasonId}
            reportFor={reportFor}
            reportWindow={reportWindow}
            report={report}
            onToggleReport={toggleReport}
            onEdit={openEdit}
            onDelete={(group) => {
              if (!canMutate || mutationFlightRef.current) return;
              setDeleteErr(null);
              setDeleteTarget(group);
            }}
            onReportWindowChange={(groupId, windowDays) => {
              setReportWindow(windowDays);
              void loadReport(groupId, windowDays);
            }}
            onRetryReport={(groupId) => void loadReport(groupId, reportWindow)}
          />
        </div>
      ) : null}

      <ControlGroupCreateModal controller={controller} />
      <ControlGroupEditModal controller={controller} />
      <ControlGroupConfirmations controller={controller} />
    </section>
  );
}

export function ControlGroupsCard(): ReactElement {
  const controller = useControlGroupsController();
  return <ControlGroupsSurface controller={controller} />;
}

function ControlGroupsTable({
  items,
  loading,
  error,
  canMutate,
  permissionReasonId,
  reportFor,
  reportWindow,
  report,
  onToggleReport,
  onEdit,
  onDelete,
  onReportWindowChange,
  onRetryReport,
}: {
  items: ControlGroup[] | null;
  loading: boolean;
  error: string | null;
  canMutate: boolean;
  permissionReasonId: string;
  reportFor: string | null;
  reportWindow: number;
  report: ReportState;
  onToggleReport: (group: ControlGroup) => void;
  onEdit: (group: ControlGroup) => void;
  onDelete: (group: ControlGroup) => void;
  onReportWindowChange: (groupId: string, windowDays: number) => void;
  onRetryReport: (groupId: string) => void;
}): ReactElement {
  const columns: readonly DataTableColumn<ControlGroup>[] = [
    {
      id: "name",
      header: "Name",
      width: "260px",
      cell: (group) => (
        <span style={{ display: "grid", gap: 2, overflowWrap: "anywhere" }}>
          <strong>{group.name}</strong>
          {group.description ? (
            <span className="muted" style={{ fontSize: 12 }}>
              {group.description}
            </span>
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>
              No description
            </span>
          )}
        </span>
      ),
    },
    {
      id: "holdback",
      header: "Holdback",
      width: "110px",
      align: "end",
      className: "tabular",
      cell: (group) => `${group.percent}%`,
    },
    {
      id: "status",
      header: "Status",
      width: "110px",
      cell: (group) => (
        <span className={statusBadgeClass(group.status)}>{group.status}</span>
      ),
    },
    {
      id: "started",
      header: "Started",
      width: "120px",
      cell: (group) => (
        <span className="muted tabular">{fmtDayMonth(group.starts_at)}</span>
      ),
    },
    {
      id: "actions",
      header: <span className="visually-hidden">Actions</span>,
      width: "260px",
      align: "end",
      cell: (group) => {
        const expanded = reportFor === group.id;
        return (
          <span
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "flex-end",
              gap: 4,
            }}
          >
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => onToggleReport(group)}
              aria-expanded={expanded}
              aria-controls={`control-group-report-${group.id}`}
              aria-label={`${expanded ? "Hide" : "Show"} lift report for ${group.name}`}
            >
              {expanded ? "Hide report" : "Report"}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => onEdit(group)}
              disabled={!canMutate}
              aria-disabled={!canMutate || undefined}
              aria-describedby={!canMutate ? permissionReasonId : undefined}
              aria-label={`Edit ${group.name}`}
            >
              Edit
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => onDelete(group)}
              disabled={!canMutate}
              aria-disabled={!canMutate || undefined}
              aria-describedby={!canMutate ? permissionReasonId : undefined}
              aria-label={`Delete ${group.name}`}
            >
              Delete
            </button>
          </span>
        );
      },
    },
  ];
  return (
    <DataTable
      caption="Configured control groups"
      description={
        loading && items
          ? "Refreshing · showing the last verified control groups"
          : CONTROL_GROUP_DISPATCH_ENFORCED
            ? "Deterministic audience holdbacks used to measure incremental lift"
            : "Recorded cohorts only · not excluded by campaign dispatch"
      }
      columns={columns}
      rows={items ?? []}
      getRowKey={(group) => group.id}
      loading={loading && items === null}
      loadingLabel="Loading control groups…"
      emptyState={
        error
          ? "Control groups are unavailable. Retry the request to load them."
          : CONTROL_GROUP_DISPATCH_ENFORCED
            ? "No control groups yet. Create one to hold back a slice of your audience and measure incremental lift."
            : "No recorded control-group configurations."
      }
      density="compact"
      expansion={{
        isExpanded: (group) => reportFor === group.id,
        regionId: (group) => `control-group-report-${group.id}`,
        label: (group) => `Lift report for ${group.name}`,
        render: (group) => (
          <ControlGroupReportPanel
            group={group}
            reportWindow={reportWindow}
            report={report}
            onWindowChange={(windowDays) =>
              onReportWindowChange(group.id, windowDays)
            }
            onRetry={() => onRetryReport(group.id)}
          />
        ),
      }}
    />
  );
}

function ControlGroupReportPanel({
  group,
  reportWindow,
  report,
  onWindowChange,
  onRetry,
}: {
  group: ControlGroup;
  reportWindow: number;
  report: ReportState;
  onWindowChange: (windowDays: number) => void;
  onRetry: () => void;
}): ReactElement {
  return (
    <div style={{ padding: "10px 4px" }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <strong style={{ fontSize: 13 }}>Lift report — {group.name}</strong>
        <select
          className="input"
          style={{ maxWidth: 130 }}
          value={reportWindow}
          aria-label={`Report window for ${group.name}`}
          onChange={(event) => onWindowChange(Number(event.target.value))}
        >
          {REPORT_WINDOW_OPTIONS.map((windowDays) => (
            <option key={windowDays} value={windowDays}>
              Last {windowDays} days
            </option>
          ))}
        </select>
      </div>
      {report.loading ? (
        <div
          className="skel"
          style={{ height: 32 }}
          role="status"
          aria-label={`Loading lift report for ${group.name}`}
        />
      ) : report.err ? (
        <Notice
          tone="danger"
          announcement="assertive"
          action={
            <button type="button" className="btn btn-sm" onClick={onRetry}>
              Retry
            </button>
          }
        >
          Couldn&apos;t load report: {report.err}
        </Notice>
      ) : report.data ? (
        reportHasCohorts(report.data) ? (
          <ReportStats data={report.data} />
        ) : (
          <div className="muted" style={{ fontSize: 13 }}>
            Not enough data yet — control cohort:{" "}
            {report.data.control_size.toLocaleString()}, treated:{" "}
            {report.data.treated_size.toLocaleString()}. Lift needs members in
            both buckets.
          </div>
        )
      ) : null}
    </div>
  );
}

/** Stats grid for a loaded report with non-empty cohorts. */
function ReportStats({ data }: { data: ControlGroupReport }): ReactElement {
  const lift = liftSummary(data);
  const liftColor =
    lift.tone === "good"
      ? "var(--pw-accent)"
      : lift.tone === "bad"
        ? "var(--pw-danger)"
        : "var(--pw-fg-muted)";
  return (
    <div>
      {/*
        While the send path does not actually exclude control members, the
        control cohort receives every campaign — so treated-vs-control would
        compare two identical populations. The server withholds the figures
        in that case; say why, rather than showing an empty grid the operator
        will read as "no lift".
      */}
      {!data.enforced && (
        <div
          role="status"
          style={{
            marginBottom: 12,
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid var(--pw-warning-border, var(--pw-border))",
            background: "var(--pw-warning-bg, transparent)",
            color: "var(--pw-fg-muted)",
            fontSize: 13,
            lineHeight: 1.45,
          }}
        >
          <strong style={{ color: "var(--pw-fg)" }}>
            Lift is not being measured yet.
          </strong>{" "}
          {data.warning ??
            "Control-group membership is not yet excluded at send time, so the control cohort received this campaign too."}
        </div>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 9rem), 1fr))",
          gap: 12,
        }}
      >
        <ReportStat
          label="Control size"
          value={data.control_size.toLocaleString()}
        />
        <ReportStat
          label="Treated size"
          value={data.treated_size.toLocaleString()}
        />
        <ReportStat
          label="Control engagement"
          value={fmtEngagementRate(data.control_engagement_rate)}
        />
        <ReportStat
          label="Treated engagement"
          value={fmtEngagementRate(data.treated_engagement_rate)}
        />
        <ReportStat
          label="Incremental lift"
          value={lift.text}
          valueColor={liftColor}
          hint="Treated minus control engagement, in percentage points. Positive = mailing helps."
        />
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
        Engagement = share of cohort with ≥1 open / click / form submit in the
        window. Generated {fmtDayMonth(data.generated_at)}.
      </div>
    </div>
  );
}

function ReportStat({
  label,
  value,
  valueColor,
  hint,
}: {
  label: string;
  value: string;
  valueColor?: string;
  hint?: string;
}): ReactElement {
  return (
    <div>
      <div className="muted" style={{ fontSize: 11 }}>
        {label}
      </div>
      <div
        className="tabular"
        style={{ fontSize: 16, fontWeight: 600, color: valueColor }}
      >
        {value}
      </div>
      {hint ? (
        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}
