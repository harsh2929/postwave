import { type ReactElement, useEffect, useRef, useState } from "react";

import { type TagGroup, api } from "../../lib/api-client";
import { redact } from "../../lib/auth";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";
import { tagColorPresentation } from "./tagColorPresentation";
import {
  TAG_NAME_MAX_RUNES,
  limitRunes,
  runeLength,
} from "./tagWriteConstraints";

interface Props {
  open: boolean;
  groups: TagGroup[];
  onClose: () => void;
  /** Fired after any successful mutation so the parent reloads groups + tags. */
  onChanged: () => void;
}

export function TagGroupManageModal({
  open,
  groups,
  onClose,
  onChanged,
}: Props): ReactElement {
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [renameDraft, setRenameDraft] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TagGroup | null>(null);
  const operationRef = useRef(false);

  useEffect(() => {
    if (open) return;
    setNewName("");
    setRenameDraft({});
    setDeleteTarget(null);
  }, [open]);

  const create = async (): Promise<void> => {
    const name = newName.trim();
    if (!name || operationRef.current) return;
    if (runeLength(name) > TAG_NAME_MAX_RUNES) {
      toast.error("Group name must be 64 characters or fewer.");
      return;
    }
    operationRef.current = true;
    setCreating(true);
    try {
      const res = await api.createTagGroup({ name });
      if (res.error) {
        toast.error(`Couldn't create group: ${redact(res.error.message)}`);
        return;
      }
      setNewName("");
      toast.success(`Group "${name}" created`);
      onChanged();
    } catch {
      toast.error("Couldn't create the group. Try again.");
    } finally {
      operationRef.current = false;
      setCreating(false);
    }
  };

  const rename = async (g: TagGroup): Promise<void> => {
    if (operationRef.current) return;
    const next = (renameDraft[g.id] ?? g.name).trim();
    if (!next || next === g.name) {
      setRenameDraft((prev) => {
        const copy = { ...prev };
        delete copy[g.id];
        return copy;
      });
      return;
    }
    if (runeLength(next) > TAG_NAME_MAX_RUNES) {
      toast.error("Group name must be 64 characters or fewer.");
      return;
    }
    operationRef.current = true;
    setBusyId(g.id);
    try {
      const res = await api.updateTagGroup(g.id, { name: next });
      if (res.error) {
        toast.error(`Couldn't rename group: ${redact(res.error.message)}`);
        return;
      }
      setRenameDraft((prev) => {
        const copy = { ...prev };
        delete copy[g.id];
        return copy;
      });
      toast.success(`Renamed to "${next}"`);
      onChanged();
    } catch {
      toast.error("Couldn't rename the group. Try again.");
    } finally {
      operationRef.current = false;
      setBusyId(null);
    }
  };

  const doDelete = async (g: TagGroup): Promise<void> => {
    if (operationRef.current) return;
    operationRef.current = true;
    setBusyId(g.id);
    try {
      const res = await api.deleteTagGroup(g.id);
      if (res.error) {
        toast.error(`Couldn't delete group: ${redact(res.error.message)}`);
        return;
      }
      setDeleteTarget(null);
      toast.success(`Group "${g.name}" deleted`);
      onChanged();
    } catch {
      toast.error("Couldn't delete the group. Try again.");
    } finally {
      operationRef.current = false;
      setBusyId(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!creating && !busyId) onClose();
      }}
      closeOnBackdrop={!creating && !busyId}
      closeOnEscape={!creating && !busyId}
      closeDisabled={creating || busyId !== null}
      title="Manage tag groups"
      description="Groups organise your tag catalogue. Tags in a deleted group fall back to “No group” — they are never removed."
    >
      <div className="field">
        <label className="field-label" htmlFor="tag-group-new">
          New group
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            id="tag-group-new"
            className="input"
            placeholder="e.g. Lifecycle"
            value={newName}
            onChange={(e) =>
              setNewName(limitRunes(e.target.value, TAG_NAME_MAX_RUNES))
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void create();
              }
            }}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void create()}
            disabled={creating || !newName.trim()}
          >
            {creating ? "Adding…" : "Add"}
          </button>
        </div>
      </div>

      <div className="field">
        <div className="field-label">Existing groups</div>
        {groups.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>
            No groups yet. Create one above, then assign tags to it from the
            tag’s edit dialog.
          </div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {groups.map((g) => {
              const editing = renameDraft[g.id] !== undefined;
              const busy = busyId === g.id;
              const color = tagColorPresentation(g.color);
              return (
                <li
                  key={g.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 0",
                    borderBottom: "1px solid var(--pw-border)",
                  }}
                >
                  {g.color ? (
                    <span
                      aria-hidden="true"
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: "50%",
                        background: color.background,
                        flexShrink: 0,
                      }}
                    />
                  ) : null}
                  {color.legacy ? (
                    <span
                      className="tags-row-badge tags-row-badge-legacy"
                      title={`Stored colour ${JSON.stringify(g.color)} is unsupported and shown as neutral slate.`}
                    >
                      Legacy colour
                    </span>
                  ) : null}
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    aria-label={`Group name for ${g.name}`}
                    value={editing ? renameDraft[g.id] : g.name}
                    onChange={(e) =>
                      setRenameDraft((prev) => ({
                        ...prev,
                        [g.id]: limitRunes(e.target.value, TAG_NAME_MAX_RUNES),
                      }))
                    }
                    disabled={busy}
                  />
                  {editing ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={() => void rename(g)}
                      disabled={busy}
                    >
                      {busy ? "Saving…" : "Save"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => setDeleteTarget(g)}
                    disabled={busy}
                    aria-label={`Delete group ${g.name}`}
                  >
                    Delete
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {deleteTarget ? (
        <div
          className="notice"
          role="alertdialog"
          aria-label="Confirm delete group"
          style={{ marginTop: 8 }}
        >
          <div style={{ marginBottom: 8 }}>
            Delete group <strong>{deleteTarget.name}</strong>? Its tags will
            move to “No group” — none are deleted.
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setDeleteTarget(null)}
              disabled={busyId === deleteTarget.id}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => void doDelete(deleteTarget)}
              disabled={busyId === deleteTarget.id}
            >
              {busyId === deleteTarget.id ? "Deleting…" : "Delete group"}
            </button>
          </div>
        </div>
      ) : null}

      <ModalFooter>
        <button
          type="button"
          className="btn"
          onClick={onClose}
          disabled={creating || busyId !== null}
        >
          Done
        </button>
      </ModalFooter>
    </Modal>
  );
}
