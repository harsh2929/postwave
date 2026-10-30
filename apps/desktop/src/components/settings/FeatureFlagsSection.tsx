/**
 * FeatureFlagsSection — admin Settings section wiring #56
 * (/api/v1/feature-flags CRUD + per-key resolve preview).
 *
 * - List shows tenant overrides above platform defaults (is_default).
 * - Create/override via the same POST upsert.
 * - Deleting removes only the tenant override (server semantics) and
 *   is gated behind a ConfirmModal.
 * - Resolve preview reports `{key, value, source}` verbatim
 *   (tenant | default | missing).
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import {
  type FeatureFlag,
  featureFlagsApi,
} from "../../lib/api-client";
import { useCanAdmin } from "../../lib/store";
import { ConfirmModal } from "../ConfirmModal";
import { toast } from "../Toast";
import { SettingsSectionHeader } from "./SettingsNav";
import {
  flagSourceLabel,
  resolveSourceCopy,
  resolveSourceTone,
  sortFlags,
  validateFlagKey,
} from "./feature-flags-helpers";

export function FeatureFlagsSection(): ReactElement | null {
  const canAdmin = useCanAdmin();
  const [flags, setFlags] = useState<FeatureFlag[] | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  // Create / override form.
  const [showForm, setShowForm] = useState<boolean>(false);
  const [draftKey, setDraftKey] = useState<string>("");
  const [draftValue, setDraftValue] = useState<string>("");
  const [draftNote, setDraftNote] = useState<string>("");
  const [formErr, setFormErr] = useState<string | null>(null);

  // Delete-override confirm target.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  // Resolve preview.
  const [resolveKey, setResolveKey] = useState<string>("");
  const [resolving, setResolving] = useState<boolean>(false);
  const [resolved, setResolved] = useState<{
    key: string;
    value: string;
    source: string;
  } | null>(null);
  const [resolveErr, setResolveErr] = useState<string | null>(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const activeRef = useRef(true);
  const resolveRef = useRef<Promise<void> | null>(null);
  const operation = useSingleFlightOperation({
    ownerId: "feature-flags",
    label: "Feature-flag request",
  });

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      const res = await featureFlagsApi.list();
      if (!activeRef.current) return;
      if (res.error) {
        setErr(res.error.message);
        setFlags(null);
      } else {
        setFlags(sortFlags(res.data?.flags ?? []));
      }
    } catch (loadError) {
      if (activeRef.current) {
        setErr(lifecycleOperationError(loadError, "Flags couldn't be loaded."));
        setFlags(null);
      }
    } finally {
      if (activeRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    activeRef.current = true;
    if (canAdmin) void load();
    return () => {
      activeRef.current = false;
    };
  }, [canAdmin, load]);

  const draftDirty =
    showForm && Boolean(draftKey || draftValue || draftNote);
  const discardDraft = useCallback((): void => {
    setShowForm(false);
    setDraftKey("");
    setDraftValue("");
    setDraftNote("");
    setFormErr(null);
    setDiscardConfirmOpen(false);
  }, []);
  const requestFormClose = useCallback((): void => {
    if (operation.promiseRef.current) return;
    if (draftDirty) setDiscardConfirmOpen(true);
    else discardDraft();
  }, [discardDraft, draftDirty, operation.promiseRef]);

  useDiscardOnlyDraftLifecycle({
    ownerId: "feature-flag-upsert",
    label: "Feature flag draft",
    dirty: draftDirty,
    operationRef: operation.promiseRef,
    discard: discardDraft,
    detail:
      "This feature-flag override has not been submitted. Return to the form or explicitly discard it.",
    operationDetail:
      "Wait for the feature-flag mutation to finish before leaving Moosewave.",
  });

  // Admin-only surface — the API enforces the same gate (403).
  if (!canAdmin) return null;

  const onUpsert = async (): Promise<void> => {
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    const keyErr = validateFlagKey(draftKey);
    if (keyErr) {
      setFormErr(keyErr);
      return;
    }
    setBusy(true);
    setFormErr(null);
    const request = operation.run(async (): Promise<void> => {
      try {
        const res = await featureFlagsApi.upsert({
          key: draftKey.trim(),
          value: draftValue,
          note: draftNote.trim() || undefined,
        });
        if (!activeRef.current) return;
        if (res.error) {
          setFormErr(res.error.message);
          return;
        }
        toast.success(`Flag "${res.data?.key ?? draftKey.trim()}" saved`);
        discardDraft();
        await load();
      } catch (saveError) {
        if (activeRef.current) {
          setFormErr(
            lifecycleOperationError(
              saveError,
              "The feature-flag override couldn't be saved.",
            ),
          );
        }
      } finally {
        if (activeRef.current) setBusy(false);
      }
    });
    if (request) await request;
  };

  const onDelete = async (key: string): Promise<void> => {
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    setBusy(true);
    const request = operation.run(async (): Promise<void> => {
      try {
        const res = await featureFlagsApi.remove(key);
        if (!activeRef.current) return;
        if (res.error) {
          toast.error({
            message: "Couldn't remove override",
            detail: res.error.message,
          });
          return;
        }
        toast.success(`Override for "${key}" removed`);
        setPendingDelete(null);
        await load();
      } catch (deleteError) {
        if (activeRef.current) {
          toast.error({
            message: "Couldn't remove override",
            detail: lifecycleOperationError(
              deleteError,
              "The feature-flag removal request failed.",
            ),
          });
        }
      } finally {
        if (activeRef.current) setBusy(false);
      }
    });
    if (request) await request;
  };

  const onResolve = async (): Promise<void> => {
    const k = resolveKey.trim();
    if (!k) return;
    if (resolveRef.current) {
      await resolveRef.current;
      return;
    }
    setResolving(true);
    setResolveErr(null);
    setResolved(null);
    const request = (async (): Promise<void> => {
      try {
        const res = await featureFlagsApi.resolve(k);
        if (!activeRef.current) return;
        if (res.error) {
          setResolveErr(res.error.message);
          return;
        }
        setResolved(res.data ?? null);
      } catch (resolveError) {
        if (activeRef.current) {
          setResolveErr(
            lifecycleOperationError(
              resolveError,
              "The flag couldn't be resolved.",
            ),
          );
        }
      } finally {
        resolveRef.current = null;
        if (activeRef.current) setResolving(false);
      }
    })();
    resolveRef.current = request;
    await request;
  };

  return (
    <>
      <FeatureFlagsPresentation
        showForm={showForm}
        onToggleForm={() => {
          if (showForm) requestFormClose();
          else setShowForm(true);
        }}
        mutationActive={operation.active}
        draftKey={draftKey}
        draftValue={draftValue}
        draftNote={draftNote}
        onDraftKey={setDraftKey}
        onDraftValue={setDraftValue}
        onDraftNote={setDraftNote}
        formError={formErr}
        saving={busy}
        onUpsert={onUpsert}
        error={err}
        loading={loading}
        flags={flags}
        onReload={load}
        onDelete={setPendingDelete}
        resolveKey={resolveKey}
        onResolveKey={setResolveKey}
        resolving={resolving}
        resolveError={resolveErr}
        resolved={resolved}
        onResolve={onResolve}
      />
      <ConfirmModal
        open={pendingDelete !== null}
        title="Remove tenant override?"
        description={
          pendingDelete
            ? `"${pendingDelete}" falls back to its platform default (or to missing if no default exists). The default row is untouched.`
            : undefined
        }
        confirmLabel="Remove override"
        danger
        busy={operation.active}
        onClose={() => {
          if (!operation.active) setPendingDelete(null);
        }}
        onConfirm={async () => {
          if (!pendingDelete) return;
          await onDelete(pendingDelete);
        }}
      />
      <ConfirmModal
        open={discardConfirmOpen}
        title="Discard feature-flag draft?"
        description="The key, value, and note have not been saved."
        confirmLabel="Discard draft"
        danger
        busy={operation.active}
        onConfirm={discardDraft}
        onClose={() => {
          if (!operation.active) setDiscardConfirmOpen(false);
        }}
      />
    </>
  );
}

function FeatureFlagsPresentation({
  showForm,
  onToggleForm,
  mutationActive,
  draftKey,
  draftValue,
  draftNote,
  onDraftKey,
  onDraftValue,
  onDraftNote,
  formError,
  saving,
  onUpsert,
  error,
  loading,
  flags,
  onReload,
  onDelete,
  resolveKey,
  onResolveKey,
  resolving,
  resolveError,
  resolved,
  onResolve,
}: {
  showForm: boolean;
  onToggleForm: () => void;
  mutationActive: boolean;
  draftKey: string;
  draftValue: string;
  draftNote: string;
  onDraftKey: (value: string) => void;
  onDraftValue: (value: string) => void;
  onDraftNote: (value: string) => void;
  formError: string | null;
  saving: boolean;
  onUpsert: () => Promise<void>;
  error: string | null;
  loading: boolean;
  flags: FeatureFlag[] | null;
  onReload: () => Promise<void>;
  onDelete: (key: string) => void;
  resolveKey: string;
  onResolveKey: (value: string) => void;
  resolving: boolean;
  resolveError: string | null;
  resolved: { key: string; value: string; source: string } | null;
  onResolve: () => Promise<void>;
}): ReactElement {
  return (
    <div className="settings-section">
      <SettingsSectionHeader
        title="Feature flags"
        description="Tenant overrides and platform defaults. Deleting an override falls back to the platform default."
        meta={
          <button
            type="button"
            className="btn btn-sm"
            onClick={onToggleForm}
            disabled={mutationActive}
          >
            {showForm ? "Cancel" : "+ Set flag"}
          </button>
        }
      />
      <div className="settings-section-body">
        {showForm ? (
          <div className="card" style={{ padding: 12, marginBottom: 12 }}>
            <FlagDraftField
              id="ff-key"
              label="Key"
              value={draftKey}
              onChange={onDraftKey}
              placeholder="e.g. new_composer"
              mono
              disabled={mutationActive}
            />
            <FlagDraftField
              id="ff-value"
              label="Value"
              value={draftValue}
              onChange={onDraftValue}
              placeholder='e.g. "on", "off", "42"'
              mono
              disabled={mutationActive}
            />
            <FlagDraftField
              id="ff-note"
              label="Note (optional)"
              value={draftNote}
              onChange={onDraftNote}
              placeholder="Why this override exists"
              disabled={mutationActive}
            />
            {formError ? (
              <div className="field-error" role="alert">
                {formError}
              </div>
            ) : null}
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => void onUpsert()}
                disabled={mutationActive || !draftKey.trim()}
              >
                {saving ? "Saving…" : "Save flag"}
              </button>
            </div>
          </div>
        ) : null}
        <FeatureFlagRows
          error={error}
          loading={loading}
          flags={flags}
          mutationActive={mutationActive}
          onReload={onReload}
          onDelete={onDelete}
        />
        <FeatureFlagResolve
          resolveKey={resolveKey}
          onResolveKey={onResolveKey}
          resolving={resolving}
          error={resolveError}
          resolved={resolved}
          onResolve={onResolve}
        />
      </div>
    </div>
  );
}

function FlagDraftField({
  id,
  label,
  value,
  onChange,
  placeholder,
  disabled,
  mono = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled: boolean;
  mono?: boolean;
}): ReactElement {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={mono ? "input mono" : "input"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
    </div>
  );
}

function FeatureFlagRows({
  error,
  loading,
  flags,
  mutationActive,
  onReload,
  onDelete,
}: {
  error: string | null;
  loading: boolean;
  flags: FeatureFlag[] | null;
  mutationActive: boolean;
  onReload: () => Promise<void>;
  onDelete: (key: string) => void;
}): ReactElement {
  if (error) {
    return (
      <div className="notice">
        <span>Couldn&apos;t load flags: {error}</span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => void onReload()}
          disabled={loading}
        >
          Retry
        </button>
      </div>
    );
  }
  if (loading) {
    return (
      <>
        <div className="skel-row" />
        <div className="skel-row" />
      </>
    );
  }
  if ((flags ?? []).length === 0) {
    return (
      <div className="muted" style={{ fontSize: 12 }}>
        No flags defined — neither tenant overrides nor platform defaults.
      </div>
    );
  }
  return (
    <div>
      {(flags ?? []).map((flag) => (
        <div
          key={`${flag.is_default ? "default" : "tenant"}:${flag.key}`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "8px 0",
            borderBottom: "1px solid var(--pw-border-soft)",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13 }}>
              <span className="mono">{flag.key}</span>
              <span className="muted"> = </span>
              <span className="mono">{flag.value}</span>
            </div>
            <div className="muted" style={{ fontSize: 11 }}>
              {flagSourceLabel(flag)}
              {flag.note ? ` · ${flag.note}` : ""}
            </div>
          </div>
          <span className={`badge${flag.is_default ? "" : " success"}`}>
            {flag.is_default ? "default" : "override"}
          </span>
          {!flag.is_default ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => onDelete(flag.key)}
              disabled={mutationActive}
            >
              Remove override
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function FeatureFlagResolve({
  resolveKey,
  onResolveKey,
  resolving,
  error,
  resolved,
  onResolve,
}: {
  resolveKey: string;
  onResolveKey: (value: string) => void;
  resolving: boolean;
  error: string | null;
  resolved: { key: string; value: string; source: string } | null;
  onResolve: () => Promise<void>;
}): ReactElement {
  return (
    <div
      className="settings-row"
      style={{ marginTop: 12, alignItems: "flex-start" }}
    >
      <div>
        <div>Resolve preview</div>
        <div className="muted" style={{ fontSize: 12 }}>
          Check what a flag key resolves to for this workspace.
        </div>
      </div>
      <div style={{ minWidth: 280 }}>
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input mono"
            value={resolveKey}
            onChange={(event) => onResolveKey(event.target.value)}
            placeholder="flag key"
            aria-label="Flag key to resolve"
            onKeyDown={(event) => {
              if (event.key === "Enter") void onResolve();
            }}
          />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void onResolve()}
            disabled={resolving || !resolveKey.trim()}
          >
            {resolving ? "Resolving…" : "Resolve"}
          </button>
        </div>
        {error ? (
          <div className="field-error" role="alert" style={{ marginTop: 6 }}>
            {error}
          </div>
        ) : null}
        {resolved ? (
          <div
            className="muted"
            style={{ fontSize: 12, marginTop: 6, textAlign: "right" }}
          >
            <span className={`badge ${resolveSourceTone(resolved.source)}`}>
              {resolved.source}
            </span>{" "}
            {resolveSourceCopy(resolved)}
          </div>
        ) : null}
      </div>
    </div>
  );
}
