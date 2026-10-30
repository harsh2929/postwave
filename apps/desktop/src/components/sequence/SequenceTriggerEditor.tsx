/**
 * SequenceTriggerEditor — modal picker for the four entry-condition
 * kinds. The card on the canvas opens this; saving here PATCHes the
 * sequence via the parent's onSave (StepCanvas owns the persistence
 * lifecycle so optimistic state + rollback stay in one place).
 *
 * Pattern matches the Sequences create modal: card grid for the kind
 * picker, then a per-kind follow-up form. Reusing the Modal component
 * keeps Esc / overlay-click / focus-trap behaviour consistent.
 */
import { type ReactElement, useEffect, useState } from "react";

import {
  api,
  type List,
  type ListsResponse,
  type SavedSegment,
  type SequenceTrigger,
  listSavedSegments,
} from "../../lib/api-client";
import { remoteFailureFromError } from "../../lib/remote-resource";
import { ChoiceGroup, type ChoiceGroupOption } from "../ChoiceGroup";
import { Modal, ModalFooter } from "../Modal";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";
import { SavedSegmentDropdown } from "../segments/SavedSegmentDropdown";

import {
  TRIGGER_KINDS,
  type SequenceTriggerKind,
  validateTrigger,
} from "./trigger-config";

interface Props {
  open: boolean;
  initial: SequenceTrigger | null;
  onClose: () => void;
  onSave: (next: SequenceTrigger | null) => void;
}

type TriggerKindChoice = SequenceTriggerKind | "";

/** Unwrap the various ListsResponse shapes the API ladders through. */
function extractLists(res: ListsResponse | undefined): List[] {
  if (!res) return [];
  if (Array.isArray(res.data)) return res.data;
  if (res.data && Array.isArray(res.data.results)) return res.data.results;
  if (Array.isArray(res.items)) return res.items;
  if (Array.isArray(res.results)) return res.results;
  return [];
}

