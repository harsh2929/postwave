/**
 * AudienceSyncFormModal — create / edit one audience sync (A13).
 *
 * Fields mirror the backend contract exactly
 * (apps/api/internal/audience_destinations/syncs.go):
 *   - name             (required, ≤200 chars)
 *   - source           (exactly ONE of list / segment — radio + picker)
 *   - destination.url  (webhook URL; non-dev servers enforce https)
 *   - destination.secret (HMAC signing key — required on create,
 *                         optional on edit: blank keeps the stored one;
 *                         reads only ever expose secret_hint)
 *   - schedule         (manual | hourly | daily)
 *   - enabled
 *
 * Source options load from the live lists/segments APIs when the modal
 * opens. Load failures render an honest inline error per picker — the
 * dropdown never silently shows an empty catalog as if the tenant had
 * no lists.
 */

import { useEffect, useRef, useState, type ReactElement } from "react";

import {
  api,
  audienceSyncsApi,
  type AudienceSync,
  type AudienceSyncSchedule,
  type List,
} from "../../lib/api-client";
import { segmentsClient, type Segment } from "../segments/segmentsClient";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";
import { FormField } from "../FormField";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";

type SourceKind = "list" | "segment";

interface Props {
  open: boolean;
  /** null → create; otherwise edit this sync. */
  sync: AudienceSync | null;
  onClose: () => void;
  /** Fired after a successful create/update so the page reloads. */
  onSaved: () => void;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Unwrap the Listmonk lists envelope ({data:{results}} | {items} | …). */
export function unwrapAudienceSyncLists(payload: unknown): List[] {
  if (Array.isArray(payload)) return payload as List[];
  const outer = record(payload);
  if (!outer) return [];
  const inner = outer["data"] ?? outer;
  if (Array.isArray(inner)) return inner as List[];
  const innerRecord = record(inner);
  const items =
    innerRecord?.["results"] ?? outer["items"] ?? outer["results"] ?? [];
  return Array.isArray(items) ? (items as List[]) : [];
}

const SCHEDULES: Array<{
  value: AudienceSyncSchedule;
  label: string;
  hint: string;
}> = [
  {
    value: "manual",
    label: "Manual",
    hint: "Runs only when you click Run now.",
  },
  {
    value: "hourly",
    label: "Hourly",
    hint: "Scheduler re-pushes the full audience every hour.",
  },
  {
    value: "daily",
    label: "Daily",
    hint: "Scheduler re-pushes the full audience every 24 hours.",
  },
];

interface AudienceSyncSourceFieldProps {
  sourceKind: SourceKind;
  listId: string;
  segmentId: string;
  lists: List[] | null;
  listsError: string | null;
  segments: Segment[] | null;
  segmentsError: string | null;
  onSourceKindChange: (kind: SourceKind) => void;
  onListChange: (id: string) => void;
  onSegmentChange: (id: string) => void;
}

function AudienceSyncSourceField({
  sourceKind,
  listId,
  segmentId,
  lists,
  listsError,
  segments,
  segmentsError,
  onSourceKindChange,
  onListChange,
  onSegmentChange,
}: AudienceSyncSourceFieldProps): ReactElement {
  return (
    <FormField
      label="Source"
      required
      help="Exactly one list or segment per sync."
    >
      <div style={{ display: "flex", gap: 14, marginBottom: 6 }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <input
            type="radio"
            name="audience-sync-source-kind"
            checked={sourceKind === "list"}
            onChange={() => onSourceKindChange("list")}
            style={{ width: "auto", height: "auto" }}
          />
          List
        </label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <input
            type="radio"
            name="audience-sync-source-kind"
            checked={sourceKind === "segment"}
            onChange={() => onSourceKindChange("segment")}
            style={{ width: "auto", height: "auto" }}
          />
          Segment
        </label>
      </div>
      {sourceKind === "list" ? (
        listsError ? (
          <div className="notice">
            <span>Couldn&apos;t load lists: {listsError}</span>
          </div>
        ) : (
          <select
            className="input"
            value={listId}
            disabled={lists === null}
            onChange={(event) => onListChange(event.target.value)}
            aria-label="Source list"
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
                {list.name || "(unnamed list)"}
                {typeof list.subscriber_count === "number"
                  ? ` (${list.subscriber_count.toLocaleString()})`
                  : ""}
              </option>
            ))}
          </select>
        )
      ) : segmentsError ? (
        <div className="notice">
          <span>Couldn&apos;t load segments: {segmentsError}</span>
        </div>
      ) : (
        <select
          className="input"
          value={segmentId}
          disabled={segments === null}
          onChange={(event) => onSegmentChange(event.target.value)}
          aria-label="Source segment"
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
              {segment.name || "(unnamed segment)"}
            </option>
          ))}
        </select>
      )}
    </FormField>
  );
}

