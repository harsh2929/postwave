/**
 * FederatedIdentityPanel — SUB-023 cross-tenant subscriber federation for
 * agency / MSP workspaces, shown in the subscriber slideover Profile tab.
 *
 * Agency tenancy links a child-workspace subscriber to a *master* subscriber
 * in the agency parent workspace, so the same human across several of an
 * agency's client workspaces is represented as one master identity. This
 * panel lists those links and (for write-scoped operators) supports creating
 * a manual link or deleting one.
 *
 * Backed by:
 *   GET    /api/v1/subscribers/{id}/federated-links
 *   POST   /api/v1/subscribers/{id}/federated-links
 *   DELETE /api/v1/subscribers/{id}/federated-links/{master_subscriber_id}
 * (apps/api/internal/subscribers/federation.go).
 *
 * HONEST-UI: the federation rows live in the *child* tenant and point UP to a
 * master subscriber in the agency parent. RLS gives the child no read path
 * into parent-workspace names or profile PII. The primary row therefore says
 * what is known (a verified master link + provenance) and keeps returned UUIDs
 * in an explicit technical-details disclosure, never a fabricated org label.
 * A 404 (routes not deployed) hides the section via onUnavailable.
 */

import { type ReactElement, useEffect, useRef, useState } from "react";

import { type SubscriberFederationLink, api } from "../../lib/api-client";
import { writeClipboardText } from "../../lib/clipboard";
import { fmtDateTime } from "../../lib/format-date";
import { ConfirmModal } from "../ConfirmModal";
import { FormField } from "../FormField";
import { toast } from "../Toast";

interface Props {
  /** Subscriber UUID (the federation endpoints key links by it). */
  subscriberId: string;
  /** Exact child-profile revision reviewed with the link snapshot. */
  subscriberVersion: string | undefined;
  /** Whether the session may mutate (write:subscribers scope). */
  canMutate: boolean;
  /** Fired when the federation routes are not deployed (404). */
  onUnavailable?: () => void;
}

type MatchType = "manual" | "email" | "external_id";

const MATCH_TYPE_LABEL: Record<string, string> = {
  manual: "Manual link",
  email: "Matched on email",
  external_id: "Matched on external ID",
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Shorten a UUID for compact display while keeping the full value copyable. */
function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function CopyableFederationId({
  id,
  label,
}: {
  id: string;
  label: string;
}): ReactElement {
  const copy = async (): Promise<void> => {
    const result = await writeClipboardText(id, {
      contentClass: "personal",
      label,
    });
    if (result.ok) toast.success(`Copied ${label.toLowerCase()}`);
    else toast.error(`Couldn't copy ${label.toLowerCase()}.`);
  };
  return (
    <span style={{ alignItems: "center", display: "flex", gap: 6 }}>
      <span
        style={{ fontFamily: "var(--pw-font-mono)" }}
        aria-label={`${label}: ${id}`}
      >
        {shortId(id)}
      </span>
      <button
        type="button"
        className="btn btn-xs"
        onClick={() => void copy()}
        aria-label={`Copy ${label.toLowerCase()}`}
      >
        Copy
      </button>
    </span>
  );
}

interface FederatedIdentityLinksProps {
  links: SubscriberFederationLink[];
  canMutate: boolean;
  rowBusy: string | null;
  onRequestDelete: (link: SubscriberFederationLink) => void;
}

function FederatedIdentityLinks({
  links,
  canMutate,
  rowBusy,
  onRequestDelete,
}: FederatedIdentityLinksProps): ReactElement | null {
  if (links.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {links.map((link) => (
        <div
          key={link.id}
          style={{
            background: "var(--pw-bg-elev-2)",
            borderRadius: 4,
            padding: "8px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 650 }}>
                Master identity linked
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                Agency parent ·{" "}
                {MATCH_TYPE_LABEL[link.match_type] ?? "Recorded match"}
              </div>
            </div>
            {canMutate ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onRequestDelete(link)}
                disabled={rowBusy === link.master_subscriber_id}
              >
                {rowBusy === link.master_subscriber_id ? "Removing…" : "Unlink"}
              </button>
            ) : null}
          </div>
          <div style={{ display: "grid", gap: 5, fontSize: 11 }}>
            {link.match_key ? (
              <div>
                <span className="muted">Match evidence · </span>
                <span style={{ overflowWrap: "anywhere" }}>
                  {link.match_key}
                </span>
              </div>
            ) : null}
            <div>
              <span className="muted">Linked</span>
              <span> · {fmtDateTime(link.created_at)}</span>
            </div>
            <details>
              <summary
                style={{ cursor: "pointer", color: "var(--pw-text-muted)" }}
              >
                Technical identifiers
              </summary>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "120px minmax(0, 1fr)",
                  gap: "5px 8px",
                  marginTop: 7,
                }}
              >
                <span className="muted">Parent workspace</span>
                <CopyableFederationId
                  id={link.parent_tenant_id}
                  label="Parent workspace ID"
                />
                <span className="muted">Master subscriber</span>
                <CopyableFederationId
                  id={link.master_subscriber_id}
                  label="Master subscriber ID"
                />
              </div>
              <p className="muted" style={{ margin: "7px 0 0", fontSize: 10 }}>
                Parent-workspace names and profile details stay private in this
                child workspace. Open an authorized parent workspace to inspect
                the linked profile.
              </p>
            </details>
          </div>
        </div>
      ))}
    </div>
  );
}

