/**
 * BroadcastComposerModal — create / edit an SMS broadcast draft.
 *
 * Mirrors the server contract in apps/api/internal/sms/broadcasts.go:
 *
 *   - Audience is EXACTLY ONE of lists | segment | tag. The picker is
 *     a radio group so the exclusivity is structural, and
 *     `buildBroadcastUpsert` clears the unchosen dimensions so a PATCH
 *     can never trip the server's 422 `invalid_audience`.
 *   - Segment counter reuses the ReplyComposer mental model but ports
 *     the REAL server math (sms.SegmentCount — GSM 160/153, unicode
 *     70/67) via `smsSegmentInfo` so the counter and the stored
 *     `segments_per_message` always agree.
 *   - Schedule is optional. Setting it does NOT arm the broadcast —
 *     the operator still clicks "Schedule" on the list, which POSTs
 *     /send and flips the row to `scheduled` for the worker due-sweep.
 *     The hint under the field says exactly that (honest UI).
 *   - Server typed 422s land inline on the offending field via
 *     `fieldForBroadcastErrorCode`; everything else goes to the _form
 *     banner verbatim.
 */

import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";

import {
  type SmsBroadcast,
  type SMSSender,
  type Tag,
  api,
  smsBroadcastsApi,
} from "../../../lib/api-client";
// GAP-4#2: the broadcast audience resolver joins sms_subscriptions.list_id on
// sms_lists UUIDs; the Listmonk email lists (api.listLists, int64 ids) trip
// broadcasts.go `invalid_audience` ("list_ids entries must be UUIDs"), so a
// list-audience broadcast could never be created. Source the list picker from
// GET /api/v1/sms/lists (UUID ids) instead.
import { type SmsList, listSmsLists } from "../../../lib/sms-a2p-api";
import { registerLifecycleGuard } from "../../../lib/lifecycle-coordinator";
import { remoteFailureFromError } from "../../../lib/remote-resource";
import { FieldError, FormField, useFormErrors } from "../../FormField";
import { Modal, ModalFooter } from "../../Modal";
// GAP-4#3: target real-time `segments` (segmentsClient), not saved_segments —
// only segments-table ids appear in segment_subscribers, which the broadcast
// audience resolver joins on. saved_segments ids resolve to zero recipients.
import { type Segment, segmentsClient } from "../../segments/segmentsClient";
import { eligibleSMSSenders } from "../sms-reply-intent";
import { useSMSDocumentVisible } from "../sms-page-activity";
import {
  type BroadcastAudienceKind,
  type BroadcastFormState,
  buildBroadcastUpsert,
  describeBroadcastError,
  emptyBroadcastForm,
  fieldForBroadcastErrorCode,
  formFromBroadcast,
  smsSegmentInfo,
  validateBroadcastForm,
} from "./broadcast-helpers";

interface Props {
  open: boolean;
  /** Null = create; a broadcast row = edit (draft|scheduled only). */
  existing: SmsBroadcast | null;
  onClose: () => void;
  onSaved: (b: SmsBroadcast) => void;
}

const AUDIENCE_OPTIONS: Array<{
  value: BroadcastAudienceKind;
  label: string;
}> = [
  { value: "lists", label: "Lists" },
  { value: "segment", label: "Segment" },
  { value: "tag", label: "Tag" },
];

// GAP-4#5: server hard-rejects broadcast bodies over this many SMS
// segments (broadcasts.go too_many_segments); enforced client-side too.
const SMS_SEGMENT_CAP = 10;

interface BroadcastAudienceFieldProps {
  form: BroadcastFormState;
  lists: SmsList[] | null;
  listsError: string | null;
  segments: Segment[] | null;
  segmentsError: string | null;
  tags: Tag[] | null;
  error: string | undefined;
  onPatch: (patch: Partial<BroadcastFormState>) => void;
  onRetrySegments: () => void;
  onToggleList: (id: string) => void;
}

