/**
 * SunsetPoliciesCard — collapsed <details> section on the Subscribers
 * page for the sunset surface (#22):
 *
 *   - policy CRUD (camelCase wire: name, inactiveDays 30..730, action
 *     suppress|tag|winback, enabled, excludedTags)
 *   - policy execution is deliberately release-gated. The legacy endpoint is
 *     synchronous and cannot provide a reviewed plan, durable progress,
 *     cancellation, targeted retry, or a complete job receipt. The desktop
 *     therefore exposes policy definitions and historical evidence without
 *     presenting that endpoint as production-safe automation.
 *   - per-policy executions history
 *   - re-engagement preview (POST /sunset/reengagement/preview) — a
 *     pure-function template generator; returns ONE template +
 *     candidateCount, not a candidates list, so that's what we render.
 *
 * Data loads lazily on first expand — the routes are admin-scoped and
 * eager-fetching would 403-spam viewer sessions.
 */

import { type ReactElement, useEffect, useId, useRef, useState } from "react";

import {
  type SunsetBrandSnapshot,
  type SunsetExecution,
  type SunsetPolicy,
  type SunsetPolicyInput,
  type SunsetReengagementTemplate,
  sunsetApi,
} from "../../lib/api/sunset";
import { ConfirmModal } from "../ConfirmModal";
import { FieldError, FormField } from "../FormField";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";
import { fmtDate } from "../../lib/format-date";
import {
  SUNSET_ACTIONS,
  SUNSET_ACTION_LABELS,
  SUNSET_INACTIVE_DAYS_MAX,
  SUNSET_INACTIVE_DAYS_MIN,
  describeSunsetCriteria,
  parseExcludedTags,
  validateSunsetPolicyInput,
} from "./subscriber-insights";

interface Props {
  canMutate: boolean;
  /** Every sunset mutation (policy CRUD) is ScopeAdmin
   *  server-side — the list 403 copy already says "admin-scoped key",
   *  so the buttons gate on admin too instead of enabling for editors
   *  and then 403ing. */
  canAdmin: boolean;
}

interface PolicyDraft {
  name: string;
  inactiveDays: string;
  action: string;
  excludedTags: string;
}

const EMPTY_DRAFT: PolicyDraft = {
  name: "",
  inactiveDays: "180",
  action: "suppress",
  excludedTags: "",
};

function draftFromPolicy(p: SunsetPolicy): PolicyDraft {
  return {
    name: p.name,
    inactiveDays: String(p.inactiveDays),
    action: p.action,
    excludedTags: p.excludedTags.join(", "),
  };
}

function draftToInput(d: PolicyDraft): SunsetPolicyInput {
  return {
    name: d.name.trim(),
    inactiveDays: Number(d.inactiveDays),
    action: d.action,
    enabled: false,
    excludedTags: parseExcludedTags(d.excludedTags),
  };
}

interface CurrentRef<T> {
  current: T;
}

function useSunsetPolicyCollection(
  mountedRef: CurrentRef<boolean>,
  generationRef: CurrentRef<number>,
) {
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [policies, setPolicies] = useState<SunsetPolicy[]>([]);
  const requestRef = useRef(0);
  const loadingRef = useRef(false);

  useEffect(
    () => () => {
      requestRef.current += 1;
      loadingRef.current = false;
    },
    [],
  );

  const invalidate = (): void => {
    requestRef.current += 1;
    loadingRef.current = false;
    setLoading(false);
    setLoaded(true);
    setError(null);
  };

  const load = async (): Promise<void> => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const generation = generationRef.current;
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    let res: Awaited<ReturnType<typeof sunsetApi.listPolicies>>;
    try {
      res = await sunsetApi.listPolicies();
    } catch {
      if (requestRef.current === request) loadingRef.current = false;
      if (
        mountedRef.current &&
        generation === generationRef.current &&
        request === requestRef.current
      ) {
        setLoading(false);
        setLoaded(true);
        setError(
          "Couldn't load sunset policies. Check your connection and retry.",
        );
      }
      return;
    }
    if (requestRef.current === request) loadingRef.current = false;
    if (
      !mountedRef.current ||
      generation !== generationRef.current ||
      request !== requestRef.current
    ) {
      return;
    }
    setLoading(false);
    setLoaded(true);
    if (res.error) {
      setError(
        res.error.kind === "http" && res.error.status === 403
          ? "Sunset policies need an admin-scoped key."
          : res.error.message,
      );
      return;
    }
    setPolicies(res.data.items ?? []);
  };

  const onToggle = (open: boolean): void => {
    if (open && !loaded && !loadingRef.current) void load();
  };

  return {
    error,
    invalidate,
    load,
    loaded,
    loading,
    onToggle,
    policies,
    setPolicies,
  };
}

