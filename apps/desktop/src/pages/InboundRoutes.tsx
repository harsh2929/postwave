/**
 * Inbound Routes — Mailgun-Routes-killer admin.
 *
 * Three sections on one page:
 *
 *   1. Endpoint card. The receiver URL + one-shot HMAC secret needed to wire
 *      up a provider (Postmark / Mailgun / SES). Without this, the
 *      rules below match nothing because no mail ever arrives. The
 *      card surfaces copy-to-clipboard for the URL and for a freshly
 *      created/rotated secret. Stored secrets are never read back.
 *
 *   2. Test match. A small panel that takes (recipient, subject?,
 *      from?) and shows which rule(s) would fire — invaluable for
 *      debugging globs without sending real email through.
 *
 *   3. Rules table. List every rule by priority (low number = checked
 *      first). Inline up/down arrows reorder, full edit modal swaps
 *      matchers + the multi-action pipeline. Type-to-confirm delete.
 *
 * Pattern grammar (mirrors server-side):
 *   match_recipient       shell-glob (e.g. "support@*", "*@acme.com", "*")
 *   match_subject_prefix  literal prefix (case-insensitive)
 *   match_from_domain     literal domain match
 *
 * Priority: ascending (lower = checked first). stop_on_match=true on
 * the first matching rule short-circuits the rest of the chain.
 *
 * Actions: zero or more per rule. Five kinds:
 *   tag                add a tag to the inbound email row
 *   automation_trigger fire an automation event (needs event_type)
 *   webhook            POST to URL (needs url)
 *   forward            re-send to an address (needs to)
 *   store_only         no side-effect; just halt at this rule
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

import { ConfirmModal } from "../components/ConfirmModal";
import { FormField } from "../components/FormField";
import {
  MatchHistoryPanel,
  ProviderSnippetsCard,
} from "../components/inbound/InboundRouteDiagnostics";
import { Modal, ModalFooter } from "../components/Modal";
import { Notice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { SectionHeader } from "../components/SectionHeader";
import { StatStrip } from "../components/StatStrip";
import { toast } from "../components/Toast";
import { ValuePropCard } from "../components/ValuePropCard";
import { useTabsInteraction } from "../hooks/useTabsInteraction";
import {
  type InboundRoute,
  type InboundRouteAction,
  type InboundRouteInput,
  type InboundRoutePreviewResponse,
  api,
} from "../lib/api-client";
import {
  type InboundRoutesController,
  useInboundRoutesController,
} from "./inbound-routes/useInboundRoutesController";
import { registerLifecycleGuard } from "../lib/lifecycle-coordinator";
import { safeInboundFailure } from "../lib/inbound-safe-error";
import {
  type InboundActionKind,
  INBOUND_ACTION_KINDS,
  inboundActionKindSpec,
} from "./inbound-routes/action-specs";
import { InboundRoutesTable } from "./inbound-routes/InboundRoutesTable";
import { EndpointCard } from "./inbound-routes/InboundEndpointCard";

import "../styles-inbound-routes-v2.css";

export { MatchHistoryPanel };
export { EndpointCard };

function registerInboundOperation(
  id: string,
  label: string,
  detail: string,
): () => void {
  return registerLifecycleGuard({
    id: `active-operation-inbound-route-${id}`,
    label,
    inspect: (intent) =>
      intent.disposition === "hide"
        ? null
        : {
            level: "blocking",
            detail,
            canSave: false,
            canDiscard: false,
            canRecover: false,
          },
  });
}

/* ---------- page ---------- */

export function InboundRoutes(): ReactElement {
  const controller = useInboundRoutesController();
  return <InboundRoutesPresentation controller={controller} />;
}

