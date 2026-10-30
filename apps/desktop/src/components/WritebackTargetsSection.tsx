/**
 * Bidirectional integration write-back (reverse-ETL) section.
 *
 * Pushes a list/segment's membership + each subscriber's computed traits BACK
 * into Shopify / HubSpot / Salesforce / Pipedrive / Klaviyo — the direct-API sibling of
 * the webhook-delivery AudienceDestinationsSection it renders beside. The whole
 * subsystem (provider adapters, runner, continuous scheduler, per-member trait mapping)
 * was server-only and invokable only via raw HTTP until this surface.
 *
 * Surface:
 *   - Active-targets list: provider, status, last run, auto-sync interval.
 *   - Per-target Run now (with a matched/tags/fields summary), Pause, Disconnect,
 *     and an expandable run history.
 *   - "New write-back" → a create modal (provider, vault credential ref, source
 *     list/segment, tags, static field_map, per-member trait_field_map, interval,
 *     advanced-JSON escape hatch for provider-specific keys).
 *
 * Honest-UI: a 404 means the surface isn't enabled on this server — we say so.
 * RBAC: every mutation is ScopeAdmin server-side; `canAdmin` gates the controls.
 *
 * Backend: apps/api/internal/integration_writeback/handlers.go.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { ConfirmModal } from "./ConfirmModal";
import { FormField } from "./FormField";
import { Modal, ModalFooter } from "./Modal";
import { SectionHeader } from "./SectionHeader";
import { toast } from "./Toast";
import { usePersistentLifecycleOperation } from "../hooks/usePersistentLifecycleOperation";
import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
} from "../hooks/useSettingsDraftLifecycle";
import {
  writebackApi,
  apiRequest,
  type ApiResult,
  type WritebackProvider,
  type WritebackRun,
  type WritebackRunSummary,
  type WritebackTarget,
} from "../lib/api-client";

const COLS = "1.4fr 110px 150px 130px 1fr";

const PROVIDER_LABELS: Record<string, string> = {
  shopify: "Shopify",
  hubspot: "HubSpot",
  salesforce: "Salesforce",
  pipedrive: "Pipedrive",
  woocommerce: "WooCommerce",
  "zoho-crm": "Zoho CRM",
  klaviyo: "Klaviyo",
};

const RESERVED_SETTING_KEYS = [
  "source_segment_id",
  "source_list_id",
  "tags",
  "field_map",
  "trait_field_map",
];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WritebackSegment {
  id: string;
  name: string;
}

function providerLabel(p: string): string {
  return PROVIDER_LABELS[p] ?? p;
}

function fmtTime(s: string | null | undefined): string {
  if (!s) return "never";
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s;
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function clip(s: string, n = 200): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function badgeClass(status: string): string {
  const s = status.toLowerCase();
  if (s === "active" || s === "completed") return "badge success";
  if (s === "error" || s === "failed") return "badge danger";
  if (s === "paused" || s === "partial") return "badge warning";
  return "badge";
}

function summaryToast(s: WritebackRunSummary): void {
  const detail = `${s.matched}/${s.members_seen} matched, ${s.tags_written} tags, ${s.fields_written} fields`;
  if (s.status === "failed") {
    toast.error({
      message: "Write-back failed",
      detail: clip(s.error_message || detail),
    });
  } else if (s.status === "partial" || s.rows_failed > 0) {
    toast.error({
      message: "Write-back partial",
      detail: `${detail}, ${s.rows_failed} failed`,
    });
  } else {
    toast.success(`Write-back complete — ${detail}`);
  }
}

export interface KeyValueRow {
  id: string;
  key: string;
  value: string;
}

function newRow(): KeyValueRow {
  return { id: crypto.randomUUID(), key: "", value: "" };
}

function rowsToMap(rows: KeyValueRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const k = row.key.trim();
    if (k) out[k] = row.value.trim();
  }
  return out;
}

function hasIncompleteRow(rows: KeyValueRow[]): boolean {
  return rows.some((r) => {
    const k = r.key.trim();
    const v = r.value.trim();
    return (k === "" && v !== "") || (k !== "" && v === "");
  });
}

type WritebackCreateInput = Parameters<typeof writebackApi.createTarget>[0];

export interface WritebackTargetDraft {
  provider: string;
  name: string;
  credentialsRef: string;
  sourceKind: "segment" | "list";
  sourceSegmentId: string;
  sourceListId: string;
  tags: string;
  fieldRows: KeyValueRow[];
  traitRows: KeyValueRow[];
  syncInterval: string;
  advancedJson: string;
}

export type WritebackTargetBuildResult =
  | { input: WritebackCreateInput }
  | { error: string };

export function buildWritebackTargetInput(
  draft: WritebackTargetDraft,
): WritebackTargetBuildResult {
  if (!draft.provider) return { error: "Pick a provider." };
  if (!draft.name.trim()) {
    return {
      error:
        "A name is required — targets are keyed on (provider, name), so reusing a name updates that target instead of creating a new one.",
    };
  }
  if (!draft.credentialsRef.trim()) {
    return { error: "A vault credential reference is required." };
  }

  const settings: Record<string, unknown> = {};
  if (draft.sourceKind === "segment") {
    if (!draft.sourceSegmentId) {
      return { error: "Choose a source segment." };
    }
    settings.source_segment_id = draft.sourceSegmentId;
  } else {
    const listId = draft.sourceListId.trim();
    if (!listId) return { error: "Enter a source list id." };
    if (!UUID_RE.test(listId)) {
      return { error: "Source list id must be a valid UUID." };
    }
    settings.source_list_id = listId;
  }

  if (hasIncompleteRow(draft.fieldRows)) {
    return {
      error: "Every static field needs both a platform field and a value.",
    };
  }
  if (hasIncompleteRow(draft.traitRows)) {
    return {
      error: "Every trait mapping needs both a platform field and a trait key.",
    };
  }

  const tagList = draft.tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (tagList.length) settings.tags = tagList;
  const fieldMap = rowsToMap(draft.fieldRows);
  if (Object.keys(fieldMap).length) settings.field_map = fieldMap;
  const traitMap = rowsToMap(draft.traitRows);
  if (Object.keys(traitMap).length) settings.trait_field_map = traitMap;

  if (draft.advancedJson.trim()) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(draft.advancedJson) as Record<string, unknown>;
    } catch {
      return { error: "Advanced settings must be valid JSON." };
    }
    const clashes = Object.keys(parsed).filter((key) =>
      RESERVED_SETTING_KEYS.includes(key),
    );
    if (clashes.length) {
      return {
        error: `Advanced settings can't override ${clashes.join(", ")} — use the fields above.`,
      };
    }
    Object.assign(settings, parsed);
  }

  const interval = Number.parseInt(draft.syncInterval, 10);
  return {
    input: {
      provider: draft.provider,
      name: draft.name.trim(),
      status: "active",
      credentials_ref: draft.credentialsRef.trim(),
      settings,
      sync_interval_minutes:
        Number.isFinite(interval) && interval > 0 ? interval : 0,
    },
  };
}

export function WritebackTargetsSection({
  canAdmin,
}: {
  canAdmin: boolean;
}): ReactElement {
  const [providers, setProviders] = useState<WritebackProvider[]>([]);
  const [targets, setTargets] = useState<WritebackTarget[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<WritebackTarget | null>(null);
  const [runsOpenId, setRunsOpenId] = useState<string | null>(null);
  const [runsById, setRunsById] = useState<Record<string, WritebackRun[]>>({});

  const load = useCallback(async (): Promise<void> => {
    const [provRes, listRes] = await Promise.all([
      writebackApi.providers(),
      writebackApi.listTargets(),
    ]);
    if (!provRes.error) setProviders(provRes.data?.items ?? []);
    if (listRes.error) {
      setErr(
        listRes.error.status === 404
          ? "Write-back isn't enabled on this Moosewave server."
          : listRes.error.message,
      );
      setTargets([]);
      return;
    }
    setErr(null);
    setTargets(listRes.data?.items ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function forgetRuns(id: string): void {
    setRunsById((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  const loadRuns = useCallback(async (id: string): Promise<void> => {
    const res = await writebackApi.listRuns(id);
    if (res.error) {
      toast.error({
        message: "Couldn't load run history",
        detail: res.error.message,
      });
      return;
    }
    setRunsById((prev) => ({ ...prev, [id]: res.data?.items ?? [] }));
  }, []);

  const runNow = async (id: string): Promise<void> => {
    if (busyId) return;
    setBusyId(id);
    const res = await writebackApi.runTarget(id);
    setBusyId(null);
    if (res.error) {
      toast.error({ message: "Run failed", detail: res.error.message });
      return;
    }
    if (res.queued) {
      toast.error("You're offline — a write-back run needs a live server.");
      return;
    }
    summaryToast(res.data);
    if (runsOpenId === id) await loadRuns(id);
    await load();
  };

  const pause = async (id: string): Promise<void> => {
    if (busyId) return;
    setBusyId(id);
    const res = await writebackApi.pauseTarget(id);
    setBusyId(null);
    if (res.error) {
      toast.error({ message: "Pause failed", detail: res.error.message });
      return;
    }
    toast.success("Target paused");
    await load();
  };

  const doDisconnect = async (): Promise<void> => {
    if (!deleting?.id) return;
    const id = deleting.id;
    const res = await writebackApi.disconnectTarget(id);
    if (res.error) {
      toast.error({ message: "Disconnect failed", detail: res.error.message });
      return;
    }
    toast.success("Target disconnected");
    setDeleting(null);
    if (runsOpenId === id) setRunsOpenId(null);
    forgetRuns(id);
    await load();
  };

  const toggleRuns = async (id: string): Promise<void> => {
    if (runsOpenId === id) {
      setRunsOpenId(null);
      return;
    }
    setRunsOpenId(id);
    if (!runsById[id]) await loadRuns(id);
  };

  return (
    <div>
      <SectionHeader
        title="Two-way sync (write-back)"
        description="Push a list or segment's membership and each subscriber's computed traits back into Shopify, WooCommerce, HubSpot, Salesforce, Pipedrive or Klaviyo."
        actions={
          canAdmin ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => setCreateOpen(true)}
            >
              + New write-back
            </button>
          ) : undefined
        }
      />

      {err ? (
        <div className="notice" role="alert">
          <span>{err}</span>
        </div>
      ) : targets === null ? (
        <p className="muted">Loading write-back targets…</p>
      ) : targets.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          No write-back targets yet — connect one to start syncing audiences
          back to a platform.
        </p>
      ) : (
        <div className="list">
          <div className="list-header" style={{ gridTemplateColumns: COLS }}>
            <div>Target</div>
            <div>Status</div>
            <div>Last run</div>
            <div>Schedule</div>
            <div></div>
          </div>
          {targets.map((t) => {
            const busy = busyId === t.id;
            const paused = t.status.toLowerCase() === "paused";
            // [GAP-1#9] Disconnected is a terminal state with no resume
            // route — hide Run/Pause/Disconnect so the row doesn't offer
            // buttons that only 500 ("write-back target is disconnected").
            const disconnected = t.status.toLowerCase() === "disconnected";
            const runsOpen = runsOpenId === t.id;
            return (
              <div key={t.id}>
                <div
                  className="list-row"
                  style={{ gridTemplateColumns: COLS, cursor: "default" }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>
                      {t.name || providerLabel(t.provider)}
                    </div>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {providerLabel(t.provider)}
                    </div>
                    {t.error_message ? (
                      <div
                        className="danger"
                        style={{
                          fontSize: 11,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                        title={t.error_message}
                      >
                        {t.error_message}
                      </div>
                    ) : null}
                  </div>
                  <div>
                    <span className={badgeClass(t.status)}>
                      {t.status || "unknown"}
                    </span>
                  </div>
                  <div className="muted tabular" style={{ fontSize: 12 }}>
                    {fmtTime(t.last_run_at)}
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {t.sync_interval_minutes > 0
                      ? `every ${t.sync_interval_minutes} min`
                      : "manual"}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      justifyContent: "flex-end",
                      flexWrap: "wrap",
                    }}
                  >
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => void toggleRuns(t.id)}
                      aria-expanded={runsOpen}
                    >
                      {runsOpen ? "Hide runs" : "Runs"}
                    </button>
                    {canAdmin && !disconnected ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy}
                          onClick={() => void runNow(t.id)}
                        >
                          {busy ? "…" : "Run now"}
                        </button>
                        {!paused ? (
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            disabled={busy}
                            onClick={() => void pause(t.id)}
                          >
                            Pause
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          disabled={busy}
                          onClick={() => setDeleting(t)}
                        >
                          Disconnect
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
                {runsOpen ? <RunHistory runs={runsById[t.id]} /> : null}
              </div>
            );
          })}
        </div>
      )}

      {createOpen ? (
        <CreateWritebackModal
          providers={providers}
          onClose={() => setCreateOpen(false)}
          onCreated={async () => {
            setCreateOpen(false);
            await load();
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmModal
          open
          title="Disconnect write-back target?"
          description={`Moosewave will stop writing audience membership and traits back to ${deleting.name || providerLabel(deleting.provider)}.`}
          confirmLabel="Disconnect"
          danger
          onConfirm={() => void doDisconnect()}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </div>
  );
}

function RunHistory({ runs }: { runs?: WritebackRun[] }): ReactElement {
  if (!runs)
    return (
      <p className="muted" style={{ fontSize: 12, padding: "6px 12px" }}>
        Loading runs…
      </p>
    );
  if (runs.length === 0)
    return (
      <p className="muted" style={{ fontSize: 12, padding: "6px 12px" }}>
        No runs yet.
      </p>
    );
  return (
    <div style={{ padding: "4px 12px 10px" }}>
      {runs.map((r) => (
        <div
          key={r.id}
          style={{
            display: "flex",
            gap: 10,
            fontSize: 12,
            alignItems: "baseline",
          }}
        >
          <span className="muted tabular" style={{ minWidth: 120 }}>
            {fmtTime(r.started_at)}
          </span>
          <span className={badgeClass(r.status)}>{r.status}</span>
          <span className="muted tabular">
            {r.matched}/{r.members_seen} matched · {r.tags_written} tags ·{" "}
            {r.fields_written} fields
            {r.rows_failed > 0 ? (
              <span className="danger"> · {r.rows_failed} failed</span>
            ) : null}
            {" · "}
            {r.run_mode}
            {r.error_message ? (
              <span className="danger" title={r.error_message}>
                {" "}
                — {clip(r.error_message, 80)}
              </span>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}

function CreateWritebackModal({
  providers,
  onClose,
  onCreated,
}: {
  providers: WritebackProvider[];
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}): ReactElement {
  const mountedRef = useRef(true);
  const available = providers.filter((p) => p.available);
  const [provider, setProvider] = useState(available[0]?.provider ?? "");
  const [name, setName] = useState("");
  const [credentialsRef, setCredentialsRef] = useState("");
  const [sourceKind, setSourceKind] = useState<"segment" | "list">("segment");
  const [sourceSegmentId, setSourceSegmentId] = useState("");
  const [sourceListId, setSourceListId] = useState("");
  const [tags, setTags] = useState("");
  const [fieldRows, setFieldRows] = useState<KeyValueRow[]>([]);
  const [traitRows, setTraitRows] = useState<KeyValueRow[]>([]);
  const [syncInterval, setSyncInterval] = useState("0");
  const [advancedJson, setAdvancedJson] = useState("");
  const [segments, setSegments] = useState<WritebackSegment[]>([]);
  const [segmentsLoaded, setSegmentsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const operation = usePersistentLifecycleOperation({
    ownerId: "writeback-target-create",
    label: "Write-back target creation",
  });
  const draftDirty =
    provider !== (available[0]?.provider ?? "") ||
    name !== "" ||
    credentialsRef !== "" ||
    sourceKind !== "segment" ||
    sourceSegmentId !== "" ||
    sourceListId !== "" ||
    tags !== "" ||
    fieldRows.length > 0 ||
    traitRows.length > 0 ||
    syncInterval !== "0" ||
    advancedJson !== "";

  const discardDraft = useCallback((): void => {
    setProvider(available[0]?.provider ?? "");
    setName("");
    setCredentialsRef("");
    setSourceKind("segment");
    setSourceSegmentId("");
    setSourceListId("");
    setTags("");
    setFieldRows([]);
    setTraitRows([]);
    setSyncInterval("0");
    setAdvancedJson("");
    setError(null);
    setDiscardConfirmOpen(false);
  }, [available]);

  useDiscardOnlyDraftLifecycle({
    ownerId: "writeback-target-create",
    label: "New write-back target draft",
    dirty: draftDirty,
    operationRef: operation.promiseRef,
    discard: discardDraft,
    detail:
      "This write-back target configuration has not been created. Return to it or explicitly discard it.",
  });

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        // Canonical segments (ids match segment_subscribers the runner joins).
        const res: ApiResult<WritebackSegment[]> =
          await apiRequest<WritebackSegment[]>("/api/v1/segments");
        if (cancelled) return;
        setSegments(res.error ? [] : (res.data ?? []));
      } catch {
        if (!cancelled) setSegments([]);
      } finally {
        if (!cancelled) setSegmentsLoaded(true);
      }
    })();
    return () => {
      mountedRef.current = false;
      cancelled = true;
    };
  }, []);

  async function submit(): Promise<void> {
    setError(null);
    const built = buildWritebackTargetInput({
      provider,
      name,
      credentialsRef,
      sourceKind,
      sourceSegmentId,
      sourceListId,
      tags,
      fieldRows,
      traitRows,
      syncInterval,
      advancedJson,
    });
    if ("error" in built) {
      setError(built.error);
      return;
    }
    const pending = operation.run(() => writebackApi.createTarget(built.input));
    if (!pending) return;
    try {
      const res = await pending;
      if (!mountedRef.current) return;
      if (res.error) {
        setError(
          res.error.status === 401 || res.error.status === 403
            ? "Admin access is required to create a write-back target."
            : clip(res.error.message),
        );
        return;
      }
      discardDraft();
      toast.success("Write-back target created");
      try {
        await onCreated();
      } catch (refreshError) {
        if (mountedRef.current) {
          toast.error({
            message: "Write-back target created, but the list couldn't refresh",
            detail: lifecycleOperationError(
              refreshError,
              "Refresh the target list to see the new target.",
            ),
          });
        }
      }
    } catch (reason) {
      if (mountedRef.current) {
        setError(
          lifecycleOperationError(
            reason,
            "The write-back target request failed.",
          ),
        );
      }
    }
  }

  const requestClose = (): void => {
    if (operation.promiseRef.current) return;
    if (draftDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    onClose();
  };

  const discardAndClose = (): void => {
    if (operation.promiseRef.current) return;
    discardDraft();
    onClose();
  };

  return (
    <>
      <Modal
        open
        onClose={requestClose}
        closeOnBackdrop={!operation.active}
        closeOnEscape={!operation.active}
        closeDisabled={operation.active}
        title="New write-back target"
      >
        <WritebackTargetFields
          available={available}
          provider={provider}
          setProvider={setProvider}
          name={name}
          setName={setName}
          credentialsRef={credentialsRef}
          setCredentialsRef={setCredentialsRef}
          sourceKind={sourceKind}
          setSourceKind={setSourceKind}
          sourceSegmentId={sourceSegmentId}
          setSourceSegmentId={setSourceSegmentId}
          sourceListId={sourceListId}
          setSourceListId={setSourceListId}
          tags={tags}
          setTags={setTags}
          fieldRows={fieldRows}
          setFieldRows={setFieldRows}
          traitRows={traitRows}
          setTraitRows={setTraitRows}
          syncInterval={syncInterval}
          setSyncInterval={setSyncInterval}
          advancedJson={advancedJson}
          setAdvancedJson={setAdvancedJson}
          segments={segments}
          segmentsLoaded={segmentsLoaded}
          error={error}
        />

        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={requestClose}
            disabled={operation.active}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={operation.active || available.length === 0}
            onClick={() => void submit()}
          >
            {operation.active ? "Creating…" : "Create write-back target"}
          </button>
        </ModalFooter>
      </Modal>
      <ConfirmModal
        open={discardConfirmOpen}
        title="Discard write-back target draft?"
        description="The provider, source, mapping, and schedule values in this draft will be lost."
        confirmLabel="Discard draft"
        danger
        busy={operation.active}
        onConfirm={discardAndClose}
        onClose={() => setDiscardConfirmOpen(false)}
      />
    </>
  );
}

interface WritebackTargetFieldsProps {
  available: WritebackProvider[];
  provider: string;
  setProvider: (value: string) => void;
  name: string;
  setName: (value: string) => void;
  credentialsRef: string;
  setCredentialsRef: (value: string) => void;
  sourceKind: "segment" | "list";
  setSourceKind: (value: "segment" | "list") => void;
  sourceSegmentId: string;
  setSourceSegmentId: (value: string) => void;
  sourceListId: string;
  setSourceListId: (value: string) => void;
  tags: string;
  setTags: (value: string) => void;
  fieldRows: KeyValueRow[];
  setFieldRows: (rows: KeyValueRow[]) => void;
  traitRows: KeyValueRow[];
  setTraitRows: (rows: KeyValueRow[]) => void;
  syncInterval: string;
  setSyncInterval: (value: string) => void;
  advancedJson: string;
  setAdvancedJson: (value: string) => void;
  segments: WritebackSegment[];
  segmentsLoaded: boolean;
  error: string | null;
}

function WritebackTargetFields(
  props: WritebackTargetFieldsProps,
): ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <FormField label="Provider" required>
        <select
          className="input"
          value={props.provider}
          onChange={(event) => props.setProvider(event.target.value)}
        >
          {props.available.length === 0 ? (
            <option value="">No write-back adapters available</option>
          ) : null}
          {props.available.map((item) => (
            <option key={item.provider} value={item.provider}>
              {providerLabel(item.provider)}
            </option>
          ))}
        </select>
      </FormField>
      <FormField
        label="Name"
        required
        help="Targets are keyed on (provider, name). Reusing a name updates that target instead of creating a new one — give each a distinct name."
      >
        <input
          className="input"
          value={props.name}
          onChange={(event) => props.setName(event.target.value)}
          placeholder={`${providerLabel(props.provider) || "Provider"} write-back`}
        />
      </FormField>
      <FormField
        label="Credential reference"
        required
        help="Raw credentials are never accepted — store the platform token in the vault and pass its reference."
      >
        <input
          className="input mono"
          value={props.credentialsRef}
          onChange={(event) => props.setCredentialsRef(event.target.value)}
          placeholder="vault://writeback/…"
        />
      </FormField>
      <WritebackSourceFields {...props} />
      <FormField
        label="Tags to apply"
        help="Comma-separated. Appended to the matched record on every member."
      >
        <input
          className="input"
          value={props.tags}
          onChange={(event) => props.setTags(event.target.value)}
          placeholder="Moosewave-VIP, Newsletter"
        />
      </FormField>
      <FormField label="Static fields" help="platform field → constant value">
        <KeyValueEditor
          rows={props.fieldRows}
          onChange={props.setFieldRows}
          keyPlaceholder="platform_field"
          valuePlaceholder="constant value"
          addLabel="Add static field"
        />
      </FormField>
      <FormField
        label="Trait mapping"
        help="platform field → Moosewave trait. Each member's own trait value is written — leave empty for constant-only sync. Predicted analytics available: _predicted_clv_cents, _churn_risk, _rfm_segment, _predicted_order_count."
      >
        <KeyValueEditor
          rows={props.traitRows}
          onChange={props.setTraitRows}
          keyPlaceholder="platform_field"
          valuePlaceholder="trait key (e.g. lifetime_value)"
          addLabel="Add trait mapping"
        />
      </FormField>
      <FormField label="Auto-sync interval" help="minutes, 0 = manual">
        <input
          className="input"
          type="number"
          min={0}
          step={1}
          value={props.syncInterval}
          onChange={(event) => props.setSyncInterval(event.target.value)}
        />
      </FormField>
      <FormField
        label="Advanced settings"
        help="JSON, optional. Provider-specific keys only (e.g. shop_domain, list_id, event_name, object)."
      >
        <textarea
          className="input mono"
          rows={2}
          value={props.advancedJson}
          onChange={(event) => props.setAdvancedJson(event.target.value)}
          placeholder='{"shop_domain": "acme.myshopify.com"}'
        />
      </FormField>
      {props.error ? (
        <div className="notice notice-error" role="alert">
          {props.error}
        </div>
      ) : null}
    </div>
  );
}

function WritebackSourceFields(
  props: WritebackTargetFieldsProps,
): ReactElement {
  return (
    <FormField label="Source" required>
      <div style={{ display: "flex", gap: 14, marginBottom: 6, fontSize: 13 }}>
        {(["segment", "list"] as const).map((kind) => (
          <label
            key={kind}
            style={{ display: "flex", gap: 4, alignItems: "center" }}
          >
            <input
              type="radio"
              name="writeback-source-kind"
              checked={props.sourceKind === kind}
              onChange={() => props.setSourceKind(kind)}
            />
            {kind === "segment" ? "Segment" : "List"}
          </label>
        ))}
      </div>
      {props.sourceKind === "segment" ? (
        <>
          <select
            className="input"
            value={props.sourceSegmentId}
            onChange={(event) => props.setSourceSegmentId(event.target.value)}
            aria-label="Source segment"
          >
            <option value="">Select a segment…</option>
            {props.segments.map((segment) => (
              <option key={segment.id} value={segment.id}>
                {segment.name}
              </option>
            ))}
          </select>
          {props.segmentsLoaded && props.segments.length === 0 ? (
            <p className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              No segments available — create one, or switch to List.
            </p>
          ) : null}
        </>
      ) : (
        <input
          className="input mono"
          value={props.sourceListId}
          onChange={(event) => props.setSourceListId(event.target.value)}
          placeholder="list id (uuid)"
        />
      )}
    </FormField>
  );
}

function KeyValueEditor({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
}: {
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
}): ReactElement {
  function update(i: number, patch: Partial<KeyValueRow>): void {
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {rows.map((row, i) => (
        <div key={row.id} style={{ display: "flex", gap: 6 }}>
          <input
            className="input mono"
            style={{ flex: 1 }}
            value={row.key}
            onChange={(e) => update(i, { key: e.target.value })}
            placeholder={keyPlaceholder}
            aria-label={`${keyPlaceholder} (row ${i + 1})`}
          />
          <input
            className="input mono"
            style={{ flex: 1 }}
            value={row.value}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder={valuePlaceholder}
            aria-label={`${valuePlaceholder} (row ${i + 1})`}
          />
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
            aria-label="Remove row"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        style={{ alignSelf: "flex-start" }}
        onClick={() => onChange([...rows, newRow()])}
      >
        + {addLabel}
      </button>
    </div>
  );
}