function AudienceSyncDeliveryFields({
  enabled,
  onEnabledChange,
  onScheduleChange,
  schedule,
}: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onScheduleChange: (schedule: AudienceSyncSchedule) => void;
  schedule: AudienceSyncSchedule;
}): ReactElement {
  return (
    <>
      <FormField label="Schedule">
        <select
          className="input"
          value={schedule}
          onChange={(event) =>
            onScheduleChange(event.target.value as AudienceSyncSchedule)
          }
          aria-label="Schedule"
        >
          {SCHEDULES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
          {SCHEDULES.find((item) => item.value === schedule)?.hint}
        </p>
      </FormField>

      <FormField label="Enabled">
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => onEnabledChange(event.target.checked)}
            style={{ width: "auto", height: "auto" }}
          />
          <span className="muted" style={{ fontSize: 12 }}>
            Disabled syncs are skipped by the scheduler and can&apos;t be run
            manually.
          </span>
        </label>
      </FormField>
    </>
  );
}

function validateAudienceSyncDraft({
  editing,
  listId,
  name,
  secret,
  segmentId,
  sourceKind,
  url,
}: {
  editing: boolean;
  listId: string;
  name: string;
  secret: string;
  segmentId: string;
  sourceKind: SourceKind;
  url: string;
}): string | null {
  if (!name.trim()) return "Name is required.";
  if (name.trim().length > 200) return "Name must be 200 characters or fewer.";
  if (sourceKind === "list" && !listId) return "Pick a source list.";
  if (sourceKind === "segment" && !segmentId) return "Pick a source segment.";
  if (!url.trim()) return "Destination webhook URL is required.";
  if (!/^https?:\/\//i.test(url.trim())) {
    return "Destination URL must start with http:// or https://.";
  }
  if (!editing && !secret.trim()) {
    return "A signing secret is required so the receiver can verify payloads.";
  }
  return null;
}

