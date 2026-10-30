/**
 * SCIM — token + role-mapping admin.
 *
 * Two stacked panels:
 *
 *   Tokens         List of bearer tokens used by the tenant's
 *                  IdP (Okta / Azure AD / JumpCloud) to authenticate
 *                  to /scim/v2/*. New tokens are returned ONCE in the
 *                  modal — the operator must copy them immediately.
 *
 *   Role mappings  Groups → Moosewave roles. When SAML asserts a user,
 *                  the JIT bridge walks the precedence-ordered
 *                  mappings to resolve owner/admin/editor/viewer.
 *                  Wildcard "*" matches when no group matches.
 *
 * v2 (audit pass):
 *   - Native confirms replaced with ConfirmModal (token revoke is
 *     type-to-confirm — once revoked the token can't be re-issued).
 *   - Raw `modal-overlay` divs replaced with the shared Modal
 *     component (focus trap, Esc, design-system styling).
 *   - Clipboard errors are now surfaced as a toast (pre-fix the
 *     `.catch(() => {})` swallowed permission-denied / clipboard-
 *     unsupported failures, so the operator got a "Copied" toast
 *     for a no-op).
 *   - Precedence input validates 0..1000 (matching the backend cap) and
 *     surfaces inline errors instead of silently coercing to 100 on bad
 *     input — the server rewrites out-of-range values to 100 with no error.
 */

import { type ReactElement, useCallback, useEffect, useState } from "react";

import { ConfirmModal } from "../components/ConfirmModal";
import { HeroEmptyState } from "../components/HeroEmptyState";
import { InlineHelp } from "../components/InlineHelp";
import { Modal, ModalFooter } from "../components/Modal";
import { SectionHeader } from "../components/SectionHeader";
import { toast } from "../components/Toast";
import { ValuePropCard } from "../components/ValuePropCard";
import {
  type ScimRoleMapping,
  type ScimTokenInfo,
  type ScimTokenMinted,
  api,
} from "../lib/api-client";
import { fmtDate } from "../lib/format-date";
import { clipboardSuccessDetail, writeClipboardText } from "../lib/clipboard";
import { HERO } from "../lib/heroAssets";
import { useCanAdmin } from "../lib/store";
import { useShownOnceSecretLifecycle } from "../hooks/useShownOnceSecretLifecycle";
import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
  useSingleFlightOperation,
} from "../hooks/useSettingsDraftLifecycle";

export function SCIM(): ReactElement {
  return (
    <div className="page page-with-pad">
      <div className="page-header">
        <h1>SCIM</h1>
        <p className="muted" style={{ fontSize: 13 }}>
          Identity-provider integration. Mint bearer tokens for your IdP, then
          map IdP groups to Moosewave roles for JIT provisioning.
        </p>
      </div>
      <TokensPanel />
      <hr style={{ margin: "24px 0" }} />
      <RoleMappingsPanel />
    </div>
  );
}

/* ---------- shared clipboard helper ---------- */

/**
 * Copy text to clipboard with proper error reporting. Pre-fix the
 * page silently swallowed clipboard failures (permission denied,
 * unsupported context, Safari pre-13) and showed "Copied" anyway —
 * the operator pasted, got nothing, and re-tried until they noticed.
 */
async function copyOrFail(text: string, label: string): Promise<void> {
  const secret = label.trim().toLowerCase() === "token";
  const result = await writeClipboardText(text, {
    contentClass: secret ? "secret" : "public",
    label,
    clearIfUnchangedAfterMs: secret ? 60_000 : undefined,
  });
  if (result.ok) {
    toast.success({
      message: `Copied ${label}`,
      detail: clipboardSuccessDetail(result),
    });
  } else toast.error(result.message);
}

/* ---------- Tokens ---------- */