export function SunsetPoliciesCard({
  canMutate,
  canAdmin,
}: Props): ReactElement {
  // All mutations are admin-scoped; write role alone isn't enough.
  const canManage = canMutate && canAdmin;
  const manageGateReason = !canMutate
    ? "Viewer role can't manage sunset policies"
    : "Sunset policies need an admin role";
  const manageReasonId = useId();
  const executionGateId = useId();
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const {
    error,
    invalidate: invalidatePolicyLoad,
    load,
    loaded,
    loading,
    onToggle: onToggleSection,
    policies,
    setPolicies,
  } = useSunsetPolicyCollection(mountedRef, generationRef);

  // Create/edit modal. editTarget==null → create.
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SunsetPolicy | null>(null);
  const [draft, setDraft] = useState<PolicyDraft>(EMPTY_DRAFT);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [formBusy, setFormBusy] = useState(false);

  const [pendingDelete, setPendingDelete] = useState<SunsetPolicy | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Executions drill-down (per policy, on demand).
  const [executionsFor, setExecutionsFor] = useState<string | null>(null);
  const [executions, setExecutions] = useState<SunsetExecution[] | null>(null);
  const [executionsErr, setExecutionsErr] = useState<string | null>(null);
  const formRequestRef = useRef(false);
  const deleteRequestRef = useRef(false);
  const executionsRequestRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      executionsRequestRef.current += 1;
    };
  }, []);
  const openCreate = (): void => {
    setEditTarget(null);
    setDraft(EMPTY_DRAFT);
    setFormErrors({});
    setFormOpen(true);
  };

  const openEdit = (p: SunsetPolicy): void => {
    setEditTarget(p);
    setDraft(draftFromPolicy(p));
    setFormErrors({});
    setFormOpen(true);
  };

  const submitForm = async (): Promise<void> => {
    if (!canManage || formRequestRef.current) return;
    const input = draftToInput({ ...draft });
    const errors = validateSunsetPolicyInput(input);
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const generation = generationRef.current;
    const target = editTarget;
    formRequestRef.current = true;
    setFormBusy(true);
    let res: Awaited<
      ReturnType<typeof sunsetApi.updatePolicy | typeof sunsetApi.createPolicy>
    >;
    try {
      res = target
        ? await sunsetApi.updatePolicy(target.id, input)
        : await sunsetApi.createPolicy(input);
    } catch {
      formRequestRef.current = false;
      if (mountedRef.current && generation === generationRef.current) {
        setFormBusy(false);
        setFormErrors({
          _form: "Couldn't save the policy. Check your connection and retry.",
        });
      }
      return;
    }
    formRequestRef.current = false;
    if (!mountedRef.current || generation !== generationRef.current) return;
    setFormBusy(false);
    if (res.error) {
      setFormErrors({ _form: res.error.message });
      return;
    }
    setFormOpen(false);
    invalidatePolicyLoad();
    setPolicies((current) =>
      target
        ? current.map((policy) =>
            policy.id === res.data.id ? res.data : policy,
          )
        : [res.data, ...current],
    );
    toast.success(
      target ? `Updated "${input.name}"` : `Created "${input.name}"`,
    );
  };

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete || !canManage || deleteRequestRef.current) return;
    const target = pendingDelete;
    const generation = generationRef.current;
    deleteRequestRef.current = true;
    setDeleteBusy(true);
    let res: Awaited<ReturnType<typeof sunsetApi.deletePolicy>>;
    try {
      res = await sunsetApi.deletePolicy(target.id);
    } catch {
      deleteRequestRef.current = false;
      if (mountedRef.current && generation === generationRef.current) {
        setDeleteBusy(false);
        toast.error(
          "Couldn't delete the policy. Check your connection and retry.",
        );
      }
      return;
    }
    deleteRequestRef.current = false;
    if (!mountedRef.current || generation !== generationRef.current) return;
    setDeleteBusy(false);
    if (res.error) {
      toast.error(`Couldn't delete: ${res.error.message}`);
      return;
    }
    invalidatePolicyLoad();
    setPolicies((current) =>
      current.filter((policy) => policy.id !== target.id),
    );
    toast.success(`Deleted "${target.name}"`);
    setPendingDelete(null);
  };

  const loadExecutions = async (policyId: string): Promise<void> => {
    const generation = generationRef.current;
    const request = ++executionsRequestRef.current;
    setExecutions(null);
    setExecutionsErr(null);
    let res: Awaited<ReturnType<typeof sunsetApi.listExecutions>>;
    try {
      res = await sunsetApi.listExecutions(policyId, 50);
    } catch {
      if (
        mountedRef.current &&
        generation === generationRef.current &&
        request === executionsRequestRef.current
      ) {
        setExecutionsErr(
          "Couldn't load execution history. Check your connection and retry.",
        );
      }
      return;
    }
    if (
      !mountedRef.current ||
      generation !== generationRef.current ||
      request !== executionsRequestRef.current
    ) {
      return;
    }
    if (res.error) {
      setExecutionsErr(res.error.message);
      return;
    }
    setExecutions(res.data.items ?? []);
  };

  const toggleExecutions = (policyId: string): void => {
    if (executionsFor === policyId) {
      executionsRequestRef.current += 1;
      setExecutionsFor(null);
      setExecutions(null);
      setExecutionsErr(null);
      return;
    }
    setExecutionsFor(policyId);
    void loadExecutions(policyId);
  };

  return (
    <SunsetPoliciesView
      canManage={canManage}
      manageGateReason={manageGateReason}
      manageReasonId={manageReasonId}
      executionGateId={executionGateId}
      loaded={loaded}
      loading={loading}
      error={error}
      policies={policies}
      executionsFor={executionsFor}
      executions={executions}
      executionsError={executionsErr}
      formOpen={formOpen}
      editTarget={editTarget}
      draft={draft}
      formErrors={formErrors}
      formBusy={formBusy}
      pendingDelete={pendingDelete}
      deleteBusy={deleteBusy}
      onToggle={onToggleSection}
      onRefresh={load}
      onCreate={openCreate}
      onEdit={openEdit}
      onDelete={setPendingDelete}
      onToggleExecutions={toggleExecutions}
      onLoadExecutions={loadExecutions}
      onDraftChange={setDraft}
      onSubmitForm={submitForm}
      onCloseForm={() => {
        if (!formRequestRef.current) setFormOpen(false);
      }}
      onConfirmDelete={confirmDelete}
      onCloseDelete={() => {
        if (!deleteRequestRef.current) setPendingDelete(null);
      }}
    />
  );
}

