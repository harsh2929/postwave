import type { ReactElement } from "react";

import type { Subscriber } from "../../lib/api-client";
import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import { LookalikeGeneratorModal } from "./LookalikeGeneratorModal";
import { ValidationResultsModal } from "./ValidationResultsModal";
import {
  BULK_CONSENT_CATEGORIES,
  BULK_MERGE_FIELDS,
  bulkBusyLabel,
  classifyResubscribeEligibility,
  type BulkActionCallbacks,
  type BulkActionUiState,
} from "./bulk-action-types";
import {
  CONSENT_EVIDENCE_CHANNELS,
  CONSENT_LEGAL_BASES,
  CONSENT_PROVENANCE_SOURCES,
  consentEvidenceError,
  type ConsentEvidenceDraft,
} from "./consent-evidence";
import { engineStatusToUi } from "./subscriber-status";

interface BulkActionOverlaysProps {
  selected: Subscriber[];
  count: number;
  plural: string;
  canMutate: boolean;
  state: BulkActionUiState;
  actions: BulkActionCallbacks;
}

export function BulkActionOverlays({
  selected,
  count,
  plural,
  canMutate,
  state,
  actions,
}: BulkActionOverlaysProps): ReactElement {
  const validEmails = new Set(
    (state.validationResult?.results ?? [])
      .filter((result) => result.valid)
      .map((result) => result.email.trim().toLowerCase()),
  );
  const validSubset = selected.filter(
    (subscriber) =>
      subscriber.id != null &&
      subscriber.email != null &&
      validEmails.has(subscriber.email.trim().toLowerCase()),
  );
  const validSubsetWithoutId = selected.filter(
    (subscriber) =>
      subscriber.id == null &&
      subscriber.email != null &&
      validEmails.has(subscriber.email.trim().toLowerCase()),
  ).length;
  return (
    <>
      <BulkTagModal
        count={count}
        plural={plural}
        state={state}
        addTag={actions.addTag}
      />
      <ConfirmModal
        open={state.showSuppress}
        title={`Suppress ${count.toLocaleString()} subscriber${plural}?`}
        description="Records a durable email-consent withdrawal and suppresses delivery. There is no automatic Undo; restoring eligibility later requires a fresh, reviewed consent receipt through Resubscribe."
        confirmLabel="Suppress"
        danger
        busy={state.busy === "suppress"}
        onClose={() => state.setShowSuppress(false)}
        onConfirm={() => void actions.suppress()}
      />
      <ConfirmModal
        open={state.showDelete}
        title={`Permanently erase ${count.toLocaleString()} subscriber${plural}?`}
        description="Irreversible privacy erasure. Profiles and attached addresses are deleted, every known address remains permanently suppressed, and no recovery snapshot or Undo is created."
        confirmLabel="Permanently erase"
        danger
        typeToConfirm={`ERASE ${count}`}
        busy={state.busy === "delete"}
        onClose={() => state.setShowDelete(false)}
        onConfirm={() => void actions.bulkDelete()}
      />
      <BulkResubscribeModal
        selected={selected}
        state={state}
        resubscribe={actions.resubscribe}
      />
      <BulkAddToListModal
        count={count}
        plural={plural}
        state={state}
        addToList={actions.addToList}
      />
      <BulkCustomFieldModal
        count={count}
        plural={plural}
        state={state}
        setCustomField={actions.setCustomField}
      />
      <BulkMergeFieldModal
        count={count}
        plural={plural}
        state={state}
        updateMergeField={actions.updateMergeField}
      />
      <BulkConsentModal
        selected={selected}
        count={count}
        plural={plural}
        state={state}
        applyConsent={actions.applyConsent}
      />
      <ValidationResultsModal
        open={state.showValidation}
        onClose={() => state.setShowValidation(false)}
        response={state.validationResult}
        skipped={state.validationSkipped}
        validSubsetCount={validSubset.length}
        validSubsetWithoutId={validSubsetWithoutId}
        exportingValidSubset={state.busy === "export"}
        onExportValidSubset={() => {
          state.setShowValidation(false);
          void actions.exportCsv(validSubset);
        }}
      />
      <LookalikeGeneratorModal
        open={state.showLookalike}
        onClose={() => state.setShowLookalike(false)}
        canMutate={canMutate}
        selectedCount={count}
      />
    </>
  );
}