function BroadcastAudienceField({
  form,
  lists,
  listsError,
  segments,
  segmentsError,
  tags,
  error,
  onPatch,
  onRetrySegments,
  onToggleList,
}: BroadcastAudienceFieldProps): ReactElement {
  return (
    <FormField
      label="Audience"
      required
      help="A broadcast targets exactly one audience type — lists, a segment, or a tag."
      error={error}
    >
      <div role="radiogroup" aria-label="Audience type" className="chips">
        {AUDIENCE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={form.audience === option.value}
            className={`chip${form.audience === option.value ? " is-active" : ""}`}
            onClick={() => onPatch({ audience: option.value })}
          >
            {option.label}
          </button>
        ))}
      </div>

      {form.audience === "lists" ? (
        lists === null ? (
          <div className="muted small">Loading SMS lists…</div>
        ) : listsError ? (
          <div className="notice" role="alert">
            <span>
              <strong>Couldn&apos;t verify SMS lists.</strong> {listsError}
            </span>
            <span className="spacer" />
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={onRetrySegments}
            >
              Retry options
            </button>
          </div>
        ) : lists.length === 0 ? (
          <div className="muted small">
            No SMS lists available yet — create one under SMS first, then target
            it here.
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              maxHeight: 180,
              overflowY: "auto",
              padding: "6px 2px",
            }}
          >
            {lists.map((list) => {
              const id = String(list.id);
              return (
                <label
                  key={id}
                  style={{ display: "flex", gap: 8, alignItems: "center" }}
                >
                  <input
                    type="checkbox"
                    checked={form.listIds.includes(id)}
                    onChange={() => onToggleList(id)}
                  />
                  <span>{list.name}</span>
                  {list.keyword ? (
                    <span className="muted small tabular">
                      keyword {list.keyword}
                    </span>
                  ) : null}
                </label>
              );
            })}
          </div>
        )
      ) : null}

      {form.audience === "segment" ? (
        segments === null ? (
          <div className="muted small" role="status" aria-live="polite">
            Loading canonical segments…
          </div>
        ) : segmentsError ? (
          <div className="notice" role="alert">
            <span>
              <strong>Couldn&apos;t load canonical segments.</strong>{" "}
              {segmentsError}
            </span>
            <span className="spacer" />
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={onRetrySegments}
            >
              Retry segments
            </button>
          </div>
        ) : segments.length === 0 ? (
          <div className="muted small">
            No segments available — create one under Audience → Segments first.
          </div>
        ) : (
          <select
            aria-label="Segment"
            value={form.segmentId}
            onChange={(event) => onPatch({ segmentId: event.target.value })}
          >
            <option value="">Pick a segment…</option>
            {segments.map((segment) => (
              <option key={segment.id} value={segment.id}>
                {segment.name}
                {typeof segment.lastCount === "number"
                  ? ` (${segment.lastCount.toLocaleString()})`
                  : ""}
              </option>
            ))}
          </select>
        )
      ) : null}

      {form.audience === "tag" ? (
        <>
          <input
            type="text"
            aria-label="Tag"
            list="sms-broadcast-tag-options"
            value={form.tag}
            onChange={(event) => onPatch({ tag: event.target.value })}
            placeholder="vip"
          />
          <datalist id="sms-broadcast-tag-options">
            {(tags ?? []).map((tag) => (
              <option key={tag.id} value={tag.name} />
            ))}
          </datalist>
        </>
      ) : null}
    </FormField>
  );
}

