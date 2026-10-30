/**
 * SavedPayloadsPanel — small sidebar panel storing reusable payloads
 * the operator has named. Backed by the identity-scoped encrypted local
 * vault; the ownership-ambiguous old localStorage key is purged without
 * importing its value.
 *
 * Use case: integrators keep three or four "test fixture" payloads
 * around — a happy-path subscriber.added, a payload that should
 * trigger their fallback branch, etc. Re-typing them every session
 * is a chore.
 *
 * Pure UI: parent controls the active payload string + event_type
 * and decides what to do when an entry is applied (overwrite editor).
 *
 * Encrypted record value schema:
 *   { id, name, event_type, payload }[]
 */

import {
  type FormEvent,
  type ReactElement,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";
import {
  loadSensitiveLocalData,
  saveSensitiveLocalData,
  type SanitizedLocalData,
} from "../../lib/sensitive-local-data";
import { validateWebhookPlaygroundRawJSONObject } from "../../lib/api/webhook-playground-contract";
import { useMe } from "../../lib/store";

interface SavedPayload {
  id: string;
  name: string;
  event_type: string;
  payload: string;
}

const LS_KEY = "postwave.webhook-sim.saved-payloads.v1";
const VAULT_NAMESPACE = "webhook-fixtures";
const MAX_SAVED_PAYLOADS = 50;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_EVENT_TYPE_CHARACTERS = 200;
const MAX_PAYLOAD_LIBRARY_BYTES = 400 * 1024;
const savedPayloadEncoder = new TextEncoder();
const STRONG_IDENTITY_SCOPE_RE = /^[a-f0-9]{64}$/u;

function savedPayloadBytes(value: string): number {
  return savedPayloadEncoder.encode(value).byteLength;
}

export function sanitizeSavedPayloads(
  candidate: unknown,
): SanitizedLocalData<SavedPayload[]> | null {
  if (!Array.isArray(candidate)) return null;
  const valid: SavedPayload[] = [];
  const ids = new Set<string>();
  let altered = false;
  for (const raw of candidate.slice(-MAX_SAVED_PAYLOADS * 2)) {
    if (!raw || typeof raw !== "object") {
      altered = true;
      continue;
    }
    const value = raw as Partial<SavedPayload>;
    if (
      typeof value.id !== "string" ||
      !value.id.trim() ||
      value.id.length > 200 ||
      ids.has(value.id) ||
      typeof value.name !== "string" ||
      !value.name.trim() ||
      value.name.length > 120 ||
      typeof value.event_type !== "string" ||
      !value.event_type.trim() ||
      value.event_type.length > MAX_EVENT_TYPE_CHARACTERS ||
      typeof value.payload !== "string" ||
      savedPayloadBytes(value.payload) > MAX_PAYLOAD_BYTES
    ) {
      altered = true;
      continue;
    }
    try {
      if (
        validateWebhookPlaygroundRawJSONObject(
          value.payload,
          "saved webhook payload",
        ).rawJSON !== value.payload
      ) {
        altered = true;
        continue;
      }
    } catch {
      altered = true;
      continue;
    }
    ids.add(value.id);
    valid.push({
      id: value.id,
      name: value.name,
      event_type: value.event_type,
      payload: value.payload,
    });
  }
  const bounded = valid.slice(-MAX_SAVED_PAYLOADS);
  altered ||= bounded.length !== candidate.length;
  while (
    bounded.length > 0 &&
    new TextEncoder().encode(JSON.stringify(bounded)).byteLength >
      MAX_PAYLOAD_LIBRARY_BYTES
  ) {
    bounded.shift();
    altered = true;
  }
  return { value: bounded, altered };
}

type SaveCandidateResult =
  | { candidate: { payload: string; eventType: string }; name: string }
  | { candidate: null; error: string; invalidJson: boolean };

function prepareSaveCandidate(
  currentPayload: string,
  currentEventType: string,
): SaveCandidateResult {
  const payload = currentPayload;
  if (!payload.trim()) {
    return {
      candidate: null,
      error: "Enter a JSON payload in the editor before saving.",
      invalidJson: false,
    };
  }
  if (savedPayloadBytes(payload) > MAX_PAYLOAD_BYTES) {
    return {
      candidate: null,
      error:
        "This payload is too large for the local fixture library. Keep saved fixtures at or below 262,144 UTF-8 bytes.",
      invalidJson: false,
    };
  }
  const eventType = currentEventType.trim();
  if (!eventType || eventType.length > MAX_EVENT_TYPE_CHARACTERS) {
    return {
      candidate: null,
      error: "Select a valid event type before saving this payload fixture.",
      invalidJson: false,
    };
  }
  try {
    validateWebhookPlaygroundRawJSONObject(payload, "saved webhook payload");
  } catch {
    return {
      candidate: null,
      error: "The current payload must be a valid JSON object before saving.",
      invalidJson: true,
    };
  }
  const name = `${eventType} · ${new Date().toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`.slice(0, 120);
  return { candidate: { payload, eventType }, name };
}

interface Props {
  currentPayload: string;
  currentEventType: string;
  onApply: (payload: string, eventType: string) => void;
  disabled?: boolean;
}

function SavedPayloadList({
  items,
  disabled,
  onApply,
  onDelete,
}: {
  items: SavedPayload[];
  disabled: boolean;
  onApply: (item: SavedPayload) => void;
  onDelete: (item: SavedPayload) => void;
}): ReactElement {
  if (items.length === 0) {
    return (
      <div className="muted" style={{ fontSize: 11, lineHeight: 1.5 }}>
        No payloads are saved on this device yet.
      </div>
    );
  }
  return (
    <ul
      aria-label="Saved webhook payloads"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        maxHeight: 320,
        overflowY: "auto",
        listStyle: "none",
        margin: 0,
        padding: 0,
      }}
    >
      {items.map((item) => (
        <li
          key={item.id}
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) auto",
            gap: 4,
            alignItems: "center",
            padding: "6px 8px",
            background: "var(--pw-bg-elev-2)",
            borderRadius: 4,
          }}
        >
          <button
            type="button"
            onClick={() => onApply(item)}
            disabled={disabled}
            aria-label={`Apply ${item.name}, ${item.event_type}`}
            style={{
              textAlign: "left",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: "var(--pw-fg)",
              padding: "4px 0",
              fontSize: 12,
              minHeight: 44,
              minWidth: 0,
            }}
          >
            <div style={{ overflowWrap: "anywhere", lineHeight: 1.4 }}>
              {item.name}
            </div>
            <div
              className="muted"
              style={{
                fontSize: 10,
                fontFamily:
                  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              }}
            >
              {item.event_type}
            </div>
          </button>
          <button
            type="button"
            onClick={() => onDelete(item)}
            disabled={disabled}
            aria-label={`Delete ${item.name}`}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--pw-fg-subtle)",
              cursor: "pointer",
              fontSize: 12,
              padding: 6,
              minWidth: 44,
              minHeight: 44,
            }}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