function TokensPanel(): ReactElement {
  const canAdmin = useCanAdmin();
  const [rows, setRows] = useState<ScimTokenInfo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [minted, setMinted] = useState<ScimTokenMinted | null>(null);
  const [confirmSecretClose, setConfirmSecretClose] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<ScimTokenInfo | null>(
    null,
  );
  const [revokeBusy, setRevokeBusy] = useState(false);
  const tokenOperation = useSingleFlightOperation({
    ownerId: "scim-token-management",
    label: "SCIM token operation",
    detail: "Wait for the SCIM token request to finish before leaving.",
  });
  const tokenSecretLifecycle = useShownOnceSecretLifecycle(
    "scim-token",
    "SCIM token",
    minted !== null,
  );

  const load = async (): Promise<void> => {
    setLoading(true);
    const res = await api.scimTokensList();
    setLoading(false);
    if (res.error) {
      setErr(res.error.message);
      setRows([]);
      return;
    }
    setErr(null);
    setRows(res.data?.tokens ?? []);
  };

  useEffect(() => {
    void load();
  }, []);

  const revoke = async (): Promise<void> => {
    if (!pendingRevoke) return;
    const target = pendingRevoke;
    const request = tokenOperation.run(() => api.scimTokenRevoke(target.id));
    if (!request) return;
    setRevokeBusy(true);
    let res: Awaited<ReturnType<typeof api.scimTokenRevoke>>;
    try {
      res = await request;
    } catch (error) {
      toast.error(
        `Revoke failed: ${lifecycleOperationError(error, "The SCIM token revoke request failed.")}`,
      );
      return;
    } finally {
      setRevokeBusy(false);
    }
    if (res.error) {
      toast.error(
        res.error.code
          ? `Revoke failed [${res.error.code}]: ${res.error.message}`
          : `Revoke failed: ${res.error.message}`,
      );
      return;
    }
    toast.success("Token revoked");
    setPendingRevoke((current) => (current?.id === target.id ? null : current));
    await load();
  };

  return (
    <div>
      <SectionHeader
        title="Tokens"
        description="Bearer tokens your IdP (Okta, Azure AD, Google Workspace) uses to authenticate SCIM requests."
      />

      {/* Value prop — encourages minting a sandbox-labelled token so
          operators can validate IdP wiring in a staging tenant before
          pointing prod traffic. Pre-fix copy promised a "synthetic
          SCIM POST" / dry-run flow that doesn't exist yet — the CTA
          opened the same Mint dialog as the primary button, leading
          operators to expect a test harness that wasn't there. */}
      <ValuePropCard
        title="Validate before you wire up prod"
        body="Mint a token in a staging tenant first and point your IdP at it — confirm token, base URL, and role mappings resolve correctly before production cutover."
        cta={{
          label: "Mint a staging token",
          onClick: () => {
            // ValuePropCard's CTA has no disabled prop, so mirror the
            // "+ Mint token" admin gate with explicit feedback instead
            // of silently no-oping for non-admins.
            if (!canAdmin) {
              toast.error("Admin role required to mint SCIM tokens");
              return;
            }
            if (minted) {
              toast.info("Store or explicitly discard the shown token first.");
              return;
            }
            if (tokenOperation.active) {
              toast.info("Wait for the current SCIM token request to finish.");
              return;
            }
            setShowCreate(true);
          },
        }}
      />

      {err && <div className="callout error">{err}</div>}

      <div style={{ margin: "12px 0" }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canAdmin || minted !== null || tokenOperation.active}
          onClick={() => setShowCreate(true)}
        >
          + Mint token
        </button>
      </div>

      {loading && rows == null ? (
        <p className="muted">Loading tokens…</p>
      ) : (rows ?? []).length === 0 ? (
        <HeroEmptyState
          tone="neutral"
          eyebrow="Provisioning"
          title="Provision users from your identity provider."
          subtitle="Okta, Azure AD, Google Workspace — all SCIM 2.0. Moosewave generates the token, you paste the URL."
          primaryCta={
            canAdmin
              ? {
                  // Pre-fix labelled "Enable SCIM" — misleading because
                  // SCIM is enabled by minting the first token; there
                  // is no separate on/off toggle. Renamed so the click
                  // outcome (a Mint dialog) matches expectations.
                  label: "Mint your first token",
                  onClick: () => {
                    if (!minted && !tokenOperation.active) setShowCreate(true);
                  },
                }
              : undefined
          }
          imageSrc={HERO.scim}
          imageAlt="A brass ring of keys"
        />
      ) : (
        <table className="data-table" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th>Prefix</th>
              <th>Description</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((t) => (
              <tr key={t.id} style={{ opacity: t.revoked_at ? 0.5 : 1 }}>
                <td>
                  {/* Display the prefix as-is. Adding a trailing
                      ellipsis here used to mislead operators using
                      the type-to-confirm revoke flow — the row
                      showed "scim_abc…" but the modal required
                      exactly "revoke scim_abc" (no ellipsis). */}
                  <code>{t.prefix}</code>
                </td>
                <td>{t.description || <span className="muted">—</span>}</td>
                <td>{fmtDate(t.created_at)}</td>
                <td>
                  {t.last_used_at ? (
                    fmtDate(t.last_used_at)
                  ) : (
                    <span className="muted">never</span>
                  )}
                </td>
                <td>
                  {t.revoked_at ? (
                    <span className="badge danger">revoked</span>
                  ) : (
                    <span className="badge success">active</span>
                  )}
                </td>
                <td>
                  {!t.revoked_at && (
                    <div
                      className="list-row-actions"
                      style={{ justifyContent: "flex-end" }}
                    >
                      <button
                        type="button"
                        className="list-row-action"
                        disabled={!canAdmin || tokenOperation.active}
                        onClick={() =>
                          void copyOrFail(t.prefix, "token prefix")
                        }
                        aria-label={`Copy token prefix ${t.prefix} for IdP log searches`}
                      >
                        Copy
                      </button>
                      <button
                        type="button"
                        className="list-row-action danger"
                        disabled={!canAdmin || tokenOperation.active}
                        onClick={() => setPendingRevoke(t)}
                      >
                        Revoke
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showCreate && (
        <MintTokenModal
          onClose={() => setShowCreate(false)}
          onMinted={(m) => {
            tokenSecretLifecycle.activate();
            setMinted(m);
            setShowCreate(false);
            void load();
          }}
        />
      )}
      {minted && (
        <RevealMintedTokenModal
          minted={minted}
          onAcknowledge={() => {
            tokenSecretLifecycle.resolve();
            setConfirmSecretClose(false);
            setMinted(null);
          }}
          onRequestClose={() => setConfirmSecretClose(true)}
        />
      )}

      <ConfirmModal
        open={confirmSecretClose}
        title="Close without storing this token?"
        description="The full SCIM token is shown once and cannot be recovered. You will need to revoke it and mint another."
        confirmLabel="Discard shown token"
        cancelLabel="Keep token open"
        danger
        onConfirm={() => {
          tokenSecretLifecycle.resolve();
          setConfirmSecretClose(false);
          setMinted(null);
        }}
        onClose={() => setConfirmSecretClose(false)}
      />

      <ConfirmModal
        open={pendingRevoke !== null}
        title="Revoke this SCIM token?"
        description="Once revoked the IdP can't re-use this token; you'll need to mint a new one and update the IdP config. Active sync flows will fail with 401 until then."
        confirmLabel="Revoke token"
        danger
        // Type-to-confirm using the token prefix — the irreversible
        // nature of revocation justifies the extra ceremony (an
        // accidental click on the wrong row would otherwise sever
        // IdP sync mid-day).
        typeToConfirm={
          pendingRevoke ? `revoke ${pendingRevoke.prefix}` : undefined
        }
        busy={revokeBusy || tokenOperation.active}
        onClose={() => {
          if (!tokenOperation.active) setPendingRevoke(null);
        }}
        onConfirm={() => void revoke()}
      />
    </div>
  );
}

function MintTokenModal({
  onClose,
  onMinted,
}: {
  onClose: () => void;
  onMinted: (m: ScimTokenMinted) => void | Promise<void>;
}): ReactElement {
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [descErr, setDescErr] = useState<string | null>(null);
  // Inline submit-error banner — pre-fix the dialog relied solely on a
  // corner toast for backend failures (CORS, 5xx, timeout). Operators
  // who didn't notice the toast saw "Mint token" snap back to idle and
  // assumed something silently worked. Surfacing the error in-context
  // keeps the failure attached to the action that produced it.
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const operation = useSingleFlightOperation({
    ownerId: "scim-token-create",
    label: "SCIM token mint operation",
    detail: "Wait for the SCIM token mint request to finish.",
  });
  const discardDraft = useCallback((): void => {
    setDescription("");
    setDescErr(null);
    setSubmitErr(null);
    setConfirmClose(false);
    onClose();
  }, [onClose]);
  const dirty = description.trim() !== "";
  useDiscardOnlyDraftLifecycle({
    ownerId: "scim-token-create",
    label: "SCIM token draft",
    dirty,
    operationRef: operation.promiseRef,
    discard: discardDraft,
    detail: "This SCIM token description has not been submitted.",
  });

  const requestClose = (): void => {
    if (busy || operation.active) return;
    if (dirty) {
      setConfirmClose(true);
      return;
    }
    discardDraft();
  };

  const mint = async (): Promise<void> => {
    // Require a description so the token list isn't a mystery soup of
    // unlabelled prefixes — the server allows empty, but the admin
    // surface should not. Auditors and ops people both want to know
    // which IdP each row belongs to.
    const trimmed = description.trim();
    if (!trimmed) {
      setDescErr("Description required — name the IdP this token belongs to.");
      return;
    }
    if (trimmed.length > 200) {
      setDescErr("Keep the description under 200 characters.");
      return;
    }
    setDescErr(null);
    setSubmitErr(null);
    const request = operation.run(async () => {
      const res = await api.scimTokenCreate({ description: trimmed });
      if (!res.error && res.data?.token) {
        setDescription("");
        // Parent activates the shown-once guard synchronously before this
        // retained mint owner is allowed to release.
        await onMinted(res.data);
      }
      return res;
    });
    if (!request) return;
    setBusy(true);
    let res: Awaited<ReturnType<typeof api.scimTokenCreate>>;
    try {
      res = await request;
    } catch (error) {
      const msg = lifecycleOperationError(
        error,
        "The SCIM token couldn't be minted.",
      );
      toast.error(msg);
      setSubmitErr(msg);
      return;
    } finally {
      setBusy(false);
    }
    if (res.error) {
      const msg = res.error.code
        ? `Mint failed [${res.error.code}]: ${res.error.message}`
        : `Couldn't mint token — ${res.error.message}`;
      toast.error(msg);
      setSubmitErr(msg);
      return;
    }
    if (!res.data?.token) {
      const msg =
        "The token may have been minted, but its one-time plaintext was missing. Revoke the newest token before retrying.";
      toast.error(msg);
      setSubmitErr(msg);
      return;
    }
  };

  return (
    <>
      <Modal
        open={true}
        onClose={requestClose}
        closeOnBackdrop={!busy && !operation.active}
        closeOnEscape={!busy && !operation.active}
        title="Mint SCIM token"
        description="The token is shown ONCE — copy it immediately into your IdP configuration. We can't show it again after this dialog closes."
      >
        <div className="field">
          <label
            className="field-label"
            htmlFor="mint-desc"
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            Description
            <InlineHelp text="Names the IdP this token belongs to (Okta prod, Azure AD staging, etc.). The token list is otherwise just opaque prefixes." />
          </label>
          <input
            id="mint-desc"
            type="text"
            className="input"
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              if (descErr) setDescErr(null);
            }}
            placeholder='e.g. "Okta production"'
            autoComplete="off"
            aria-invalid={descErr ? "true" : undefined}
            maxLength={200}
          />
          {descErr ? (
            <div className="field-error">{descErr}</div>
          ) : (
            <div className="field-help">
              Names the IdP this token belongs to so the token list stays
              scannable.
            </div>
          )}
        </div>
        {submitErr && (
          <div className="callout error" style={{ marginTop: 8 }} role="alert">
            {submitErr}
          </div>
        )}
        <ModalFooter>
          <button
            type="button"
            className="btn"
            disabled={busy || operation.active}
            onClick={requestClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || operation.active}
            onClick={() => void mint()}
          >
            {busy ? "Minting…" : "Mint token"}
          </button>
        </ModalFooter>
      </Modal>
      <ConfirmModal
        open={confirmClose}
        title="Discard SCIM token draft?"
        description="The unsaved IdP description will be cleared. No token has been minted yet."
        confirmLabel="Discard draft"
        cancelLabel="Keep editing"
        danger
        onConfirm={discardDraft}
        onClose={() => setConfirmClose(false)}
      />
    </>
  );
}

function RevealMintedTokenModal({
  minted,
  onAcknowledge,
  onRequestClose,
}: {
  minted: ScimTokenMinted;
  onAcknowledge: () => void;
  onRequestClose: () => void;
}): ReactElement {
  // Show/hide the token value — useful when screen-sharing to demo
  // the IdP setup without leaking the secret to the recording.
  const [show, setShow] = useState(true);
  return (
    <Modal
      open={true}
      onClose={onRequestClose}
      title="New SCIM token"
      description="This is the only time the full token is shown. Copy it to your IdP now."
    >
      <div
        style={{
          position: "relative",
          marginTop: 4,
        }}
      >
        <textarea
          readOnly
          value={
            show ? minted.token : "•".repeat(Math.min(minted.token.length, 48))
          }
          rows={3}
          className="mono"
          style={{
            width: "100%",
            fontSize: 12,
          }}
          onFocus={(e) => show && e.currentTarget.select()}
        />
        <button
          type="button"
          className="link-button"
          onClick={() => setShow((s) => !s)}
          style={{
            position: "absolute",
            top: 6,
            right: 8,
            fontSize: 11,
          }}
        >
          {show ? "Hide" : "Show"}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
        Configure your IdP to send this as <code>Authorization: Bearer …</code>{" "}
        on every SCIM request.
      </p>
      <ModalFooter>
        <button
          type="button"
          className="btn"
          onClick={() => void copyOrFail(minted.token, "token")}
        >
          Copy token
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onAcknowledge}
        >
          Done — I've saved it
        </button>
      </ModalFooter>
    </Modal>
  );
}

/* ---------- Role mappings ---------- */

function RoleMappingsPanel(): ReactElement {
  const canAdmin = useCanAdmin();
  const [rows, setRows] = useState<ScimRoleMapping[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ScimRoleMapping | null>(
    null,
  );
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = async (): Promise<void> => {
    setLoading(true);
    const res = await api.scimRoleMappingsList();
    setLoading(false);
    if (res.error) {
      setErr(res.error.message);
      setRows([]);
      return;
    }
    setErr(null);
    setRows(res.data?.mappings ?? []);
  };

  useEffect(() => {
    void load();
  }, []);

  const destroy = async (): Promise<void> => {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    const res = await api.scimRoleMappingDelete(pendingDelete.id);
    setDeleteBusy(false);
    if (res.error) {
      toast.error(
        res.error.code
          ? `Delete failed [${res.error.code}]: ${res.error.message}`
          : `Delete failed: ${res.error.message}`,
      );
      return;
    }
    toast.success("Mapping deleted");
    setPendingDelete(null);
    await load();
  };

  return (
    <div>
      <SectionHeader
        title="Role mappings"
        description="Map IdP groups to Moosewave roles. Lower precedence wins; group * is the catch-all."
        helpText="When SAML asserts a group, the JIT bridge walks mappings in precedence order. First match decides the user's role."
      />
      {err && <div className="callout error">{err}</div>}

      <div style={{ marginBottom: 12 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canAdmin}
          onClick={() => setShowCreate(true)}
        >
          + Add mapping
        </button>
      </div>

      {loading && rows == null ? (
        <p className="muted">Loading mappings…</p>
      ) : (rows ?? []).length === 0 ? (
        <div className="empty-section">
          <div className="empty-section-title">No role mappings yet</div>
          <div className="empty-section-body">
            Without a mapping, JIT-provisioned users default to{" "}
            <code>viewer</code>. Add at least a catch-all <code>*</code> mapping
            plus one per high-privilege IdP group to bootstrap.
          </div>
        </div>
      ) : (
        <table className="data-table" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th>Precedence</th>
              <th>Group</th>
              <th>Role</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((m) => (
              <tr key={m.id}>
                <td className="tabular">{m.precedence}</td>
                <td>
                  <code>{m.group_name}</code>
                </td>
                <td>
                  <span className="badge">{m.role}</span>
                </td>
                <td>
                  <button
                    type="button"
                    className="link-button danger"
                    disabled={!canAdmin}
                    onClick={() => setPendingDelete(m)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showCreate && (
        <MappingModal
          existingMappings={rows ?? []}
          onClose={() => setShowCreate(false)}
          onCreated={async () => {
            setShowCreate(false);
            await load();
          }}
        />
      )}

      <ConfirmModal
        open={pendingDelete !== null}
        title="Delete this role mapping?"
        description={
          pendingDelete
            ? `Group "${pendingDelete.group_name}" will no longer resolve to ${pendingDelete.role}. Users hitting this mapping fall through to the next one (or the catch-all *).`
            : ""
        }
        confirmLabel="Delete mapping"
        danger
        busy={deleteBusy}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void destroy()}
      />
    </div>
  );
}

function MappingModal({
  existingMappings,
  onClose,
  onCreated,
}: {
  /**
   * Used for the "this group already has a mapping" hint — `upsert`
   * silently overwrites by `group_name`, which is the documented
   * behaviour, but the operator deserves a heads-up before they
   * clobber a previously-saved row.
   */
  existingMappings: ScimRoleMapping[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}): ReactElement {
  const [groupName, setGroupName] = useState("");
  const [role, setRole] = useState<"owner" | "admin" | "editor" | "viewer">(
    "viewer",
  );
  // Precedence stored as raw string so we can distinguish "" (no
  // input) from "100" (typed value). The handler parses on submit
  // and surfaces a field-level error instead of silently coercing.
  const [precedence, setPrecedence] = useState<string>("100");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{
    group?: string;
    precedence?: string;
  }>({});

  const trimmedGroup = groupName.trim();
  const willOverwrite = existingMappings.some(
    (m) => m.group_name === trimmedGroup,
  );

  const create = async (): Promise<void> => {
    const next: typeof errors = {};
    if (!trimmedGroup) {
      next.group = "Group name required (use * for catch-all).";
    } else if (trimmedGroup.length > 200) {
      next.group = "Group names are capped at 200 characters.";
    }
    const p = Number(precedence);
    if (precedence.trim() === "") {
      next.precedence = "Precedence required.";
    } else if (!Number.isFinite(p) || !Number.isInteger(p)) {
      next.precedence = "Precedence must be a whole number.";
    } else if (p < 0 || p > 1000) {
      // D13-governance-privacy#6: backend caps precedence at 0..1000 and
      // silently rewrites out-of-range values to 100 (role_mappings.go),
      // which would reorder role resolution without warning. Reject here
      // so the operator never saves a value the server quietly rewrites.
      next.precedence = "Precedence must be between 0 and 1000.";
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setBusy(true);
    const res = await api.scimRoleMappingUpsert({
      group_name: trimmedGroup,
      role,
      precedence: p,
    });
    setBusy(false);
    if (res.error) {
      toast.error(
        res.error.code
          ? `Save failed [${res.error.code}]: ${res.error.message}`
          : `Save failed: ${res.error.message}`,
      );
      return;
    }
    toast.success(willOverwrite ? "Mapping updated" : "Mapping created");
    await onCreated();
  };

  return (
    <Modal
      open={true}
      onClose={() => (busy ? undefined : onClose())}
      title="Role mapping"
      description="Maps an IdP group to a Moosewave role. Resolved at JIT-provisioning time when SAML asserts the group."
    >
      <div className="field">
        <label className="field-label" htmlFor="map-group">
          IdP group name
        </label>
        <input
          id="map-group"
          type="text"
          className="input"
          value={groupName}
          onChange={(e) => {
            setGroupName(e.target.value);
            if (errors.group) setErrors({ ...errors, group: undefined });
          }}
          placeholder="Engineering"
          autoComplete="off"
          aria-invalid={errors.group ? "true" : undefined}
        />
        {errors.group ? (
          <div className="field-error">{errors.group}</div>
        ) : (
          <div className="field-help">
            Use <code>*</code> for the catch-all when no other mapping matches.
          </div>
        )}
        {!errors.group && willOverwrite ? (
          <div
            className="field-help"
            style={{ color: "var(--pw-warning)", marginTop: 4 }}
          >
            ⚠ A mapping already exists for <code>{trimmedGroup}</code> — saving
            will overwrite it.
          </div>
        ) : null}
      </div>
      <div className="field">
        <label
          className="field-label"
          htmlFor="map-role"
          style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
        >
          Role
          <InlineHelp text="owner: full control incl. billing. admin: manage settings, members, integrations. editor: compose and send. viewer: read-only." />
        </label>
        <select
          id="map-role"
          className="input"
          value={role}
          onChange={(e) => setRole(e.target.value as typeof role)}
        >
          <option value="owner">owner</option>
          <option value="admin">admin</option>
          <option value="editor">editor</option>
          <option value="viewer">viewer</option>
        </select>
      </div>
      <div className="field">
        <label
          className="field-label"
          htmlFor="map-precedence"
          style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
        >
          Precedence
          <InlineHelp text="Mappings are evaluated low→high. The first match wins. Use 0 for the catch-all (*), 100s for org-wide groups, 200+ for team-specific overrides." />
        </label>
        <input
          id="map-precedence"
          type="number"
          className="input tabular"
          value={precedence}
          onChange={(e) => {
            setPrecedence(e.target.value);
            if (errors.precedence)
              setErrors({ ...errors, precedence: undefined });
          }}
          min={0}
          max={1000}
          step={1}
          aria-invalid={errors.precedence ? "true" : undefined}
        />
        {errors.precedence ? (
          <div className="field-error">{errors.precedence}</div>
        ) : (
          <div className="field-help">
            Lower precedence = checked first. Typical values: 0 for catch-alls,
            100 for org-wide groups, 200+ for team-specific.
          </div>
        )}
      </div>
      <ModalFooter>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void create()}
        >
          {busy
            ? "Saving…"
            : willOverwrite
              ? "Overwrite mapping"
              : "Save mapping"}
        </button>
      </ModalFooter>
    </Modal>
  );
}