interface FederatedIdentityFormProps {
  parentTenantId: string;
  masterSubscriberId: string;
  matchType: MatchType;
  adding: boolean;
  hasExistingLinks: boolean;
  onParentTenantChange: (value: string) => void;
  onMasterSubscriberChange: (value: string) => void;
  onMatchTypeChange: (value: MatchType) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

function FederatedIdentityForm({
  parentTenantId,
  masterSubscriberId,
  matchType,
  adding,
  hasExistingLinks,
  onParentTenantChange,
  onMasterSubscriberChange,
  onMatchTypeChange,
  onSubmit,
  onCancel,
}: FederatedIdentityFormProps): ReactElement {
  const parentError =
    parentTenantId.trim() && !UUID_PATTERN.test(parentTenantId.trim())
      ? "Enter a valid parent workspace UUID."
      : null;
  const masterError =
    masterSubscriberId.trim() && !UUID_PATTERN.test(masterSubscriberId.trim())
      ? "Enter a valid master subscriber UUID."
      : null;
  const ready =
    UUID_PATTERN.test(parentTenantId.trim()) &&
    UUID_PATTERN.test(masterSubscriberId.trim());
  return (
    <div
      style={{
        marginTop: hasExistingLinks ? 8 : 0,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        background: "var(--pw-bg-elev-2)",
        borderRadius: 4,
        padding: "10px",
      }}
    >
      <div className="muted" style={{ fontSize: 11, lineHeight: 1.45 }}>
        Use the exact IDs from an authorized agency-parent workspace. Parent
        names and profile details are intentionally not exposed across the
        child-workspace privacy boundary.
      </div>
      <FormField
        label="Parent workspace ID"
        htmlFor="fed-parent-tenant"
        error={parentError}
      >
        <input
          id="fed-parent-tenant"
          className="input"
          value={parentTenantId}
          onChange={(event) => onParentTenantChange(event.target.value)}
          placeholder="Agency parent tenant UUID"
          autoComplete="off"
          spellCheck={false}
          maxLength={36}
          style={{ fontFamily: "var(--pw-font-mono)", fontSize: 12 }}
        />
      </FormField>
      <FormField
        label="Master subscriber ID"
        htmlFor="fed-master-subscriber"
        error={masterError}
      >
        <input
          id="fed-master-subscriber"
          className="input"
          value={masterSubscriberId}
          onChange={(event) => onMasterSubscriberChange(event.target.value)}
          placeholder="Subscriber UUID in the parent workspace"
          autoComplete="off"
          spellCheck={false}
          maxLength={36}
          style={{ fontFamily: "var(--pw-font-mono)", fontSize: 12 }}
        />
      </FormField>
      <FormField label="Match type" htmlFor="fed-match-type">
        <select
          id="fed-match-type"
          className="input"
          value={matchType}
          onChange={(event) =>
            onMatchTypeChange(event.target.value as MatchType)
          }
        >
          <option value="manual">Manual link</option>
          <option value="email">Matched on email</option>
          <option value="external_id">Matched on external ID</option>
        </select>
      </FormField>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={onSubmit}
          disabled={adding || !ready}
        >
          {adding ? "Linking…" : "Link"}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onCancel}
          disabled={adding}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function FederatedIdentityPanelBody({
  subscriberId,
  subscriberVersion,
  canMutate,
  onUnavailable,
}: Props): ReactElement | null {
  const activeRef = useRef(true);
  const [links, setLinks] = useState<SubscriberFederationLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [currentVersion, setCurrentVersion] = useState(subscriberVersion);

  // Add-form state (manual federation link).
  const [showForm, setShowForm] = useState(false);
  const [parentTenantId, setParentTenantId] = useState("");
  const [masterSubscriberId, setMasterSubscriberId] = useState("");
  const [matchType, setMatchType] = useState<MatchType>("manual");
  const [adding, setAdding] = useState(false);
  const addInFlightRef = useRef(false);
  const deleteInFlightRef = useRef(new Set<string>());

  // Per-row delete confirm + in-flight guard (keyed by master subscriber id).
  const [pendingDelete, setPendingDelete] =
    useState<SubscriberFederationLink | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setErrMsg(null);
    setLinks([]);
    void (async () => {
      try {
        const res = await api.listSubscriberFederatedLinks(subscriberId, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (res.error) {
          if (res.error.kind === "http" && res.error.status === 404) {
            onUnavailable?.();
            return;
          }
          setErrMsg("Federated identities could not be loaded.");
          return;
        }
        setLinks(res.data.items ?? []);
        if (res.data.subscriber_version) {
          setCurrentVersion(res.data.subscriber_version);
        }
      } catch {
        if (!controller.signal.aborted) {
          setErrMsg("Federated identities could not be loaded.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadNonce, subscriberId]);

  const resetForm = (): void => {
    setParentTenantId("");
    setMasterSubscriberId("");
    setMatchType("manual");
    setShowForm(false);
  };

  const addLink = async (): Promise<void> => {
    if (!canMutate || !currentVersion || addInFlightRef.current) return;
    const parent = parentTenantId.trim();
    const master = masterSubscriberId.trim();
    if (!UUID_PATTERN.test(parent) || !UUID_PATTERN.test(master)) return;
    addInFlightRef.current = true;
    setAdding(true);
    try {
      const res = await api.createSubscriberFederatedLink(
        subscriberId,
        {
          parent_tenant_id: parent,
          master_subscriber_id: master,
          match_type: matchType,
        },
        currentVersion,
      );
      if (!activeRef.current) return;
      if (res.error) {
        const detail =
          res.error.code === "parent_not_agency"
            ? "That workspace is not this workspace's agency parent."
            : "Review both IDs and try again. No link was created.";
        toast.error({ message: "Couldn't federate", detail });
        return;
      }
      setLinks((prev) => [
        res.data,
        ...prev.filter(
          (link) => link.master_subscriber_id !== res.data.master_subscriber_id,
        ),
      ]);
      if (res.data?.subscriber_version) {
        setCurrentVersion(res.data.subscriber_version);
      }
      toast.success({ message: "Federated identity linked" });
      resetForm();
    } catch {
      if (activeRef.current) {
        toast.error({
          message: "Couldn't federate",
          detail: "Check your connection and try again. No link was created.",
        });
      }
    } finally {
      addInFlightRef.current = false;
      if (activeRef.current) setAdding(false);
    }
  };

  const deleteLink = async (link: SubscriberFederationLink): Promise<void> => {
    if (
      !canMutate ||
      !currentVersion ||
      deleteInFlightRef.current.has(link.master_subscriber_id)
    ) {
      return;
    }
    deleteInFlightRef.current.add(link.master_subscriber_id);
    setRowBusy(link.master_subscriber_id);
    try {
      const res = await api.deleteSubscriberFederatedLink(
        subscriberId,
        link.master_subscriber_id,
        currentVersion,
      );
      if (!activeRef.current) return;
      if (res.error) {
        toast.error({
          message: "Couldn't remove link",
          detail: "No link was removed. Review the latest profile and retry.",
        });
        return;
      }
      setLinks((prev) =>
        prev.filter(
          (item) => item.master_subscriber_id !== link.master_subscriber_id,
        ),
      );
      if (res.data?.subscriber_version) {
        setCurrentVersion(res.data.subscriber_version);
      }
      setPendingDelete(null);
      toast.success({ message: "Federated identity unlinked" });
    } catch {
      if (activeRef.current) {
        toast.error({
          message: "Couldn't remove link",
          detail: "Check your connection and try again. No link was removed.",
        });
      }
    } finally {
      deleteInFlightRef.current.delete(link.master_subscriber_id);
      if (activeRef.current) setRowBusy(null);
    }
  };

  if (loading) {
    return (
      <section>
        <div className="label">Federated identity</div>
        <div className="skel" style={{ height: 48 }} />
      </section>
    );
  }

  return (
    <section>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 4,
        }}
      >
        <div className="label" style={{ marginBottom: 0 }}>
          Federated identity
        </div>
        {canMutate && currentVersion && !showForm ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setShowForm(true)}
          >
            Link parent identity…
          </button>
        ) : null}
      </div>

      {errMsg ? (
        <div role="alert" style={{ fontSize: 12 }}>
          <span className="muted">{errMsg}</span>
          <div style={{ marginTop: 6 }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setReloadNonce((current) => current + 1)}
            >
              Retry federation links
            </button>
          </div>
        </div>
      ) : links.length === 0 && !showForm ? (
        <div className="muted" style={{ fontSize: 12 }}>
          Not federated. Link this profile to a master subscriber in the agency
          parent workspace to represent the same person across client workspaces
          as one identity.
        </div>
      ) : null}

      <FederatedIdentityLinks
        links={links}
        canMutate={canMutate}
        rowBusy={rowBusy}
        onRequestDelete={setPendingDelete}
      />

      {showForm && canMutate && currentVersion ? (
        <FederatedIdentityForm
          parentTenantId={parentTenantId}
          masterSubscriberId={masterSubscriberId}
          matchType={matchType}
          adding={adding}
          hasExistingLinks={links.length > 0}
          onParentTenantChange={setParentTenantId}
          onMasterSubscriberChange={setMasterSubscriberId}
          onMatchTypeChange={setMatchType}
          onSubmit={() => void addLink()}
          onCancel={resetForm}
        />
      ) : null}

      <ConfirmModal
        open={pendingDelete !== null}
        title="Unlink federated identity?"
        description="This removes the cross-tenant link to the master subscriber in the parent workspace. The subscribers themselves are not changed; you can re-link later."
        confirmLabel={rowBusy ? "Removing…" : "Unlink"}
        danger
        busy={rowBusy !== null}
        onClose={() => (rowBusy ? undefined : setPendingDelete(null))}
        onConfirm={() => {
          if (pendingDelete) void deleteLink(pendingDelete);
        }}
      />
    </section>
  );
}

/**
 * Key the stateful controller by subscriber so draft and confirmation state
 * cannot carry over when the slideover switches profiles. The body also
 * suppresses mutation completions after this keyed instance unmounts.
 */
export function FederatedIdentityPanel(props: Props): ReactElement {
  return <FederatedIdentityPanelBody key={props.subscriberId} {...props} />;
}