interface SunsetPoliciesViewProps {
  canManage: boolean;
  manageGateReason: string;
  manageReasonId: string;
  executionGateId: string;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  policies: SunsetPolicy[];
  executionsFor: string | null;
  executions: SunsetExecution[] | null;
  executionsError: string | null;
  formOpen: boolean;
  editTarget: SunsetPolicy | null;
  draft: PolicyDraft;
  formErrors: Record<string, string>;
  formBusy: boolean;
  pendingDelete: SunsetPolicy | null;
  deleteBusy: boolean;
  onToggle: (open: boolean) => void;
  onRefresh: () => Promise<void>;
  onCreate: () => void;
  onEdit: (policy: SunsetPolicy) => void;
  onDelete: (policy: SunsetPolicy) => void;
  onToggleExecutions: (policyId: string) => void;
  onLoadExecutions: (policyId: string) => Promise<void>;
  onDraftChange: (draft: PolicyDraft) => void;
  onSubmitForm: () => Promise<void>;
  onCloseForm: () => void;
  onConfirmDelete: () => Promise<void>;
  onCloseDelete: () => void;
}

function SunsetPoliciesView(props: SunsetPoliciesViewProps): ReactElement {
  return (
    <details
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 8,
        padding: "8px 16px",
        marginBottom: 12,
        background: "var(--pw-bg-elev)",
      }}
      onToggle={(event) =>
        props.onToggle((event.target as HTMLDetailsElement).open)
      }
    >
      <summary
        style={{
          cursor: "pointer",
          padding: "6px 0",
          fontWeight: 600,
          fontSize: 14,
        }}
      >
        Sunset policies
        <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
          {" "}
          — retire chronically-inactive subscribers
        </span>
      </summary>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          padding: "6px 0 10px",
        }}
      >
        <SunsetPoliciesToolbar {...props} />
        <SunsetExecutionGate id={props.executionGateId} />
        <SunsetPolicyList {...props} />
        <ReengagementPreview
          canManage={props.canManage}
          manageReasonId={props.manageReasonId}
        />
      </div>
      <SunsetPolicyFormModal {...props} />
      <ConfirmModal
        open={props.pendingDelete !== null}
        title="Delete sunset policy?"
        description={
          props.pendingDelete
            ? `Delete "${props.pendingDelete.name}"? Past executions stay in the history; no subscribers are changed.`
            : ""
        }
        confirmLabel="Delete policy"
        danger
        busy={props.deleteBusy}
        onConfirm={() => void props.onConfirmDelete()}
        onClose={props.onCloseDelete}
      />
    </details>
  );
}

