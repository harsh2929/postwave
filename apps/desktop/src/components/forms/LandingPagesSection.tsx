/**
 * LandingPagesSection — "Landing pages" block on the Forms page
 * (apps/api/internal/landingpages — ROADMAP-WRAPPERS T2).
 *
 * The desktop editor is deliberately scoped to what the backend
 * stores against the row: name, slug (create-only), custom domain,
 * template key, and status. blocks / seo / tracking are free-form
 * jsonb owned by the web page builder — we show counts, not editors.
 * Pages are SERVED by the tenant's public web app at /landing/[slug]
 * (apps/web), never by this API host, so URL copy is honest about
 * that. Mutations are admin-scoped per the manifest.
 */

/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The landing-page
 * table is a named horizontal scroll region at narrow/zoomed layouts. It must
 * be keyboard-focusable so non-pointer users can pan columns and actions. */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import { Notice } from "../Notice";
import { SectionHeader } from "../SectionHeader";
import { toast } from "../Toast";
import { useDraftLifecycleController } from "../../hooks/useDraftLifecycleController";
import {
  lifecycleOperationError,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import { type LandingPage, landingPagesApi } from "../../lib/api-client";
import { useCanAdmin } from "../../lib/store";
import {
  type LandingPageDraft,
  blocksSummary,
  buildLandingPageInput,
  landingPageToDraft,
  landingPageUrl,
  landingStatusTone,
  newLandingPageDraft,
  slugifyPageName,
  sortLandingPages,
  statusAction,
} from "./landing-pages-helpers";

function statusBadge(status: string | undefined): ReactElement {
  const tone = landingStatusTone(status);
  const label = (status ?? "draft").replace(/^./, (c) => c.toUpperCase());
  if (tone === "default") return <span className="badge">{label}</span>;
  return <span className={`badge ${tone}`}>{label}</span>;
}

function landingSaveError(error: unknown): { field: string; error: string } {
  return {
    field: "_form",
    error: lifecycleOperationError(
      error,
      "The landing page couldn't be saved.",
    ),
  };
}

interface LandingPageListProps {
  rows: LandingPage[];
  canAdmin: boolean;
  busyId: string | null;
  onStatusChange: (page: LandingPage) => void;
  onEdit: (page: LandingPage) => void;
  onDelete: (page: LandingPage) => void;
}

function LandingPageList({
  rows,
  canAdmin,
  busyId,
  onStatusChange,
  onEdit,
  onDelete,
}: LandingPageListProps): ReactElement {
  return (
    <div
      className="forms-table-scroll"
      role="region"
      aria-label="Landing pages table"
      tabIndex={0}
    >
      <div className="list" role="table" aria-label="Landing pages">
        <div
          className="list-header"
          role="row"
          style={{ gridTemplateColumns: "1.4fr 1.6fr 110px 110px 220px" }}
        >
          <div role="columnheader">Name</div>
          <div role="columnheader">URL</div>
          <div role="columnheader">Status</div>
          <div role="columnheader">Content</div>
          <div role="columnheader" aria-label="Actions" />
        </div>
        {rows.map((page) => {
          const url = landingPageUrl(page);
          const action = statusAction(page.status);
          return (
            <div
              key={page.id}
              className="list-row"
              role="row"
              style={{
                gridTemplateColumns: "1.4fr 1.6fr 110px 110px 220px",
                cursor: "default",
              }}
            >
              <div
                role="cell"
                style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={page.name}
              >
                {page.name || "Untitled"}
              </div>
              <div
                role="cell"
                className="muted mono"
                style={{
                  fontSize: 11,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={
                  url.absolute
                    ? url.url
                    : `${url.url} — path on your web deployment (no custom domain set)`
                }
              >
                {url.url}
              </div>
              <div role="cell">{statusBadge(page.status)}</div>
              <div role="cell" className="muted" style={{ fontSize: 11 }}>
                {blocksSummary(page.blocks)}
              </div>
              <div
                role="cell"
                style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}
              >
                {canAdmin ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      disabled={busyId !== null}
                      onClick={() => onStatusChange(page)}
                    >
                      {action.label}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      disabled={busyId !== null}
                      onClick={() => onEdit(page)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      disabled={busyId !== null}
                      onClick={() => onDelete(page)}
                    >
                      Archive
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function LandingPagesSection(): ReactElement {
  const activeRef = useRef(true);
  const loadRequestRef = useRef(0);
  // list/get are read:campaigns; ALL mutations are admin-scoped.
  const canAdmin = useCanAdmin();
  const [rows, setRows] = useState<LandingPage[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [draft, setDraft] = useState<LandingPageDraft | null>(null);
  const [draftBaseline, setDraftBaseline] = useState<LandingPageDraft | null>(
    null,
  );
  const [draftErr, setDraftErr] = useState<{
    field: string;
    error: string;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LandingPage | null>(null);
  const mutation = useSingleFlightOperation({
    ownerId: "landing-page-mutation",
    label: "Landing page mutation",
    detail: "Wait for the landing-page request to finish before leaving.",
  });

  const load = useCallback(async (): Promise<void> => {
    const requestId = ++loadRequestRef.current;
    const res = await landingPagesApi.list();
    if (!activeRef.current || requestId !== loadRequestRef.current) return;
    if (res.error) {
      if (res.error.status === 404 || res.error.status === 501) {
        setErr(null);
        setUnavailable(true);
        return;
      }
      setUnavailable(false);
      setErr(res.error.message);
      return;
    }
    setUnavailable(false);
    setErr(null);
    if (!Array.isArray(res.data)) {
      setErr(
        "The server returned an unrecognised landing-page response. The last confirmed inventory has been kept.",
      );
      return;
    }
    setRows(sortLandingPages(res.data));
  }, []);

  useEffect(() => {
    activeRef.current = true;
    void load();
    return () => {
      activeRef.current = false;
      loadRequestRef.current += 1;
    };
  }, [load]);

  const save = async (): Promise<boolean> => {
    if (!draft) return false;
    setDraftErr(null);
    const built = buildLandingPageInput(draft);
    if (!built.ok) {
      setDraftErr({ field: built.field, error: built.error });
      return false;
    }
    const res = draft.id
      ? await landingPagesApi.update(draft.id, built.patch)
      : await landingPagesApi.create(built.create);
    if (!activeRef.current) return false;
    if (res.error) {
      setDraftErr({ field: "_form", error: res.error.message });
      return false;
    }
    toast.success(draft.id ? "Landing page updated" : "Landing page created");
    setDraft(null);
    setDraftBaseline(null);
    void load();
    return true;
  };

  const draftLifecycle = useDraftLifecycleController({
    ownerId: draft?.id
      ? `landing-page-edit-${draft.id}`
      : "landing-page-create",
    label: draft?.id ? "Landing page changes" : "New landing page draft",
    mode: draft?.id ? "edit" : "create",
    enabled: draft !== null,
    dirty:
      draft !== null &&
      JSON.stringify(draft) !==
        JSON.stringify(draftBaseline ?? newLandingPageDraft()),
    save,
    discard: () => {
      setDraft(draftBaseline);
      setDraftErr(null);
    },
    close: () => {
      setDraft(null);
      setDraftBaseline(null);
    },
    detail: draft?.id
      ? "These landing-page changes have not been saved."
      : "This landing page has not been created. Return to the editor or explicitly discard it.",
    operationDetail:
      "Wait for the landing-page save request to finish before leaving Moosewave.",
    onError: (error) => setDraftErr(landingSaveError(error)),
  });

  const setStatus = async (page: LandingPage): Promise<void> => {
    const request = mutation.run(async () => {
      const action = statusAction(page.status);
      setBusyId(page.id);
      try {
        const res = await landingPagesApi.update(page.id, {
          status: action.next,
        });
        if (!activeRef.current) return;
        if (res.error) {
          toast.error(`${action.label} failed: ${res.error.message}`);
          return;
        }
        toast.success(
          action.next === "published"
            ? `"${page.name}" published`
            : `"${page.name}" moved to draft`,
        );
        void load();
      } catch (error) {
        if (activeRef.current) {
          toast.error(
            lifecycleOperationError(error, `${action.label} failed.`),
          );
        }
      } finally {
        if (activeRef.current) setBusyId(null);
      }
    });
    if (!request) await mutation.wait();
  };

  const remove = async (): Promise<void> => {
    if (!deleteTarget) return;
    const page = deleteTarget;
    const request = mutation.run(async () => {
      setBusyId(page.id);
      try {
        const res = await landingPagesApi.remove(page.id);
        if (!activeRef.current) return;
        if (res.error) {
          toast.error(`Archive failed: ${res.error.message}`);
          return;
        }
        setDeleteTarget(null);
        toast.success(`Landing page "${page.name}" archived`);
        void load();
      } catch (error) {
        if (activeRef.current) {
          toast.error(
            lifecycleOperationError(error, "The landing page wasn't archived."),
          );
        }
      } finally {
        if (activeRef.current) setBusyId(null);
      }
    });
    if (!request) await mutation.wait();
  };

  return (
    <div style={{ marginTop: 32 }}>
      <SectionHeader
        title="Landing pages"
        description="Standalone signup pages served by your public web app at /landing/<slug> — not by this API host."
        helpText="The desktop app manages the page record (name, slug, domain, template, publish state). Page content (blocks, SEO, tracking) is edited in the web page builder."
        actions={
          canAdmin && !unavailable ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setDraftErr(null);
                const next = newLandingPageDraft();
                setDraftBaseline(next);
                setDraft(next);
              }}
            >
              New page
            </button>
          ) : undefined
        }
      />

      {err ? (
        <Notice
          tone="danger"
          title={
            rows === null
              ? "Couldn’t load landing pages"
              : "Couldn’t refresh landing pages"
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
          {rows !== null ? " The last confirmed records remain below." : ""}
        </Notice>
      ) : null}

      {unavailable ? (
        <p className="muted" style={{ fontSize: 12 }}>
          This API build doesn&apos;t expose landing pages
          (/api/v1/landing-pages returned not-found). Upgrade the backend to
          manage them here.
        </p>
      ) : rows === null && !err ? (
        <p className="muted">Loading landing pages…</p>
      ) : rows?.length === 0 ? (
        <p className="muted" style={{ fontSize: 12 }}>
          No landing pages yet. A landing page is a standalone hosted signup
          page — useful for link-in-bio, ads, and QR codes when you don&apos;t
          want to embed a form.
          {canAdmin ? "" : " Creating pages requires an admin role."}
        </p>
      ) : rows && rows.length > 0 ? (
        <LandingPageList
          rows={rows}
          canAdmin={canAdmin}
          busyId={busyId}
          onStatusChange={(page) => void setStatus(page)}
          onEdit={(page) => {
            setDraftErr(null);
            const next = landingPageToDraft(page);
            setDraftBaseline(next);
            setDraft(next);
          }}
          onDelete={setDeleteTarget}
        />
      ) : null}

      <Modal
        open={draft !== null}
        onClose={draftLifecycle.requestClose}
        closeOnBackdrop={!draftLifecycle.active}
        closeOnEscape={!draftLifecycle.active}
        closeDisabled={draftLifecycle.active}
        title={draft?.id ? "Edit landing page" : "New landing page"}
        description={
          draft?.id
            ? "Slug is fixed after creation — the public URL never breaks."
            : "Creates the page record in draft. Content is built in the web page builder."
        }
      >
        {draft ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void draftLifecycle.submit();
            }}
          >
            <LandingPageDraftFields
              draft={draft}
              error={draftErr}
              onChange={setDraft}
            />
            {draftErr?.field === "_form" ? (
              <div className="field-error" role="alert">
                {draftErr.error}
              </div>
            ) : null}
            <ModalFooter>
              <button
                type="button"
                className="btn"
                onClick={draftLifecycle.requestClose}
                disabled={draftLifecycle.active}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={draftLifecycle.active}
              >
                {draftLifecycle.active
                  ? "Saving…"
                  : draft.id
                    ? "Save changes"
                    : "Create page"}
              </button>
            </ModalFooter>
          </form>
        ) : (
          <span />
        )}
      </Modal>

      <ConfirmModal
        open={deleteTarget !== null}
        title={`Archive "${deleteTarget?.name ?? ""}"?`}
        description="The public URL stops resolving immediately. The record and history are retained, and an admin can restore it to draft later."
        confirmLabel="Archive"
        busy={mutation.active}
        onConfirm={() => void remove()}
        onClose={() => {
          if (!mutation.active) setDeleteTarget(null);
        }}
      />
      <ConfirmModal
        open={draftLifecycle.discardConfirmOpen}
        title={
          draft?.id
            ? "Discard landing-page changes?"
            : "Discard landing-page draft?"
        }
        description={
          draft?.id
            ? "Your changes will be restored to the last loaded page."
            : "The landing page has not been created."
        }
        confirmLabel="Discard"
        danger
        busy={draftLifecycle.active}
        onConfirm={draftLifecycle.discardAndClose}
        onClose={draftLifecycle.keepEditing}
      />
    </div>
  );
}

function LandingPageDraftFields({
  draft,
  error,
  onChange,
}: {
  draft: LandingPageDraft;
  error: { field: string; error: string } | null;
  onChange: (draft: LandingPageDraft) => void;
}): ReactElement {
  const nameError = error?.field === "name" ? error.error : null;
  const slugError = error?.field === "slug" ? error.error : null;
  const domainError = error?.field === "domain" ? error.error : null;
  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor="lp-name">
          Name
        </label>
        <input
          id="lp-name"
          className="input"
          placeholder="Spring promo"
          value={draft.name}
          maxLength={200}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? "lp-name-error" : undefined}
          aria-errormessage={nameError ? "lp-name-error" : undefined}
          onChange={(event) =>
            onChange({
              ...draft,
              name: event.target.value,
              slug:
                draft.slugTouched || draft.id
                  ? draft.slug
                  : slugifyPageName(event.target.value),
            })
          }
        />
        {nameError ? (
          <div id="lp-name-error" className="field-error" role="alert">
            {nameError}
          </div>
        ) : null}
      </div>
      {!draft.id ? (
        <div className="field">
          <label className="field-label" htmlFor="lp-slug">
            Slug
          </label>
          <input
            id="lp-slug"
            className="input mono"
            placeholder="spring-promo"
            value={draft.slug}
            maxLength={64}
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={slugError ? true : undefined}
            aria-describedby={
              slugError ? "lp-slug-help lp-slug-error" : "lp-slug-help"
            }
            aria-errormessage={slugError ? "lp-slug-error" : undefined}
            onChange={(event) =>
              onChange({
                ...draft,
                slug: event.target.value,
                slugTouched: true,
              })
            }
          />
          <div id="lp-slug-help" className="field-help">
            Public path: /landing/{draft.slug || "your-slug"} on your web
            deployment.
          </div>
          {slugError ? (
            <div id="lp-slug-error" className="field-error" role="alert">
              {slugError}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="field">
        <label className="field-label" htmlFor="lp-domain">
          Custom domain <span className="muted">(optional)</span>
        </label>
        <input
          id="lp-domain"
          className="input mono"
          placeholder="pages.example.com"
          value={draft.domain}
          readOnly
          aria-describedby={
            domainError ? "lp-domain-help lp-domain-error" : "lp-domain-help"
          }
          aria-invalid={domainError ? true : undefined}
          aria-errormessage={domainError ? "lp-domain-error" : undefined}
        />
        <div id="lp-domain-help" className="field-help">
          Inspection only in desktop until DNS ownership and routing
          verification are available. Configure domains in the qualified web
          deployment.
        </div>
        {domainError ? (
          <div id="lp-domain-error" className="field-error" role="alert">
            {domainError}
          </div>
        ) : null}
      </div>
      <div className="field">
        <label className="field-label" htmlFor="lp-template">
          Template key <span className="muted">(optional)</span>
        </label>
        <input
          id="lp-template"
          className="input mono"
          placeholder="(server default)"
          value={draft.template}
          onChange={(event) =>
            onChange({ ...draft, template: event.target.value })
          }
        />
      </div>
    </>
  );
}