function AudienceSyncFormModalBody({
  open,
  sync,
  onClose,
  onSaved,
}: Props): ReactElement | null {
  const activeRef = useRef(true);
  const editing = sync !== null;

  const [name, setName] = useState("");
  const [sourceKind, setSourceKind] = useState<SourceKind>("list");
  const [listId, setListId] = useState("");
  const [segmentId, setSegmentId] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [schedule, setSchedule] = useState<AudienceSyncSchedule>("manual");
  const [enabled, setEnabled] = useState(true);

  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  // Source catalogs — loaded on open, with honest per-picker errors.
  const [lists, setLists] = useState<List[] | null>(null);
  const [listsErr, setListsErr] = useState<string | null>(null);
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [segmentsErr, setSegmentsErr] = useState<string | null>(null);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  // Re-seed the form whenever the modal opens (create) or the target
  // sync changes (edit).
  useEffect(() => {
    if (!open) return;
    setDirty(false);
    setFormErr(null);
    setSaving(false);
    setSecret("");
    if (sync) {
      setName(sync.name ?? "");
      // `source` (and its ids) may be absent on an incomplete sync —
      // guard every nested read so editing never crashes on seed.
      const segId = sync.source?.segment_id ?? "";
      setSourceKind(segId ? "segment" : "list");
      setListId(sync.source?.list_id ?? "");
      setSegmentId(segId);
      setUrl(sync.destination?.url ?? "");
      setSchedule(
        (["manual", "hourly", "daily"].includes(sync.schedule ?? "")
          ? sync.schedule
          : "manual") as AudienceSyncSchedule,
      );
      setEnabled(sync.enabled ?? true);
    } else {
      setName("");
      setSourceKind("list");
      setListId("");
      setSegmentId("");
      setUrl("");
      setSchedule("manual");
      setEnabled(true);
    }
  }, [open, sync]);

  // GAP-1#11: the stored source.list_id is the resolved Moosewave uuid, but
  // the picker options are keyed by the Listmonk numeric id. A controlled
  // <select> whose value matches no option silently renders the placeholder,
  // so an edited list-sourced sync looked unconfigured (and nudged the
  // operator to re-pick). Once lists load, map a uuid-form listId back to the
  // numeric id it points at (list rows carry their uuid in Listmonk's
  // passthrough fields).
  useEffect(() => {
    if (!open || !editing || sourceKind !== "list") return;
    if (!lists || lists.length === 0) return;
    // Numeric ids already match an option; only a non-numeric (uuid) value
    // needs resolving.
    if (!listId || /^\d+$/.test(listId)) return;
    const match = lists.find(
      (l) => String((l as { uuid?: unknown }).uuid ?? "") === listId,
    );
    if (match) setListId(String(match.id));
  }, [open, editing, sourceKind, lists, listId]);

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
        setLists(unwrapAudienceSyncLists(res.data));
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

  const validation = validateAudienceSyncDraft({
    editing,
    listId,
    name,
    secret,
    segmentId,
    sourceKind,
    url,
  });

  const save = async (): Promise<void> => {
    if (validation) {
      setFormErr(validation);
      return;
    }
    setSaving(true);
    setFormErr(null);
    const source =
      sourceKind === "list" ? { list_id: listId } : { segment_id: segmentId };
    const res = sync
      ? await audienceSyncsApi.update(sync.id, {
          name: name.trim(),
          source,
          destination: {
            type: "webhook",
            url: url.trim(),
            // Blank keeps the stored secret (write-only semantics).
            ...(secret.trim() ? { secret: secret.trim() } : {}),
          },
          schedule,
          enabled,
        })
      : await audienceSyncsApi.create({
          name: name.trim(),
          source,
          destination: {
            type: "webhook",
            url: url.trim(),
            secret: secret.trim(),
          },
          schedule,
          enabled,
        });
    if (!activeRef.current) return;
    setSaving(false);
    if (res.error) {
      setFormErr(res.error.message);
      return;
    }
    toast.success(editing ? "Sync updated" : "Sync created");
    setDirty(false);
    onSaved();
  };

  useEffect(() => {
    if (!dirty && !saving) return;
    return registerLifecycleGuard({
      id: `audience-sync-${sync?.id ?? "create"}`,
      label: editing ? "Audience sync changes" : "New audience sync draft",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : saving
            ? {
                level: "blocking",
                detail: "The audience sync is still being saved.",
                canDiscard: false,
              }
            : {
                level: "blocking",
                detail:
                  "The audience source, destination, or signing secret has unsaved local changes.",
              },
      discard: onClose,
    });
  }, [dirty, editing, onClose, saving, sync?.id]);

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={() => (saving ? undefined : onClose())}
      title={editing ? "Edit audience sync" : "New audience sync"}
      description="Moosewave pushes the audience to your webhook in HMAC-signed batches — verify X-Postwave-Signature before trusting each payload."
    >
      <FormField label="Name" required>
        <input
          className="input"
          value={name}
          maxLength={200}
          placeholder="e.g. Newsletter → CRM"
          onChange={(e) => {
            setDirty(true);
            setName(e.target.value);
          }}
        />
      </FormField>

      <AudienceSyncSourceField
        sourceKind={sourceKind}
        listId={listId}
        segmentId={segmentId}
        lists={lists}
        listsError={listsErr}
        segments={segments}
        segmentsError={segmentsErr}
        onSourceKindChange={(value) => {
          setDirty(true);
          setSourceKind(value);
        }}
        onListChange={(value) => {
          setDirty(true);
          setListId(value);
        }}
        onSegmentChange={(value) => {
          setDirty(true);
          setSegmentId(value);
        }}
      />

      <FormField
        label="Webhook URL"
        required
        help="Your receiver. Production servers require https."
      >
        <input
          className="input mono"
          value={url}
          placeholder="https://example.com/postwave/audience"
          onChange={(e) => {
            setDirty(true);
            setUrl(e.target.value);
          }}
        />
      </FormField>

      <FormField
        label="Signing secret"
        required={!editing}
        help={
          editing
            ? sync?.destination?.secret_set
              ? `Stored secret ends in ${sync.destination?.secret_hint || "••••"} — leave blank to keep it.`
              : "No secret stored — set one before running."
            : "Used to HMAC-sign every batch (X-Postwave-Signature)."
        }
      >
        <input
          className="input mono"
          type="password"
          value={secret}
          autoComplete="new-password"
          placeholder={
            editing
              ? "Leave blank to keep current secret"
              : "Paste a strong shared secret"
          }
          onChange={(e) => {
            setDirty(true);
            setSecret(e.target.value);
          }}
        />
      </FormField>

      <AudienceSyncDeliveryFields
        enabled={enabled}
        schedule={schedule}
        onEnabledChange={(value) => {
          setDirty(true);
          setEnabled(value);
        }}
        onScheduleChange={(value) => {
          setDirty(true);
          setSchedule(value);
        }}
      />

      {formErr ? (
        <div className="notice" role="alert">
          <span>{formErr}</span>
        </div>
      ) : null}

      <ModalFooter>
        <button
          type="button"
          className="btn"
          onClick={onClose}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void save()}
          disabled={saving}
        >
          {saving ? "Saving…" : editing ? "Save changes" : "Create sync"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

/** Closing or changing the target unmounts the request-owning form body. */
export function AudienceSyncFormModal(props: Props): ReactElement | null {
  if (!props.open) return null;
  return (
    <AudienceSyncFormModalBody key={props.sync?.id ?? "create"} {...props} />
  );
}