function SavePayloadModal({
  open,
  name,
  eventType,
  error,
  saving,
  onNameChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  name: string;
  eventType: string | undefined;
  error: string | null;
  saving: boolean;
  onNameChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}): ReactElement | null {
  const helpId = useId();
  const errorId = useId();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save payload"
      description="Give this payload a name so you can find it again next session."
    >
      <form onSubmit={onSubmit} noValidate>
        <div className="field">
          <label className="field-label" htmlFor="saved-payload-name">
            Name
          </label>
          <input
            id="saved-payload-name"
            type="text"
            className="input"
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229)
              ) {
                event.preventDefault();
              }
            }}
            placeholder="e.g. Happy-path subscriber.added"
            autoComplete="off"
            maxLength={120}
            aria-invalid={error ? "true" : undefined}
            aria-describedby={error ? errorId : helpId}
          />
          {error ? (
            <div id={errorId} className="field-error" role="alert">
              {error}
            </div>
          ) : (
            <div id={helpId} className="field-help">
              Event type ({eventType}) and the current JSON snapshot are
              captured together.
            </div>
          )}
        </div>
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Saving encrypted payload…" : "Save payload"}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function useSavedPayloadStorage() {
  const me = useMe();
  const identityScope =
    typeof me?.webhookPlaygroundRecoveryScope === "string" &&
    STRONG_IDENTITY_SCOPE_RE.test(me.webhookPlaygroundRecoveryScope)
      ? me.webhookPlaygroundRecoveryScope
      : null;
  const scopeToken = identityScope ?? "unresolved";
  const [items, setItems] = useState<SavedPayload[]>([]);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [errorRetryable, setErrorRetryable] = useState(false);
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    setItems([]);
    setBusy(false);
    setLoading(true);
    setError(null);
    setErrorRetryable(false);
    void loadSensitiveLocalData({
      identityScope,
      namespace: VAULT_NAMESPACE,
      fallback: [] as SavedPayload[],
      validate: sanitizeSavedPayloads,
      unownedLegacyKeys: [LS_KEY],
      purgeLegacy16HexScopes: true,
    }).then((loaded) => {
      if (generation !== generationRef.current) return;
      setItems(loaded.value);
      setLoadedScope(scopeToken);
      setLoading(false);
      setError(loaded.warning);
      setErrorRetryable(loaded.retryable);
    });
    return () => {
      if (generation === generationRef.current) generationRef.current += 1;
    };
  }, [identityScope, retry, scopeToken]);

  async function persist(
    candidate: SavedPayload[],
  ): Promise<SavedPayload[] | null> {
    const sanitized = sanitizeSavedPayloads(candidate);
    if (!sanitized || sanitized.altered) {
      setError(
        "This change would exceed the encrypted fixture library's 400 KB total limit. Delete an older or larger payload first.",
      );
      setErrorRetryable(false);
      return null;
    }
    const generation = generationRef.current;
    setBusy(true);
    try {
      const saved = await saveSensitiveLocalData({
        identityScope,
        namespace: VAULT_NAMESPACE,
        validate: sanitizeSavedPayloads,
        value: sanitized.value,
      });
      if (generation !== generationRef.current) return null;
      setItems(saved);
      setError(null);
      setErrorRetryable(false);
      return saved;
    } catch {
      if (generation === generationRef.current) {
        setError(
          "This change couldn't be encrypted on this device. Restore OS keychain access or free local storage, then retry.",
        );
        setErrorRetryable(true);
      }
      return null;
    } finally {
      if (generation === generationRef.current) setBusy(false);
    }
  }

  const ownsRenderedScope = loadedScope === scopeToken;
  return {
    items: ownsRenderedScope ? items : [],
    loading: !ownsRenderedScope || loading,
    busy,
    error: ownsRenderedScope ? error : null,
    errorRetryable: ownsRenderedScope && errorRetryable,
    identityScope,
    generationRef,
    persist,
    retry: () => setRetry((value) => value + 1),
  };
}

