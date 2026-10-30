/**
 * ReverseETLMappingModal — SUB-112 create one reverse-ETL mapping.
 *
 * A reverse-ETL mapping defines how one warehouse column would map to a
 * subscriber custom-field key, with optional type casting. This desktop build
 * deliberately creates contracts in draft or paused state because it has no
 * warehouse row-fetch driver; creating a mapping does not move subscriber data.
 *
 * Fields mirror the backend contract exactly
 * (apps/api/internal/warehouse/reverse_etl.go → ReverseETLMapping):
 *   - source_table        (required)
 *   - source_column       (required)
 *   - target_field_key    (required — the custom-field key)
 *   - profile_key_column  (default "email")
 *   - profile_key_target  (backend requires "email")
 *   - cast_type           (string | number | boolean | date | datetime | json)
 *   - status              (draft | paused from this safety-held UI)
 *
 * Validation matches the server's normalizeReverseETLMapping so the UI
 * never POSTs a body it knows will 400.
 */

import { useState, type ReactElement } from "react";

import { useDraftLifecycleController } from "../../hooks/useDraftLifecycleController";
import { ConfirmModal } from "../ConfirmModal";
import { FormField } from "../FormField";
import { Modal, ModalFooter } from "../Modal";
import { Notice } from "../Notice";
import { toast } from "../Toast";
import { warehouseApi, type ReverseETLCastType } from "../../lib/api-client";
import { safeDataPlatformFailure } from "../dataplatform/safe-failures";

const CAST_TYPES: ReverseETLCastType[] = [
  "string",
  "number",
  "boolean",
  "date",
  "datetime",
  "json",
];

const STATUSES = ["draft", "paused"] as const;

interface Props {
  connectionId: string;
  connectionName: string;
  onClose: () => void;
  onSaved: () => void;
}