export function BroadcastComposerModal({
  open,
  existing,
  onClose,
  onSaved,
}: Props): ReactElement | null {
  const [form, setForm] = useState<BroadcastFormState>(emptyBroadcastForm());
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const errors = useFormErrors();

  const [senders, setSenders] = useState<SMSSender[] | null>(null);
  const [lists, setLists] = useState<SmsList[] | null>(null);
  const [listsError, setListsError] = useState<string | null>(null);
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [segmentsError, setSegmentsError] = useState<string | null>(null);
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [sendersError, setSendersError] = useState<string | null>(null);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [optionsRevision, setOptionsRevision] = useState(0);
  const documentVisible = useSMSDocumentVisible();

  // Reset the form whenever the modal (re)opens for a different row.
  useEffect(() => {
    if (!open) return;
    setForm(existing ? formFromBroadcast(existing) : emptyBroadcastForm());
    errors.clear();
    // errors is identity-stable per useFormErrors; existing?.id keys the reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing?.id]);

  // Lazy-load the pickers' option sources on open. Requests are isolated so a
  // failed sender/tag/list read cannot strand the canonical segment picker in
  // a permanent loading state. Segment failures remain distinct from a
  // verified-empty catalog and can be retried in place.
  useEffect(() => {
    if (!open || !documentVisible) return;
    let cancelled = false;
    const senderController = new AbortController();
    setSenders(null);
    setSendersError(null);
    setLists(null);
    setListsError(null);
    setSegments(null);
    setSegmentsError(null);
    setTags(null);
    setTagsError(null);
    void (async () => {
      const [sendersRes, listsRes, segmentsRes, tagsRes] = await Promise.all([
        api
          .listSMSSenders({ signal: senderController.signal })
          .catch(() => null),
        listSmsLists().catch(() => null),
        segmentsClient.list().catch(() => null),
        api.listTags().catch(() => null),
      ]);
      if (cancelled) return;
      if (!sendersRes || sendersRes.error) {
        setSenders([]);
        setSendersError(
          sendersRes?.error
            ? remoteFailureFromError(sendersRes.error).message
            : "The sender service could not be reached.",
        );
      } else {
        setSenders(eligibleSMSSenders(sendersRes.data?.items ?? []));
      }
      // GAP-4#2: SMS lists (UUID ids), not the Listmonk email lists.
      if (!listsRes || listsRes.error) {
        setLists([]);
        setListsError(
          listsRes?.error
            ? remoteFailureFromError(listsRes.error).message
            : "The SMS list service could not be reached.",
        );
      } else {
        setLists(listsRes.data?.items ?? []);
      }
      // segmentsClient.list() returns a bare Segment[] (not an {items} envelope).
      if (!segmentsRes) {
        setSegmentsError(
          "The segment service could not be reached. Check the connection and retry.",
        );
        setSegments([]);
      } else if (segmentsRes.error) {
        setSegmentsError(remoteFailureFromError(segmentsRes.error).message);
        setSegments([]);
      } else if (!Array.isArray(segmentsRes.data)) {
        setSegmentsError(
          "The segment service returned a response that could not be verified.",
        );
        setSegments([]);
      } else {
        setSegmentsError(null);
        setSegments(segmentsRes.data);
      }
      if (!tagsRes || tagsRes.error) {
        setTags([]);
        setTagsError(
          tagsRes?.error
            ? remoteFailureFromError(tagsRes.error).message
            : "Tag suggestions could not be reached.",
        );
      } else {
        setTags(tagsRes.data?.items ?? []);
      }
    })();
    return (): void => {
      cancelled = true;
      senderController.abort();
    };
  }, [documentVisible, open, optionsRevision]);

  const baselineForm = useMemo(
    () => (existing ? formFromBroadcast(existing) : emptyBroadcastForm()),
    [existing],
  );
  const broadcastDirty =
    open && JSON.stringify(form) !== JSON.stringify(baselineForm);
  useEffect(() => {
    if (!broadcastDirty && !saving) return;
    return registerLifecycleGuard({
      id: "sms-broadcast-draft",
      label: existing ? "SMS broadcast changes" : "New SMS broadcast draft",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : saving
            ? {
                level: "blocking",
                detail: "The SMS broadcast draft is still being saved.",
                canDiscard: false,
              }
            : {
                level: "blocking",
                detail:
                  "The SMS broadcast has local changes that are not saved.",
              },
      discard: () => {
        setForm(baselineForm);
        onClose();
      },
    });
  }, [baselineForm, broadcastDirty, existing, onClose, saving]);

  if (!open) return null;

  const seg = smsSegmentInfo(form.body);
  const isEdit = existing !== null;

  const patch = (p: Partial<BroadcastFormState>): void =>
    setForm((f) => ({ ...f, ...p }));

  const toggleList = (id: string): void => {
    setForm((f) => ({
      ...f,
      listIds: f.listIds.includes(id)
        ? f.listIds.filter((x) => x !== id)
        : [...f.listIds, id],
    }));
  };

  const onSave = async (): Promise<void> => {
    if (savingRef.current) return;
    errors.clear();
    const clientErrors = validateBroadcastForm(form);
    // GAP-4#5: the server hard-rejects bodies over SMS_SEGMENT_CAP segments
    // (broadcasts.go too_many_segments), but validateBroadcastForm doesn't
    // check it. Enforce the same cap here so the operator gets an inline
    // Message error at the cap instead of a bottom-of-form banner after a
    // failed round-trip. `seg` is smsSegmentInfo(body), a 1:1 port of
    // sms.SegmentCount.
    if (!clientErrors.body && seg.segments > SMS_SEGMENT_CAP) {
      clientErrors.body = `Message is too long — SMS broadcasts are capped at ${SMS_SEGMENT_CAP} segments (this message is ${seg.segments}). Shorten it; any non-ASCII character switches the whole message to shorter 70-char segments.`;
    }
    if (Object.keys(clientErrors).length > 0) {
      errors.setMany(clientErrors);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    const input = buildBroadcastUpsert(form);
    try {
      const res = isEdit
        ? await smsBroadcastsApi.update(existing.id, input)
        : await smsBroadcastsApi.create(input);
      if (res.error) {
        errors.set(
          fieldForBroadcastErrorCode(res.error.code),
          describeBroadcastError(res.error),
        );
        return;
      }
      if (res.data) onSaved(res.data);
    } catch (error) {
      errors.set(
        "_form",
        error instanceof Error && error.message
          ? error.message
          : "The broadcast draft could not be saved.",
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => (savingRef.current ? undefined : onClose())}
      title={isEdit ? `Edit ${existing.name}` : "New SMS broadcast"}
      description="This saves an editable draft; it does not send or schedule. Any later dispatch must pass live server readiness, US/Canada consent, suppression, and quiet-hours checks."
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <FormField label="Name" required error={errors.get("name")}>
          <input
            type="text"
            value={form.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="June flash sale"
            maxLength={200}
          />
        </FormField>

        <FormField
          label="From sender"
          help="Optional while drafting — required before the broadcast can send."
          error={errors.get("sender")}
        >
          <select
            value={form.senderProfileId}
            onChange={(e) => patch({ senderProfileId: e.target.value })}
            disabled={saving || senders === null || sendersError !== null}
          >
            <option value="">
              {senders === null
                ? "Loading senders…"
                : senders.length === 0
                  ? "No approved live sender"
                  : "Pick an approved sender…"}
            </option>
            {(senders ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.label || s.phone_number || s.id}
              </option>
            ))}
          </select>
          {sendersError ? (
            <div className="notice" role="alert">
              Couldn&apos;t verify approved live senders: {sendersError}
            </div>
          ) : null}
        </FormField>

        <FormField label="Message" required error={errors.get("body")}>
          <textarea
            rows={4}
            value={form.body}
            onChange={(e) => patch({ body: e.target.value })}
            placeholder="Type the broadcast message…"
            maxLength={1600}
          />
          <span
            className="muted small tabular"
            title="Mirrors the server's segment math: GSM bodies split at 160 chars (153 when concatenated); any non-ASCII character switches the whole message to 70-char (67 concatenated) unicode segments. Carriers bill per segment, per recipient."
          >
            {seg.chars} chars · {seg.segments} segment
            {seg.segments === 1 ? "" : "s"} · {seg.remaining} left in segment
            {seg.encoding === "unicode" ? " · unicode (70-char segments)" : ""}
            {" · "}max {SMS_SEGMENT_CAP} segments
          </span>
          {seg.segments > SMS_SEGMENT_CAP ? (
            // GAP-4#5: surface the cap as the counter crosses it, before save.
            <span className="small" style={{ color: "var(--pw-danger)" }}>
              Over the {SMS_SEGMENT_CAP}-segment limit — shorten the message
              before saving.
            </span>
          ) : null}
        </FormField>

        <BroadcastAudienceField
          form={form}
          lists={lists}
          listsError={listsError}
          segments={segments}
          segmentsError={segmentsError}
          tags={tags}
          error={errors.get("audience")}
          onPatch={patch}
          onRetrySegments={() => {
            setSegments(null);
            setSegmentsError(null);
            setOptionsRevision((revision) => revision + 1);
          }}
          onToggleList={toggleList}
        />

        {form.audience === "tag" && tagsError ? (
          <div className="notice" role="status">
            Tag suggestions are unavailable: {tagsError} You can still enter an
            exact known tag; the server will verify it when the draft is saved.
          </div>
        ) : null}

        <FormField
          label="Schedule (optional)"
          help="Saving with a time keeps the broadcast as a draft — click Schedule on the list to authorize it. At the scheduled time, dispatch still depends on live readiness and recipient eligibility."
          error={errors.get("schedule")}
        >
          <input
            type="datetime-local"
            value={form.scheduledAtLocal}
            onChange={(e) => patch({ scheduledAtLocal: e.target.value })}
          />
        </FormField>

        {errors.get("_form") ? (
          <FieldError>{errors.get("_form")}</FieldError>
        ) : null}
      </div>

      <ModalFooter>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            if (!savingRef.current) onClose();
          }}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void onSave()}
          disabled={saving}
        >
          {saving ? "Saving…" : isEdit ? "Save changes" : "Create draft"}
        </button>
      </ModalFooter>
    </Modal>
  );
}
