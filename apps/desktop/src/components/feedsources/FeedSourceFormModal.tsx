/**
 * FeedSourceFormModal — create / edit one RSS feed source (R1,
 * apps/api/internal/feed_ingest).
 *
 * Fields mirror the backend contract exactly:
 *   - name             (required)
 *   - url              (required; http(s) feed URL)
 *   - schedule         (manual | daily | weekly — no monthly)
 *   - subject_template (required; {{title}} / {{name}} / {{count}})
 *   - targeting        (everyone, ONE list, or ONE segment)
 *   - enabled
 *
 * Targeting options load from the live lists/segments APIs when the
 * modal opens (same pattern as audiencesync/AudienceSyncFormModal).
 * Load failures render an honest inline error per picker — the
 * dropdown never silently shows an empty catalog as if the tenant
 * had no lists.
 *
 * Honest copy: polls create DRAFT campaigns only — nothing sends
 * automatically.
 */

import { useEffect, useState, type ReactElement } from "react";

import {
  api,
  feedSourcesApi,
  type FeedSource,
  type List,
} from "../../lib/api-client";
import { segmentsClient, type Segment } from "../segments/segmentsClient";
import { ConfirmModal } from "../ConfirmModal";
import { FieldError, FormField, useFormErrors } from "../FormField";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";
import { useDraftLifecycleController } from "../../hooks/useDraftLifecycleController";
import { lifecycleOperationError } from "../../hooks/useSettingsDraftLifecycle";
import {
  EMPTY_FEED_DRAFT,
  FEED_SCHEDULES,
  SUBJECT_TEMPLATE_HELP,
  draftToInput,
  sourceToDraft,
  unwrapLists,
  validateFeedSourceDraft,
  type FeedSourceDraft,
  type FeedTargetKind,
} from "./feed-sources-helpers";

interface Props {
  open: boolean;
  /** null → create; otherwise edit this source. */
  source: FeedSource | null;
  onClose: () => void;
  /** Fired after a successful create/update so the section reloads. */
  onSaved: () => void;
}

