import type { ReactElement } from "react";

import {
  FieldError,
  FormField,
  type FormErrors,
} from "../../components/FormField";
import { Modal, ModalFooter } from "../../components/Modal";
import type { DraftLifecycleController } from "../../hooks/useDraftLifecycleController";
import type { TagGroup, TagSuggestion } from "../../lib/api-client";
import type { TagDraft } from "./tagPageModel";
import { limitRunes, runeLength } from "./tagPageModel";
import { TagPaletteField } from "./TagPaletteField";

interface TagCreateModalProps {
  open: boolean;
  draft: TagDraft;
  groups: TagGroup[];
  suggestions: TagSuggestion[];
  suggestionError: string | null;
  dedupHint: TagSuggestion | null;
  formErrors: FormErrors;
  submitError: string | null;
  lifecycle: DraftLifecycleController;
  onChange: (draft: TagDraft) => void;
}

export function TagCreateModal({
  open,
  draft,
  groups,
  suggestions,
  suggestionError,
  dedupHint,
  formErrors,
  submitError,
  lifecycle,
  onChange,
}: TagCreateModalProps): ReactElement {
  return (
    <Modal
      open={open}
      onClose={lifecycle.requestClose}
      closeOnBackdrop={!lifecycle.active}
      closeOnEscape={!lifecycle.active}
      closeDisabled={lifecycle.active}
      title="New tag"
      description="Tags label subscribers so you can segment campaigns."
    >
      <FormField
        label="Name"
        required
        htmlFor="tag-new-name"
        error={formErrors.get("name")}
      >
        <input
          id="tag-new-name"
          className="input"
          placeholder="vip"
          value={draft.name}
          onChange={(event) =>
            onChange({ ...draft, name: limitRunes(event.target.value, 64) })
          }
          autoComplete="off"
          spellCheck={false}
        />
        {dedupHint ? (
          <div className="notice" style={{ marginTop: 6, fontSize: 12 }}>
            <strong>{dedupHint.tag}</strong>{" "}
            {dedupHint.registered
              ? "already exists in your catalogue."
              : `is already applied to ${dedupHint.subscribers.toLocaleString()} subscribers but is not registered yet.`}
          </div>
        ) : suggestions.length > 0 ? (
          <div className="muted" style={{ marginTop: 4, fontSize: 11 }}>
            Did you mean:{" "}
            {suggestions.slice(0, 4).map((suggestion, index) => (
              <span key={suggestion.tag}>
                {index > 0 ? ", " : ""}
                <button
                  type="button"
                  className="link"
                  onClick={() => onChange({ ...draft, name: suggestion.tag })}
                >
                  {suggestion.tag}
                </button>
              </span>
            ))}
            ?
          </div>
        ) : suggestionError ? (
          <div
            className="field-help"
            role="status"
            aria-live="polite"
            style={{ color: "var(--pw-warning)" }}
          >
            {suggestionError}
          </div>
        ) : null}
      </FormField>
      <TagPaletteField
        id="tag-new-color"
        value={draft.color}
        onChange={(color) => onChange({ ...draft, color })}
      />
      {groups.length > 0 ? (
        <FormField label="Group" htmlFor="tag-new-group">
          <select
            id="tag-new-group"
            className="input"
            value={draft.groupId}
            onChange={(event) =>
              onChange({ ...draft, groupId: event.target.value })
            }
          >
            <option value="">No group</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </FormField>
      ) : null}
      <FormField label="Description" htmlFor="tag-new-desc">
        <textarea
          id="tag-new-desc"
          className="input"
          rows={3}
          value={draft.description}
          onChange={(event) =>
            onChange({
              ...draft,
              description: limitRunes(event.target.value, 1_024),
            })
          }
          placeholder="What does this tag mean? Who should get it?"
        />
        <div className="field-help">
          {runeLength(draft.description)} / 1,024 characters.
        </div>
      </FormField>
      {formErrors.get("_form") ? (
        <FieldError>{formErrors.get("_form")}</FieldError>
      ) : submitError ? (
        <div className="field-error">{submitError}</div>
      ) : null}
      <ModalFooter>
        <button
          type="button"
          className="btn"
          onClick={lifecycle.requestClose}
          disabled={lifecycle.active}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void lifecycle.submit()}
          disabled={lifecycle.active}
        >
          {lifecycle.active ? "Creating…" : "Create tag"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

interface TagEditModalProps {
  open: boolean;
  draft: TagDraft;
  groups: TagGroup[];
  error: string | null;
  lifecycle: DraftLifecycleController;
  onChange: (draft: TagDraft) => void;
}

export function TagEditModal({
  open,
  draft,
  groups,
  error,
  lifecycle,
  onChange,
}: TagEditModalProps): ReactElement {
  return (
    <Modal
      open={open}
      onClose={lifecycle.requestClose}
      closeOnBackdrop={!lifecycle.active}
      closeOnEscape={!lifecycle.active}
      closeDisabled={lifecycle.active}
      title="Edit tag"
      description="Update the name, colour, description, or group in one version-checked save."
    >
      <FormField label="Name" required htmlFor="tag-edit-name">
        <input
          id="tag-edit-name"
          className="input"
          value={draft.name}
          onChange={(event) =>
            onChange({ ...draft, name: limitRunes(event.target.value, 64) })
          }
          autoComplete="off"
          spellCheck={false}
        />
      </FormField>
      <TagPaletteField
        id="tag-edit-color"
        value={draft.color}
        onChange={(color) => onChange({ ...draft, color })}
      />
      {groups.length > 0 ? (
        <FormField label="Group" htmlFor="tag-edit-group">
          <select
            id="tag-edit-group"
            className="input"
            value={draft.groupId}
            onChange={(event) =>
              onChange({ ...draft, groupId: event.target.value })
            }
          >
            <option value="">No group</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </FormField>
      ) : null}
      <FormField label="Description" htmlFor="tag-edit-desc">
        <textarea
          id="tag-edit-desc"
          className="input"
          rows={3}
          value={draft.description}
          onChange={(event) =>
            onChange({
              ...draft,
              description: limitRunes(event.target.value, 1_024),
            })
          }
          placeholder="What does this tag mean? Who should get it?"
        />
        <div className="field-help">
          {runeLength(draft.description)} / 1,024 characters.
        </div>
      </FormField>
      {error ? <div className="field-error">{error}</div> : null}
      <ModalFooter>
        <button
          type="button"
          className="btn"
          onClick={lifecycle.requestClose}
          disabled={lifecycle.active}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void lifecycle.submit()}
          disabled={lifecycle.active}
        >
          {lifecycle.active ? "Saving…" : "Save changes"}
        </button>
      </ModalFooter>
    </Modal>
  );
}