function SunsetExecutionGate({ id }: { id: string }): ReactElement {
  return (
    <section
      id={id}
      role="note"
      aria-label="Sunset execution availability"
      style={{
        display: "grid",
        gridTemplateColumns: "auto minmax(0, 1fr)",
        gap: 10,
        alignItems: "start",
        padding: "10px 12px",
        border:
          "1px solid color-mix(in srgb, var(--pw-warning) 45%, var(--pw-border))",
        borderRadius: 8,
        background:
          "color-mix(in srgb, var(--pw-warning) 7%, var(--pw-bg-elev-2))",
      }}
    >
      <span className="badge" aria-hidden="true" style={{ fontSize: 10 }}>
        Draft mode
      </span>
      <div style={{ minWidth: 0 }}>
        <strong style={{ display: "block", fontSize: 12 }}>
          Automated and manual sweeps are unavailable in this release
        </strong>
        <p className="muted" style={{ margin: "3px 0 0", fontSize: 11 }}>
          You can review policy definitions and historical executions. New and
          edited definitions stay paused until execution has an immutable impact
          preview, durable progress, cancellation, targeted retry, and a
          complete receipt. No subscriber is changed from this desktop surface.
        </p>
      </div>
    </section>
  );
}

function SunsetPoliciesToolbar({
  canManage,
  manageGateReason,
  manageReasonId,
  loading,
  onRefresh,
  onCreate,
}: SunsetPoliciesViewProps): ReactElement {
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <span className="muted" style={{ fontSize: 12 }}>
          Policies decide when a subscriber counts as inactive and what happens
          to them.
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void onRefresh()}
          disabled={loading}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => {
            if (canManage) onCreate();
          }}
          aria-disabled={!canManage || undefined}
          aria-describedby={!canManage ? manageReasonId : undefined}
        >
          New policy
        </button>
      </div>
      {!canManage ? (
        <div
          id={manageReasonId}
          className="muted"
          role="status"
          style={{ fontSize: 11 }}
        >
          {manageGateReason}. You can still inspect policies, criteria, and
          execution history.
        </div>
      ) : null}
    </>
  );
}

function SunsetPolicyList(props: SunsetPoliciesViewProps): ReactElement {
  if (props.error) {
    return (
      <div className="notice" role="alert" style={{ fontSize: 12 }}>
        {props.error}
      </div>
    );
  }
  if (props.loading && !props.loaded) {
    return (
      <div className="muted" style={{ fontSize: 12 }} role="status">
        Loading sunset policies…
      </div>
    );
  }
  if (props.loaded && props.policies.length === 0) {
    return (
      <div className="muted" style={{ fontSize: 12 }}>
        No sunset policies yet. Create one to define when inactive subscribers
        get suppressed, tagged, or queued for a win-back.
      </div>
    );
  }
  return (
    <>
      {props.policies.map((policy) => (
        <SunsetPolicyCard key={policy.id} policy={policy} {...props} />
      ))}
    </>
  );
}

function SunsetPolicyCard({
  policy,
  canManage,
  manageReasonId,
  executionGateId,
  executionsFor,
  executions,
  executionsError,
  onEdit,
  onDelete,
  onToggleExecutions,
  onLoadExecutions,
}: SunsetPoliciesViewProps & { policy: SunsetPolicy }): ReactElement {
  const historyId = useId();
  const historyOpen = executionsFor === policy.id;
  const permissionDescription = !canManage ? manageReasonId : undefined;
  return (
    <article
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <strong style={{ fontSize: 13 }}>{policy.name}</strong>
        <span className="badge" style={{ fontSize: 10 }}>
          {policy.enabled ? "Legacy enabled flag · execution gated" : "Paused"}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => onToggleExecutions(policy.id)}
          aria-expanded={historyOpen}
          aria-controls={historyId}
        >
          {historyOpen ? "Hide history" : "History"}
        </button>
        <span
          className="badge"
          aria-describedby={executionGateId}
          style={{ fontSize: 10 }}
        >
          Run unavailable
        </span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            if (canManage) onEdit(policy);
          }}
          aria-disabled={!canManage || undefined}
          aria-describedby={permissionDescription}
        >
          Edit
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => {
            if (canManage) onDelete(policy);
          }}
          aria-disabled={!canManage || undefined}
          aria-describedby={permissionDescription}
          style={{ color: "var(--pw-danger)" }}
        >
          Delete
        </button>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        {describeSunsetCriteria(policy)}
      </div>
      <SunsetExecutionHistory
        id={historyId}
        hidden={!historyOpen}
        policyId={policy.id}
        executions={executions}
        error={executionsError}
        onRetry={onLoadExecutions}
      />
    </article>
  );
}