function PayloadStorageNotice({
  message,
  retryable,
  busy,
  onRetry,
}: {
  message: string | null;
  retryable: boolean;
  busy: boolean;
  onRetry: () => void;
}): ReactElement | null {
  if (!message) return null;
  return (
    <div
      className={retryable ? "field-error" : "notice"}
      role="alert"
      style={{ margin: 0 }}
    >
      <span>{message}</span>
      {retryable ? (
        <button
          type="button"
          className="btn btn-sm"
          onClick={onRetry}
          disabled={busy}
        >
          Retry encrypted storage
        </button>
      ) : null}
    </div>
  );
}

export function SavedPayloadsPanel({
  currentPayload,
  currentEventType,
  onApply,
  disabled = false,
}: Props): ReactElement {
  const storage = useSavedPayloadStorage();
  const {
    items,
    loading: storageLoading,
    busy: persistenceBusy,
    error: persistenceError,
    errorRetryable: persistenceErrorRetryable,
    identityScope,
    generationRef: storageGenerationRef,
    persist: persistItems,
    retry: retryStorage,
  } = storage;
  const [libraryStatus, setLibraryStatus] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [lastDeleted, setLastDeleted] = useState<{
    item: SavedPayload;
    index: number;
  } | null>(null);
  const headingId = useId();
  const saveReasonId = useId();
  const saveCommitRef = useRef(false);

  // Save modal (replacing the legacy window.prompt that didn't match
  // the rest of the admin shell).
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveCandidate, setSaveCandidate] = useState<{
    payload: string;
    eventType: string;
  } | null>(null);

  // Delete-confirm target (replacing the silent destructive click on
  // the × button, which had no undo).
  const [deleteTarget, setDeleteTarget] = useState<SavedPayload | null>(null);

  useEffect(() => {
    setLastDeleted(null);
    setDeleteTarget(null);
    setSaveOpen(false);
    setSaveCandidate(null);
    saveCommitRef.current = false;
  }, [identityScope]);

  function onSaveClicked(): void {
    if (storageLoading || persistenceBusy || !identityScope) return;
    const prepared = prepareSaveCandidate(currentPayload, currentEventType);
    if (!prepared.candidate) {
      if (prepared.invalidJson) toast.error(prepared.error);
      setLibraryStatus(prepared.error);
      return;
    }
    setSaveName(prepared.name);
    setSaveCandidate(prepared.candidate);
    setSaveErr(null);
    setLibraryStatus(null);
    setSaveOpen(true);
  }

  function commitSave(event?: FormEvent<HTMLFormElement>): void {
    event?.preventDefault();
    if (saveCommitRef.current || !saveCandidate) return;
    const name = saveName.trim();
    if (!name) {
      setSaveErr("Enter a name so you can recognise this payload later.");
      return;
    }
    if (name.length > 120) {
      setSaveErr("Keep the saved payload name to 120 characters or fewer.");
      return;
    }
    if (items.length >= MAX_SAVED_PAYLOADS) {
      setSaveErr(
        `This device already has ${MAX_SAVED_PAYLOADS} saved payloads. Delete one before saving another.`,
      );
      return;
    }
    if (
      items.some(
        (item) => item.name.trim().toLowerCase() === name.toLowerCase(),
      )
    ) {
      setSaveErr("Use a unique name; a saved payload already has this name.");
      return;
    }
    saveCommitRef.current = true;
    const next = [
      ...items,
      {
        id: `p-${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 6)}`,
        name,
        event_type: saveCandidate.eventType,
        payload: saveCandidate.payload,
      },
    ];
    const eventType = saveCandidate.eventType;
    const generation = storageGenerationRef.current;
    void persistItems(next).then((saved) => {
      if (generation !== storageGenerationRef.current) return;
      if (!saved) {
        setSaveErr(
          "This change couldn't be saved on this device. Check the encrypted desktop vault message and retry.",
        );
        saveCommitRef.current = false;
        return;
      }
      setLastDeleted(null);
      setSaveOpen(false);
      setSaveCandidate(null);
      setLibraryStatus(`Saved ${name} for ${eventType}.`);
      toast.success("Payload saved");
      saveCommitRef.current = false;
    });
  }

  function confirmDelete(): void {
    if (!deleteTarget || saveCommitRef.current) return;
    saveCommitRef.current = true;
    const target = deleteTarget;
    const generation = storageGenerationRef.current;
    const index = items.findIndex((item) => item.id === target.id);
    const next = items.filter((item) => item.id !== target.id);
    void persistItems(next).then((saved) => {
      if (generation !== storageGenerationRef.current) return;
      saveCommitRef.current = false;
      if (!saved) {
        setLibraryStatus(
          `Couldn't delete ${target.name}. The encrypted library was left unchanged.`,
        );
        return;
      }
      setLastDeleted({ item: target, index: Math.max(index, 0) });
      setLibraryStatus(
        `Deleted ${target.name}. You can undo this until you leave the page.`,
      );
      toast.success("Payload deleted");
      setDeleteTarget(null);
    });
  }

  function undoDelete(): void {
    if (!lastDeleted || saveCommitRef.current) return;
    saveCommitRef.current = true;
    const deleted = lastDeleted;
    const generation = storageGenerationRef.current;
    const next = [...items];
    next.splice(Math.min(deleted.index, next.length), 0, deleted.item);
    void persistItems(next).then((saved) => {
      if (generation !== storageGenerationRef.current) return;
      saveCommitRef.current = false;
      if (!saved) {
        setLibraryStatus(
          `Couldn't restore ${deleted.item.name}. The encrypted library was left unchanged.`,
        );
        return;
      }
      setLibraryStatus(`Restored ${deleted.item.name}.`);
      setLastDeleted(null);
    });
  }

  function applyPayload(item: SavedPayload): void {
    try {
      onApply(item.payload, item.event_type);
      setApplyError(null);
      setLibraryStatus(
        `Selected ${item.name}. Review the editor or confirm replacement if it had unsaved changes.`,
      );
    } catch {
      setApplyError(
        `Couldn't apply ${item.name}. The editor kept its existing payload; try again.`,
      );
    }
  }

  function closeSave(): void {
    if (saveCommitRef.current) return;
    setSaveOpen(false);
    setSaveCandidate(null);
    setSaveErr(null);
  }

  const saveUnavailable =
    disabled ||
    currentPayload.trim().length === 0 ||
    storageLoading ||
    persistenceBusy ||
    !identityScope;
  const saveUnavailableReason = disabled
    ? "Wait for the current live-fire operation to settle."
    : storageLoading
      ? "Wait for the encrypted fixture library to finish loading."
      : !identityScope
        ? "Wait for the signed-in workspace identity before saving a fixture."
        : persistenceBusy
          ? "Wait for the encrypted fixture change to finish."
          : "Enter a JSON payload in the editor to enable saving.";

  return (
    <section
      className="card"
      aria-labelledby={headingId}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h3
          id={headingId}
          className="section-title"
          style={{ flex: 1, marginBottom: 0 }}
        >
          Saved payloads
        </h3>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onSaveClicked}
          disabled={saveUnavailable}
          aria-describedby={saveUnavailable ? saveReasonId : undefined}
        >
          + Save
        </button>
      </div>

      <p className="muted" style={{ fontSize: 11, lineHeight: 1.5, margin: 0 }}>
        Reuse trusted JSON fixtures on this device. Applying one replaces the
        editor payload and selects its event type when that type is available.
      </p>
      <p className="muted" style={{ fontSize: 11, lineHeight: 1.5, margin: 0 }}>
        Fixtures are encrypted at rest and isolated to this signed-in workspace.
        They are not a secret manager, so remove credentials and unnecessary
        personal data before saving.
      </p>
      {saveUnavailable ? (
        <p id={saveReasonId} className="muted small" style={{ margin: 0 }}>
          {saveUnavailableReason}
        </p>
      ) : null}
      <PayloadStorageNotice
        message={persistenceError}
        retryable={persistenceErrorRetryable}
        busy={persistenceBusy}
        onRetry={retryStorage}
      />
      {!storageLoading && applyError ? (
        <p className="field-error" role="alert" style={{ margin: 0 }}>
          {applyError}
        </p>
      ) : null}
      <div className="sr-only" role="status" aria-live="polite">
        {storageLoading ? null : libraryStatus}
      </div>
      {!storageLoading && lastDeleted ? (
        <button
          type="button"
          className="btn btn-sm"
          onClick={undoDelete}
          disabled={disabled}
        >
          Undo delete of {lastDeleted.item.name}
        </button>
      ) : null}

      {storageLoading ? (
        <div className="muted small" role="status" aria-live="polite">
          Loading encrypted saved payloads…
        </div>
      ) : (
        <SavedPayloadList
          items={items}
          disabled={disabled}
          onApply={applyPayload}
          onDelete={setDeleteTarget}
        />
      )}

      <SavePayloadModal
        open={saveOpen && !storageLoading}
        name={saveName}
        eventType={saveCandidate?.eventType}
        error={saveErr}
        saving={persistenceBusy}
        onNameChange={(value) => {
          setSaveName(value);
          if (saveErr) setSaveErr(null);
        }}
        onClose={closeSave}
        onSubmit={commitSave}
      />

      <ConfirmModal
        open={!!deleteTarget && !storageLoading}
        title="Delete saved payload"
        description={
          deleteTarget
            ? `Remove "${deleteTarget.name}" from this device's saved payload library. You can undo the deletion until you leave this page.`
            : ""
        }
        confirmLabel="Delete"
        danger
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />
    </section>
  );
}