export function SequenceTriggerEditor({
  open,
  initial,
  onClose,
  onSave,
}: Props): ReactElement {
  // Local draft so the operator can swap kinds without immediately
  // PATCHing the server. `null` here means "no trigger configured" —
  // saving that path clears the trigger on the parent.
  const [draft, setDraft] = useState<SequenceTrigger | null>(initial);
  const [err, setErr] = useState<string | null>(null);
  const [lists, setLists] = useState<List[] | null>(null);
  const [segments, setSegments] = useState<SavedSegment[] | null>(null);
  const [segmentsError, setSegmentsError] = useState<string | null>(null);
  const [optionsRevision, setOptionsRevision] = useState(0);

  // Sync `draft` whenever the modal opens against fresh `initial`
  // props — otherwise re-opening after a cancel would show stale edits.
  useEffect(() => {
    if (open) {
      setDraft(initial);
      setErr(null);
    }
  }, [open, initial]);

  // Fetch dropdown options once when opened. We only need both lists
  // when the user actually picks the corresponding kind, but a single
  // up-front fetch is cheaper than re-fetching on each kind switch and
  // the responses are small enough to keep in memory.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSegmentsError(null);
    void (async () => {
      try {
        const [listsRes, segmentsRes] = await Promise.all([
          api.listLists(),
          listSavedSegments(),
        ]);
        if (cancelled) return;
        setLists(extractLists(listsRes.data));
        if (segmentsRes.error) {
          setSegmentsError(remoteFailureFromError(segmentsRes.error).message);
        } else if (!Array.isArray(segmentsRes.data?.items)) {
          setSegmentsError(
            "The saved-segment service returned an invalid response.",
          );
        } else {
          setSegments(segmentsRes.data.items);
        }
      } catch {
        if (!cancelled) {
          setSegmentsError("The saved-segment service could not be reached.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, optionsRevision]);

  const pickedKind: SequenceTriggerKind | null = draft?.kind ?? null;
  const dirty = open && JSON.stringify(draft) !== JSON.stringify(initial);

  useEffect(() => {
    if (!dirty) return;
    return registerLifecycleGuard({
      id: "sequence-trigger-draft",
      label: "Sequence trigger changes",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : {
              level: "blocking",
              detail: "The sequence trigger has unsaved local changes.",
            },
      discard: onClose,
    });
  }, [dirty, onClose]);

  const pickKind = (kind: SequenceTriggerKind): void => {
    setErr(null);
    // Preserve any partial config already entered if the operator
    // re-picks the same kind — but reset between kinds so the form
    // doesn't carry stale fields (e.g. a list_id orphaned on a
    // segment_match trigger).
    setDraft((prev) => {
      if (prev?.kind === kind) return prev;
      return { kind };
    });
  };

  const updateDraft = (patch: Partial<SequenceTrigger>): void => {
    setErr(null);
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const handleSave = (): void => {
    if (!draft) {
      // No kind picked — treat as "clear trigger" if there was one
      // before, otherwise no-op.
      onSave(null);
      onClose();
      return;
    }
    const v = validateTrigger(draft);
    if (v) {
      setErr(v);
      return;
    }
    onSave(draft);
    onClose();
  };

  const handleClear = (): void => {
    onSave(null);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title="Sequence trigger"
      description="Pick how a subscriber enters this flow. Changes apply to new entries only — subscribers already mid-sequence keep running on the old trigger."
    >
      <div className="seq-trigger-editor">
        {/* Kind picker — radio-card grid. Stacked vertically so the
            follow-up form sits directly below the chosen tile without
            jumping the page. */}
        <div className="seq-trigger-kind-legend">Trigger type</div>
        <ChoiceGroup<TriggerKindChoice>
          legend="Trigger type"
          value={pickedKind ?? ""}
          options={TRIGGER_KINDS.map(
            (kind): ChoiceGroupOption<TriggerKindChoice> => ({
              value: kind.kind,
              label: (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span className="seq-trigger-kind-icon" aria-hidden="true">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d={kind.iconPath} />
                    </svg>
                  </span>
                  <span className="seq-trigger-kind-label">{kind.label}</span>
                </span>
              ),
              description: kind.description,
            }),
          )}
          onChange={(kind) => {
            if (kind) pickKind(kind);
          }}
          className="seq-trigger-kind-grid"
          optionClassName="seq-trigger-kind-card"
          orientation="vertical"
          style={{ display: "grid" }}
        />

        {/* Per-kind follow-up. Rendered conditionally so unrelated
            fields aren't visible — keeps the modal scannable. */}
        {draft ? (
          <TriggerKindForm
            draft={draft}
            lists={lists}
            segments={segments}
            segmentsError={segmentsError}
            onRetrySegments={() =>
              setOptionsRevision((revision) => revision + 1)
            }
            onChange={updateDraft}
          />
        ) : null}

        {err ? <div className="field-error">{err}</div> : null}
      </div>
      <ModalFooter>
        {/* Clear is only meaningful when something is already saved —
            avoids a misleading "Clear" button when the trigger was
            never configured in the first place. */}
        {initial ? (
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
          >
            <button
              type="button"
              className="btn btn-ghost"
              onClick={handleClear}
              aria-describedby="sequence-trigger-clear-description"
            >
              Clear trigger
            </button>
            <span
              id="sequence-trigger-clear-description"
              className="muted"
              style={{ fontSize: 11 }}
            >
              Stops new entries; subscribers already in the sequence continue.
            </span>
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={handleSave}>
          Save trigger
        </button>
      </ModalFooter>
    </Modal>
  );
}

/* ============ per-kind form ============ */

interface TriggerKindFormProps {
  draft: SequenceTrigger;
  lists: List[] | null;
  segments: SavedSegment[] | null;
  segmentsError: string | null;
  onRetrySegments: () => void;
  onChange: (patch: Partial<SequenceTrigger>) => void;
}

function TriggerKindForm({
  draft,
  lists,
  segments,
  segmentsError,
  onRetrySegments,
  onChange,
}: TriggerKindFormProps): ReactElement {
  switch (draft.kind) {
    case "list_subscribe":
      return (
        <ListPickerField draft={draft} lists={lists} onChange={onChange} />
      );
    case "segment_match":
      return (
        <SegmentPickerField
          draft={draft}
          segments={segments}
          error={segmentsError}
          onRetry={onRetrySegments}
          onChange={onChange}
        />
      );
    case "custom_event":
      return <EventNameField draft={draft} onChange={onChange} />;
    case "schedule":
      return <ScheduleField draft={draft} onChange={onChange} />;
    case "tag_added":
    case "tag_removed":
      return <TagNameField draft={draft} onChange={onChange} />;
  }
}

function ListPickerField({
  draft,
  lists,
  onChange,
}: {
  draft: SequenceTrigger;
  lists: List[] | null;
  onChange: (patch: Partial<SequenceTrigger>) => void;
}): ReactElement {
  const loading = lists === null;
  return (
    <div className="field">
      <label className="field-label" htmlFor="seq-trigger-list">
        List
      </label>
      <select
        id="seq-trigger-list"
        className="input"
        value={draft.list_id != null ? String(draft.list_id) : ""}
        onChange={(e) => {
          const v = e.target.value;
          onChange({ list_id: v === "" ? undefined : v });
        }}
        disabled={loading}
      >
        <option value="">{loading ? "Loading lists…" : "Pick a list…"}</option>
        {(lists ?? []).map((l) => (
          <option key={String(l.id)} value={String(l.id)}>
            {l.name}{" "}
            {l.subscriber_count != null ? `(${l.subscriber_count})` : ""}
          </option>
        ))}
      </select>
      <div className="field-help">
        New subscribers added to this list will enter the sequence from step 1.
        Existing list members are not re-enrolled.
      </div>
    </div>
  );
}

function SegmentPickerField({
  draft,
  segments,
  error,
  onRetry,
  onChange,
}: {
  draft: SequenceTrigger;
  segments: SavedSegment[] | null;
  error: string | null;
  onRetry: () => void;
  onChange: (patch: Partial<SequenceTrigger>) => void;
}): ReactElement {
  return (
    <div className="field">
      <label className="field-label" htmlFor="seq-trigger-segment">
        Segment
      </label>
      {/* SUB-030 — the dropdown shows aggregate live count, workspace
          percentage, and generated-at evidence without exposing member
          identities, so audience size is visible before saving. */}
      <SavedSegmentDropdown
        id="seq-trigger-segment"
        value={draft.segment_id ?? ""}
        segments={segments}
        error={error ?? undefined}
        onRetry={onRetry}
        onChange={(segmentId) =>
          onChange({ segment_id: segmentId || undefined })
        }
      />
      <div className="field-help">
        The segment re-evaluates periodically; new matches are enrolled into the
        sequence.
      </div>
    </div>
  );
}

function EventNameField({
  draft,
  onChange,
}: {
  draft: SequenceTrigger;
  onChange: (patch: Partial<SequenceTrigger>) => void;
}): ReactElement {
  return (
    <div className="field">
      <label className="field-label" htmlFor="seq-trigger-event">
        Event name
      </label>
      <input
        id="seq-trigger-event"
        type="text"
        className="input"
        placeholder="checkout.completed"
        value={draft.event_name ?? ""}
        onChange={(e) => onChange({ event_name: e.target.value || undefined })}
      />
      <div className="field-help">
        Use dot-separated names (e.g. <code>checkout.completed</code>) — match
        exactly what your app POSTs to the event ingest endpoint.
      </div>
    </div>
  );
}

function TagNameField({
  draft,
  onChange,
}: {
  draft: SequenceTrigger;
  onChange: (patch: Partial<SequenceTrigger>) => void;
}): ReactElement {
  return (
    <div className="field">
      <label className="field-label" htmlFor="seq-trigger-tag">
        Tag name
      </label>
      <input
        id="seq-trigger-tag"
        type="text"
        className="input"
        placeholder="customer"
        value={draft.tag_name ?? ""}
        onChange={(e) => onChange({ tag_name: e.target.value || undefined })}
      />
      <div className="field-help">
        Matches case-insensitively against the tag name. Fan-out is capped at 10
        active flows per tag mutation.
      </div>
    </div>
  );
}

function ScheduleField({
  draft,
  onChange,
}: {
  draft: SequenceTrigger;
  onChange: (patch: Partial<SequenceTrigger>) => void;
}): ReactElement {
  // Local toggle between "one-shot" and "cron" modes — purely a render
  // concern; the persisted shape carries either run_at or cron, never
  // both.
  const [mode, setMode] = useState<"once" | "cron">(
    draft.cron ? "cron" : "once",
  );
  const options: readonly ChoiceGroupOption<"once" | "cron">[] = [
    {
      value: "once",
      label: "One-shot",
      description: "Enroll the audience once at a specific time.",
    },
    {
      value: "cron",
      label: "Recurring (cron)",
      description: "Repeat enrollment on a five-field cron schedule.",
    },
  ];

  return (
    <div className="field">
      <ChoiceGroup
        legend="Schedule mode"
        value={mode}
        options={options}
        onChange={(nextMode) => {
          setMode(nextMode);
          if (nextMode === "once") onChange({ cron: undefined });
          else onChange({ run_at: undefined });
        }}
        className="seq-trigger-mode-tabs"
      />
      {mode === "once" ? (
        <>
          <label
            className="field-label"
            htmlFor="seq-trigger-runat"
            style={{ marginTop: 10 }}
          >
            Run at
          </label>
          <input
            id="seq-trigger-runat"
            type="datetime-local"
            className="input"
            value={draft.run_at ?? ""}
            onChange={(e) => onChange({ run_at: e.target.value || undefined })}
          />
          <div className="field-help">
            One-shot run in your workspace time zone. Subscribers in the
            audience at that moment enter the sequence.
          </div>
        </>
      ) : (
        <>
          <label
            className="field-label"
            htmlFor="seq-trigger-cron"
            style={{ marginTop: 10 }}
          >
            Cron expression
          </label>
          <input
            id="seq-trigger-cron"
            type="text"
            className="input mono"
            placeholder="0 9 * * 1"
            value={draft.cron ?? ""}
            onChange={(e) => onChange({ cron: e.target.value || undefined })}
          />
          <div className="field-help">
            Standard 5-field cron. Example: <code>0 9 * * 1</code> runs every
            Monday at 09:00.
          </div>
        </>
      )}
    </div>
  );
}