function SunsetExecutionHistory({
  id,
  hidden,
  policyId,
  executions,
  error,
  onRetry,
}: {
  id: string;
  hidden: boolean;
  policyId: string;
  executions: SunsetExecution[] | null;
  error: string | null;
  onRetry: (policyId: string) => Promise<void>;
}): ReactElement {
  return (
    <section
      id={id}
      hidden={hidden}
      style={{ borderTop: "1px solid var(--pw-border)", paddingTop: 6 }}
    >
      <div className="label" style={{ fontSize: 11 }}>
        Execution history
      </div>
      {error ? (
        <div role="alert" style={{ fontSize: 12 }}>
          Couldn&apos;t load history: {error}
          <div style={{ marginTop: 4 }}>
            <button
              type="button"
              className="btn btn-xs"
              onClick={() => void onRetry(policyId)}
            >
              Retry history
            </button>
          </div>
        </div>
      ) : executions == null ? (
        <div className="muted" role="status" style={{ fontSize: 12 }}>
          Loading execution history…
        </div>
      ) : executions.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          No executions recorded for this policy yet.
        </div>
      ) : (
        <div
          style={{ maxHeight: 200, overflowY: "auto", display: "grid", gap: 4 }}
        >
          {executions.map((execution) => (
            <div
              key={execution.id}
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(min(140px, 100%), 1fr))",
                gap: 8,
                fontSize: 12,
                padding: "4px 6px",
                background: "var(--pw-bg-elev-2)",
                borderRadius: 4,
              }}
            >
              <span style={{ overflowWrap: "anywhere", whiteSpace: "normal" }}>
                {execution.subscriberId}
                {execution.reason ? (
                  <span className="muted"> — {execution.reason}</span>
                ) : null}
              </span>
              <span className="badge" style={{ fontSize: 10 }}>
                {execution.actionTaken}
              </span>
              <time className="muted tabular" dateTime={execution.executedAt}>
                {fmtDate(execution.executedAt)}
              </time>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SunsetPolicyFormModal({
  formOpen,
  editTarget,
  draft,
  formErrors,
  formBusy,
  onDraftChange,
  onSubmitForm,
  onCloseForm,
}: SunsetPoliciesViewProps): ReactElement {
  const statusId = useId();
  return (
    <Modal
      open={formOpen}
      onClose={onCloseForm}
      title={editTarget ? "Edit sunset policy" : "New sunset policy"}
      description="Subscribers inactive past the threshold are swept by the policy's action. Excluded tags are never touched."
      closeDisabled={formBusy}
      closeOnBackdrop={!formBusy}
      closeOnEscape={!formBusy}
    >
      <FormField
        label="Name"
        required
        htmlFor="sunset-name"
        error={formErrors.name}
      >
        <input
          id="sunset-name"
          className="input"
          value={draft.name}
          onChange={(event) =>
            onDraftChange({ ...draft, name: event.target.value })
          }
          placeholder="12-month sunset"
          disabled={formBusy}
        />
      </FormField>
      <FormField
        label="Inactive days"
        required
        htmlFor="sunset-days"
        helpTooltip={`How long without engagement before a subscriber qualifies. Accepted range: ${SUNSET_INACTIVE_DAYS_MIN}–${SUNSET_INACTIVE_DAYS_MAX} days.`}
        error={formErrors.inactiveDays}
      >
        <input
          id="sunset-days"
          type="number"
          className="input"
          min={SUNSET_INACTIVE_DAYS_MIN}
          max={SUNSET_INACTIVE_DAYS_MAX}
          value={draft.inactiveDays}
          onChange={(event) =>
            onDraftChange({ ...draft, inactiveDays: event.target.value })
          }
          disabled={formBusy}
        />
      </FormField>
      <FormField
        label="Action"
        required
        htmlFor="sunset-action"
        error={formErrors.action}
      >
        <select
          id="sunset-action"
          className="input"
          value={draft.action}
          onChange={(event) =>
            onDraftChange({ ...draft, action: event.target.value })
          }
          disabled={formBusy}
        >
          {SUNSET_ACTIONS.map((action) => (
            <option key={action} value={action}>
              {SUNSET_ACTION_LABELS[action]}
            </option>
          ))}
        </select>
      </FormField>
      <FormField
        label="Excluded tags"
        htmlFor="sunset-excluded"
        helpTooltip="Comma-separated. Subscribers carrying any of these tags are skipped by the sweep."
      >
        <input
          id="sunset-excluded"
          className="input"
          value={draft.excludedTags}
          onChange={(event) =>
            onDraftChange({ ...draft, excludedTags: event.target.value })
          }
          placeholder="vip, paying-customer"
          disabled={formBusy}
        />
      </FormField>
      <div
        className="notice"
        role="note"
        style={{ fontSize: 11, lineHeight: 1.5 }}
      >
        This definition will be saved as paused. Enabling execution is withheld
        until the reviewed, cancellable job contract is available.
      </div>
      {formErrors._form ? <FieldError>{formErrors._form}</FieldError> : null}
      <p id={statusId} className="muted" role="status" style={{ fontSize: 11 }}>
        {formBusy
          ? "Saving the policy. This dialog stays open until the request settles."
          : "Saving changes only updates this paused definition; it does not scan or change subscribers."}
      </p>
      <ModalFooter>
        <button
          type="button"
          className="btn"
          onClick={onCloseForm}
          disabled={formBusy}
          aria-describedby={statusId}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void onSubmitForm()}
          disabled={formBusy}
          aria-describedby={statusId}
        >
          {formBusy ? "Saving…" : editTarget ? "Save policy" : "Create policy"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

/* ---------- re-engagement preview ----------------------------------- */

const SUNSET_VARIANTS = ["soft", "direct", "last_chance"] as const;

const VARIANT_LABELS: Record<string, string> = {
  soft: "Soft (we miss you)",
  direct: "Direct (still want these?)",
  last_chance: "Last chance (final notice)",
};

const TONES = ["casual", "formal", "professional"] as const;

const MAX_BRAND_TEXT_CHARACTERS = 160;
const MAX_BRAND_TEXT_BYTES = 512;
const MAX_BRAND_URL_BYTES = 2048;

interface BrandFieldError {
  field: keyof SunsetBrandSnapshot;
  message: string;
}

function validateBrandPreviewInput(
  brand: SunsetBrandSnapshot,
): BrandFieldError | null {
  const encoder = new TextEncoder();
  for (const field of ["WorkspaceName", "SenderName", "ProductName"] as const) {
    const value = brand[field]?.trim() ?? "";
    if (
      Array.from(value).length > MAX_BRAND_TEXT_CHARACTERS ||
      encoder.encode(value).byteLength > MAX_BRAND_TEXT_BYTES
    ) {
      return {
        field,
        message: `${field.replace(/([A-Z])/g, " $1").trim()} must be at most 160 characters.`,
      };
    }
    if (/\p{Cc}/u.test(value)) {
      return {
        field,
        message: `${field.replace(/([A-Z])/g, " $1").trim()} can't contain control characters.`,
      };
    }
  }

  for (const field of ["HomepageURL", "UnsubscribeURL"] as const) {
    const value = brand[field]?.trim() ?? "";
    if (value === "") continue;
    if (encoder.encode(value).byteLength > MAX_BRAND_URL_BYTES) {
      return {
        field,
        message: `${field === "HomepageURL" ? "Homepage" : "Unsubscribe"} URL is too long.`,
      };
    }
    try {
      const parsed = new URL(value);
      if (
        parsed.protocol !== "https:" ||
        parsed.hostname === "" ||
        parsed.username !== "" ||
        parsed.password !== ""
      ) {
        throw new Error("unsafe URL");
      }
    } catch {
      return {
        field,
        message: `${field === "HomepageURL" ? "Homepage" : "Unsubscribe"} URL must be an absolute HTTPS URL without embedded credentials.`,
      };
    }
  }
  return null;
}

/**
 * ReengagementPreview — POST /sunset/reengagement/preview with a
 * customer-supplied brand snapshot. NB: BrandSnapshot has no json tags
 * server-side, so the Go field names (WorkspaceName, Tone, …) go over
 * the wire verbatim — the api-client type mirrors that.
 *
 * The endpoint is a pure template generator: it returns ONE rendered
 * template (subject / preheader / body / CTA) plus the echoed
 * candidateCount — not a candidates list — and that's what we show.
 */
function ReengagementPreview({
  canManage,
  manageReasonId,
}: {
  canManage: boolean;
  manageReasonId: string;
}): ReactElement {
  const [brand, setBrand] = useState<SunsetBrandSnapshot>({});
  const [variant, setVariant] = useState<string>("soft");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [template, setTemplate] = useState<SunsetReengagementTemplate | null>(
    null,
  );
  const [showHtml, setShowHtml] = useState(false);
  const htmlSourceId = useId();
  const validationErrorId = useId();
  const [invalidField, setInvalidField] = useState<
    keyof SunsetBrandSnapshot | null
  >(null);
  const mountedRef = useRef(true);
  const requestRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setField = (key: keyof SunsetBrandSnapshot, value: string): void => {
    if (!canManage) return;
    setBrand((prev) => ({ ...prev, [key]: value }));
    setInvalidField(null);
    setErr(null);
    setTemplate(null);
    setShowHtml(false);
  };

  const generate = async (): Promise<void> => {
    if (!canManage || requestRef.current) return;
    const validation = validateBrandPreviewInput(brand);
    if (validation) {
      setInvalidField(validation.field);
      setErr(validation.message);
      return;
    }
    const request = { brand: { ...brand }, variant };
    requestRef.current = true;
    setBusy(true);
    setErr(null);
    setInvalidField(null);
    let res: Awaited<ReturnType<typeof sunsetApi.previewReengagement>>;
    try {
      res = await sunsetApi.previewReengagement(request);
    } catch {
      requestRef.current = false;
      if (mountedRef.current) {
        setBusy(false);
        setErr("Couldn't generate a preview. Check your connection and retry.");
      }
      return;
    }
    requestRef.current = false;
    if (!mountedRef.current) return;
    setBusy(false);
    if (res.error) {
      setErr(res.error.message);
      return;
    }
    setTemplate(res.data);
    setShowHtml(false);
  };

  return (
    <details
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        padding: "6px 10px",
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 600,
          padding: "4px 0",
        }}
      >
        Re-engagement email preview
        <span className="muted" style={{ fontWeight: 400 }}>
          {" "}
          — template-generated win-back copy from your brand fields
        </span>
      </summary>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: "6px 0",
        }}
      >
        <p className="muted" style={{ margin: 0, fontSize: 11 }}>
          This is a copy-only preview. It does not select recipients, schedule a
          campaign, or send a message. Empty URLs use safe campaign merge tags.
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 6,
          }}
        >
          <input
            className="input"
            placeholder="Workspace name"
            value={brand.WorkspaceName ?? ""}
            onChange={(e) => setField("WorkspaceName", e.target.value)}
            aria-label="Workspace name"
            maxLength={MAX_BRAND_TEXT_CHARACTERS}
            aria-invalid={invalidField === "WorkspaceName" || undefined}
            aria-describedby={
              invalidField === "WorkspaceName"
                ? validationErrorId
                : !canManage
                  ? manageReasonId
                  : undefined
            }
            disabled={busy}
            readOnly={!canManage}
            aria-disabled={!canManage || undefined}
          />
          <input
            className="input"
            placeholder="Sender name"
            value={brand.SenderName ?? ""}
            onChange={(e) => setField("SenderName", e.target.value)}
            aria-label="Sender name"
            maxLength={MAX_BRAND_TEXT_CHARACTERS}
            aria-invalid={invalidField === "SenderName" || undefined}
            aria-describedby={
              invalidField === "SenderName"
                ? validationErrorId
                : !canManage
                  ? manageReasonId
                  : undefined
            }
            disabled={busy}
            readOnly={!canManage}
            aria-disabled={!canManage || undefined}
          />
          <input
            className="input"
            placeholder="Product name"
            value={brand.ProductName ?? ""}
            onChange={(e) => setField("ProductName", e.target.value)}
            aria-label="Product name"
            maxLength={MAX_BRAND_TEXT_CHARACTERS}
            aria-invalid={invalidField === "ProductName" || undefined}
            aria-describedby={
              invalidField === "ProductName"
                ? validationErrorId
                : !canManage
                  ? manageReasonId
                  : undefined
            }
            disabled={busy}
            readOnly={!canManage}
            aria-disabled={!canManage || undefined}
          />
          <select
            className="input"
            value={brand.Tone ?? "casual"}
            aria-label="Tone"
            disabled={busy}
            aria-disabled={!canManage || undefined}
            aria-describedby={!canManage ? manageReasonId : undefined}
            onChange={(e) => {
              if (canManage) setField("Tone", e.target.value);
            }}
          >
            {TONES.map((t) => (
              <option key={t} value={t}>
                Tone: {t}
              </option>
            ))}
          </select>
          <input
            type="url"
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
            className="input"
            placeholder="Homepage URL"
            value={brand.HomepageURL ?? ""}
            onChange={(e) => setField("HomepageURL", e.target.value)}
            aria-label="Homepage URL"
            maxLength={MAX_BRAND_URL_BYTES}
            aria-invalid={invalidField === "HomepageURL" || undefined}
            aria-describedby={
              invalidField === "HomepageURL"
                ? validationErrorId
                : !canManage
                  ? manageReasonId
                  : undefined
            }
            disabled={busy}
            readOnly={!canManage}
            aria-disabled={!canManage || undefined}
          />
          <input
            type="url"
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
            className="input"
            placeholder="Unsubscribe URL"
            value={brand.UnsubscribeURL ?? ""}
            onChange={(e) => setField("UnsubscribeURL", e.target.value)}
            aria-label="Unsubscribe URL"
            maxLength={MAX_BRAND_URL_BYTES}
            aria-invalid={invalidField === "UnsubscribeURL" || undefined}
            aria-describedby={
              invalidField === "UnsubscribeURL"
                ? validationErrorId
                : !canManage
                  ? manageReasonId
                  : undefined
            }
            disabled={busy}
            readOnly={!canManage}
            aria-disabled={!canManage || undefined}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <select
            className="input"
            style={{ maxWidth: 220 }}
            value={variant}
            aria-label="Template variant"
            disabled={busy}
            aria-disabled={!canManage || undefined}
            aria-describedby={!canManage ? manageReasonId : undefined}
            onChange={(e) => {
              if (canManage) {
                setVariant(e.target.value);
                setErr(null);
                setInvalidField(null);
                setTemplate(null);
                setShowHtml(false);
              }
            }}
          >
            {SUNSET_VARIANTS.map((v) => (
              <option key={v} value={v}>
                {VARIANT_LABELS[v]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void generate()}
            disabled={busy}
            aria-disabled={!canManage || undefined}
            aria-describedby={!canManage ? manageReasonId : undefined}
          >
            {busy ? "Generating…" : "Generate preview"}
          </button>
        </div>

        {err ? (
          <div
            id={validationErrorId}
            className="notice"
            role="alert"
            style={{ fontSize: 12 }}
          >
            {err}
          </div>
        ) : null}
        {busy ? (
          <div className="muted" role="status" style={{ fontSize: 11 }}>
            Generating the preview from the current brand-field snapshot…
          </div>
        ) : null}

        {template ? (
          <div
            style={{
              border: "1px solid var(--pw-border)",
              borderRadius: 4,
              padding: 8,
              display: "flex",
              flexDirection: "column",
              gap: 6,
              fontSize: 12,
            }}
          >
            <div>
              <span className="muted">Subject:</span>{" "}
              <strong>{template.subject}</strong>
            </div>
            <div>
              <span className="muted">Preheader:</span> {template.preheader}
            </div>
            <pre
              style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                fontFamily: "inherit",
                fontSize: 12,
                background: "var(--pw-bg-elev-2)",
                borderRadius: 4,
                padding: 8,
              }}
            >
              {template.bodyText}
            </pre>
            <div>
              <span className="muted">Primary CTA:</span> {template.primaryCta}
            </div>
            <div className="muted" style={{ fontSize: 11 }}>
              Variant: {template.variant}. This preview is not linked to a live
              recipient count or an execution plan.
            </div>
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              style={{ alignSelf: "flex-start", fontSize: 11 }}
              onClick={() => setShowHtml((p) => !p)}
              aria-expanded={showHtml}
              aria-controls={htmlSourceId}
            >
              {showHtml ? "Hide HTML source" : "Show HTML source"}
            </button>
            {showHtml ? (
              <pre
                id={htmlSourceId}
                style={{
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  fontSize: 10,
                  fontFamily: "var(--pw-font-mono)",
                  maxHeight: 200,
                  overflowY: "auto",
                  background: "var(--pw-bg-elev-2)",
                  borderRadius: 4,
                  padding: 8,
                }}
              >
                {template.bodyHtml}
              </pre>
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}
