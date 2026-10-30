/**
 * EvidencePackSchedulesModal — recurring audit evidence-pack exports
 * (roadmap R10). Opens from the "Evidence schedules…" button next to
 * the Audit page's export controls.
 *
 * List + create + delete via auditExportSchedulesApi. Wire deviations
 * honoured here: list envelope is `{schedules}`, delete returns 200
 * `{deleted:true}` (not 204).
 *
 * Scope gating mirrors the backend: the caller only renders the launch
 * button with audit:read; mutations additionally need
 * audit:configure_sinks (`canConfigure`) — without it the form is
 * hidden and a muted hint says which scope is missing.
 */

import { type ReactElement, useEffect, useState } from "react";

import { useDraftLifecycleController } from "../../hooks/useDraftLifecycleController";
import {
  lifecycleOperationError,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import {
  type AuditExportSchedule,
  auditExportSchedulesApi,
} from "../../lib/api-client";
import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";
import {
  EVIDENCE_CADENCES,
  EVIDENCE_SCHEDULE_MAX_RECIPIENTS,
  type EvidenceCadence,
  parseRecipients,
  scheduleSummary,
  validateScheduleInput,
} from "./evidence-schedules-helpers";

interface Props {
  open: boolean;
  /** audit:configure_sinks (or admin) — gates create + delete. */
  canConfigure: boolean;
  onClose: () => void;
}

export function EvidencePackSchedulesModal({
  open,
  canConfigure,
  onClose,
}: Props): ReactElement {
  const [schedules, setSchedules] = useState<AuditExportSchedule[] | null>(
    null,
  );
  const [loading, setLoading] = useState<boolean>(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  // Create form.
  const [cadence, setCadence] = useState<EvidenceCadence>("weekly");
  const [recipientsRaw, setRecipientsRaw] = useState<string>("");
  const [formErr, setFormErr] = useState<string | null>(null);

  // Delete confirm.
  const [pendingDelete, setPendingDelete] =
    useState<AuditExportSchedule | null>(null);
  const deleteOperation = useSingleFlightOperation({
    ownerId: "evidence-schedule-delete",
    label: "Evidence schedule deletion",
    detail: "Wait for the evidence-schedule deletion to finish before leaving.",
  });

  async function load(): Promise<void> {
    setLoading(true);
    setLoadErr(null);
    const res = await auditExportSchedulesApi.list();
    setLoading(false);
    if (res.error) {
      setLoadErr(res.error.message);
      return;
    }
    // Deviation: envelope key is `schedules`, not `items`.
    setSchedules(res.data?.schedules ?? []);
  }

  useEffect(() => {
    if (!open) return;
    void load();
    // Reset transient form state on every open so a half-typed draft
    // from a previous session doesn't linger.
    setFormErr(null);
    setCadence("weekly");
    setRecipientsRaw("");
  }, [open]);

  async function create(): Promise<boolean> {
    const parsed = parseRecipients(recipientsRaw);
    const err = validateScheduleInput(cadence, parsed);
    if (err) {
      setFormErr(err);
      return false;
    }
    setFormErr(null);
    const res = await auditExportSchedulesApi.create({
      cadence,
      recipients: parsed.emails,
    });
    if (res.error) {
      setFormErr(res.error.message);
      return false;
    }
    toast.success("Evidence schedule created");
    setCadence("weekly");
    setRecipientsRaw("");
    void load();
    return true;
  }

  const createLifecycle = useDraftLifecycleController({
    ownerId: "evidence-schedule-create",
    label: "New evidence schedule draft",
    mode: "create",
    enabled: open && canConfigure,
    dirty: cadence !== "weekly" || Boolean(recipientsRaw.trim()),
    save: create,
    discard: () => {
      setCadence("weekly");
      setRecipientsRaw("");
      setFormErr(null);
    },
    close: onClose,
    detail:
      "This evidence schedule has not been created. Return to it or explicitly discard the draft.",
    operationDetail:
      "Wait for the evidence-schedule request to finish before leaving Moosewave.",
    onError: (error) =>
      setFormErr(
        lifecycleOperationError(
          error,
          "The evidence schedule couldn't be created.",
        ),
      ),
  });

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return;
    const target = pendingDelete;
    // Deviation: returns 200 {deleted:true}, not 204.
    const request = deleteOperation.run(async () => {
      try {
        const res = await auditExportSchedulesApi.remove(target.id);
        if (res.error) {
          toast.error(`Couldn't delete schedule: ${res.error.message}`);
          return;
        }
        toast.success("Schedule deleted");
        setPendingDelete(null);
        void load();
      } catch (error) {
        toast.error(
          lifecycleOperationError(error, "The schedule couldn't be deleted."),
        );
      }
    });
    if (!request) await deleteOperation.wait();
  }

  const requestClose = (): void => {
    if (deleteOperation.promiseRef.current) return;
    createLifecycle.requestClose();
  };

  return (
    <Modal
      open={open}
      onClose={requestClose}
      closeOnBackdrop={!createLifecycle.active && !deleteOperation.active}
      closeOnEscape={!createLifecycle.active && !deleteOperation.active}
      closeDisabled={createLifecycle.active || deleteOperation.active}
      title="Evidence pack schedules"
      description="Recurring audit evidence exports, emailed to your compliance recipients on a weekly or monthly cadence."
      size="lg"
    >
      {loadErr ? (
        <div className="notice">
          <span>Couldn&apos;t load schedules: {loadErr}</span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void load()}
            disabled={loading}
          >
            Retry
          </button>
        </div>
      ) : loading && schedules === null ? (
        <div className="muted" style={{ fontSize: 12, padding: "8px 0" }}>
          Loading schedules…
        </div>
      ) : (schedules ?? []).length === 0 ? (
        <div className="muted" style={{ fontSize: 12, padding: "8px 0" }}>
          No evidence schedules yet. Exports only happen when a schedule exists
          — nothing is emailed by default.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {(schedules ?? []).map((s) => (
            <div
              key={s.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                background: "var(--pw-bg-elev)",
                borderRadius: 6,
                fontSize: 12,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>{scheduleSummary(s.cadence, s.recipients)}</div>
                <div
                  className="muted mono"
                  style={{
                    fontSize: 11,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={s.recipients.join(", ")}
                >
                  {s.recipients.join(", ")}
                </div>
              </div>
              <span className="muted" style={{ whiteSpace: "nowrap" }}>
                {s.last_enqueued_at
                  ? `Last sent ${new Date(s.last_enqueued_at).toLocaleDateString()}`
                  : "Never sent yet"}
              </span>
              {canConfigure ? (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={deleteOperation.active || createLifecycle.active}
                  onClick={() => setPendingDelete(s)}
                  aria-label={`Delete ${scheduleSummary(s.cadence, s.recipients)} schedule`}
                >
                  Delete
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {canConfigure ? (
        <div
          style={{
            marginTop: 14,
            paddingTop: 12,
            borderTop: "1px solid var(--pw-border)",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600 }}>New schedule</div>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <span className="muted" style={{ fontSize: 12 }}>
              Cadence
            </span>
            {EVIDENCE_CADENCES.map((c) => (
              <button
                key={c.value}
                type="button"
                className={`chip${cadence === c.value ? " is-active" : ""}`}
                aria-pressed={cadence === c.value}
                disabled={createLifecycle.active || deleteOperation.active}
                onClick={() => setCadence(c.value)}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="field">
            <label className="field-label" htmlFor="evidence-recipients">
              Recipients (up to {EVIDENCE_SCHEDULE_MAX_RECIPIENTS},
              comma-separated)
            </label>
            <input
              id="evidence-recipients"
              type="text"
              className="input"
              placeholder="compliance@example.com, auditor@example.com"
              value={recipientsRaw}
              onChange={(e) => setRecipientsRaw(e.target.value)}
              disabled={createLifecycle.active || deleteOperation.active}
            />
          </div>
          {formErr ? <div className="field-error">{formErr}</div> : null}
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>
          Creating or deleting schedules requires the audit:configure_sinks
          scope — ask a tenant owner to assign it from Settings → Team → Roles.
        </div>
      )}

      <ModalFooter>
        <button
          type="button"
          className="btn"
          disabled={createLifecycle.active || deleteOperation.active}
          onClick={requestClose}
        >
          Close
        </button>
        {canConfigure ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void createLifecycle.submit()}
            disabled={createLifecycle.active || deleteOperation.active}
          >
            {createLifecycle.active ? "Creating…" : "Create schedule"}
          </button>
        ) : null}
      </ModalFooter>

      <ConfirmModal
        open={pendingDelete !== null}
        title="Delete evidence schedule?"
        description={
          pendingDelete
            ? `Stop the ${pendingDelete.cadence} evidence pack to ${pendingDelete.recipients.join(", ")}? Already-delivered packs are unaffected.`
            : ""
        }
        confirmLabel="Delete schedule"
        danger
        busy={deleteOperation.active}
        onConfirm={() => void confirmDelete()}
        onClose={() =>
          deleteOperation.active ? undefined : setPendingDelete(null)
        }
      />
      <ConfirmModal
        open={createLifecycle.discardConfirmOpen}
        title="Discard evidence-schedule draft?"
        description="The recurring evidence export has not been created."
        confirmLabel="Discard draft"
        danger
        busy={createLifecycle.active || deleteOperation.active}
        onConfirm={createLifecycle.discardAndClose}
        onClose={createLifecycle.keepEditing}
      />
    </Modal>
  );
}