function InboundRoutesPresentation({
  controller,
}: {
  controller: InboundRoutesController;
}): ReactElement {
  const {
    canAdmin,
    endpoint,
    endpointErr,
    endpointStatus,
    err,
    loading,
    rows,
  } = controller;

  return (
    <div className="page page-with-pad">
      <PageHeader
        eyebrow="Inbound"
        title="Inbound routes"
        subtitle="Match inbound emails by recipient, subject prefix, or sender domain. Rules are evaluated in priority order (lowest first); stop_on_match halts the chain at the first hit."
        actions={
          canAdmin
            ? [
                {
                  label: "+ New route",
                  onClick: () => controller.setShowCreate(true),
                  variant: "primary",
                },
              ]
            : undefined
        }
      />

      {rows && rows.length > 0 ? <StatStrip cells={controller.stats} /> : null}

      {err && <div className="callout error">{err}</div>}

      {endpointStatus === "loading" && !endpoint ? (
        <Notice tone="neutral" announcement="polite">
          Verifying inbound endpoint configuration…
        </Notice>
      ) : endpointStatus === "error" && !endpoint ? (
        <Notice
          tone="danger"
          announcement="assertive"
          title="Inbound endpoint could not be verified."
          action={
            <button
              type="button"
              className="btn btn-sm pw-discoverable-unavailable"
              aria-disabled={loading || undefined}
              onClick={() => {
                if (!loading) void controller.reload();
              }}
            >
              Retry endpoint check
            </button>
          }
        >
          {endpointErr}
        </Notice>
      ) : (
        <>
          {endpointStatus === "error" ? (
            <Notice tone="warning" announcement="assertive">
              Showing the last verified endpoint. {endpointErr}
            </Notice>
          ) : null}
          <EndpointCard
            endpoint={endpoint}
            canAdmin={canAdmin}
            onRotated={controller.rotateEndpoint}
            onSecretHandled={controller.clearEndpointSecret}
          />
        </>
      )}

      {endpointStatus === "ready" || endpoint ? (
        <ProviderSnippetsCard slug={endpoint?.slug ?? ""} />
      ) : null}

      <TestMatchPanel routes={rows ?? []} />

      <div style={{ marginTop: 24, marginBottom: 4 }}>
        <SectionHeader
          title="Rules"
          description="Evaluated in priority order — lowest number first. Drag the handle to reorder."
          helpText="Glob-style match against the recipient address; supports * and ?. Subject and from-domain are exact-prefix and exact-match respectively."
        />
      </div>
      <InboundRoutesTable
        rows={rows}
        loading={loading}
        canAdmin={canAdmin}
        onCreate={() => controller.setShowCreate(true)}
        onEdit={controller.setEditing}
        onDelete={controller.setDeleting}
        onToggle={(route) => void controller.toggleEnabled(route)}
        onMove={(route, direction) => void controller.move(route, direction)}
        onDuplicate={(route) => void controller.duplicate(route)}
        onReorder={(srcId, targetId, placeBefore) =>
          void controller.reorder(srcId, targetId, placeBefore)
        }
        activeOperations={controller.activeOperations}
      />

      {rows && rows.length > 0 ? (
        <div style={{ marginTop: 20 }}>
          <ValuePropCard
            title="Test inbound routes with the Webhook Simulator"
            body="Fire synthetic, HMAC-signed payloads at any of your rules before going live. Inspect the exact request, response, and signature."
          />
        </div>
      ) : null}

      {controller.showCreate && (
        <RouteModal
          mode="create"
          onClose={() => controller.setShowCreate(false)}
          onSaved={async () => {
            controller.setShowCreate(false);
            await controller.loadRoutes();
          }}
        />
      )}

      {controller.editing && (
        <RouteModal
          mode="edit"
          existing={controller.editing}
          onClose={() => controller.setEditing(null)}
          onSaved={async () => {
            controller.setEditing(null);
            await controller.loadRoutes();
          }}
        />
      )}

      {controller.deleting && (
        <DeleteRouteModal
          route={controller.deleting}
          onClose={() => controller.setDeleting(null)}
          onDeleted={async () => {
            controller.setDeleting(null);
            await controller.loadRoutes();
          }}
        />
      )}
    </div>
  );
}

/* ---------- test-match panel ---------- */