function BulkResubscribeModal({
  selected,
  state,
  resubscribe,
}: {
  selected: Subscriber[];
  state: BulkActionUiState;
  resubscribe: () => Promise<void>;
}): ReactElement {
  const eligibility = classifyResubscribeEligibility(selected);
  const busy = state.busy === "resubscribe";
  const expected = `RESUBSCRIBE ${eligibility.eligible}`;
  const error = consentEvidenceError(state.consentEvidence, {
    requireEvidence: true,
    requireScope: true,
  });
  const canConfirm =
    eligibility.eligible > 0 &&
    error == null &&
    state.consentEvidence.confirmation.trim() === expected;
  return (
    <Modal
      open={state.showResubscribe}
      onClose={() => (busy ? undefined : state.setShowResubscribe(false))}
      title="Review resubscribe eligibility"
      description="Resubscribe can restore email send eligibility. Only locally recognized unsubscribed records enter the request; the server excludes complaints, erasures, protected bounces, and records whose state changed after this review."
    >
      <div
        role="status"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: 8,
          marginBottom: 12,
          fontSize: 12,
        }}
      >
        <EligibilityCount
          label="Eligible for server preflight"
          value={eligibility.eligible}
        />
        <EligibilityCount
          label="Already subscribed"
          value={eligibility.alreadySubscribed}
        />
        <EligibilityCount
          label="Inactive or unconfirmed"
          value={eligibility.ineligible}
        />
        <EligibilityCount
          label="Unknown or missing id"
          value={eligibility.unknown + eligibility.missingId}
        />
      </div>
      <ConsentEvidenceFields
        draft={state.consentEvidence}
        disabled={busy}
        mode="resubscribe"
        prefix="bulk-resubscribe"
        exactPhrase={expected}
        onChange={state.setConsentEvidence}
      />
      {error ? (
        <div className="field-error" role="status">
          {error}
        </div>
      ) : null}
      <ModalFooter>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => state.setShowResubscribe(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !canConfirm}
          onClick={() => void resubscribe()}
        >
          {busy ? "Resubscribing…" : `Resubscribe ${eligibility.eligible}`}
        </button>
      </ModalFooter>
    </Modal>
  );
}

function EligibilityCount({
  label,
  value,
}: {
  label: string;
  value: number;
}): ReactElement {
  return (
    <div
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        padding: 8,
      }}
    >
      <strong className="tabular">{value.toLocaleString()}</strong>
      <div className="muted" style={{ fontSize: 11 }}>
        {label}
      </div>
    </div>
  );
}

interface CountModalProps {
  count: number;
  plural: string;
  state: BulkActionUiState;
}

