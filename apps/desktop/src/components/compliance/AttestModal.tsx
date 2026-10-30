/**
 * AttestModal — generic "Attest to this framework" form used by
 * every supported framework. HIPAA is excluded because Moosewave offers no BAA
 * and prohibits PHI workloads.
 * Refined Compliance PR 1.
 *
 * Captures: signer email, signer name (counter-signer), document
 * path (s3:// URL or similar), optional SHA-256 hash for tamper
 * detection, free-text notes, optional renewal date suggested
 * from the framework's cadence.
 *
 * Validation:
 *   - Signer email required + HTML5 type="email" gate
 *   - SHA-256 hex format (64 hex chars) when present
 *   - Renewal date can't be in the past
 *
 * Operators with informal processes are still unblocked: every
 * other field is optional. The validation surfaces inline (red
 * field-error) rather than via toast so the operator sees which
 * field tripped.
 */

import { type ReactElement, useEffect, useState } from "react";

import { useDraftLifecycleController } from "../../hooks/useDraftLifecycleController";
import { lifecycleOperationError } from "../../hooks/useSettingsDraftLifecycle";
import { api } from "../../lib/api-client";
import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";

import type { FrameworkMeta } from "./FrameworkMeta";

interface Props {
  meta: FrameworkMeta;
  /** Exact stored revision; omitted only for the first attestation. */
  expectedUpdatedAt?: string;
  onClose: () => void;
  /**
   * Callback fired after a successful attestation. Accepts either a
   * sync or async function — the caller commonly does an await api
   * reload here, and v1's `() => void` signature silently dropped
   * the awaited Promise.
   */
  onDone: () => void | Promise<void>;
}

function defaultRenewalISO(cadenceMonths: number | null): string {
  if (!cadenceMonths) return "";
  const d = new Date();
  d.setMonth(d.getMonth() + cadenceMonths);
  return d.toISOString().slice(0, 10);
}

const SHA256_RE = /^[a-f0-9]{64}$/i;