export function TestMatchPanel({
  routes,
}: {
  routes: InboundRoute[];
}): ReactElement {
  const [recipient, setRecipient] = useState("");
  const [subject, setSubject] = useState("");
  const [from, setFrom] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InboundRoutePreviewResponse | null>(
    null,
  );
  const [err, setErr] = useState<string | null>(null);
  const instanceId = useId();
  const runDescriptionId = `${instanceId}-run-description`;
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const lifecycleDiscardedRef = useRef(false);
  const dirty = recipient.length > 0 || subject.length > 0 || from.length > 0;

  const clearDraft = useCallback((): void => {
    setRecipient("");
    setSubject("");
    setFrom("");
    setResult(null);
    setErr(null);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!dirty || busy) return;
    lifecycleDiscardedRef.current = false;
    return registerLifecycleGuard({
      id: `inbound-route-preview-draft-${instanceId}`,
      label: "Inbound route preview draft",
      inspect: (intent) =>
        lifecycleDiscardedRef.current || intent.disposition === "hide"
          ? null
          : {
              level: "warning",
              detail:
                "The recipient, subject, and sender preview values have not been run or cleared.",
              canSave: false,
              canDiscard: true,
              canRecover: false,
            },
      discard: () => {
        lifecycleDiscardedRef.current = true;
        clearDraft();
      },
    });
  }, [busy, clearDraft, dirty, instanceId]);

  const run = async (): Promise<void> => {
    if (busyRef.current) return;
    if (!recipient.trim()) {
      setErr("Recipient required");
      return;
    }
    busyRef.current = true;
    setErr(null);
    setBusy(true);
    const unregisterOperation = registerInboundOperation(
      `preview-${instanceId}`,
      "Inbound route preview",
      "Wait for the route preview to finish before leaving Moosewave.",
    );
    try {
      const res = await api.inboundRoutePreview({
        recipient: recipient.trim(),
        subject: subject.trim() || undefined,
        from: from.trim() || undefined,
      });
      if (!mountedRef.current) return;
      if (res.error) {
        setErr(
          safeInboundFailure(res.error, "The preview couldn't be verified."),
        );
        setResult(null);
        return;
      }
      setResult(res.data ?? null);
    } catch {
      if (mountedRef.current) {
        setErr(
          "Preview did not complete. Check your connection and try again.",
        );
        setResult(null);
      }
    } finally {
      unregisterOperation();
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  return (
    <details
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 8,
        padding: "8px 16px",
        marginBottom: 16,
        background: "var(--pw-bg-elev)",
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          padding: "6px 0",
          fontWeight: 600,
          fontSize: 14,
        }}
      >
        Test match
        <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
          — see which rules would fire for a synthesized message
        </span>
      </summary>
      <div style={{ paddingBottom: 8 }}>
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {/* D12-comms-webhooks#17: PreviewRoutes deliberately evaluates
              disabled rules too (they're returned marked "disabled"), unlike
              production MatchRoutes which filters enabled=true. */}
          Doesn't send real email; doesn't bump match counters. Disabled rules
          are shown but marked &mdash; they&apos;re evaluated here so you can
          see whether they <em>would</em> fire, but they won&apos;t fire in
          production. A stop_on_match on an earlier <strong>enabled</strong>{" "}
          rule still hides later matches, just as in production.
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
            gap: 8,
          }}
        >
          <div>
            <div className="label">Recipient (To:)</div>
            <input
              type="text"
              aria-label="Preview recipient"
              value={recipient}
              autoComplete="off"
              placeholder="support@acme.com"
              onChange={(e) => setRecipient(e.target.value)}
            />
          </div>
          <div>
            <div className="label">Subject (optional)</div>
            <input
              type="text"
              aria-label="Preview subject"
              value={subject}
              autoComplete="off"
              placeholder="[urgent] need help"
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
          <div>
            <div className="label">From (optional)</div>
            <input
              type="text"
              aria-label="Preview sender"
              value={from}
              autoComplete="off"
              placeholder="customer@example.com"
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
        </div>
        <div
          style={{
            marginTop: 8,
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            className={`btn btn-primary${routes.length === 0 ? " pw-discoverable-unavailable" : ""}`}
            disabled={busy}
            aria-disabled={busy || routes.length === 0 || undefined}
            aria-describedby={runDescriptionId}
            onClick={() => {
              if (routes.length > 0) void run();
            }}
          >
            {busy ? "Running…" : "Run preview"}
          </button>
          {dirty || result ? (
            <button type="button" disabled={busy} onClick={clearDraft}>
              Clear preview
            </button>
          ) : null}
          {err && (
            <span style={{ color: "var(--pw-danger)", fontSize: 12 }}>
              {err}
            </span>
          )}
        </div>
        <div
          id={runDescriptionId}
          className="muted"
          role="status"
          style={{ fontSize: 11, marginTop: 6 }}
        >
          {busy
            ? "Evaluating the preview against the current rule order."
            : routes.length === 0
              ? "Create at least one route before running a preview."
              : "Runs a non-delivery preview against every current route; a recipient is required."}
        </div>

        {result && (
          <div style={{ marginTop: 12 }}>
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>
              Evaluated <strong>{result.evaluated}</strong> rule
              {result.evaluated === 1 ? "" : "s"}.{" "}
              {result.no_matches ? (
                <>
                  No rule matched — the email would be stored with no actions.
                </>
              ) : (
                <>
                  {result.matches.length} match
                  {result.matches.length === 1 ? "" : "es"}.{" "}
                  {result.stopped_at_route_id && (
                    <>
                      Chain stopped at <code>stop_on_match</code> after the
                      highlighted rule.
                    </>
                  )}
                </>
              )}
            </p>
            {result.matches.length > 0 && (
              <ul style={{ paddingLeft: 18, margin: "8px 0 0" }}>
                {result.matches.map((m) => {
                  const stopped = m.route.id === result.stopped_at_route_id;
                  return (
                    <li
                      key={m.route.id}
                      style={{ fontSize: 13, marginBottom: 6 }}
                    >
                      <strong>{m.route.name || "(unnamed)"}</strong>{" "}
                      <span className="badge">prio {m.route.priority}</span>{" "}
                      {!m.route.enabled && (
                        <span className="badge warning">disabled</span>
                      )}{" "}
                      {stopped && <span className="badge success">stop</span>}
                      <div
                        className="muted"
                        style={{ fontSize: 12, marginTop: 2 }}
                      >
                        {m.reason} · actions:{" "}
                        {m.route.actions.map((a) => a.kind).join(", ") || "—"}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </details>
  );
}

/* ---------- create/edit modal ---------- */

interface ActionDraft {
  /** Local id so React doesn't keep wrong fields when reorder. */
  uid: string;
  kind: InboundActionKind;
  tag?: string;
  event_type?: string;
  url?: string;
  to?: string;
  /**
   * v2: webhook HMAC signing secret. Stored in the route's
   * actions[i].extra.hmac_secret jsonb slot. The v1 backend already
   * supported this for outbound signing of inbound webhook actions
   * but the editor never exposed it — operators couldn't configure
   * signed webhooks without a direct SQL UPDATE.
   */
  hmac_secret?: string;
  /** Preserve non-edited server extras without exposing a stored secret. */
  originIndex?: number;
  hasStoredHmacSecret?: boolean;
  remove_hmac_secret?: boolean;
}

function actionToDraft(a: InboundRouteAction, i: number): ActionDraft {
  return {
    uid: `${i}-${a.kind}-${Math.random().toString(36).slice(2, 8)}`,
    kind: a.kind,
    tag: a.tag,
    event_type: a.event_type,
    url: a.url,
    to: a.to,
    hmac_secret: "",
    originIndex: i,
    hasStoredHmacSecret:
      a.has_stored_hmac_secret === true ||
      (typeof a.extra?.hmac_secret === "string" &&
        a.extra.hmac_secret.trim() !== ""),
    remove_hmac_secret: false,
  };
}

function draftToAction(
  d: ActionDraft,
  originalActions: InboundRouteAction[] = [],
): InboundRouteAction {
  const a: InboundRouteAction = { kind: d.kind };
  if (d.kind === "tag" && d.tag) a.tag = d.tag.trim();
  if (d.kind === "automation_trigger" && d.event_type)
    a.event_type = d.event_type.trim();
  if (d.kind === "webhook" && d.url) a.url = d.url.trim();
  if (d.kind === "forward" && d.to) a.to = d.to.trim();
  // Preserve opaque extras by source identity. A stored HMAC value never enters
  // a controlled input: blank means keep it, a new value replaces it, and the
  // explicit removal checkbox deletes it.
  const original =
    d.originIndex == null ? undefined : originalActions[d.originIndex];
  const extra =
    original?.kind === d.kind && original.extra ? { ...original.extra } : {};
  delete extra.hmac_secret;
  if (d.kind === "webhook") {
    if (d.remove_hmac_secret) a.remove_stored_hmac = true;
    else if (d.hmac_secret?.trim()) extra.hmac_secret = d.hmac_secret.trim();
    else if (d.hasStoredHmacSecret && d.originIndex != null)
      a.preserve_hmac_from_index = d.originIndex;
  }
  if (Object.keys(extra).length > 0) a.extra = extra;
  return a;
}

interface RouteDraftFingerprintInput {
  name: string;
  recipient: string;
  subjectPrefix: string;
  fromDomain: string;
  priority: string;
  stopOnMatch: boolean;
  actions: ActionDraft[];
}

/** Exact, non-persistent comparison covering every editable route field. */
export function inboundRouteDraftFingerprint(
  draft: RouteDraftFingerprintInput,
): string {
  return JSON.stringify({
    name: draft.name,
    recipient: draft.recipient,
    subjectPrefix: draft.subjectPrefix,
    fromDomain: draft.fromDomain,
    priority: draft.priority,
    stopOnMatch: draft.stopOnMatch,
    actions: draft.actions.map((action) => ({
      kind: action.kind,
      tag: action.tag ?? "",
      event_type: action.event_type ?? "",
      url: action.url ?? "",
      to: action.to ?? "",
      hmac_secret: action.hmac_secret ?? "",
      originIndex: action.originIndex ?? null,
      hasStoredHmacSecret: action.hasStoredHmacSecret ?? false,
      remove_hmac_secret: action.remove_hmac_secret ?? false,
    })),
  });
}

function initialRouteActions(existing?: InboundRoute): ActionDraft[] {
  return existing?.actions?.length
    ? existing.actions.map(actionToDraft)
    : [{ uid: "default", kind: "tag", tag: "inbound" }];
}

function useRouteActionDrafts(existing?: InboundRoute) {
  const [actions, setActions] = useState<ActionDraft[]>(() =>
    initialRouteActions(existing),
  );
  const addAction = (): void => {
    setActions((previous) => [
      ...previous,
      {
        uid: `new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        kind: "tag",
        tag: "",
      },
    ]);
  };
  const updateAction = (uid: string, patch: Partial<ActionDraft>): void => {
    setActions((previous) =>
      previous.map((action) =>
        action.uid === uid ? { ...action, ...patch } : action,
      ),
    );
  };
  const removeAction = (uid: string): void => {
    setActions((previous) => previous.filter((action) => action.uid !== uid));
  };
  const moveAction = (index: number, direction: -1 | 1): void => {
    setActions((previous) => {
      const target = index + direction;
      if (target < 0 || target >= previous.length) return previous;
      const next = [...previous];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  };
  return {
    actions,
    setActions,
    addAction,
    updateAction,
    removeAction,
    moveAction,
  };
}

interface RouteValidationDraft {
  actions: ActionDraft[];
  name: string;
  priority: string;
  recipient: string;
}

function validateRouteDraft({
  actions,
  name,
  priority,
  recipient,
}: RouteValidationDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!name.trim()) errors.name = "Name is required";
  if (!recipient.trim()) {
    errors.recipient = "Recipient glob is required (use * for catch-all)";
  }
  const parsedPriority = Number(priority.trim());
  if (
    priority.trim() === "" ||
    !Number.isInteger(parsedPriority) ||
    parsedPriority < 0 ||
    parsedPriority > 10000
  ) {
    errors.priority = "Priority must be a whole number between 0 and 10000";
  }
  actions.forEach((action) => {
    const specification = inboundActionKindSpec(action.kind);
    for (const field of specification.fields) {
      if (!field.required) continue;
      const value =
        (action[field.key as keyof ActionDraft] as string | undefined) ?? "";
      if (!value.trim()) {
        errors[`${action.uid}.${String(field.key)}`] =
          `${field.label} required`;
      }
    }
  });
  return errors;
}

export function RouteModal({
  mode,
  existing,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  existing?: InboundRoute;
  onClose: () => void;
  onSaved: () => Promise<void>;
}): ReactElement {
  const [name, setName] = useState(existing?.name ?? "");
  const [recipient, setRecipient] = useState(existing?.match_recipient ?? "*");
  const [subjectPrefix, setSubjectPrefix] = useState(
    existing?.match_subject_prefix ?? "",
  );
  const [fromDomain, setFromDomain] = useState(
    existing?.match_from_domain ?? "",
  );
  // Kept as a string so the field can be controlled while empty —
  // `parseInt(v) || 100` silently coerced a valid 0 to 100 (priority 0
  // is the *highest* priority, so that bug pushed top rules near-last).
  // Parsed + validated on submit instead.
  const [priority, setPriority] = useState<string>(
    String(existing?.priority ?? 100),
  );
  const [stopOnMatch, setStopOnMatch] = useState(
    existing?.stop_on_match ?? true,
  );
  const {
    actions,
    setActions,
    addAction,
    updateAction,
    removeAction,
    moveAction,
  } = useRouteActionDrafts(existing);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [discardTarget, setDiscardTarget] = useState<
    "close" | "history" | null
  >(null);
  const instanceId = useId();
  const operationRef = useRef(false);
  const mountedRef = useRef(true);
  const lifecycleDiscardedRef = useRef(false);
  const baselineFingerprintRef = useRef(
    inboundRouteDraftFingerprint({
      name: existing?.name ?? "",
      recipient: existing?.match_recipient ?? "*",
      subjectPrefix: existing?.match_subject_prefix ?? "",
      fromDomain: existing?.match_from_domain ?? "",
      priority: String(existing?.priority ?? 100),
      stopOnMatch: existing?.stop_on_match ?? true,
      actions: initialRouteActions(existing),
    }),
  );
  const currentFingerprint = useMemo(
    () =>
      inboundRouteDraftFingerprint({
        name,
        recipient,
        subjectPrefix,
        fromDomain,
        priority,
        stopOnMatch,
        actions,
      }),
    [
      actions,
      fromDomain,
      name,
      priority,
      recipient,
      stopOnMatch,
      subjectPrefix,
    ],
  );
  const dirty = currentFingerprint !== baselineFingerprintRef.current;

  const zeroizeHmacDrafts = useCallback((): void => {
    setActions((previous) =>
      previous.map((action) => ({ ...action, hmac_secret: "" })),
    );
  }, []);

  const closeAndZeroize = useCallback((): void => {
    zeroizeHmacDrafts();
    setErrors({});
    setDiscardTarget(null);
    onClose();
  }, [onClose, zeroizeHmacDrafts]);

  const restoreBaseline = useCallback((): void => {
    const restoredActions = initialRouteActions(existing);
    const restored = {
      name: existing?.name ?? "",
      recipient: existing?.match_recipient ?? "*",
      subjectPrefix: existing?.match_subject_prefix ?? "",
      fromDomain: existing?.match_from_domain ?? "",
      priority: String(existing?.priority ?? 100),
      stopOnMatch: existing?.stop_on_match ?? true,
      actions: restoredActions,
    };
    baselineFingerprintRef.current = inboundRouteDraftFingerprint(restored);
    setName(restored.name);
    setRecipient(restored.recipient);
    setSubjectPrefix(restored.subjectPrefix);
    setFromDomain(restored.fromDomain);
    setPriority(restored.priority);
    setStopOnMatch(restored.stopOnMatch);
    setActions(restoredActions);
    setErrors({});
  }, [existing]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!dirty || busy) return;
    lifecycleDiscardedRef.current = false;
    return registerLifecycleGuard({
      id: `inbound-route-draft-${mode}-${existing?.id ?? "new"}-${instanceId}`,
      label: mode === "create" ? "New inbound route" : "Inbound route changes",
      inspect: (intent) =>
        lifecycleDiscardedRef.current || intent.disposition === "hide"
          ? null
          : {
              level: "blocking",
              detail:
                "This route configuration is only in memory. Return to the editor or explicitly discard it.",
              canSave: false,
              canDiscard: true,
              canRecover: false,
            },
      discard: () => {
        lifecycleDiscardedRef.current = true;
        closeAndZeroize();
      },
    });
  }, [busy, closeAndZeroize, dirty, existing?.id, instanceId, mode]);

  const validate = (): boolean => {
    const nextErrors = validateRouteDraft({
      actions,
      name,
      priority,
      recipient,
    });
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const save = async (): Promise<void> => {
    if (operationRef.current) return;
    if (!validate()) return;
    operationRef.current = true;
    setBusy(true);
    const unregisterOperation = registerInboundOperation(
      `save-${mode}-${existing?.id ?? "new"}-${instanceId}`,
      mode === "create" ? "Inbound route creation" : "Inbound route update",
      "Wait for the inbound route request to finish before leaving Moosewave.",
    );
    const builtActions = actions.map((action) =>
      draftToAction(action, existing?.actions),
    );
    const input: InboundRouteInput = {
      name: name.trim(),
      priority: Number(priority.trim()),
      stop_on_match: stopOnMatch,
      enabled: existing?.enabled ?? true,
      match_recipient: recipient.trim() || "*",
      match_subject_prefix: subjectPrefix.trim(),
      match_from_domain: fromDomain.trim(),
      actions: builtActions,
      // v2: explicit clear sentinel. When the editor has zero actions,
      // pair `actions: []` with `clear_actions: true` so the v2
      // backend distinguishes "I removed all actions" from the legacy
      // accidental-empty-PATCH case (v1 silently preserved actions in
      // both, hiding a real data-loss footgun).
      clear_actions: mode === "edit" && builtActions.length === 0,
      ...(mode === "edit"
        ? { expected_updated_at: existing!.updated_at }
        : {}),
    };
    try {
      const res =
        mode === "create"
          ? await api.inboundRouteCreate(input)
          : await api.inboundRoutePatch(existing!.id, input);
      if (!mountedRef.current) return;
      if (res.error) {
        toast.error({
          message:
            mode === "create"
              ? "Couldn't create route"
              : "Couldn't update route",
          detail: safeInboundFailure(
            res.error,
            mode === "create"
              ? "The route wasn't created."
              : "The route wasn't updated.",
          ),
        });
        return;
      }
      zeroizeHmacDrafts();
      toast.success(mode === "create" ? "Route created" : "Route updated");
      try {
        await onSaved();
      } catch {
        if (mountedRef.current) {
          toast.error({
            message:
              mode === "create"
                ? "Route created, but refresh failed"
                : "Route updated, but refresh failed",
            detail:
              "The server committed the change. Refresh the route list; do not submit the same mutation again.",
          });
        }
      }
    } catch {
      if (mountedRef.current) {
        toast.error({
          message:
            mode === "create"
              ? "Couldn't create route"
              : "Couldn't update route",
          detail:
            "The request did not complete. Your draft is still open so you can retry.",
        });
      }
    } finally {
      unregisterOperation();
      operationRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  // Tab state: only shown in edit mode. Create mode has no history.
  const [tab, setTab] = useState<"config" | "history">("config");

  const requestClose = (): void => {
    if (operationRef.current || busy) return;
    if (dirty) {
      setDiscardTarget("close");
      return;
    }
    closeAndZeroize();
  };

  const requestHistory = (): void => {
    if (operationRef.current || busy) return;
    if (dirty) {
      setDiscardTarget("history");
      return;
    }
    zeroizeHmacDrafts();
    setTab("history");
  };

  const confirmDiscard = (): void => {
    if (operationRef.current || busy || !discardTarget) return;
    const target = discardTarget;
    restoreBaseline();
    setDiscardTarget(null);
    if (target === "history") setTab("history");
    else closeAndZeroize();
  };

  const controller: RouteModalViewModel = {
    name,
    setName,
    recipient,
    setRecipient,
    subjectPrefix,
    setSubjectPrefix,
    fromDomain,
    setFromDomain,
    priority,
    setPriority,
    stopOnMatch,
    setStopOnMatch,
    actions,
    errors,
    busy,
    discardTarget,
    setDiscardTarget,
    tab,
    setTab,
    save,
    addAction,
    updateAction,
    removeAction,
    moveAction,
    requestClose,
    requestHistory,
    confirmDiscard,
  };

  return (
    <RouteModalPresentation
      mode={mode}
      existing={existing}
      controller={controller}
    />
  );
}

interface RouteModalViewModel {
  name: string;
  setName: (value: string) => void;
  recipient: string;
  setRecipient: (value: string) => void;
  subjectPrefix: string;
  setSubjectPrefix: (value: string) => void;
  fromDomain: string;
  setFromDomain: (value: string) => void;
  priority: string;
  setPriority: (value: string) => void;
  stopOnMatch: boolean;
  setStopOnMatch: (value: boolean) => void;
  actions: ActionDraft[];
  errors: Record<string, string>;
  busy: boolean;
  discardTarget: "close" | "history" | null;
  setDiscardTarget: (value: "close" | "history" | null) => void;
  tab: "config" | "history";
  setTab: (value: "config" | "history") => void;
  save: () => Promise<void>;
  addAction: () => void;
  updateAction: (uid: string, patch: Partial<ActionDraft>) => void;
  removeAction: (uid: string) => void;
  moveAction: (index: number, direction: -1 | 1) => void;
  requestClose: () => void;
  requestHistory: () => void;
  confirmDiscard: () => void;
}

function RouteConfigurationForm({
  mode,
  controller,
}: {
  mode: "create" | "edit";
  controller: RouteModalViewModel;
}): ReactElement {
  const {
    name,
    setName,
    recipient,
    setRecipient,
    subjectPrefix,
    setSubjectPrefix,
    fromDomain,
    setFromDomain,
    priority,
    setPriority,
    stopOnMatch,
    setStopOnMatch,
    actions,
    errors,
    busy,
    save,
    addAction,
    updateAction,
    removeAction,
    moveAction,
    requestClose,
  } = controller;
  return (
    <form
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <FormField label="Name" required error={errors.name}>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Support catch-all"
          autoComplete="off"
        />
      </FormField>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
        <FormField
          label="Priority"
          help="Lower number = evaluated first. 0 is highest."
          error={errors.priority}
        >
          <input
            type="number"
            value={priority}
            min={0}
            max={10000}
            onChange={(event) => setPriority(event.target.value)}
          />
        </FormField>
        <FormField label=" ">
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: 32,
              fontSize: 13,
            }}
          >
            <input
              type="checkbox"
              checked={stopOnMatch}
              onChange={(event) => setStopOnMatch(event.target.checked)}
              style={{ width: "auto", height: "auto" }}
            />
            Stop on match
          </label>
        </FormField>
      </div>
      <RouteMatcherFields
        recipient={recipient}
        subjectPrefix={subjectPrefix}
        fromDomain={fromDomain}
        recipientError={errors.recipient}
        onRecipientChange={setRecipient}
        onSubjectPrefixChange={setSubjectPrefix}
        onFromDomainChange={setFromDomain}
      />
      <RouteActionsFields
        actions={actions}
        errors={errors}
        onAdd={addAction}
        onChange={updateAction}
        onRemove={removeAction}
        onMove={moveAction}
      />
      <ModalFooter>
        <button type="button" onClick={requestClose} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy
            ? "Saving…"
            : mode === "create"
              ? "Create route"
              : "Save changes"}
        </button>
      </ModalFooter>
    </form>
  );
}

function RouteModalPresentation({
  mode,
  existing,
  controller,
}: {
  mode: "create" | "edit";
  existing?: InboundRoute;
  controller: RouteModalViewModel;
}): ReactElement {
  const {
    busy,
    discardTarget,
    setDiscardTarget,
    tab,
    setTab,
    requestClose,
    requestHistory,
    confirmDiscard,
  } = controller;
  const tabs = useTabsInteraction({
    value: tab,
    items: [
      { value: "config" as const },
      { value: "history" as const, disabled: busy },
    ],
    onChange: (next) => {
      if (next === "history") requestHistory();
      else setTab("config");
    },
    activation: "manual",
  });

  return (
    <Modal
      open
      onClose={requestClose}
      title={mode === "create" ? "New inbound route" : `Edit ${existing?.name}`}
      description="Match by recipient glob, subject prefix, and/or from-domain. Define the action pipeline that fires on match."
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      closeDisabled={busy}
    >
      {mode === "edit" && existing ? (
        <>
          <div
            ref={tabs.listRef}
            className="tabbar"
            {...tabs.listProps}
            aria-label="Inbound route editor sections"
            style={{ marginBottom: 12 }}
          >
            <button
              type="button"
              {...tabs.getTabProps("config")}
              className={tab === "config" ? "tab active" : "tab"}
            >
              Configuration
            </button>
            <button
              type="button"
              {...tabs.getTabProps("history")}
              className={tab === "history" ? "tab active" : "tab"}
              disabled={busy}
            >
              History{" "}
              <span className="muted">
                ({existing.match_count}{" "}
                {existing.match_count === 1 ? "match" : "matches"})
              </span>
            </button>
          </div>
          <div {...tabs.getPanelProps("config")}>
            <RouteConfigurationForm mode={mode} controller={controller} />
          </div>
          <div {...tabs.getPanelProps("history")}>
            {tab === "history" ? (
              <>
                <MatchHistoryPanel routeId={existing.id} />
                <ModalFooter>
                  <button type="button" onClick={requestClose}>
                    Close
                  </button>
                </ModalFooter>
              </>
            ) : null}
          </div>
        </>
      ) : (
        <RouteConfigurationForm mode={mode} controller={controller} />
      )}
      <ConfirmModal
        open={discardTarget !== null}
        onClose={() => setDiscardTarget(null)}
        title={
          discardTarget === "history"
            ? "Discard changes and view history?"
            : "Discard inbound route draft?"
        }
        description="Every unsaved matcher and action change will be cleared. New HMAC plaintext is zeroized."
        confirmLabel="Discard changes"
        danger
        onConfirm={confirmDiscard}
      />
    </Modal>
  );
}

function RouteMatcherFields({
  recipient,
  subjectPrefix,
  fromDomain,
  recipientError,
  onRecipientChange,
  onSubjectPrefixChange,
  onFromDomainChange,
}: {
  recipient: string;
  subjectPrefix: string;
  fromDomain: string;
  recipientError?: string;
  onRecipientChange: (value: string) => void;
  onSubjectPrefixChange: (value: string) => void;
  onFromDomainChange: (value: string) => void;
}): ReactElement {
  return (
    <div
      style={{
        borderTop: "1px solid var(--pw-border)",
        paddingTop: 12,
        marginTop: 4,
      }}
    >
      <div className="label">Matchers</div>
      <FormField
        label="Recipient (glob)"
        required
        error={recipientError}
        help="Glob-style match against the recipient address; supports * and ?. Case-insensitive. Use * for catch-all."
      >
        <input
          type="text"
          value={recipient}
          onChange={(event) => onRecipientChange(event.target.value)}
          placeholder="support@* or *@acme.com or *"
          autoComplete="off"
        />
      </FormField>
      <FormField
        label="Subject prefix (optional)"
        help="Case-insensitive prefix match. Leave blank to match any subject."
      >
        <input
          type="text"
          value={subjectPrefix}
          onChange={(event) => onSubjectPrefixChange(event.target.value)}
          placeholder="[urgent]"
          autoComplete="off"
        />
      </FormField>
      <FormField
        label="From-domain (optional)"
        help="Exact domain match (case-insensitive). Leave blank to match any sender."
      >
        <input
          type="text"
          value={fromDomain}
          onChange={(event) => onFromDomainChange(event.target.value)}
          placeholder="acme.com"
          autoComplete="off"
        />
      </FormField>
    </div>
  );
}

function RouteActionsFields({
  actions,
  errors,
  onAdd,
  onChange,
  onRemove,
  onMove,
}: {
  actions: ActionDraft[];
  errors: Record<string, string>;
  onAdd: () => void;
  onChange: (uid: string, patch: Partial<ActionDraft>) => void;
  onRemove: (uid: string) => void;
  onMove: (index: number, direction: -1 | 1) => void;
}): ReactElement {
  return (
    <div
      style={{
        borderTop: "1px solid var(--pw-border)",
        paddingTop: 12,
        marginTop: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <div>
          <div className="label" style={{ marginBottom: 0 }}>
            Actions
          </div>
          <p className="muted" style={{ fontSize: 11, margin: "2px 0 0" }}>
            Run top-to-bottom on match. Action failures are logged but don't
            halt the rest of the pipeline.
          </p>
        </div>
        <button type="button" onClick={onAdd}>
          + Add action
        </button>
      </div>
      {actions.length === 0 && (
        <p className="muted" style={{ fontSize: 12 }}>
          No actions — matched emails will be stored with no side-effect.
        </p>
      )}
      {actions.map((action, index) => (
        <ActionEditor
          key={action.uid}
          draft={action}
          index={index}
          total={actions.length}
          errors={errors}
          onChange={(patch) => onChange(action.uid, patch)}
          onRemove={() => onRemove(action.uid)}
          onMoveUp={() => onMove(index, -1)}
          onMoveDown={() => onMove(index, 1)}
        />
      ))}
    </div>
  );
}

function ActionEditor({
  draft,
  index,
  total,
  errors,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  draft: ActionDraft;
  index: number;
  total: number;
  errors: Record<string, string>;
  onChange: (patch: Partial<ActionDraft>) => void;
  onRemove: () => void;
  /** v2: reorder controls. Disabled when at the relevant edge. */
  onMoveUp: () => void;
  onMoveDown: () => void;
}): ReactElement {
  const spec = inboundActionKindSpec(draft.kind);
  const reorderDescriptionId = useId();
  const moveUpDescriptionId = `${reorderDescriptionId}-earlier`;
  const moveDownDescriptionId = `${reorderDescriptionId}-later`;
  const cannotMoveUp = index === 0;
  const cannotMoveDown = index === total - 1;
  return (
    <div
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        padding: 10,
        marginBottom: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
          alignItems: "flex-start",
        }}
      >
        <div style={{ flex: 1 }}>
          <div className="label" style={{ fontSize: 10 }}>
            Action {index + 1} of {total}
          </div>
          <select
            value={draft.kind}
            onChange={(e) =>
              onChange({
                kind: e.target.value as InboundActionKind,
                // Clear kind-specific fields when switching so we
                // don't keep stale values that no longer apply.
                tag: undefined,
                event_type: undefined,
                url: undefined,
                to: undefined,
                hmac_secret: undefined,
                originIndex: undefined,
                hasStoredHmacSecret: false,
                remove_hmac_secret: false,
              })
            }
          >
            {INBOUND_ACTION_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", gap: 4, marginTop: 18 }}>
          {/* v2: reorder controls — actions are documented as
              executed top-to-bottom, but the v1 editor had no way to
              change order. Up/down arrows are the most direct
              affordance; matches the rule-priority pattern used in
              the table above. */}
          <button
            type="button"
            className={`link-button${cannotMoveUp ? " pw-discoverable-unavailable" : ""}`}
            onClick={() => {
              if (!cannotMoveUp) onMoveUp();
            }}
            aria-disabled={cannotMoveUp || undefined}
            aria-label={`Move action ${index + 1} earlier`}
            aria-describedby={moveUpDescriptionId}
            style={{ padding: "0 4px" }}
          >
            ▲
          </button>
          <button
            type="button"
            className={`link-button${cannotMoveDown ? " pw-discoverable-unavailable" : ""}`}
            onClick={() => {
              if (!cannotMoveDown) onMoveDown();
            }}
            aria-disabled={cannotMoveDown || undefined}
            aria-label={`Move action ${index + 1} later`}
            aria-describedby={moveDownDescriptionId}
            style={{ padding: "0 4px" }}
          >
            ▼
          </button>
          <button
            type="button"
            className="link-button danger"
            onClick={onRemove}
            aria-label="Remove action"
          >
            Remove
          </button>
          <span id={moveUpDescriptionId} className="sr-only">
            {cannotMoveUp
              ? "This action already runs first."
              : "Moves this action one position earlier in the execution order."}
          </span>
          <span id={moveDownDescriptionId} className="sr-only">
            {cannotMoveDown
              ? "This action already runs last."
              : "Moves this action one position later in the execution order."}
          </span>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 11, margin: "6px 0 8px" }}>
        {spec.description}
      </p>
      {spec.fields.map((f) => {
        const errKey = `${draft.uid}.${String(f.key)}`;
        const value =
          (draft[f.key as keyof ActionDraft] as string | undefined) ?? "";
        return (
          <FormField
            key={String(f.key)}
            label={f.label}
            required={f.required}
            error={errors[errKey]}
            help={f.helpText}
          >
            <input
              type="text"
              value={value}
              placeholder={f.placeholder}
              autoComplete="off"
              onChange={(e) =>
                onChange({ [f.key]: e.target.value } as Partial<ActionDraft>)
              }
            />
          </FormField>
        );
      })}
      {/* v2: webhook HMAC secret field. Backend already reads
          action.extra.hmac_secret for outbound signing — surface
          it here so operators can configure signed webhooks
          without a direct SQL UPDATE. */}
      {draft.kind === "webhook" ? (
        <FormField
          label="HMAC signing secret"
          help={
            draft.hasStoredHmacSecret
              ? "A secret is already configured but is never pre-filled here. Leave blank to keep it, or enter a replacement."
              : "Optional. When set, each POST carries X-Postwave-Inbound-Signature: sha256=<hex(hmac(secret, body))>. Receivers verify with the same key."
          }
        >
          <input
            type="password"
            aria-label="HMAC signing secret"
            value={draft.hmac_secret ?? ""}
            placeholder={
              draft.hasStoredHmacSecret
                ? "leave blank to keep stored secret"
                : "leave blank for unsigned"
            }
            autoComplete="off"
            spellCheck={false}
            disabled={draft.remove_hmac_secret}
            onChange={(e) =>
              onChange({
                hmac_secret: e.target.value,
                remove_hmac_secret: false,
              })
            }
          />
          {draft.hasStoredHmacSecret ? (
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                marginTop: 6,
              }}
            >
              <input
                type="checkbox"
                checked={draft.remove_hmac_secret ?? false}
                onChange={(event) =>
                  onChange({
                    remove_hmac_secret: event.target.checked,
                    hmac_secret: "",
                  })
                }
                style={{ width: "auto", height: "auto" }}
              />
              Remove the stored signing secret when this route is saved
            </label>
          ) : null}
        </FormField>
      ) : null}
    </div>
  );
}

/* ---------- delete (type-to-confirm) ---------- */

export function DeleteRouteModal({
  route,
  onClose,
  onDeleted,
}: {
  route: InboundRoute;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}): ReactElement {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const instanceId = useId();
  const operationRef = useRef(false);
  const mountedRef = useRef(true);
  // Falls back to id-prefix when the route has no name so the prompt
  // stays meaningful.
  const target = route.name?.trim() || `route ${route.id.slice(0, 8)}`;
  const matches = text.trim() === target;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const destroy = async (): Promise<void> => {
    if (!matches || operationRef.current) return;
    operationRef.current = true;
    setBusy(true);
    const unregisterOperation = registerInboundOperation(
      `delete-${route.id}-${instanceId}`,
      "Inbound route deletion",
      "Wait for route deletion to finish before leaving Moosewave.",
    );
    try {
      const res = await api.inboundRouteDelete(route.id);
      if (!mountedRef.current) return;
      if (res.error) {
        toast.error({
          message: "Couldn't delete route",
          detail: safeInboundFailure(res.error, "The route wasn't deleted."),
        });
        return;
      }
      setText("");
      toast.success("Route deleted");
      try {
        await onDeleted();
      } catch {
        if (mountedRef.current) {
          toast.error({
            message: "Route deleted, but refresh failed",
            detail:
              "The server committed the deletion. Refresh the route list; do not repeat the delete request.",
          });
        }
      }
    } catch {
      if (mountedRef.current) {
        toast.error({
          message: "Couldn't delete route",
          detail:
            "The delete request did not complete. The route has not been assumed deleted.",
        });
      }
    } finally {
      unregisterOperation();
      operationRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Delete inbound route"
      description="This permanently removes the rule. Inbound emails that previously matched will pass through to the next rule (or fall through with no actions)."
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      closeDisabled={busy}
    >
      <p style={{ fontSize: 13 }}>
        Type <strong>{target}</strong> to confirm deletion.
      </p>
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoComplete="off"
        placeholder={target}
      />
      <ModalFooter>
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={!matches || busy}
          onClick={() => void destroy()}
        >
          {busy ? "Deleting…" : "Delete route"}
        </button>
      </ModalFooter>
    </Modal>
  );
}