function BulkTagModal({
  count,
  plural,
  state,
  addTag,
}: CountModalProps & { addTag: () => Promise<void> }): ReactElement {
  return (
    <Modal
      open={state.showTag}
      onClose={() =>
        state.busy === "tag" ? undefined : state.setShowTag(false)
      }
      title="Add tags"
      description={`Add tags to ${count.toLocaleString()} subscriber${plural}. Existing tags are preserved.`}
    >
      <div className="field">
        <label className="field-label" htmlFor="bulk-tags">
          Tags (comma-separated)
        </label>
        <input
          id="bulk-tags"
          type="text"
          className="input"
          value={state.tagInput}
          onChange={(event) => state.setTagInput(event.target.value)}
          placeholder="vip, beta-tester, 2026-launch"
          autoComplete="off"
          onKeyDown={(event) => {
            if (event.key === "Enter" && !state.busy) {
              event.preventDefault();
              void addTag();
            }
          }}
        />
        <div className="field-help">
          New tags are merged with each subscriber&apos;s existing tags. No
          duplicates.
        </div>
      </div>
      <ModalFooter>
        <button
          type="button"
          className="btn"
          disabled={state.busy === "tag"}
          onClick={() => state.setShowTag(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={state.busy === "tag" || !state.tagInput.trim()}
          onClick={() => void addTag()}
        >
          {bulkBusyLabel(
            state.busy,
            state.progress,
            "Add tags",
            "Tagging",
            "tag",
          )}
        </button>
      </ModalFooter>
    </Modal>
  );
}

function BulkAddToListModal({
  count,
  plural,
  state,
  addToList,
}: CountModalProps & { addToList: () => Promise<void> }): ReactElement {
  const listsReady = state.listLoadStatus === "ready";
  return (
    <Modal
      open={state.showAddToList}
      onClose={() =>
        state.busy === "addToList" ? undefined : state.setShowAddToList(false)
      }
      title="Add to list"
      description={`Add ${count.toLocaleString()} subscriber${plural} to a list. Already-member rows are skipped.`}
    >
      <div className="field">
        <label className="field-label" htmlFor="bulk-list">
          List
        </label>
        <select
          id="bulk-list"
          className="input"
          value={state.listId}
          onChange={(event) => state.setListId(event.target.value)}
          disabled={
            state.busy === "addToList" ||
            !listsReady ||
            state.lists.length === 0
          }
        >
          {state.listLoadStatus === "loading" ? (
            <option value="">Loading lists…</option>
          ) : null}
          {state.listLoadStatus === "error" ? (
            <option value="">Lists unavailable</option>
          ) : null}
          {listsReady && state.lists.length === 0 ? (
            <option value="">No lists found</option>
          ) : null}
          {state.lists.map((list) => (
            <option key={String(list.id)} value={String(list.id)}>
              {list.name}
            </option>
          ))}
        </select>
      </div>
      {state.listLoadStatus === "loading" ? (
        <div role="status" aria-live="polite" className="field-help">
          Loading workspace lists…
        </div>
      ) : null}
      {state.listLoadStatus === "error" ? (
        <div className="notice danger" role="alert" style={{ fontSize: 12 }}>
          <span>{state.listLoadError}</span>{" "}
          <button
            type="button"
            className="btn btn-sm"
            onClick={state.reloadLists}
          >
            Retry loading lists
          </button>
        </div>
      ) : null}
      {listsReady && state.lists.length === 0 ? (
        <div className="notice" role="status" style={{ fontSize: 12 }}>
          This workspace has no lists yet. Create a list before using this
          action.
        </div>
      ) : null}
      <ModalFooter>
        <button
          type="button"
          className="btn"
          disabled={state.busy === "addToList"}
          onClick={() => state.setShowAddToList(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={state.busy === "addToList" || !listsReady || !state.listId}
          onClick={() => void addToList()}
        >
          {state.busy === "addToList" ? "Adding…" : "Add to list"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

function BulkCustomFieldModal({
  count,
  plural,
  state,
  setCustomField,
}: CountModalProps & { setCustomField: () => Promise<void> }): ReactElement {
  return (
    <Modal
      open={state.showCustomField}
      onClose={() =>
        state.busy === "customField"
          ? undefined
          : state.setShowCustomField(false)
      }
      title="Set custom field"
      description={`Set a custom-field value on ${count.toLocaleString()} subscriber${plural}. Existing values for the same key are overwritten.`}
    >
      <div className="field">
        <label className="field-label" htmlFor="bulk-cf-key">
          Field key
        </label>
        <input
          id="bulk-cf-key"
          type="text"
          className="input"
          value={state.cfKey}
          onChange={(event) => state.setCfKey(event.target.value)}
          placeholder="plan_tier"
          autoComplete="off"
          disabled={state.busy === "customField"}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="bulk-cf-value">
          Value
        </label>
        <input
          id="bulk-cf-value"
          type="text"
          className="input"
          value={state.cfValue}
          onChange={(event) => state.setCfValue(event.target.value)}
          placeholder="enterprise"
          autoComplete="off"
          disabled={state.busy === "customField"}
        />
      </div>
      <ModalFooter>
        <button
          type="button"
          className="btn"
          disabled={state.busy === "customField"}
          onClick={() => state.setShowCustomField(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={state.busy === "customField" || !state.cfKey.trim()}
          onClick={() => void setCustomField()}
        >
          {state.busy === "customField" ? "Saving…" : "Set field"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

function BulkMergeFieldModal({
  count,
  plural,
  state,
  updateMergeField,
}: CountModalProps & { updateMergeField: () => Promise<void> }): ReactElement {
  return (
    <Modal
      open={state.showMergeField}
      onClose={() =>
        state.busy === "mergeField" ? undefined : state.setShowMergeField(false)
      }
      title="Update merge field"
      description={`Set a Mailchimp-style merge tag on ${count.toLocaleString()} subscriber${plural}.`}
    >
      <div className="field">
        <label className="field-label" htmlFor="bulk-mf-key">
          Merge field
        </label>
        <select
          id="bulk-mf-key"
          className="input"
          value={state.mfKey}
          onChange={(event) => state.setMfKey(event.target.value)}
          disabled={state.busy === "mergeField"}
        >
          {BULK_MERGE_FIELDS.map((field) => (
            <option key={field} value={field}>
              {field}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="bulk-mf-value">
          Value
        </label>
        <input
          id="bulk-mf-value"
          type="text"
          className="input"
          value={state.mfValue}
          onChange={(event) => state.setMfValue(event.target.value)}
          autoComplete="off"
          disabled={state.busy === "mergeField"}
        />
      </div>
      <ModalFooter>
        <button
          type="button"
          className="btn"
          disabled={state.busy === "mergeField"}
          onClick={() => state.setShowMergeField(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={state.busy === "mergeField"}
          onClick={() => void updateMergeField()}
        >
          {state.busy === "mergeField" ? "Saving…" : "Update field"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

function BulkConsentModal({
  selected,
  count,
  plural,
  state,
  applyConsent,
}: CountModalProps & {
  selected: Subscriber[];
  applyConsent: (mode: "grant" | "revoke") => Promise<void>;
}): ReactElement {
  const consentBusy =
    state.busy === "grantConsent" || state.busy === "revokeConsent";
  const mode = state.showConsent ?? "grant";
  const eligibleCount = selected.filter(
    (subscriber) =>
      subscriber.id != null &&
      engineStatusToUi(subscriber.status) !== "unknown",
  ).length;
  const unknownCount = count - eligibleCount;
  const expected = `${mode === "grant" ? "GRANT" : "REVOKE"} ${eligibleCount}`;
  const error = consentEvidenceError(state.consentEvidence, {
    requireEvidence: mode === "grant",
    requireScope: true,
  });
  const canConfirm =
    eligibleCount > 0 &&
    error == null &&
    state.consentEvidence.confirmation.trim() === expected;
  return (
    <Modal
      open={state.showConsent != null}
      onClose={() => (consentBusy ? undefined : state.setShowConsent(null))}
      title={
        state.showConsent === "revoke" ? "Revoke consent" : "Grant consent"
      }
      description={`${state.showConsent === "revoke" ? "Record a consent revocation" : "Record consent"} for ${count.toLocaleString()} subscriber${plural}. Appends to the immutable consent ledger.`}
    >
      {unknownCount > 0 ? (
        <div
          className="notice warning"
          role="status"
          style={{ marginBottom: 10 }}
        >
          {unknownCount.toLocaleString()} unknown-status or id-less record
          {unknownCount === 1 ? " is" : "s are"} excluded until reconciled.
        </div>
      ) : null}
      <div className="field">
        <label className="field-label" htmlFor="bulk-consent-cat">
          Category
        </label>
        <select
          id="bulk-consent-cat"
          className="input"
          value={state.consentCategory}
          onChange={(event) => state.setConsentCategory(event.target.value)}
          disabled={consentBusy}
        >
          {BULK_CONSENT_CATEGORIES.map((category) => (
            <option key={category.value} value={category.value}>
              {category.label}
            </option>
          ))}
        </select>
      </div>
      <ConsentEvidenceFields
        draft={state.consentEvidence}
        disabled={consentBusy}
        mode={mode}
        prefix="bulk-consent"
        exactPhrase={expected}
        onChange={state.setConsentEvidence}
      />
      {error ? (
        <div className="field-error" role="status">
          {error}
        </div>
      ) : null}
      <ModalFooter>
        <button
          type="button"
          className="btn"
          disabled={consentBusy}
          onClick={() => state.setShowConsent(null)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={consentBusy || !canConfirm}
          onClick={() => void applyConsent(state.showConsent ?? "grant")}
        >
          {state.busy === "grantConsent"
            ? "Granting…"
            : state.busy === "revokeConsent"
              ? "Revoking…"
              : state.showConsent === "revoke"
                ? "Revoke"
                : "Grant"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

function ConsentEvidenceFields({
  draft,
  disabled,
  mode,
  prefix,
  exactPhrase,
  onChange,
}: {
  draft: ConsentEvidenceDraft;
  disabled: boolean;
  mode: "grant" | "revoke" | "resubscribe";
  prefix: string;
  exactPhrase: string;
  onChange: BulkActionUiState["setConsentEvidence"];
}): ReactElement {
  const update = <K extends keyof ConsentEvidenceDraft>(
    key: K,
    value: ConsentEvidenceDraft[K],
  ): void => onChange((current) => ({ ...current, [key]: value }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: 10,
        }}
      >
        <EvidenceSelect
          id={`${prefix}-source`}
          label="Evidence source"
          value={draft.source}
          options={CONSENT_PROVENANCE_SOURCES}
          disabled={disabled}
          onChange={(value) => update("source", value)}
        />
        <EvidenceSelect
          id={`${prefix}-channel`}
          label="Capture channel"
          value={draft.channel}
          options={CONSENT_EVIDENCE_CHANNELS}
          disabled={disabled}
          onChange={(value) => update("channel", value)}
        />
        <EvidenceSelect
          id={`${prefix}-basis`}
          label="Legal basis"
          value={draft.legalBasis}
          options={CONSENT_LEGAL_BASES}
          disabled={disabled}
          onChange={(value) => update("legalBasis", value)}
        />
        <label className="field" htmlFor={`${prefix}-occurred-at`}>
          <span className="field-label">Decision captured at</span>
          <input
            id={`${prefix}-occurred-at`}
            type="datetime-local"
            className="input"
            value={draft.occurredAt}
            disabled={disabled}
            onChange={(event) => update("occurredAt", event.target.value)}
          />
        </label>
        <label className="field" htmlFor={`${prefix}-jurisdiction`}>
          <span className="field-label">Jurisdiction</span>
          <input
            id={`${prefix}-jurisdiction`}
            className="input"
            value={draft.jurisdiction}
            disabled={disabled}
            placeholder="US-CA, GB, EU"
            maxLength={32}
            onChange={(event) => update("jurisdiction", event.target.value)}
          />
        </label>
        <label className="field" htmlFor={`${prefix}-policy`}>
          <span className="field-label">Policy version</span>
          <input
            id={`${prefix}-policy`}
            className="input"
            value={draft.policyVersion}
            disabled={disabled}
            placeholder="privacy-2026-07"
            maxLength={100}
            onChange={(event) => update("policyVersion", event.target.value)}
          />
        </label>
      </div>
      <label className="field" htmlFor={`${prefix}-evidence`}>
        <span className="field-label">
          Durable evidence reference{mode === "revoke" ? " (optional)" : ""}
        </span>
        <textarea
          id={`${prefix}-evidence`}
          className="input"
          rows={2}
          value={draft.evidence}
          disabled={disabled}
          maxLength={2048}
          placeholder="Receipt id, signed-form id, or approved evidence URL — do not paste unnecessary personal data"
          onChange={(event) => update("evidence", event.target.value)}
        />
      </label>
      <label className="field" htmlFor={`${prefix}-reason`}>
        <span className="field-label">Operator reason</span>
        <textarea
          id={`${prefix}-reason`}
          className="input"
          rows={2}
          value={draft.reason}
          disabled={disabled}
          maxLength={500}
          placeholder="Why this change is valid and who reviewed the evidence"
          onChange={(event) => update("reason", event.target.value)}
        />
      </label>
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <input
          type="checkbox"
          checked={draft.scopeAcknowledged}
          disabled={disabled}
          onChange={(event) =>
            update("scopeAcknowledged", event.target.checked)
          }
        />
        <span style={{ fontSize: 12 }}>
          I reviewed the eligible scope and exclusions. This evidence applies to
          every record included in this operation.
        </span>
      </label>
      <label className="field" htmlFor={`${prefix}-confirmation`}>
        <span className="field-label">
          Type <strong>{exactPhrase}</strong> to confirm
        </span>
        <input
          id={`${prefix}-confirmation`}
          className="input"
          value={draft.confirmation}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => update("confirmation", event.target.value)}
        />
      </label>
    </div>
  );
}

function EvidenceSelect({
  id,
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  disabled: boolean;
  onChange: (value: string) => void;
}): ReactElement {
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <select
        id={id}
        className="input"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Select…</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