export function ReverseETLMappingModal({
  connectionId,
  connectionName,
  onClose,
  onSaved,
}: Props): ReactElement {
  const [sourceTable, setSourceTable] = useState("");
  const [sourceColumn, setSourceColumn] = useState("");
  const [targetFieldKey, setTargetFieldKey] = useState("");
  const [profileKeyColumn, setProfileKeyColumn] = useState("email");
  const [castType, setCastType] = useState<ReverseETLCastType>("string");
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("draft");

  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!sourceTable.trim()) e.sourceTable = "Source table is required";
    if (!sourceColumn.trim()) e.sourceColumn = "Source column is required";
    if (!targetFieldKey.trim()) {
      e.targetFieldKey = "Target custom-field key is required";
    }
    return e;
  };

  const save = async (): Promise<boolean> => {
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0) return false;
    const res = await warehouseApi.createReverseETLMapping(connectionId, {
      expected_version: 0,
      source_table: sourceTable.trim(),
      source_column: sourceColumn.trim(),
      target_field_key: targetFieldKey.trim(),
      profile_key_column: profileKeyColumn.trim() || "email",
      profile_key_target: "email",
      cast_type: castType,
      status,
    });
    if (res.error) {
      setErrors({
        form: safeDataPlatformFailure(
          res.error,
          "The warehouse service could not save this mapping.",
        ),
      });
      return false;
    }
    toast.success(`Mapping for "${sourceTable.trim()}" saved`);
    onSaved();
    return true;
  };

  const lifecycle = useDraftLifecycleController({
    ownerId: `reverse-etl-mapping-create-${connectionId}`,
    label: "New reverse-ETL mapping draft",
    mode: "create",
    enabled: true,
    dirty:
      Boolean(sourceTable.trim()) ||
      Boolean(sourceColumn.trim()) ||
      Boolean(targetFieldKey.trim()) ||
      profileKeyColumn !== "email" ||
      castType !== "string" ||
      status !== "draft",
    save,
    discard: () => {
      setSourceTable("");
      setSourceColumn("");
      setTargetFieldKey("");
      setProfileKeyColumn("email");
      setCastType("string");
      setStatus("draft");
      setErrors({});
    },
    close: onClose,
    detail:
      "This reverse-ETL mapping has not been created. Return to it or explicitly discard it.",
    operationDetail:
      "Wait for the reverse-ETL mapping request to finish before leaving Moosewave.",
    onError: (error) =>
      setErrors({
        form: safeDataPlatformFailure(
          error,
          "The reverse-ETL mapping couldn't be saved.",
        ),
      }),
  });

  const mappingPreview =
    sourceTable.trim() && sourceColumn.trim() && targetFieldKey.trim()
      ? `warehouse.${sourceTable.trim()}.${sourceColumn.trim()} → custom_field.${targetFieldKey.trim()}`
      : null;

  return (
    <Modal
      open
      onClose={lifecycle.requestClose}
      closeOnBackdrop={!lifecycle.active}
      closeOnEscape={!lifecycle.active}
      closeDisabled={lifecycle.active}
      title="Add reverse-ETL mapping"
      description={`Sync a warehouse column onto subscribers as a custom field via "${connectionName}". Rows match subscribers by the profile-key column.`}
    >
      <form
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          void lifecycle.submit();
        }}
      >
        <fieldset
          disabled={lifecycle.active}
          style={{ border: 0, margin: 0, padding: 0 }}
        >
          {errors.form ? (
            <Notice
              tone="danger"
              announcement="assertive"
              style={{ marginBottom: 12 }}
            >
              {errors.form}
            </Notice>
          ) : null}

          <div className="dp-runtime-callout" role="note">
            <div>
              <strong>Mapping contract only</strong>
              <p>
                New mappings stay draft or paused while this build has no
                warehouse row-fetch driver. Creating a mapping does not move
                subscriber data.
              </p>
            </div>
            <span className="dp-status-pill dp-status-pill-warning">
              Execution held
            </span>
          </div>

          <div className="dp-form-grid dp-form-grid-2">
            <FormField label="Source table" required error={errors.sourceTable}>
              <input
                type="text"
                value={sourceTable}
                onChange={(e) => setSourceTable(e.target.value)}
                placeholder="customers"
              />
            </FormField>
            <FormField
              label="Source column"
              required
              error={errors.sourceColumn}
            >
              <input
                type="text"
                value={sourceColumn}
                onChange={(e) => setSourceColumn(e.target.value)}
                placeholder="ltv_cents"
              />
            </FormField>
          </div>

          <FormField
            label="Target custom-field key"
            required
            error={errors.targetFieldKey}
            help="The subscriber custom field the warehouse value is written to."
          >
            <input
              type="text"
              value={targetFieldKey}
              onChange={(e) => setTargetFieldKey(e.target.value)}
              placeholder="customer_lifetime_value"
            />
          </FormField>

          <div className="dp-form-grid dp-form-grid-3">
            <FormField
              label="Profile-key column"
              help="Warehouse column matched against subscribers."
            >
              <input
                type="text"
                value={profileKeyColumn}
                onChange={(e) => setProfileKeyColumn(e.target.value)}
                placeholder="email"
              />
            </FormField>
            <FormField label="Field type" help="Auto-cast on import.">
              <select
                value={castType}
                onChange={(e) =>
                  setCastType(e.target.value as ReverseETLCastType)
                }
              >
                {CAST_TYPES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Status">
              <select
                value={status}
                onChange={(e) =>
                  setStatus(e.target.value as (typeof STATUSES)[number])
                }
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </FormField>
          </div>

          {mappingPreview ? (
            <div
              className="mono"
              style={{
                fontSize: 12,
                padding: "8px 10px",
                border: "1px solid var(--pw-border)",
                borderRadius: 6,
                marginTop: 4,
                wordBreak: "break-all",
              }}
            >
              {mappingPreview}
            </div>
          ) : null}

          <ModalFooter>
            <button
              type="button"
              className="btn"
              disabled={lifecycle.active}
              onClick={lifecycle.requestClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={lifecycle.active}
            >
              {lifecycle.active ? "Saving…" : "Save mapping"}
            </button>
          </ModalFooter>
        </fieldset>
      </form>
      <ConfirmModal
        open={lifecycle.discardConfirmOpen}
        title="Discard reverse-ETL mapping draft?"
        description="The mapping has not been created."
        confirmLabel="Discard draft"
        danger
        busy={lifecycle.active}
        onConfirm={lifecycle.discardAndClose}
        onClose={lifecycle.keepEditing}
      />
    </Modal>
  );
}
