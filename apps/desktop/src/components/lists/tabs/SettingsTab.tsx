/**
 * SettingsTab — rename + visibility/opt-in + tags + description for one list.
 *
 * Wires to the NEW PATCH endpoint exposed via `listsExtendedApi.patch`
 * (POST /api/v1/lists/{id}) rather than the legacy Listmonk-direct
 * `api.updateList` path so the gateway can enforce its whitelist of
 * editable fields.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  type List,
  type ListsUpdateInput,
  listsExtendedApi,
} from "../../../lib/api-client";
import { useCanWrite } from "../../../lib/store";
import { FormField } from "../../FormField";
import { InlineHelp } from "../../InlineHelp";
import { toast } from "../../Toast";
import { usePersistentLifecycleOperation } from "../../../hooks/usePersistentLifecycleOperation";
import {
  lifecycleOperationError,
  useExistingSettingLifecycle,
} from "../../../hooks/useSettingsDraftLifecycle";

interface Props {
  list: List;
  /** Bubble updates so the parent slideover can refresh its header. */
  onUpdated: (next: List) => void;
  /** Parent-local close/tab guard; this is not another registry owner. */
  onDraftStateChange?: (state: {
    dirty: boolean;
    operationActive: boolean;
  }) => void;
}

interface Draft {
  name: string;
  type: "public" | "private";
  optin: "single" | "double";
  description: string;
  tags: string;
}

function draftFrom(list: List): Draft {
  return {
    name: list.name ?? "",
    type:
      (list.type ?? "private").toLowerCase() === "public"
        ? "public"
        : "private",
    optin:
      (list.optin ?? "single").toLowerCase() === "double" ? "double" : "single",
    description: list.description ?? "",
    tags: Array.isArray(list.tags) ? list.tags.join(", ") : "",
  };
}

function draftsEqual(left: Draft, right: Draft): boolean {
  return (
    left.name === right.name &&
    left.type === right.type &&
    left.optin === right.optin &&
    left.description === right.description &&
    left.tags === right.tags
  );
}

interface ListSettingsFieldsProps {
  canMutate: boolean;
  draft: Draft;
  operationActive: boolean;
  permissionReasonId: string;
  setDraft: (draft: Draft) => void;
}

function ListSettingsFields({
  canMutate,
  draft,
  operationActive,
  permissionReasonId,
  setDraft,
}: ListSettingsFieldsProps): ReactElement {
  const protectReadOnlySelect = (event: React.KeyboardEvent): void => {
    if (!canMutate && event.key !== "Tab") event.preventDefault();
  };
  return (
    <>
      <FormField label="Name" required htmlFor="list-settings-name">
        <input
          id="list-settings-name"
          className="input"
          value={draft.name}
          readOnly={!canMutate}
          aria-describedby={!canMutate ? permissionReasonId : undefined}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          disabled={operationActive}
        />
      </FormField>
      <div className="row" style={{ gap: 8 }}>
        <div style={{ flex: 1 }}>
          <FormField
            label="Visibility"
            htmlFor="list-settings-type"
            helpTooltip="Private lists are admin-managed and invisible to subscribers. Public lists appear on hosted preference pages so people can subscribe themselves."
          >
            <select
              id="list-settings-type"
              className="input"
              value={draft.type}
              aria-disabled={!canMutate || undefined}
              aria-describedby={!canMutate ? permissionReasonId : undefined}
              onPointerDown={(event) => {
                if (!canMutate) event.preventDefault();
              }}
              onKeyDown={protectReadOnlySelect}
              onChange={(event) => {
                if (!canMutate) return;
                setDraft({
                  ...draft,
                  type: event.target.value as "public" | "private",
                });
              }}
              disabled={operationActive}
            >
              <option value="private">Private</option>
              <option value="public">Public</option>
            </select>
          </FormField>
        </div>
        <div style={{ flex: 1 }}>
          <FormField
            label="Opt-in"
            htmlFor="list-settings-optin"
            helpTooltip="Single accepts subscribers immediately. Double sends a confirmation email first — better deliverability and required by GDPR / CASL."
          >
            <select
              id="list-settings-optin"
              className="input"
              value={draft.optin}
              aria-disabled={!canMutate || undefined}
              aria-describedby={!canMutate ? permissionReasonId : undefined}
              onPointerDown={(event) => {
                if (!canMutate) event.preventDefault();
              }}
              onKeyDown={protectReadOnlySelect}
              onChange={(event) => {
                if (!canMutate) return;
                setDraft({
                  ...draft,
                  optin: event.target.value as "single" | "double",
                });
              }}
              disabled={operationActive}
            >
              <option value="single">Single</option>
              <option value="double">Double</option>
            </select>
          </FormField>
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="list-settings-tags">
          Tags
          <InlineHelp text="Comma-separated labels used to organize lists in the dashboard. Distinct from subscriber tags." />
        </label>
        <input
          id="list-settings-tags"
          className="input"
          placeholder="vip, newsletter, …"
          value={draft.tags}
          readOnly={!canMutate}
          aria-describedby={!canMutate ? permissionReasonId : undefined}
          onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
          disabled={operationActive}
        />
      </div>
      <FormField label="Description" htmlFor="list-settings-desc">
        <input
          id="list-settings-desc"
          className="input"
          value={draft.description}
          readOnly={!canMutate}
          aria-describedby={!canMutate ? permissionReasonId : undefined}
          onChange={(event) =>
            setDraft({ ...draft, description: event.target.value })
          }
          disabled={operationActive}
        />
      </FormField>
    </>
  );
}

