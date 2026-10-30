/**
 * SubscriberCustomObjectLinks — SUB-011 custom objects on the profile.
 *
 * Renders the custom object records linked to a subscriber, grouped by
 * object type. Each record card shows a small properties preview plus
 * edit-relationship and unlink affordances. A linker modal binds a new
 * record (type → record selector + relationship label).
 *
 * Backed by:
 *   GET    /api/v1/subscribers/{id}/custom-objects
 *   POST   /api/v1/subscribers/{id}/custom-objects
 *   PATCH  /api/v1/subscribers/{id}/custom-objects/{link_id}
 *   DELETE /api/v1/subscribers/{id}/custom-objects/{link_id}
 * (apps/api/internal/customobjects/profile_links.go)
 */
import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type CustomObjectRecord,
  type CustomObjectType,
  type ProfileObjectLink,
  customObjectsApi,
  subscriberCustomObjectsApi,
} from "../../lib/api-client";
import { responseIdentityMatches } from "../../lib/api/subscriber-response-integrity";
import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";

interface Props {
  subscriberId: string | number;
  canMutate: boolean;
  /** Fired when the endpoint 404s so the parent can hide the tab. */
  onUnavailable?: () => void;
}

function profileLinkBelongsToSubscriber(
  link: ProfileObjectLink,
  subscriberId: string | number,
): boolean {
  if (
    typeof link.subscriberId === "string" &&
    responseIdentityMatches(subscriberId, link.subscriberId)
  ) {
    return true;
  }
  return (
    String(subscriberId).includes("@") &&
    typeof link.subscriberEmail === "string" &&
    responseIdentityMatches(subscriberId, link.subscriberEmail)
  );
}

function profileLinksAreValid(
  links: ProfileObjectLink[],
  subscriberId: string | number,
): boolean {
  if (!Array.isArray(links)) return false;
  const ids = new Set<string>();
  const tenantIds = new Set<string>();
  for (const link of links) {
    if (
      typeof link?.id !== "string" ||
      link.id.trim() === "" ||
      ids.has(link.id) ||
      typeof link.tenantId !== "string" ||
      link.tenantId.trim() === "" ||
      !profileLinkBelongsToSubscriber(link, subscriberId)
    ) {
      return false;
    }
    ids.add(link.id);
    tenantIds.add(link.tenantId);
  }
  return tenantIds.size <= 1;
}

function formatPropertyValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value !== "object") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "Value could not be displayed";
  }
}

function CustomObjectLinksLoadError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): ReactElement {
  return (
    <div role="alert" style={{ fontSize: 12 }}>
      {message}
      <div style={{ marginTop: 6 }}>
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  );
}

