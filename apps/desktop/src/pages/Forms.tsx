/**
 * Forms — list of embeddable signup forms with create + detail flows.
 *
 * Mirrors the rhythm of Subscribers.tsx: page header w/ primary action,
 * a search input + status chips row, a paginated list, and a slide-over
 * for detail. Adds a card-grid of starter templates at the bottom that
 * pre-fill the create modal.
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

import { Card } from "../components/Card";
import { ConfirmModal } from "../components/ConfirmModal";
import { FormDetailSlideover } from "../components/FormDetailSlideover";
import { FieldError, FormField, useFormErrors } from "../components/FormField";
import { HeroEmptyState } from "../components/HeroEmptyState";
import { HERO } from "../lib/heroAssets";
import { FormsStatStrip } from "../components/forms/FormsStatStrip";
import { LandingPagesSection } from "../components/forms/LandingPagesSection";
import { Modal, ModalFooter } from "../components/Modal";
import { Notice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { PendingSyncStatus } from "../components/PendingSyncStatus";
import { SectionHeader } from "../components/SectionHeader";
import { Skeleton } from "../components/Skeleton";
import { toast } from "../components/Toast";
import { useTabsInteraction } from "../hooks/useTabsInteraction";
import {
  type FormOptInMode,
  type FormStatus,
  type FormSummary,
  api,
} from "../lib/api-client";
import { queueReceiptMessage } from "../lib/api/result";
import {
  capabilityForSection,
  capabilityReadinessLabel,
} from "../lib/desktop-capabilities";
import { consumeDesktopTaskIntent } from "../lib/desktop-task-intents";
import {
  consumePendingDeepLinkTarget,
  onPendingDeepLinkTarget,
} from "../lib/deep-link";
import { useCanWrite } from "../lib/store";
import { registerLifecycleGuard } from "../lib/lifecycle-coordinator";
import { useWriteDesktopTaskIntent } from "../hooks/useDesktopTaskIntent";

import "../styles-forms.css";

type Filter = "all" | FormStatus;
type FormsSurface = "library" | "landing" | "social";

const PAGE_SIZE = 24;
const FORMS_SURFACES = [
  { value: "library" },
  { value: "landing" },
  { value: "social" },
] as const;

interface TemplateDef {
  key: string;
  name: string;
  desc: string;
  optInMode: FormOptInMode;
  successMessage: string;
}

// D08-forms-assets-archive#9: these presets only set opt-in mode + success
// message + name/slug — the create flow does NOT add any fields, so every form
// starts with the default single email field. Descriptions that promised
// "name + email", "dietary preferences", "message field", "multi-select
// feedback" were misleading (those fields were never created). Copy now
// describes only what each preset actually configures. (The richer
// forms-templates.ts library carries real fields[] but can't be wired here
// until the canonical form-field shape lands — see the D08 P0 finding.)
const TEMPLATES: TemplateDef[] = [
  {
    key: "newsletter",
    name: "Newsletter signup",
    desc: "Email field with double opt-in confirmation.",
    optInMode: "double",
    successMessage: "Thanks! Check your inbox to confirm.",
  },
  {
    key: "lead-magnet",
    name: "Lead magnet",
    desc: "Single opt-in with a download-ready confirmation.",
    optInMode: "single",
    successMessage: "Thanks! Your download is on its way.",
  },
  {
    key: "beta-waitlist",
    name: "Beta waitlist",
    desc: "Single opt-in for an upcoming launch.",
    optInMode: "single",
    successMessage: "You're on the list — we'll be in touch.",
  },
  {
    key: "event-rsvp",
    name: "Event RSVP",
    desc: "Single opt-in with an RSVP confirmation.",
    optInMode: "single",
    successMessage: "You're RSVP'd — see you there!",
  },
  {
    key: "contact-us",
    name: "Contact us",
    desc: "Single opt-in for inbound support requests.",
    optInMode: "single",
    successMessage: "Thanks — we'll reply within one business day.",
  },
  {
    key: "survey",
    name: "Quick survey",
    desc: "Single opt-in for product-research feedback.",
    optInMode: "single",
    successMessage: "Thanks for the feedback — it really helps.",
  },
];

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function statusBadge(status: FormStatus | string | undefined): ReactElement {
  const s = (status ?? "draft").toLowerCase();
  if (s === "published")
    return <span className="badge success">Published</span>;
  if (s === "archived") return <span className="badge warning">Archived</span>;
  return <span className="badge">Draft</span>;
}

function optInBadge(mode: FormOptInMode | string | undefined): ReactElement {
  const m = (mode ?? "double").toLowerCase();
  if (m === "single")
    return <span className="badge accent">Single opt-in</span>;
  return <span className="badge accent">Double opt-in</span>;
}

interface CreateDraft {
  name: string;
  slug: string;
  slugTouched: boolean;
  optInMode: FormOptInMode;
  successMessage: string;
}

const EMPTY_DRAFT: CreateDraft = {
  name: "",
  slug: "",
  slugTouched: false,
  optInMode: "double",
  successMessage: "",
};

function useFormCreateTaskLifecycle(options: {
  open: boolean;
  draft: CreateDraft;
  submitting: boolean;
  canMutate: boolean;
  errors: ReturnType<typeof useFormErrors>;
  onOpen: () => void;
  setOpen: (open: boolean) => void;
  setDraft: (draft: CreateDraft) => void;
  setSubmitErr: (error: string | null) => void;
}) {
  const {
    open,
    draft,
    submitting,
    canMutate,
    errors,
    onOpen,
    setOpen,
    setDraft,
    setSubmitErr,
  } = options;
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const dirty = open && JSON.stringify(draft) !== JSON.stringify(EMPTY_DRAFT);
  const reset = useCallback((): void => {
    setDraft(EMPTY_DRAFT);
    setOpen(false);
    setSubmitErr(null);
    errors.clear();
    setDiscardConfirmOpen(false);
  }, [errors, setDraft, setOpen, setSubmitErr]);
  const consume = useCallback((): void => {
    setOpen(false);
    setDiscardConfirmOpen(false);
    consumeDesktopTaskIntent("new-form");
  }, [setOpen]);
  const requestClose = useCallback((): void => {
    if (submitting) return;
    if (dirty) setDiscardConfirmOpen(true);
    else consume();
  }, [consume, dirty, submitting]);
  const confirmDiscard = useCallback((): void => {
    reset();
    consumeDesktopTaskIntent("new-form");
  }, [reset]);

  useEffect(() => {
    if (!dirty && !submitting) return;
    return registerLifecycleGuard({
      id: "form-create-draft",
      label: "New form draft",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : submitting
            ? {
                level: "blocking",
                detail: "The new form is still being submitted.",
                canDiscard: false,
              }
            : {
                level: "blocking",
                detail: "The new form has unsaved local changes.",
              },
      discard: (intent) => {
        reset();
        if (intent.kind !== "route-change") {
          consumeDesktopTaskIntent("new-form");
        }
      },
    });
  }, [dirty, reset, submitting]);
  useWriteDesktopTaskIntent({
    intent: "new-form",
    open,
    canMutate,
    onOpen,
    onRouteExit: () => setOpen(false),
  });
  return {
    cancelDiscard: () => setDiscardConfirmOpen(false),
    complete: consume,
    confirmDiscard,
    discardConfirmOpen,
    requestClose,
  };
}

interface FormsSelectionToolbarProps {
  selectedCount: number;
  busy: boolean;
  canMutate: boolean;
  writeReasonId: string;
  lifecycleUnavailableReason: string | null;
  onPublish: () => void;
  onMoveToDraft: () => void;
  onArchive: () => void;
  onClear: () => void;
}

function FormsSelectionToolbar({
  selectedCount,
  busy,
  canMutate,
  writeReasonId,
  lifecycleUnavailableReason,
  onPublish,
  onMoveToDraft,
  onArchive,
  onClear,
}: FormsSelectionToolbarProps): ReactElement {
  const lifecycleReasonId = useId();
  const mutationUnavailable = !canMutate || lifecycleUnavailableReason !== null;
  const descriptionId = !canMutate
    ? writeReasonId
    : lifecycleUnavailableReason
      ? lifecycleReasonId
      : undefined;
  return (
    <Card
      variant="subtle"
      padding="sm"
      style={{ marginBottom: 12 }}
      aria-busy={busy}
    >
      <div className="forms-selection-toolbar">
        <span style={{ fontSize: 13 }}>{selectedCount} selected</span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          aria-disabled={mutationUnavailable || undefined}
          aria-describedby={descriptionId}
          onClick={() => {
            if (!mutationUnavailable) onPublish();
          }}
        >
          Publish
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          aria-disabled={mutationUnavailable || undefined}
          aria-describedby={descriptionId}
          onClick={() => {
            if (!mutationUnavailable) onMoveToDraft();
          }}
        >
          Move to draft
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          aria-disabled={mutationUnavailable || undefined}
          aria-describedby={descriptionId}
          onClick={() => {
            if (!mutationUnavailable) onArchive();
          }}
        >
          Archive
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={onClear}
          disabled={busy}
        >
          Clear
        </button>
        {busy ? (
          <span className="muted" role="status" style={{ fontSize: 11 }}>
            Applying the selected form changes…
          </span>
        ) : lifecycleUnavailableReason ? (
          <span
            id={lifecycleReasonId}
            className="muted"
            role="status"
            style={{ fontSize: 11 }}
          >
            {lifecycleUnavailableReason}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

interface FormTileProps {
  form: FormSummary;
  selected: boolean;
  canMutate: boolean;
  writeReasonId: string;
  onOpen: () => void;
  onToggleSelected: () => void;
}

function FormTile({
  form,
  selected,
  canMutate,
  writeReasonId,
  onOpen,
  onToggleSelected,
}: FormTileProps): ReactElement {
  const name = form.name || "Untitled";
  return (
    <Card
      className="form-tile"
      data-selected={selected ? "true" : undefined}
      style={{ position: "relative" }}
    >
      <label
        className="form-tile-select"
        style={{
          position: "absolute",
          top: 6,
          right: 6,
          display: "flex",
          alignItems: "center",
          cursor: "pointer",
          padding: 2,
        }}
      >
        <input
          type="checkbox"
          aria-label={`${selected ? "Deselect" : "Select"} ${name} for bulk action`}
          checked={selected}
          aria-disabled={!canMutate || undefined}
          aria-describedby={!canMutate ? writeReasonId : undefined}
          onPointerDown={(event) => {
            if (!canMutate) event.preventDefault();
          }}
          onChange={() => {
            if (canMutate) onToggleSelected();
          }}
        />
      </label>
      <div className="form-tile-row">
        {statusBadge(form.status)}
        {optInBadge(form.optInMode)}
      </div>
      <button
        type="button"
        className="link-button form-tile-open"
        onClick={onOpen}
        style={{
          fontWeight: 600,
          fontSize: 13,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          paddingRight: 28,
        }}
      >
        {name}
      </button>
      <div
        className="muted mono"
        style={{
          fontSize: 11,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        /{form.slug}
      </div>
      <div className="form-tile-stats">
        <div>
          <span className="form-tile-stat-num tabular">
            {(form.submissions30d ?? 0).toLocaleString()}
          </span>{" "}
          <span className="muted">subs / 30d</span>
        </div>
        <div>
          <span className="form-tile-stat-num tabular">
            {Math.round(form.conversionRate ?? 0)}%
          </span>{" "}
          <span className="muted">conv.</span>
        </div>
      </div>
      <div className="form-tile-actions">
        <button type="button" className="btn btn-sm" onClick={onOpen}>
          Manage
        </button>
      </div>
    </Card>
  );
}

function useMountedFlag(): React.MutableRefObject<boolean> {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}

function isFormSummary(value: unknown): value is FormSummary {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.name === "string" &&
    typeof record.slug === "string" &&
    record.slug.length > 0
  );
}

function readFormRows(candidate: unknown): FormSummary[] | null {
  if (!Array.isArray(candidate)) return null;
  return candidate.every(isFormSummary) ? candidate : null;
}

function unwrapForms(payload: unknown): FormSummary[] | null {
  if (Array.isArray(payload)) return readFormRows(payload);
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const candidate = record.items ?? record.results ?? record.data;
    if (Array.isArray(candidate)) return readFormRows(candidate);
  }
  return null;
}

function useFormsCollection() {
  const mountedRef = useMountedFlag();
  const loadSeqRef = useRef(0);
  const loadingRef = useRef(false);
  const [rows, setRows] = useState<FormSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingDeepLinkId, setPendingDeepLinkId] = useState<string | null>(
    null,
  );

  const load = useCallback(async (): Promise<void> => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setErr(null);
    try {
      const res = await api.listForms();
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      if (res.error) {
        setErr(res.error.message);
      } else {
        const next = unwrapForms(res.data);
        if (next === null) {
          setErr(
            "The server returned an unrecognised Forms response. Existing data has been kept; retry after checking API compatibility.",
          );
        } else {
          setRows(next);
        }
      }
    } catch (error) {
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      setErr(
        error instanceof Error && error.message
          ? error.message
          : "The forms request failed unexpectedly.",
      );
    } finally {
      loadingRef.current = false;
      if (mountedRef.current && seq === loadSeqRef.current) setLoading(false);
    }
  }, [mountedRef]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const accept = (target: { section: string; id: string } | null): void => {
      if (target?.section === "forms" && target.id) {
        setPendingDeepLinkId(target.id);
      }
    };
    accept(consumePendingDeepLinkTarget());
    return onPendingDeepLinkTarget((target) => {
      if (target.section !== "forms") return;
      consumePendingDeepLinkTarget();
      accept(target);
    });
  }, []);

  useEffect(() => {
    if (!pendingDeepLinkId || !rows) return;
    setPendingDeepLinkId(null);
    const match = rows.find((row) => row.id === pendingDeepLinkId);
    if (match) setSelectedId(match.id);
    else toast.error("Couldn't find that form — it may have been deleted.");
  }, [pendingDeepLinkId, rows]);

  const filtered = useMemo<FormSummary[]>(() => {
    const byStatus =
      filter === "all"
        ? (rows ?? [])
        : (rows ?? []).filter((row) => (row.status ?? "draft") === filter);
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return byStatus;
    return byStatus.filter(
      (row) =>
        (row.name ?? "").toLowerCase().includes(normalizedQuery) ||
        (row.slug ?? "").toLowerCase().includes(normalizedQuery),
    );
  }, [filter, query, rows]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  useEffect(() => {
    if (page > totalPages) setPage(1);
  }, [page, totalPages]);

  return {
    err,
    filter,
    filtered,
    load,
    loading,
    page,
    pageRows,
    query,
    rows,
    selectedId,
    setFilter,
    setPage,
    setQuery,
    setSelectedId,
    totalPages,
  };
}

function useFormsBulkActions(options: {
  canMutate: boolean;
  reload: () => Promise<void>;
}) {
  const { canMutate, reload } = options;
  const mountedRef = useMountedFlag();
  const operationRef = useRef(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!canMutate) setPicked(new Set());
  }, [canMutate]);
  const togglePicked = (id: string): void => {
    if (!canMutate || operationRef.current) return;
    setPicked((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clear = (): void => setPicked(new Set());

  const update = async (
    label: string,
    patch: { status?: FormStatus },
  ): Promise<void> => {
    if (!canMutate || operationRef.current || picked.size === 0) return;
    operationRef.current = true;
    const targets = [...picked];
    setBusy(true);
    let ok = 0;
    let queued = 0;
    let failed = 0;
    const failedIds: string[] = [];
    try {
      for (const id of targets) {
        try {
          const res = await api.updateForm(id, patch);
          if (res.error) {
            failed++;
            failedIds.push(id);
          } else if (res.queued) queued++;
          else ok++;
        } catch {
          failed++;
          failedIds.push(id);
        }
      }
      if (!mountedRef.current) return;
      setPicked(new Set(failedIds));
      if (failed === 0 && queued === 0) {
        toast.success(`${label} ${ok} form${ok === 1 ? "" : "s"}`);
      } else if (failed === 0) {
        toast.info({
          message: `${queued} ${queued === 1 ? "change" : "changes"} saved on this device · pending sync`,
          detail: `${ok} confirmed by the server. Queued changes remain visible in the sync journal.`,
        });
      } else {
        toast.error({
          message:
            ok > 0
              ? `${label} ${ok} of ${ok + failed} forms`
              : `Couldn't update ${failed} form${failed === 1 ? "" : "s"}`,
          detail:
            ok > 0
              ? `${failed} failed. Retry the unchanged rows.`
              : "Check the form status and try again.",
        });
      }
      await reload();
    } finally {
      operationRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  return {
    busy,
    clear,
    picked,
    togglePicked,
    update,
  };
}

interface FormsHeaderProps {
  canMutate: boolean;
  writeReasonId: string;
  loading: boolean;
  formCount: number;
  showCreate: boolean;
  onCreate: () => void;
}

function FormsHeader({
  canMutate,
  writeReasonId,
  loading,
  formCount,
  showCreate,
  onCreate,
}: FormsHeaderProps): ReactElement {
  return (
    <>
      <PageHeader
        eyebrow="Audience growth"
        title="Capture studio"
        subtitle="Create, publish, and measure consent-aware signup experiences without losing sight of what is live, limited, or still staged."
        meta={
          <span className="forms-header-count" role="status">
            {loading
              ? "Loading form inventory…"
              : `${formCount.toLocaleString()} ${formCount === 1 ? "form" : "forms"} in this workspace`}
          </span>
        }
        actions={
          showCreate
            ? [
                {
                  label: "New form",
                  variant: "primary",
                  onClick: onCreate,
                  disabled: !canMutate,
                  title: !canMutate
                    ? "Your current role can inspect Forms but cannot create or change them."
                    : undefined,
                },
              ]
            : undefined
        }
      />
      {!canMutate ? (
        <div id={writeReasonId} className="forms-role-boundary" role="status">
          <strong>Read-only access</strong>
          <span>
            You can inspect Forms and reporting. Creating, publishing, and
            archiving require an editor or admin role; deleting response-bearing
            forms requires an admin.
          </span>
        </div>
      ) : null}
    </>
  );
}

function FormsReadiness(): ReactElement {
  const capability = capabilityForSection("forms");
  return (
    <section
      className="forms-readiness"
      aria-labelledby="forms-readiness-title"
    >
      <div className="forms-readiness-intro">
        <div>
          <span className="forms-readiness-badge">
            {capabilityReadinessLabel(capability.readiness) ??
              "Limited readiness"}
          </span>
          <h2 id="forms-readiness-title">Know what reaches a customer</h2>
          <p>
            {capability.limitation}
          </p>
        </div>
        <div className="forms-readiness-boundary">
          <strong>Current safety boundary</strong>
          <span>
            Canonical fields stay read-only in desktop. Live variant splitting,
            onsite experiments, provider auto-replies, and tap-to-text creation
            are withheld until their end-to-end contracts pass production
            evidence.
          </span>
        </div>
      </div>
      <ol className="forms-readiness-stages" aria-label="Capture readiness">
        <li data-tone="limited">
          <span aria-hidden="true">01</span>
          <div>
            <strong>Core forms</strong>
            <small>
              Manage definitions, hosted sharing, submissions, and analytics.
            </small>
          </div>
        </li>
        <li data-tone="limited">
          <span aria-hidden="true">02</span>
          <div>
            <strong>Landing pages</strong>
            <small>
              Definition lifecycle is available; delivery depends on deployment
              readiness.
            </small>
          </div>
        </li>
        <li data-tone="blocked">
          <span aria-hidden="true">03</span>
          <div>
            <strong>Social capture</strong>
            <small>
              Provider ingestion and SMS list binding are not qualified in
              desktop.
            </small>
          </div>
        </li>
        <li data-tone="blocked">
          <span aria-hidden="true">04</span>
          <div>
            <strong>Optimization</strong>
            <small>
              Variants and onsite experiments are not connected to public
              rendering.
            </small>
          </div>
        </li>
      </ol>
    </section>
  );
}

function FormsSurfaceTabs({
  value,
  formCount,
  onChange,
  library,
  landing,
  social,
}: {
  value: FormsSurface;
  formCount: number;
  onChange: (value: FormsSurface) => void;
  library: ReactElement;
  landing: ReactElement;
  social: ReactElement;
}): ReactElement {
  const tabs = useTabsInteraction({
    activation: "automatic",
    value,
    items: FORMS_SURFACES,
    onChange,
  });
  const definitions: Array<{
    value: FormsSurface;
    label: string;
    status: string;
    description: string;
  }> = [
    {
      value: "library",
      label: "Forms library",
      status: `${formCount.toLocaleString()} total`,
      description: "Create, inspect, share, and measure hosted forms.",
    },
    {
      value: "landing",
      label: "Landing pages",
      status: "Limited",
      description: "Manage page definitions and publication state.",
    },
    {
      value: "social",
      label: "Social capture",
      status: "Staged",
      description: "Review the qualification boundary before activation.",
    },
  ];
  return (
    <>
      <div
        ref={tabs.listRef}
        {...tabs.listProps}
        className="forms-surface-tabs"
        aria-label="Capture studio sections"
      >
        {definitions.map((item) => (
          <button
            key={item.value}
            type="button"
            {...tabs.getTabProps(item.value)}
            className="forms-surface-tab"
            data-active={value === item.value ? "true" : undefined}
          >
            <span className="forms-surface-tab-title">
              <strong>{item.label}</strong>
              <small>{item.status}</small>
            </span>
            <span className="forms-surface-tab-description">
              {item.description}
            </span>
          </button>
        ))}
      </div>
      <section
        {...tabs.getPanelProps("library")}
        className="forms-surface-panel"
      >
        {library}
      </section>
      <section
        {...tabs.getPanelProps("landing")}
        className="forms-surface-panel"
      >
        {landing}
      </section>
      <section
        {...tabs.getPanelProps("social")}
        className="forms-surface-panel"
      >
        {social}
      </section>
    </>
  );
}

function SocialCaptureBoundary(): ReactElement {
  const gates = [
    {
      title: "Provider events",
      detail:
        "Prove authenticated ingestion, trigger matching, reply delivery, and list subscription for every advertised network.",
    },
    {
      title: "Consent binding",
      detail:
        "Require a tenant-owned SMS list and preserve auditable consent before a tap-to-text link can be created.",
    },
    {
      title: "Safe operations",
      detail:
        "Add pause, edit, delete, pagination, rate limits, and tenant-safe public link identity before activation.",
    },
  ];
  return (
    <div className="forms-staged-surface">
      <div className="forms-staged-hero">
        <span className="forms-staged-kicker">Activation unavailable</span>
        <h2>Social capture is staged, not live.</h2>
        <p>
          This desktop build does not watch social triggers, send provider
          replies, subscribe captured leads, or create production-safe
          tap-to-text links. The controls stay withheld until the full customer
          path is verified.
        </p>
      </div>
      <ol
        className="forms-staged-gates"
        aria-label="Social capture release gates"
      >
        {gates.map((gate, index) => (
          <li key={gate.title}>
            <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
            <div>
              <strong>{gate.title}</strong>
              <p>{gate.detail}</p>
            </div>
          </li>
        ))}
      </ol>
      <Notice tone="neutral" title="No hidden side effects">
        Opening this tab performs no provider, lead, rule, redirect, or SMS
        mutation requests.
      </Notice>
    </div>
  );
}

interface FormsFilterBarProps {
  query: string;
  filter: Filter;
  loading: boolean;
  resultCount: number;
  totalCount: number;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: Filter) => void;
  onReload: () => void;
}

function FormsFilterBar({
  query,
  filter,
  loading,
  resultCount,
  totalCount,
  onQueryChange,
  onFilterChange,
  onReload,
}: FormsFilterBarProps): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 12,
        flexWrap: "wrap",
      }}
    >
      <input
        className="input"
        style={{ width: 280, maxWidth: "100%" }}
        type="search"
        aria-label="Search forms by name or slug"
        placeholder="Search name or slug…"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      <div className="chips" style={{ flexWrap: "wrap" }}>
        {(["all", "draft", "published", "archived"] as Filter[]).map(
          (candidate) => (
            <button
              key={candidate}
              type="button"
              className={`chip${filter === candidate ? " is-active" : ""}`}
              aria-pressed={filter === candidate}
              onClick={() => onFilterChange(candidate)}
            >
              {candidate[0]!.toUpperCase() + candidate.slice(1)}
            </button>
          ),
        )}
      </div>
      <span className="forms-filter-count" role="status" aria-live="polite">
        {resultCount === totalCount
          ? `${totalCount.toLocaleString()} shown`
          : `${resultCount.toLocaleString()} of ${totalCount.toLocaleString()} shown`}
      </span>
      <span className="spacer" />
      <button
        type="button"
        className="btn"
        onClick={onReload}
        disabled={loading}
        aria-busy={loading}
      >
        {loading ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}

interface FormsResultsProps {
  rows: FormSummary[] | null;
  pageRows: FormSummary[];
  query: string;
  loading: boolean;
  canMutate: boolean;
  writeReasonId: string;
  picked: ReadonlySet<string>;
  onCreate: () => void;
  onOpen: (form: FormSummary) => void;
  onTogglePicked: (id: string) => void;
}

function FormsResults({
  rows,
  pageRows,
  query,
  loading,
  canMutate,
  writeReasonId,
  picked,
  onCreate,
  onOpen,
  onTogglePicked,
}: FormsResultsProps): ReactElement {
  if (loading && !rows) {
    return (
      <div
        className="card-grid"
        role="status"
        aria-label="Loading forms"
        aria-busy="true"
      >
        {[0, 1, 2, 3].map((index) => (
          <Card variant="default" style={{ minHeight: 132 }} key={index}>
            <Skeleton variant="row" height={14} width="60%" />
            <Skeleton
              variant="row"
              height={10}
              width="40%"
              style={{ marginTop: 8 }}
            />
            <Skeleton variant="row" height={30} style={{ marginTop: 16 }} />
          </Card>
        ))}
      </div>
    );
  }
  if (pageRows.length === 0 && (query || (rows && rows.length > 0))) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">·</div>
        <h3>{query ? `No matches for "${query}"` : "No matching forms"}</h3>
        <p>
          {query
            ? "Clear search to see all forms."
            : "Try clearing your filters."}
        </p>
      </div>
    );
  }
  if (pageRows.length === 0) {
    if (rows === null) return <></>;
    return (
      <HeroEmptyState
        tone="blush"
        eyebrow="Capture"
        title="Turn visitors into subscribers."
        subtitle="Publish a hosted signup experience, embed it on your site, or share its link. Confirmed captures route into your audience."
        primaryCta={
          canMutate ? { label: "Create form", onClick: onCreate } : undefined
        }
        imageSrc={HERO.forms}
        imageAlt="A laptop showing an elegant teal subscription popup"
      />
    );
  }
  return (
    <div className="card-grid">
      {pageRows.map((form) => (
        <FormTile
          key={form.id}
          form={form}
          selected={picked.has(form.id)}
          canMutate={canMutate}
          writeReasonId={writeReasonId}
          onOpen={() => onOpen(form)}
          onToggleSelected={() => onTogglePicked(form.id)}
        />
      ))}
    </div>
  );
}

function FormsPagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}): ReactElement | null {
  const pageStatusId = useId();
  if (totalPages <= 1) return null;
  return (
    <div className="pagination">
      <button
        type="button"
        className="btn btn-sm"
        aria-label="Previous page"
        aria-disabled={page <= 1 || undefined}
        aria-describedby={pageStatusId}
        onClick={() => {
          if (page > 1) onPageChange(page - 1);
        }}
      >
        Prev
      </button>
      <span id={pageStatusId}>
        Page {page} of {totalPages}
      </span>
      <button
        type="button"
        className="btn btn-sm"
        aria-label="Next page"
        aria-disabled={page >= totalPages || undefined}
        aria-describedby={pageStatusId}
        onClick={() => {
          if (page < totalPages) onPageChange(page + 1);
        }}
      >
        Next
      </button>
    </div>
  );
}

function FormsTemplates({
  canMutate,
  writeReasonId,
  onUse,
}: {
  canMutate: boolean;
  writeReasonId: string;
  onUse: (template: TemplateDef) => void;
}): ReactElement {
  return (
    <div style={{ marginTop: 32 }}>
      <SectionHeader
        title="Start from a template"
        description="Pre-fill the name, slug, opt-in mode, and confirmation message before creating a canonical form."
        helpText="These presets do not change the field schema. Canonical fields stay read-only in desktop and are managed in the web form builder."
      />
      <div className="card-grid">
        {TEMPLATES.map((template) => (
          <Card key={template.key} variant="default" style={{ minHeight: 120 }}>
            <div
              className="muted"
              style={{ fontSize: 11, textTransform: "uppercase" }}
            >
              Template
            </div>
            <div style={{ fontWeight: 600, marginTop: 4 }}>{template.name}</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {template.desc}
            </div>
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  if (canMutate) onUse(template);
                }}
                aria-disabled={!canMutate || undefined}
                aria-describedby={!canMutate ? writeReasonId : undefined}
              >
                Use template
              </button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function FormsLibrarySurface({
  canMutate,
  collection,
  bulk,
  writeReasonId,
  onCreate,
}: {
  canMutate: boolean;
  collection: ReturnType<typeof useFormsCollection>;
  bulk: ReturnType<typeof useFormsBulkActions>;
  writeReasonId: string;
  onCreate: (preset?: TemplateDef) => void;
}): ReactElement {
  const {
    err,
    filter,
    filtered,
    load,
    loading,
    page,
    pageRows,
    query,
    rows,
    setFilter,
    setPage,
    setQuery,
    setSelectedId,
    totalPages,
  } = collection;
  const selectedIncludesArchived = (rows ?? []).some(
    (row) => bulk.picked.has(row.id) && row.status === "archived",
  );
  const lifecycleUnavailableReason = selectedIncludesArchived
    ? "Archived forms are terminal. Remove archived rows from the selection before changing lifecycle state; open one individually to review admin-only deletion."
    : null;

  return (
    <div className="forms-library">
      <PendingSyncStatus resource="forms" />
      <FormsStatStrip rows={rows} />

      {bulk.picked.size > 0 ? (
        <FormsSelectionToolbar
          selectedCount={bulk.picked.size}
          busy={bulk.busy}
          canMutate={canMutate}
          writeReasonId={writeReasonId}
          lifecycleUnavailableReason={lifecycleUnavailableReason}
          onPublish={() =>
            void bulk.update("Published", { status: "published" })
          }
          onMoveToDraft={() =>
            void bulk.update("Moved to draft", { status: "draft" })
          }
          onArchive={() => void bulk.update("Archived", { status: "archived" })}
          onClear={bulk.clear}
        />
      ) : null}

      <FormsFilterBar
        query={query}
        filter={filter}
        loading={loading}
        resultCount={filtered.length}
        totalCount={rows?.length ?? 0}
        onQueryChange={(nextQuery) => {
          bulk.clear();
          setQuery(nextQuery);
          setPage(1);
        }}
        onFilterChange={(nextFilter) => {
          bulk.clear();
          setFilter(nextFilter);
          setPage(1);
        }}
        onReload={() => void load()}
      />

      {err ? (
        <Notice
          tone="danger"
          title={
            rows === null ? "Couldn’t load Forms" : "Couldn’t refresh Forms"
          }
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void load()}
            >
              Retry
            </button>
          }
        >
          {err}
          {rows !== null
            ? " The last confirmed inventory remains available below."
            : ""}
        </Notice>
      ) : null}

      <FormsResults
        rows={rows}
        pageRows={pageRows}
        query={query}
        loading={loading}
        canMutate={canMutate}
        writeReasonId={writeReasonId}
        picked={bulk.picked}
        onCreate={() => onCreate()}
        onOpen={(form) => setSelectedId(form.id)}
        onTogglePicked={bulk.togglePicked}
      />

      <FormsPagination
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
      />

      <FormsTemplates
        canMutate={canMutate}
        writeReasonId={writeReasonId}
        onUse={onCreate}
      />
    </div>
  );
}

interface FormsOverlaysProps {
  selectedId: string | null;
  rows: FormSummary[] | null;
  createOpen: boolean;
  draft: CreateDraft;
  submitting: boolean;
  submitErr: string | null;
  errors: ReturnType<typeof useFormErrors>;
  createLifecycle: ReturnType<typeof useFormCreateTaskLifecycle>;
  onReload: () => void;
  onCloseDetail: () => void;
  onNameChange: (name: string) => void;
  onSlugChange: (slug: string) => void;
  onDraftChange: (draft: CreateDraft) => void;
  onSubmit: () => void;
}

function FormsOverlays({
  selectedId,
  rows,
  createOpen,
  draft,
  submitting,
  submitErr,
  errors,
  createLifecycle,
  onReload,
  onCloseDetail,
  onNameChange,
  onSlugChange,
  onDraftChange,
  onSubmit,
}: FormsOverlaysProps): ReactElement {
  return (
    <>
      {selectedId ? (
        <FormDetailSlideover
          key={selectedId}
          formId={selectedId}
          initial={rows?.find((row) => row.id === selectedId) ?? null}
          onClose={onCloseDetail}
          onChanged={onReload}
          onDeleted={() => {
            onCloseDetail();
            onReload();
          }}
        />
      ) : null}
      <ConfirmModal
        open={createLifecycle.discardConfirmOpen}
        title="Discard form draft?"
        description="The form has not been created."
        confirmLabel="Discard draft"
        danger
        busy={submitting}
        onConfirm={createLifecycle.confirmDiscard}
        onClose={createLifecycle.cancelDiscard}
      />
      <Modal
        open={createOpen}
        onClose={createLifecycle.requestClose}
        closeDisabled={submitting}
        closeOnBackdrop={!submitting}
        closeOnEscape={!submitting}
        title="New form"
        description="Choose the public identity and consent flow. Canonical fields are managed in the web builder after creation."
      >
        <form
          className="forms-create-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <FormField
            label="Name"
            required
            htmlFor="form-create-name"
            error={errors.get("name")}
          >
            <input
              id="form-create-name"
              type="text"
              className="input"
              placeholder="Newsletter signup"
              value={draft.name}
              maxLength={200}
              disabled={submitting}
              onChange={(event) => onNameChange(event.target.value)}
            />
          </FormField>
          <FormField
            label="Slug"
            required
            htmlFor="form-create-slug"
            error={errors.get("slug")}
          >
            <input
              id="form-create-slug"
              type="text"
              className="input mono"
              placeholder="newsletter"
              value={draft.slug}
              maxLength={128}
              autoCapitalize="none"
              spellCheck={false}
              disabled={submitting}
              onChange={(event) => onSlugChange(event.target.value)}
            />
            <div className="field-help">
              Used in the public URL: /forms/{draft.slug || "your-slug"}
            </div>
          </FormField>
          <FormField
            label="Opt-in mode"
            htmlFor="form-create-optin"
            helpTooltip="Double opt-in asks the subscriber to confirm by email and is generally safer for list quality. Whether it is legally required depends on your jurisdiction, audience, and lawful basis."
          >
            <select
              id="form-create-optin"
              className="input"
              value={draft.optInMode}
              disabled={submitting}
              onChange={(event) =>
                onDraftChange({
                  ...draft,
                  optInMode: event.target.value as FormOptInMode,
                })
              }
            >
              <option value="double">
                Double — confirm by email (recommended)
              </option>
              <option value="single">Single — subscribe instantly</option>
            </select>
          </FormField>
          <FormField label="Success message" htmlFor="form-create-success">
            <textarea
              id="form-create-success"
              className="input"
              style={{ minHeight: 60, padding: 8, resize: "vertical" }}
              placeholder="Thanks for subscribing!"
              value={draft.successMessage}
              maxLength={2000}
              disabled={submitting}
              onChange={(event) =>
                onDraftChange({ ...draft, successMessage: event.target.value })
              }
            />
          </FormField>
          {errors.get("_form") ? (
            <FieldError>{errors.get("_form")}</FieldError>
          ) : submitErr ? (
            <div className="field-error" role="alert">
              {submitErr}
            </div>
          ) : null}
          <ModalFooter>
            <button
              type="button"
              className="btn"
              onClick={createLifecycle.requestClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={submitting}
              aria-busy={submitting}
            >
              {submitting ? "Creating…" : "Create form"}
            </button>
          </ModalFooter>
        </form>
      </Modal>
    </>
  );
}

export function Forms(): ReactElement {
  // Editors author lifecycle changes; destructive response-bearing deletion
  // remains admin-only. Viewers see a read-only projection.
  const canMutate = useCanWrite();
  const writeReasonId = useId();
  const collection = useFormsCollection();
  const { load, loading, rows, selectedId, setSelectedId } = collection;
  const bulk = useFormsBulkActions({ canMutate, reload: load });
  const [surface, setSurface] = useState<FormsSurface>("library");
  const [visitedSurfaces, setVisitedSurfaces] = useState<Set<FormsSurface>>(
    () => new Set<FormsSurface>(["library"]),
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<CreateDraft>(EMPTY_DRAFT);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const mountedRef = useMountedFlag();
  const errors = useFormErrors();

  useEffect(() => {
    if (selectedId) setSurface("library");
  }, [selectedId]);

  const openCreate = (preset?: TemplateDef): void => {
    setSurface("library");
    if (preset) {
      setDraft({
        name: preset.name,
        slug: slugify(preset.name),
        slugTouched: false,
        optInMode: preset.optInMode,
        successMessage: preset.successMessage,
      });
    } else {
      setDraft(EMPTY_DRAFT);
    }
    setSubmitErr(null);
    errors.clear();
    setCreateOpen(true);
  };
  const createLifecycle = useFormCreateTaskLifecycle({
    open: createOpen,
    draft,
    submitting,
    canMutate,
    errors,
    onOpen: () => openCreate(),
    setOpen: setCreateOpen,
    setDraft,
    setSubmitErr,
  });

  const setName = (name: string): void => {
    setDraft((d) => ({
      ...d,
      name,
      slug: d.slugTouched ? d.slug : slugify(name),
    }));
  };

  const setSlug = (slug: string): void => {
    setDraft((d) => ({ ...d, slug: slug.toLowerCase(), slugTouched: true }));
  };

  const submitCreate = async (): Promise<void> => {
    if (!canMutate || submittingRef.current) return;
    const name = draft.name.trim();
    const slug = draft.slug.trim() || slugify(name);
    errors.clear();
    if (!name) {
      errors.set("name", "Name is required.");
      return;
    }
    if (name.length > 200) {
      errors.set("name", "Name must be 200 characters or fewer.");
      return;
    }
    if (!slug) {
      errors.set("slug", "Slug is required.");
      return;
    }
    if (slug.length > 128) {
      errors.set("slug", "Slug must be 128 characters or fewer.");
      return;
    }
    if (!/^[a-z0-9._~-]+$/.test(slug)) {
      errors.set(
        "slug",
        "Slug can only contain lowercase letters, numbers, and -._~ characters.",
      );
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitErr(null);
    try {
      const res = await api.createForm({
        name,
        slug,
        optInMode: draft.optInMode,
        successMessage: draft.successMessage,
      });
      if (!mountedRef.current) return;
      if (res.error) {
        errors.set("_form", res.error.message);
        return;
      }
      createLifecycle.complete();
      if (res.queued) {
        toast.info({
          message: queueReceiptMessage(res.receipt),
          detail: `“${name}” will appear after the server confirms the create. It remains in the offline queue across restarts.`,
        });
        return;
      }
      toast.success(`Form "${name}" created`);
      await load();
      if (mountedRef.current) setSelectedId(res.data.id);
    } catch (error) {
      if (!mountedRef.current) return;
      errors.set(
        "_form",
        error instanceof Error && error.message
          ? error.message
          : "The form couldn't be created because the request failed unexpectedly.",
      );
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  };

  return (
    <div className="forms-page">
      <FormsHeader
        canMutate={canMutate}
        writeReasonId={writeReasonId}
        loading={loading && rows === null}
        formCount={rows?.length ?? 0}
        showCreate={surface === "library"}
        onCreate={() => openCreate()}
      />

      <FormsReadiness />

      <FormsSurfaceTabs
        value={surface}
        formCount={rows?.length ?? 0}
        onChange={(next) => {
          bulk.clear();
          setVisitedSurfaces((current) => {
            if (current.has(next)) return current;
            const expanded = new Set(current);
            expanded.add(next);
            return expanded;
          });
          setSurface(next);
        }}
        library={
          <FormsLibrarySurface
            canMutate={canMutate}
            collection={collection}
            bulk={bulk}
            writeReasonId={writeReasonId}
            onCreate={openCreate}
          />
        }
        landing={
          visitedSurfaces.has("landing") ? (
            <div className="forms-landing-surface">
              <Notice tone="warning" title="Deployment-qualified delivery">
                Page definitions and lifecycle records are available here.
                Custom-domain routing, DNS verification, and the production page
                editor must be qualified separately before a page is described
                as customer-ready.
              </Notice>
              <LandingPagesSection />
            </div>
          ) : (
            <></>
          )
        }
        social={<SocialCaptureBoundary />}
      />

      <FormsOverlays
        selectedId={selectedId}
        rows={rows}
        createOpen={createOpen}
        draft={draft}
        submitting={submitting}
        submitErr={submitErr}
        errors={errors}
        createLifecycle={createLifecycle}
        onReload={() => void load()}
        onCloseDetail={() => setSelectedId(null)}
        onNameChange={setName}
        onSlugChange={setSlug}
        onDraftChange={setDraft}
        onSubmit={() => void submitCreate()}
      />
    </div>
  );
}