export function SettingsTab({
  list,
  onUpdated,
  onDraftStateChange,
}: Props): ReactElement {
  const mountedRef = useRef(true);
  const permissionReasonId = useId();
  const actionReasonId = useId();
  const listIdRef = useRef(String(list.id));
  const baselineRef = useRef<Draft>(draftFrom(list));
  const canMutate = useCanWrite();
  const [baseline, setBaseline] = useState<Draft>(baselineRef.current);
  const [draft, setDraft] = useState<Draft>(baselineRef.current);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const operation = usePersistentLifecycleOperation({
    ownerId: `list-settings-${String(list.id)}`,
    label: "List settings update",
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset when the parent flips to a different list.
  useEffect(() => {
    const next = draftFrom(list);
    const previous = baselineRef.current;
    const listChanged = listIdRef.current !== String(list.id);
    listIdRef.current = String(list.id);
    baselineRef.current = next;
    setBaseline(next);
    setDraft((current) =>
      listChanged || draftsEqual(current, previous) ? next : current,
    );
    setErr(null);
  }, [list]);

  const dirty = !draftsEqual(draft, baseline);
  const actionUnavailableReason = !canMutate
    ? "Viewer access is read-only; an editor or admin can change list settings."
    : operation.active
      ? "Wait for the list update to finish."
      : !dirty
        ? "There are no unsaved list-setting changes."
        : null;

  const discardDraft = useCallback((): void => {
    setDraft(baselineRef.current);
    setErr(null);
  }, []);

  const submit = async (): Promise<boolean> => {
    if (!canMutate) {
      setErr("An editor-scoped session is required to save list settings.");
      return false;
    }
    const name = draft.name.trim();
    if (!name) {
      setErr("Name is required.");
      return false;
    }
    const submitted = draft;
    setSaving(true);
    setErr(null);
    const tags = draft.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const patch: ListsUpdateInput = {
      name,
      type: draft.type,
      optin: draft.optin,
      tags,
      description: draft.description.trim(),
    };
    const pending = operation.run(() => listsExtendedApi.patch(list.id, patch));
    if (!pending) {
      setSaving(false);
      return false;
    }
    try {
      const res = await pending;
      if (!mountedRef.current) return true;
      if (res.error) {
        setErr(res.error.message);
        return false;
      }
      const acknowledgedList = {
        ...list,
        ...(res.data ?? {}),
        name,
        type: submitted.type,
        optin: submitted.optin,
        tags,
        description: submitted.description.trim(),
      } as List;
      const acknowledged = draftFrom(acknowledgedList);
      baselineRef.current = acknowledged;
      setBaseline(acknowledged);
      setDraft(acknowledged);
      toast.success(`List "${name}" updated`);
      try {
        onUpdated(acknowledgedList);
      } catch (refreshError) {
        toast.error({
          message: "List saved, but the header couldn't refresh",
          detail: lifecycleOperationError(
            refreshError,
            "Refresh the list detail to see the saved settings.",
          ),
        });
      }
      return true;
    } catch (error) {
      if (mountedRef.current) {
        setErr(
          lifecycleOperationError(error, "The list-settings request failed."),
        );
      }
      return false;
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  useExistingSettingLifecycle({
    ownerId: `list-settings-${String(list.id)}`,
    label: `Settings for ${list.name}`,
    dirty,
    operationRef: operation.promiseRef,
    save: submit,
    discard: discardDraft,
    detail:
      "These list name, visibility, opt-in, tag, or description changes have not been saved.",
  });

  useEffect(() => {
    onDraftStateChange?.({ dirty, operationActive: operation.active });
    return () => {
      onDraftStateChange?.({ dirty: false, operationActive: false });
    };
  }, [dirty, onDraftStateChange, operation.active]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {!canMutate ? (
        <p
          id={permissionReasonId}
          className="muted"
          style={{ fontSize: 11, margin: 0 }}
        >
          Viewer access is read-only; an editor or admin can change list
          settings.
        </p>
      ) : null}
      <ListSettingsFields
        canMutate={canMutate}
        draft={draft}
        operationActive={operation.active}
        permissionReasonId={permissionReasonId}
        setDraft={setDraft}
      />

      {err ? <div className="field-error">{err}</div> : null}
      {actionUnavailableReason ? (
        <p
          id={actionReasonId}
          className="muted"
          style={{ fontSize: 11, margin: 0, textAlign: "right" }}
        >
          {actionUnavailableReason}
        </p>
      ) : null}

      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          borderTop: "1px solid var(--pw-border)",
          paddingTop: 12,
        }}
      >
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (operation.active || !dirty) return;
            discardDraft();
          }}
          aria-disabled={operation.active || !dirty || undefined}
          aria-describedby={
            operation.active || !dirty ? actionReasonId : undefined
          }
        >
          Reset
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            if (actionUnavailableReason) return;
            void submit();
          }}
          aria-disabled={actionUnavailableReason ? true : undefined}
          aria-describedby={
            actionUnavailableReason ? actionReasonId : undefined
          }
        >
          {saving || operation.active ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}