export function AttestModal({
  meta,
  expectedUpdatedAt,
  onClose,
  onDone,
}: Props): ReactElement {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [docPath, setDocPath] = useState("");
  const [docSHA, setDocSHA] = useState("");
  const [notes, setNotes] = useState("");
  const [renewalAt, setRenewalAt] = useState(
    defaultRenewalISO(meta.renewalCadenceMonths),
  );
  const [errors, setErrors] = useState<{
    email?: string;
    docSHA?: string;
    renewalAt?: string;
  }>({});

  // Reset whenever the modal swaps frameworks. The renewalAt re-seed
  // is intentional — the cadence default depends on the framework so
  // a fresh open should pick up the new framework's value.
  useEffect(() => {
    setEmail("");
    setName("");
    setDocPath("");
    setDocSHA("");
    setNotes("");
    setRenewalAt(defaultRenewalISO(meta.renewalCadenceMonths));
    setErrors({});
  }, [meta.slug, meta.renewalCadenceMonths]);

  const validate = (): boolean => {
    const next: typeof errors = {};
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      next.email = "Signer email required.";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      next.email = "Enter a valid email address.";
    }
    const trimmedSHA = docSHA.trim();
    if (trimmedSHA && !SHA256_RE.test(trimmedSHA)) {
      next.docSHA = "Must be 64 hex characters (sha256 hex digest).";
    }
    if (renewalAt) {
      const d = new Date(renewalAt + "T00:00:00Z");
      if (Number.isNaN(d.getTime())) {
        next.renewalAt = "Couldn't parse this date.";
      } else if (d.getTime() < Date.now() - 24 * 3600 * 1000) {
        // Allow today's date (some flows record same-day signatures);
        // reject "yesterday or earlier" since that's almost always a
        // typo.
        next.renewalAt = "Renewal date can't be in the past.";
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async (): Promise<boolean> => {
    if (!validate()) return false;
    const targetMeta = meta;
    const res = await api.attestComplianceProgram(targetMeta.slug, {
      signedByEmail: email.trim(),
      signerName: name.trim() || undefined,
      documentPath: docPath.trim() || undefined,
      documentSha256: docSHA.trim() || undefined,
      notes: notes.trim() || undefined,
      renewalAt: renewalAt
        ? new Date(renewalAt + "T00:00:00Z").toISOString()
        : undefined,
      ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
    });
    if (res.error) {
      toast.error(
        res.error.code
          ? `Couldn't attest [${res.error.code}]: ${res.error.message}`
          : `Couldn't attest: ${res.error.message}`,
      );
      return false;
    }
    toast.success(`Attested to ${targetMeta.short}`);
    // Await whichever shape the caller passed. Pre-fix `onDone` was
    // typed `() => void` but call-sites passed async functions; the
    // returned Promise was dropped and `await` in the caller's body
    // resolved before the post-attest reload finished.
    void Promise.resolve(onDone()).catch((error: unknown) =>
      toast.error(
        lifecycleOperationError(
          error,
          "The attestation was recorded, but the compliance view couldn't refresh.",
        ),
      ),
    );
    return true;
  };

  const baseline = {
    email: "",
    name: "",
    docPath: "",
    docSHA: "",
    notes: "",
    renewalAt: defaultRenewalISO(meta.renewalCadenceMonths),
  };
  const lifecycle = useDraftLifecycleController({
    ownerId: `compliance-attestation-${meta.slug}`,
    label: `${meta.short} attestation draft`,
    mode: "action",
    enabled: true,
    dirty:
      JSON.stringify({ email, name, docPath, docSHA, notes, renewalAt }) !==
      JSON.stringify(baseline),
    save: submit,
    discard: () => {
      setEmail("");
      setName("");
      setDocPath("");
      setDocSHA("");
      setNotes("");
      setRenewalAt(baseline.renewalAt);
      setErrors({});
    },
    close: onClose,
    detail:
      "This compliance attestation has not been recorded. Return to it or explicitly discard it.",
    operationDetail:
      "Wait for the compliance attestation request to finish before leaving Moosewave.",
    onError: (error) =>
      toast.error(
        lifecycleOperationError(error, "The attestation couldn't be recorded."),
      ),
  });

  return (
    <Modal
      open={true}
      onClose={lifecycle.requestClose}
      closeOnBackdrop={!lifecycle.active}
      closeOnEscape={!lifecycle.active}
      closeDisabled={lifecycle.active}
      title={`Attest to ${meta.short}`}
      description={`${meta.full}. Record what you have on file; auditors review the event ledger.`}
    >
      <div className="field">
        <label className="field-label" htmlFor="attest-email">
          Signer email <span style={{ color: "var(--pw-danger)" }}>*</span>
        </label>
        <input
          id="attest-email"
          type="email"
          className="input"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="cto@acme.com"
          autoComplete="off"
          disabled={lifecycle.active}
          aria-invalid={errors.email ? "true" : undefined}
        />
        {errors.email ? (
          <div className="field-error">{errors.email}</div>
        ) : null}
      </div>
      <div className="field">
        <label className="field-label" htmlFor="attest-name">
          Counter-signer (optional)
        </label>
        <input
          id="attest-name"
          type="text"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme Legal"
          autoComplete="off"
          disabled={lifecycle.active}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="attest-doc">
          Document path (optional)
        </label>
        <input
          id="attest-doc"
          type="text"
          className="input"
          value={docPath}
          onChange={(e) => setDocPath(e.target.value)}
          placeholder={`s3://compliance/${meta.slug}-2026.pdf`}
          autoComplete="off"
          disabled={lifecycle.active}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="attest-sha">
          Document SHA-256 (optional)
        </label>
        <input
          id="attest-sha"
          type="text"
          className="input mono"
          value={docSHA}
          onChange={(e) => setDocSHA(e.target.value)}
          placeholder="64 hex chars"
          maxLength={64}
          autoComplete="off"
          aria-invalid={errors.docSHA ? "true" : undefined}
          disabled={lifecycle.active}
        />
        {errors.docSHA ? (
          <div className="field-error">{errors.docSHA}</div>
        ) : (
          <div className="field-help">
            Tamper-evidence hash. Run <code>shasum -a 256 doc.pdf</code>{" "}
            locally.
          </div>
        )}
      </div>
      <div className="field">
        <label className="field-label" htmlFor="attest-notes">
          Notes (optional)
        </label>
        <textarea
          id="attest-notes"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Scope, exclusions, etc."
          disabled={lifecycle.active}
        />
      </div>
      {meta.renewalCadenceMonths !== null ? (
        <div className="field">
          <label className="field-label" htmlFor="attest-renewal">
            Next renewal{" "}
            <span className="muted">
              (typical: {meta.renewalCadenceMonths} months)
            </span>
          </label>
          <input
            id="attest-renewal"
            type="date"
            className="input tabular"
            value={renewalAt}
            onChange={(e) => setRenewalAt(e.target.value)}
            aria-invalid={errors.renewalAt ? "true" : undefined}
            disabled={lifecycle.active}
          />
          {errors.renewalAt ? (
            <div className="field-error">{errors.renewalAt}</div>
          ) : null}
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
          type="button"
          className="btn btn-primary"
          disabled={lifecycle.active}
          onClick={() => void lifecycle.submit()}
        >
          {lifecycle.active ? "Recording…" : "Record attestation"}
        </button>
      </ModalFooter>
      <ConfirmModal
        open={lifecycle.discardConfirmOpen}
        title="Discard attestation draft?"
        description="The compliance attestation has not been recorded."
        confirmLabel="Discard draft"
        danger
        busy={lifecycle.active}
        onConfirm={lifecycle.discardAndClose}
        onClose={lifecycle.keepEditing}
      />
    </Modal>
  );
}