export function FeedSourceFormModal({
  open,
  source,
  onClose,
  onSaved,
}: Props): ReactElement | null {
  const editing = source !== null;

  const [draft, setDraft] = useState<FeedSourceDraft>(EMPTY_FEED_DRAFT);
  const errors = useFormErrors();

  // Targeting catalogs — loaded on open, with honest per-picker errors.
  const [lists, setLists] = useState<List[] | null>(null);
  const [listsErr, setListsErr] = useState<string | null>(null);
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [segmentsErr, setSegmentsErr] = useState<string | null>(null);

  // Re-seed the form whenever the modal opens (create) or the target
  // source changes (edit).
  useEffect(() => {
    if (!open) return;
    errors.clear();
    setDraft(source ? sourceToDraft(source) : EMPTY_FEED_DRAFT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLists(null);
    setListsErr(null);
    setSegments(null);
    setSegmentsErr(null);
    void (async () => {
      const res = await api.listLists();
      if (cancelled) return;
      if (res.error) {
        setListsErr(res.error.message);
        setLists([]);
      } else {
        setLists(unwrapLists(res.data));
      }
    })();
    void (async () => {
      const res = await segmentsClient.list();
      if (cancelled) return;
      if (res.error) {
        // 404 → segments surface not mounted on this server; the picker
        // explains that instead of pretending the tenant has none.
        setSegmentsErr(
          res.error.status === 404
            ? "Segments aren't enabled on this Moosewave server."
            : res.error.message,
        );
        setSegments([]);
      } else {
        setSegments(Array.isArray(res.data) ? res.data : []);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const save = async (): Promise<boolean> => {
    errors.clear();
    const v = validateFeedSourceDraft(draft);
    if (!v.ok) {
      if (v.errors.name) errors.set("name", v.errors.name);
      if (v.errors.url) errors.set("url", v.errors.url);
      if (v.errors.subjectTemplate) {
        errors.set("subjectTemplate", v.errors.subjectTemplate);
      }
      if (v.errors.target) errors.set("target", v.errors.target);
      return false;
    }
    const input = draftToInput(draft);
    const res = source
      ? await feedSourcesApi.update(source.id, input)
      : await feedSourcesApi.create(input);
    if (res.error) {
      // 400 invalid_input carries the server's message verbatim.
      errors.set("_form", res.error.message);
      return false;
    }
    toast.success(editing ? "Feed source updated" : "Feed source created");
    onSaved();
    return true;
  };

  const baseline = source ? sourceToDraft(source) : EMPTY_FEED_DRAFT;
  const lifecycle = useDraftLifecycleController({
    ownerId: source ? `feed-source-edit-${source.id}` : "feed-source-create",
    label: editing ? "Feed source changes" : "New feed source draft",
    mode: editing ? "edit" : "create",
    enabled: open,
    dirty: JSON.stringify(draft) !== JSON.stringify(baseline),
    save,
    discard: () => {
      setDraft(baseline);
      errors.clear();
    },
    close: onClose,
    detail: editing
      ? "These feed-source changes have not been saved."
      : "This feed source has not been created. Return to the form or explicitly discard it.",
    operationDetail:
      "Wait for the feed-source request to finish before leaving Moosewave.",
    onError: (error) =>
      errors.set(
        "_form",
        lifecycleOperationError(error, "The feed source couldn't be saved."),
      ),
  });

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={lifecycle.requestClose}
      closeOnBackdrop={!lifecycle.active}
      closeOnEscape={!lifecycle.active}
      closeDisabled={lifecycle.active}
      title={editing ? "Edit feed source" : "New feed source"}
      description="Each poll that finds new items creates a DRAFT campaign — you review and send it yourself; nothing sends automatically."
    >
      <FormField
        label="Name"
        required
        htmlFor="feed-name"
        error={errors.get("name")}
      >
        <input
          id="feed-name"
          className="input"
          value={draft.name}
          placeholder="e.g. Company blog"
          onChange={(e) => {
            setDraft({ ...draft, name: e.target.value });
            if (errors.get("name")) errors.clear("name");
          }}
        />
      </FormField>

      <FormField
        label="Feed URL"
        required
        htmlFor="feed-url"
        error={errors.get("url")}
        help="RSS or Atom feed address."
      >
        <input
          id="feed-url"
          className="input mono"
          value={draft.url}
          placeholder="https://example.com/blog/rss.xml"
          onChange={(e) => {
            setDraft({ ...draft, url: e.target.value });
            if (errors.get("url")) errors.clear("url");
          }}
        />
      </FormField>

      <FormField label="Schedule" htmlFor="feed-schedule">
        <select
          id="feed-schedule"
          className="input"
          value={draft.schedule}
          onChange={(e) =>
            setDraft({
              ...draft,
              schedule: e.target.value as FeedSourceDraft["schedule"],
            })
          }
        >
          {FEED_SCHEDULES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
          {FEED_SCHEDULES.find((s) => s.value === draft.schedule)?.hint}
        </p>
      </FormField>

      <FormField
        label="Subject template"
        required
        htmlFor="feed-subject-template"
        error={errors.get("subjectTemplate")}
        help={SUBJECT_TEMPLATE_HELP}
      >
        <input
          id="feed-subject-template"
          className="input mono"
          value={draft.subjectTemplate}
          placeholder="{{title}}"
          onChange={(e) => {
            setDraft({ ...draft, subjectTemplate: e.target.value });
            if (errors.get("subjectTemplate")) errors.clear("subjectTemplate");
          }}
        />
      </FormField>

      <FeedTargetField
        draft={draft}
        lists={lists}
        listsError={listsErr}
        segments={segments}
        segmentsError={segmentsErr}
        error={errors.get("target")}
        onChange={(next) => {
          setDraft(next);
          if (errors.get("target")) errors.clear("target");
        }}
      />

      <FormField label="Enabled">
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            style={{ width: "auto", height: "auto" }}
          />
          <span className="muted" style={{ fontSize: 12 }}>
            Disabled sources are skipped by the scheduler. Poll now still works
            so you can test the feed.
          </span>
        </label>
      </FormField>

      {errors.get("_form") ? (
        <FieldError>{errors.get("_form")}</FieldError>
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
          {lifecycle.active
            ? "Saving…"
            : editing
              ? "Save changes"
              : "Create feed source"}
        </button>
      </ModalFooter>
      <ConfirmModal
        open={lifecycle.discardConfirmOpen}
        title={
          editing
            ? "Discard feed-source changes?"
            : "Discard feed-source draft?"
        }
        description={
          editing
            ? "Your changes will be restored to the last loaded feed source."
            : "The feed source has not been created."
        }
        confirmLabel="Discard"
        danger
        busy={lifecycle.active}
        onConfirm={lifecycle.discardAndClose}
        onClose={lifecycle.keepEditing}
      />
    </Modal>
  );
}

function FeedTargetField({
  draft,
  lists,
  listsError,
  segments,
  segmentsError,
  error,
  onChange,
}: {
  draft: FeedSourceDraft;
  lists: List[] | null;
  listsError: string | null;
  segments: Segment[] | null;
  segmentsError: string | null;
  error?: string;
  onChange: (draft: FeedSourceDraft) => void;
}): ReactElement {
  return (
    <FormField
      label="Target audience"
      error={error}
      help="Who the draft campaigns are addressed to."
    >
      <div style={{ display: "flex", gap: 14, marginBottom: 6 }}>
        {(
          [
            { kind: "all", label: "Everyone" },
            { kind: "list", label: "List" },
            { kind: "segment", label: "Segment" },
          ] as { kind: FeedTargetKind; label: string }[]
        ).map((option) => (
          <label
            key={option.kind}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <input
              type="radio"
              name="feed-source-target-kind"
              checked={draft.targetKind === option.kind}
              onChange={() => onChange({ ...draft, targetKind: option.kind })}
              style={{ width: "auto", height: "auto" }}
            />
            {option.label}
          </label>
        ))}
      </div>
      {draft.targetKind === "list" ? (
        listsError ? (
          <div className="notice">
            <span>Couldn&apos;t load lists: {listsError}</span>
          </div>
        ) : (
          <select
            className="input"
            value={draft.listId}
            disabled={lists === null}
            onChange={(event) =>
              onChange({ ...draft, listId: event.target.value })
            }
            aria-label="Target list"
          >
            <option value="">
              {lists === null
                ? "Loading lists…"
                : lists.length === 0
                  ? "No lists on this workspace"
                  : "Select a list…"}
            </option>
            {(lists ?? []).map((list) => (
              <option key={String(list.id)} value={String(list.id)}>
                {list.name}
                {typeof list.subscriber_count === "number"
                  ? ` (${list.subscriber_count.toLocaleString()})`
                  : ""}
              </option>
            ))}
          </select>
        )
      ) : null}
      {draft.targetKind === "segment" ? (
        segmentsError ? (
          <div className="notice">
            <span>Couldn&apos;t load segments: {segmentsError}</span>
          </div>
        ) : (
          <select
            className="input"
            value={draft.segmentId}
            disabled={segments === null}
            onChange={(event) =>
              onChange({ ...draft, segmentId: event.target.value })
            }
            aria-label="Target segment"
          >
            <option value="">
              {segments === null
                ? "Loading segments…"
                : segments.length === 0
                  ? "No segments on this workspace"
                  : "Select a segment…"}
            </option>
            {(segments ?? []).map((segment) => (
              <option key={segment.id} value={segment.id}>
                {segment.name}
              </option>
            ))}
          </select>
        )
      ) : null}
    </FormField>
  );
}