export function SubscriberCustomObjectLinks({
  subscriberId,
  canMutate,
  onUnavailable,
}: Props): ReactElement {
  const [links, setLinks] = useState<ProfileObjectLink[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Linker modal state.
  const [linkerOpen, setLinkerOpen] = useState(false);

  // Inline edit (relationship) per link id.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRelationship, setEditRelationship] = useState("");
  const [editBusy, setEditBusy] = useState(false);

  const [pendingUnlink, setPendingUnlink] = useState<ProfileObjectLink | null>(
    null,
  );
  const [unlinkBusy, setUnlinkBusy] = useState(false);
  const permissionReasonId = useId();
  const mountedRef = useRef(true);
  const requestGenerationRef = useRef(0);
  const loadRequestRef = useRef(0);
  const editRequestRef = useRef<string | null>(null);
  const unlinkRequestRef = useRef<string | null>(null);
  const onUnavailableRef = useRef(onUnavailable);

  useEffect(() => {
    onUnavailableRef.current = onUnavailable;
  }, [onUnavailable]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestGenerationRef.current += 1;
      loadRequestRef.current += 1;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    const generation = requestGenerationRef.current;
    const request = ++loadRequestRef.current;
    setLoading(true);
    setErr(null);
    let res: Awaited<ReturnType<typeof subscriberCustomObjectsApi.list>>;
    try {
      res = await subscriberCustomObjectsApi.list(subscriberId);
    } catch {
      if (
        mountedRef.current &&
        generation === requestGenerationRef.current &&
        request === loadRequestRef.current
      ) {
        setLoading(false);
        setErr(
          "Couldn't load custom objects. Check your connection and retry.",
        );
      }
      return;
    }
    if (
      !mountedRef.current ||
      generation !== requestGenerationRef.current ||
      request !== loadRequestRef.current
    ) {
      return;
    }
    setLoading(false);
    if (res.error) {
      if (res.error.kind === "http" && res.error.status === 404) {
        onUnavailableRef.current?.();
        setLinks([]);
        return;
      }
      setErr(res.error.message);
      return;
    }
    if (!profileLinksAreValid(res.data.items, subscriberId)) {
      setErr(
        "The server returned custom-object links for a different subscriber. The previous verified links were kept; retry the request.",
      );
      return;
    }
    setLinks(res.data.items);
  }, [subscriberId]);

  useEffect(() => {
    requestGenerationRef.current += 1;
    setLinks(null);
    setEditingId(null);
    setPendingUnlink(null);
    void load();
  }, [load]);

  // Group links by object type for the sectioned render.
  const grouped = useMemo<
    Array<{ key: string; label: string; rows: ProfileObjectLink[] }>
  >(() => {
    const map = new Map<
      string,
      { key: string; label: string; rows: ProfileObjectLink[] }
    >();
    for (const l of links ?? []) {
      const k = l.objectTypeId || l.objectTypeKey || "unknown";
      const existing = map.get(k);
      if (existing) {
        existing.rows.push(l);
      } else {
        map.set(k, {
          key: l.objectTypeKey || k,
          label: l.objectTypeLabel || l.objectTypeKey || "Custom object",
          rows: [l],
        });
      }
    }
    return Array.from(map.values());
  }, [links]);

  const startEdit = (link: ProfileObjectLink): void => {
    if (
      !canMutate ||
      editRequestRef.current !== null ||
      unlinkRequestRef.current !== null
    ) {
      return;
    }
    setEditingId(link.id);
    setEditRelationship(link.relationship || "");
  };

  const saveEdit = async (link: ProfileObjectLink): Promise<void> => {
    if (
      !canMutate ||
      editRequestRef.current !== null ||
      unlinkRequestRef.current !== null
    ) {
      return;
    }
    const generation = requestGenerationRef.current;
    const relationship = editRelationship.trim() || "related";
    editRequestRef.current = link.id;
    setEditBusy(true);
    let res: Awaited<ReturnType<typeof subscriberCustomObjectsApi.update>>;
    try {
      res = await subscriberCustomObjectsApi.update(subscriberId, link.id, {
        relationship,
      });
    } catch {
      if (mountedRef.current && generation === requestGenerationRef.current) {
        setEditBusy(false);
        toast.error("Couldn't update link. Check your connection and retry.");
      }
      editRequestRef.current = null;
      return;
    }
    editRequestRef.current = null;
    if (!mountedRef.current || generation !== requestGenerationRef.current)
      return;
    setEditBusy(false);
    if (res.error) {
      toast.error(`Couldn't update link: ${res.error.message}`);
      return;
    }
    if (
      !profileLinkBelongsToSubscriber(res.data, subscriberId) ||
      !responseIdentityMatches(link.id, res.data.id) ||
      !responseIdentityMatches(link.tenantId, res.data.tenantId) ||
      !responseIdentityMatches(link.objectTypeId, res.data.objectTypeId) ||
      !responseIdentityMatches(link.objectRecordId, res.data.objectRecordId)
    ) {
      toast.error(
        "Couldn't update link: the server returned a different custom-object link. Retry the request.",
      );
      return;
    }
    setEditingId(null);
    setLinks((prev) =>
      prev
        ? prev.map((l) =>
            l.id === link.id
              ? { ...l, relationship: res.data.relationship }
              : l,
          )
        : prev,
    );
    toast.success("Relationship updated");
  };

  const confirmUnlink = async (): Promise<void> => {
    if (
      !pendingUnlink ||
      !canMutate ||
      unlinkRequestRef.current !== null ||
      editRequestRef.current !== null
    )
      return;
    const target = pendingUnlink;
    const generation = requestGenerationRef.current;
    unlinkRequestRef.current = target.id;
    setUnlinkBusy(true);
    let res: Awaited<ReturnType<typeof subscriberCustomObjectsApi.unlink>>;
    try {
      res = await subscriberCustomObjectsApi.unlink(subscriberId, target.id);
    } catch {
      if (mountedRef.current && generation === requestGenerationRef.current) {
        setUnlinkBusy(false);
        toast.error("Couldn't unlink. Check your connection and retry.");
      }
      unlinkRequestRef.current = null;
      return;
    }
    unlinkRequestRef.current = null;
    if (!mountedRef.current || generation !== requestGenerationRef.current)
      return;
    setUnlinkBusy(false);
    if (res.error) {
      toast.error(`Couldn't unlink: ${res.error.message}`);
      return;
    }
    const id = target.id;
    setPendingUnlink(null);
    setLinks((prev) => (prev ? prev.filter((l) => l.id !== id) : prev));
    toast.success("Record unlinked");
  };

  if (loading && links === null) {
    return (
      <div className="muted" style={{ fontSize: 12 }} role="status">
        Loading linked custom-object records…
      </div>
    );
  }

  if (err && links === null) {
    return (
      <CustomObjectLinksLoadError
        message={`Couldn't load custom objects: ${err}`}
        onRetry={() => void load()}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {err ? (
        <CustomObjectLinksLoadError message={err} onRetry={() => void load()} />
      ) : null}
      <CustomObjectLinksView
        grouped={grouped}
        canMutate={canMutate}
        permissionReasonId={permissionReasonId}
        editingId={editingId}
        editRelationship={editRelationship}
        editBusy={editBusy}
        unlinkBusy={unlinkBusy}
        onOpenLinker={() => {
          if (!editBusy && !unlinkBusy) setLinkerOpen(true);
        }}
        onStartEdit={startEdit}
        onCancelEdit={() => setEditingId(null)}
        onEditRelationship={setEditRelationship}
        onSaveEdit={saveEdit}
        onRequestUnlink={setPendingUnlink}
      />
      {linkerOpen ? (
        <LinkRecordModal
          subscriberId={subscriberId}
          onClose={() => setLinkerOpen(false)}
          onLinked={(created) => {
            setLinkerOpen(false);
            // Refetch so the new row picks up denormalized type/properties.
            void load();
            if (created) toast.success("Record linked");
          }}
        />
      ) : null}

      <ConfirmModal
        open={pendingUnlink !== null}
        title="Unlink record?"
        description="Removes the link between this subscriber and the custom object record. The record itself is not deleted."
        confirmLabel="Unlink"
        danger
        busy={unlinkBusy}
        onClose={() => {
          if (unlinkRequestRef.current === null) setPendingUnlink(null);
        }}
        onConfirm={() => void confirmUnlink()}
      />
    </div>
  );
}

type GroupedLinks = Array<{
  key: string;
  label: string;
  rows: ProfileObjectLink[];
}>;

function CustomObjectLinksView({
  grouped,
  canMutate,
  permissionReasonId,
  editingId,
  editRelationship,
  editBusy,
  unlinkBusy,
  onOpenLinker,
  onStartEdit,
  onCancelEdit,
  onEditRelationship,
  onSaveEdit,
  onRequestUnlink,
}: {
  grouped: GroupedLinks;
  canMutate: boolean;
  permissionReasonId: string;
  editingId: string | null;
  editRelationship: string;
  editBusy: boolean;
  unlinkBusy: boolean;
  onOpenLinker: () => void;
  onStartEdit: (link: ProfileObjectLink) => void;
  onCancelEdit: () => void;
  onEditRelationship: (value: string) => void;
  onSaveEdit: (link: ProfileObjectLink) => Promise<void>;
  onRequestUnlink: (link: ProfileObjectLink) => void;
}): ReactElement {
  return (
    <>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span className="label" style={{ margin: 0 }}>
          Linked records
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={editBusy || unlinkBusy}
          aria-disabled={!canMutate || undefined}
          aria-describedby={!canMutate ? permissionReasonId : undefined}
          onClick={() => {
            if (canMutate) onOpenLinker();
          }}
        >
          Link record
        </button>
      </div>
      {!canMutate ? (
        <p
          id={permissionReasonId}
          className="muted"
          role="status"
          style={{ fontSize: 11, margin: 0 }}
        >
          Viewer role can inspect linked records but can&apos;t link, edit, or
          unlink them.
        </p>
      ) : null}
      {grouped.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          No custom object records linked to this subscriber yet.
        </div>
      ) : (
        grouped.map((group) => (
          <section key={group.key}>
            <div className="label">{group.label}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {group.rows.map((link) => (
                <LinkedRecordCard
                  key={link.id}
                  link={link}
                  editing={editingId === link.id}
                  editRelationship={editRelationship}
                  editBusy={editBusy}
                  unlinkBusy={unlinkBusy}
                  canMutate={canMutate}
                  permissionReasonId={permissionReasonId}
                  onStartEdit={onStartEdit}
                  onCancelEdit={onCancelEdit}
                  onEditRelationship={onEditRelationship}
                  onSaveEdit={onSaveEdit}
                  onRequestUnlink={onRequestUnlink}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </>
  );
}

function LinkedRecordCard({
  link,
  editing,
  editRelationship,
  editBusy,
  unlinkBusy,
  canMutate,
  permissionReasonId,
  onStartEdit,
  onCancelEdit,
  onEditRelationship,
  onSaveEdit,
  onRequestUnlink,
}: {
  link: ProfileObjectLink;
  editing: boolean;
  editRelationship: string;
  editBusy: boolean;
  unlinkBusy: boolean;
  canMutate: boolean;
  permissionReasonId: string;
  onStartEdit: (link: ProfileObjectLink) => void;
  onCancelEdit: () => void;
  onEditRelationship: (value: string) => void;
  onSaveEdit: (link: ProfileObjectLink) => Promise<void>;
  onRequestUnlink: (link: ProfileObjectLink) => void;
}): ReactElement {
  const properties = Object.entries(link.properties ?? {});
  const permissionDescription = !canMutate ? permissionReasonId : undefined;
  return (
    <article
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "6px 8px",
        background: "var(--pw-bg-elev-2)",
        borderRadius: 4,
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span style={{ minWidth: 0 }}>
          <span className="muted">External record ID:</span>{" "}
          <code style={{ fontSize: 11, overflowWrap: "anywhere" }}>
            {link.externalId || link.objectRecordId}
          </code>
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        {!editing ? (
          <span style={{ fontSize: 11 }}>
            <span className="muted">Relationship:</span>{" "}
            <span className="badge" style={{ fontSize: 9 }}>
              {link.relationship || "related"}
            </span>
          </span>
        ) : null}
        <button
          type="button"
          className="btn btn-xs btn-ghost"
          style={{ fontSize: 10 }}
          disabled={editBusy || unlinkBusy}
          aria-disabled={!canMutate || undefined}
          aria-describedby={permissionDescription}
          onClick={() => {
            if (!canMutate) return;
            editing ? onCancelEdit() : onStartEdit(link);
          }}
        >
          {editing ? "Cancel" : "Edit"}
        </button>
        <button
          type="button"
          className="btn btn-xs btn-ghost"
          style={{ fontSize: 10, color: "var(--pw-danger)" }}
          disabled={unlinkBusy || editBusy}
          aria-disabled={!canMutate || undefined}
          aria-describedby={permissionDescription}
          onClick={() => {
            if (canMutate) onRequestUnlink(link);
          }}
        >
          Unlink
        </button>
      </div>
      {editing ? (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            alignItems: "end",
          }}
        >
          <label style={{ flex: "1 1 180px", display: "grid", gap: 3 }}>
            <span className="muted" style={{ fontSize: 11 }}>
              Relationship label
            </span>
            <input
              className="input"
              value={editRelationship}
              placeholder="related"
              disabled={editBusy}
              onChange={(event) => onEditRelationship(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.nativeEvent.isComposing &&
                  event.nativeEvent.keyCode !== 229
                ) {
                  void onSaveEdit(link);
                }
              }}
              style={{ fontSize: 12 }}
            />
          </label>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={editBusy}
            onClick={() => void onSaveEdit(link)}
          >
            {editBusy ? "Saving…" : "Save"}
          </button>
        </div>
      ) : properties.length > 0 ? (
        <details>
          <summary
            className="muted"
            style={{ cursor: "pointer", fontSize: 11 }}
          >
            Properties ({properties.length})
          </summary>
          <dl
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(min(140px, 100%), 1fr))",
              gap: "4px 8px",
              margin: "6px 0 0",
              fontSize: 11,
            }}
          >
            {properties.map(([key, value]) => (
              <div key={key} style={{ minWidth: 0 }}>
                <dt className="muted" style={{ overflowWrap: "anywhere" }}>
                  {key}
                </dt>
                <dd
                  style={{
                    margin: 0,
                    fontFamily: "var(--pw-font-mono)",
                    overflowWrap: "anywhere",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {formatPropertyValue(value)}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </article>
  );
}

/* ------- link-record modal ---------------------------------------- */

function LinkRecordModal({
  subscriberId,
  onClose,
  onLinked,
}: {
  subscriberId: string | number;
  onClose: () => void;
  onLinked: (created: boolean) => void;
}): ReactElement {
  const [types, setTypes] = useState<CustomObjectType[] | null>(null);
  const [typeId, setTypeId] = useState("");
  const [records, setRecords] = useState<CustomObjectRecord[] | null>(null);
  const [recordId, setRecordId] = useState("");
  const [relationship, setRelationship] = useState("related");
  const [busy, setBusy] = useState(false);
  const [typesError, setTypesError] = useState<string | null>(null);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const availabilityId = useId();
  const mountedRef = useRef(true);
  const typesRequestRef = useRef(0);
  const recordsRequestRef = useRef(0);
  const submitRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      typesRequestRef.current += 1;
      recordsRequestRef.current += 1;
    };
  }, []);

  const loadTypes = useCallback(async (): Promise<void> => {
    const request = ++typesRequestRef.current;
    setTypes(null);
    setTypesError(null);
    let res: Awaited<ReturnType<typeof customObjectsApi.listTypes>>;
    try {
      res = await customObjectsApi.listTypes();
    } catch {
      if (mountedRef.current && request === typesRequestRef.current) {
        setTypesError(
          "Couldn't load object types. Check your connection and retry.",
        );
        setTypes([]);
      }
      return;
    }
    if (!mountedRef.current || request !== typesRequestRef.current) return;
    if (res.error) {
      setTypesError(res.error.message);
      setTypes([]);
      return;
    }
    const items = res.data.items ?? [];
    setTypes(items);
    if (items[0]) setTypeId(items[0].id);
  }, []);

  useEffect(() => {
    void loadTypes();
  }, [loadTypes]);

  // Load records for the selected type.
  useEffect(() => {
    if (!typeId) {
      setRecords(null);
      setRecordId("");
      setRecordsError(null);
      return;
    }
    const request = ++recordsRequestRef.current;
    setRecords(null);
    setRecordId("");
    setRecordsError(null);
    void (async () => {
      let res: Awaited<ReturnType<typeof customObjectsApi.listRecords>>;
      try {
        res = await customObjectsApi.listRecords(typeId, { limit: 100 });
      } catch {
        if (mountedRef.current && request === recordsRequestRef.current) {
          setRecordsError(
            "Couldn't load records. Check your connection and choose the type again.",
          );
          setRecords([]);
        }
        return;
      }
      if (!mountedRef.current || request !== recordsRequestRef.current) return;
      if (res.error) {
        setRecordsError(res.error.message);
        setRecords([]);
        return;
      }
      const items = res.data.items ?? [];
      setRecords(items);
      if (items[0]) setRecordId(items[0].id);
    })();
    return () => {
      recordsRequestRef.current += 1;
    };
  }, [typeId]);

  const submit = async (): Promise<void> => {
    if (!recordId || submitRef.current) return;
    submitRef.current = true;
    setBusy(true);
    let res: Awaited<ReturnType<typeof subscriberCustomObjectsApi.link>>;
    try {
      res = await subscriberCustomObjectsApi.link(subscriberId, {
        objectRecordId: recordId,
        relationship: relationship.trim() || "related",
      });
    } catch {
      submitRef.current = false;
      if (mountedRef.current) {
        setBusy(false);
        toast.error("Couldn't link record. Check your connection and retry.");
      }
      return;
    }
    submitRef.current = false;
    if (!mountedRef.current) return;
    setBusy(false);
    if (res.error) {
      const msg =
        res.error.kind === "http" && res.error.status === 409
          ? "This record is already linked with that relationship."
          : res.error.message;
      toast.error(`Couldn't link record: ${msg}`);
      return;
    }
    if (
      !profileLinkBelongsToSubscriber(res.data, subscriberId) ||
      typeof res.data.id !== "string" ||
      res.data.id.trim() === "" ||
      !responseIdentityMatches(recordId, res.data.objectRecordId)
    ) {
      toast.error(
        "Couldn't link record: the server returned a link for a different subscriber or record. Retry the request.",
      );
      return;
    }
    onLinked(true);
  };

  return (
    <Modal
      open
      onClose={() => {
        if (!submitRef.current) onClose();
      }}
      title="Link a record"
      description="Bind a custom object record to this subscriber's profile."
      size="sm"
      closeDisabled={busy}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {typesError ? (
          <div role="alert" style={{ fontSize: 12 }}>
            Couldn&apos;t load object types: {typesError}
            <div style={{ marginTop: 6 }}>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void loadTypes()}
              >
                Retry types
              </button>
            </div>
          </div>
        ) : null}
        {types == null ? (
          <div className="muted" style={{ fontSize: 12 }} role="status">
            Loading object types…
          </div>
        ) : typesError ? null : types.length === 0 ? (
          <div className="muted" style={{ fontSize: 12 }}>
            No custom object types defined yet. Create one in Custom Objects
            first.
          </div>
        ) : (
          <>
            <label style={{ fontSize: 12, display: "grid", gap: 4 }}>
              <span className="muted">Object type</span>
              <select
                className="input"
                value={typeId}
                disabled={!types || busy}
                onChange={(e) => setTypeId(e.target.value)}
              >
                {(types ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            {recordsError ? (
              <div role="alert" style={{ fontSize: 12 }}>
                Couldn&apos;t load records: {recordsError}
              </div>
            ) : null}
            <label style={{ fontSize: 12, display: "grid", gap: 4 }}>
              <span className="muted">Record</span>
              <select
                className="input"
                value={recordId}
                disabled={!records || records.length === 0 || busy}
                onChange={(e) => setRecordId(e.target.value)}
              >
                {records == null ? (
                  <option value="">Loading…</option>
                ) : records.length === 0 ? (
                  <option value="">No records for this type</option>
                ) : (
                  records.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.externalId || r.id}
                    </option>
                  ))
                )}
              </select>
            </label>
            <label style={{ fontSize: 12, display: "grid", gap: 4 }}>
              <span className="muted">Relationship</span>
              <input
                className="input"
                value={relationship}
                placeholder="related"
                disabled={busy}
                onChange={(e) => setRelationship(e.target.value)}
              />
            </label>
          </>
        )}
      </div>
      <p
        id={availabilityId}
        className="muted"
        role="status"
        style={{ fontSize: 11, margin: "8px 0 0" }}
      >
        {busy
          ? "Linking the selected record. This dialog stays open until the request settles."
          : recordId
            ? "Linking creates a relationship; it does not modify or duplicate the custom-object record."
            : "Choose an object type with at least one record before linking."}
      </p>
      <ModalFooter>
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (!submitRef.current) onClose();
          }}
          disabled={busy}
          aria-describedby={availabilityId}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          aria-disabled={!recordId || undefined}
          aria-describedby={availabilityId}
          onClick={() => void submit()}
        >
          {busy ? "Linking…" : "Link record"}
        </button>
      </ModalFooter>
    </Modal>
  );
}
