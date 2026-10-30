/**
 * CampaignTranslationsPanel (G19 of the campaigns 2026 pack)
 *
 * The per-campaign multi-language variant matrix: author N localizations
 * (subject + HTML body per locale) for one campaign. Distinct from the
 * AI smart-translations dictionary — these are hand-authored variants.
 *
 * Lists existing locale variants, lets the operator add/edit a locale's
 * subject + body, and delete one. Queue-fill routing by recipient locale
 * + a per-language report are backend follow-ups.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { type CampaignTranslation, api } from "../../lib/api-client";
import { usePersistentLifecycleOperation } from "../../hooks/usePersistentLifecycleOperation";
import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
} from "../../hooks/useSettingsDraftLifecycle";
import { ConfirmModal } from "../ConfirmModal";
import { Notice } from "../Notice";
import { toast } from "../Toast";

interface Props {
  campaignId: string | number;
  canMutate: boolean;
}

interface TranslationDraft {
  locale: string;
  subject: string;
  bodyHtml: string;
}

type DraftTransition =
  | { kind: "close" }
  | { kind: "edit"; translation: CampaignTranslation };

const EMPTY_TRANSLATION_DRAFT: TranslationDraft = {
  locale: "",
  subject: "",
  bodyHtml: "",
};

// Recipient dispatch currently ignores saved locale variants. Existing rows
// remain inspectable, but authoring another persisted no-op is intentionally
// unavailable until locale routing is part of the canonical send plan.
const CAMPAIGN_LOCALE_ROUTING_ENABLED = false;

function TranslationRows({
  canMutate,
  operationActive,
  rows,
  onDelete,
  onEdit,
}: {
  canMutate: boolean;
  operationActive: boolean;
  rows: CampaignTranslation[];
  onDelete: (locale: string) => void;
  onEdit: (translation: CampaignTranslation) => void;
}): ReactElement {
  return (
    <div style={{ marginTop: 8 }}>
      {rows.map((translation) => (
        <div
          key={translation.locale}
          style={{
            display: "flex",
            gap: 8,
            alignItems: "baseline",
            padding: "6px 0",
            borderTop: "1px solid var(--pw-border)",
            fontSize: 13,
          }}
        >
          <span className="badge accent">{translation.locale}</span>
          <span
            style={{
              flex: 1,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={translation.subject}
          >
            {translation.subject || <span className="muted">(no subject)</span>}
          </span>
          {canMutate ? (
            <>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => onEdit(translation)}
                disabled={operationActive}
              >
                Edit
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => onDelete(translation.locale)}
                disabled={operationActive}
              >
                Delete
              </button>
            </>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function TranslationEditor({
  bodyHtml,
  busy,
  canMutate,
  fieldPrefix,
  locale,
  operationActive,
  subject,
  onBodyChange,
  onCancel,
  onLocaleChange,
  onSave,
  onSubjectChange,
}: {
  bodyHtml: string;
  busy: boolean;
  canMutate: boolean;
  fieldPrefix: string;
  locale: string;
  operationActive: boolean;
  subject: string;
  onBodyChange: (value: string) => void;
  onCancel: () => void;
  onLocaleChange: (value: string) => void;
  onSave: () => void;
  onSubjectChange: (value: string) => void;
}): ReactElement {
  const disabled = !canMutate || operationActive;
  return (
    <div
      style={{
        marginTop: 8,
        padding: 10,
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <label className="visually-hidden" htmlFor={`${fieldPrefix}-locale`}>
        Translation locale
      </label>
      <input
        id={`${fieldPrefix}-locale`}
        className="input"
        placeholder="Locale (es, fr-CA, pt-BR…)"
        value={locale}
        onChange={(event) => onLocaleChange(event.target.value)}
        disabled={disabled}
      />
      <label className="visually-hidden" htmlFor={`${fieldPrefix}-subject`}>
        Translated subject
      </label>
      <input
        id={`${fieldPrefix}-subject`}
        className="input"
        placeholder="Subject for this language"
        value={subject}
        onChange={(event) => onSubjectChange(event.target.value)}
        disabled={disabled}
      />
      <label className="visually-hidden" htmlFor={`${fieldPrefix}-body`}>
        Translated HTML body
      </label>
      <textarea
        id={`${fieldPrefix}-body`}
        className="input"
        rows={4}
        placeholder="<p>Body HTML for this language…</p>"
        value={bodyHtml}
        onChange={(event) => onBodyChange(event.target.value)}
        disabled={disabled}
        style={{
          fontFamily: "ui-monospace, Menlo, monospace",
          resize: "vertical",
        }}
      />
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={disabled}
          onClick={onSave}
        >
          {busy ? "Saving…" : "Save variant"}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onCancel}
          disabled={operationActive}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function TranslationConfirmations({
  deleting,
  draftTransition,
  operationActive,
  pendingDeleteLocale,
  onConfirmDelete,
  onConfirmDiscard,
  onKeepEditing,
  onKeepLocale,
}: {
  deleting: boolean;
  draftTransition: DraftTransition | null;
  operationActive: boolean;
  pendingDeleteLocale: string | null;
  onConfirmDelete: () => void;
  onConfirmDiscard: () => void;
  onKeepEditing: () => void;
  onKeepLocale: () => void;
}): ReactElement {
  return (
    <>
      <ConfirmModal
        open={pendingDeleteLocale !== null}
        title={`Remove ${pendingDeleteLocale ?? ""} variant?`}
        description="This variant's translations clear too."
        confirmLabel="Remove variant"
        danger
        busy={deleting}
        onConfirm={onConfirmDelete}
        onClose={() => {
          if (!operationActive) onKeepLocale();
        }}
      />
      <ConfirmModal
        open={draftTransition !== null}
        title={
          draftTransition?.kind === "edit"
            ? "Discard this translation and edit another?"
            : "Discard this translation?"
        }
        description="The locale, subject, and HTML body changes have not been saved."
        confirmLabel="Discard translation"
        danger
        onConfirm={onConfirmDiscard}
        onClose={onKeepEditing}
      />
    </>
  );
}

export function CampaignTranslationsPanel({
  campaignId,
  canMutate,
}: Props): ReactElement {
  const authoringEnabled = canMutate && CAMPAIGN_LOCALE_ROUTING_ENABLED;
  const [rows, setRows] = useState<CampaignTranslation[]>([]);
  const [loading, setLoading] = useState(true);
  // GAP-3#11: capture load failures instead of swallowing them — a 500/network
  // error used to fall through as "· 0 variants", which reads as "no variants
  // authored" and invites re-authoring / assumed deletion.
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [locale, setLocale] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [baseline, setBaseline] = useState<TranslationDraft>(
    EMPTY_TRANSLATION_DRAFT,
  );
  const [busy, setBusy] = useState(false);
  // SUB-092: locale staged for deletion → drives the ConfirmModal.
  const [pendingDeleteLocale, setPendingDeleteLocale] = useState<string | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const [draftTransition, setDraftTransition] =
    useState<DraftTransition | null>(null);
  const mountedRef = useRef(true);
  const loadSequenceRef = useRef(0);
  const fieldPrefix = useId();
  const operation = usePersistentLifecycleOperation({
    ownerId: `campaign-locale-translation-${String(campaignId)}`,
    label: "Campaign language variant request",
    detail:
      "Wait for the campaign language-variant request to finish before leaving Moosewave.",
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadSequenceRef.current += 1;
    };
  }, []);

  const currentDraft: TranslationDraft = { locale, subject, bodyHtml };
  const draftDirty =
    adding &&
    (currentDraft.locale !== baseline.locale ||
      currentDraft.subject !== baseline.subject ||
      currentDraft.bodyHtml !== baseline.bodyHtml);
  const discardEditor = useCallback((): void => {
    setAdding(false);
    setLocale("");
    setSubject("");
    setBodyHtml("");
    setBaseline(EMPTY_TRANSLATION_DRAFT);
    setDraftTransition(null);
  }, []);
  useDiscardOnlyDraftLifecycle({
    ownerId: `campaign-locale-translation-${String(campaignId)}`,
    label: "Campaign language variant draft",
    dirty: draftDirty,
    operationRef: operation.promiseRef,
    discard: discardEditor,
    detail:
      "This locale, subject, and translated body have not been saved. Return to the editor or explicitly discard them.",
    operationDetail:
      "Wait for the campaign language-variant request to finish before leaving Moosewave.",
  });

  const load = useCallback(async (): Promise<void> => {
    const requestId = ++loadSequenceRef.current;
    setLoading(true);
    setLoadErr(null);
    try {
      const res = await api.listCampaignTranslations(campaignId);
      if (!mountedRef.current || requestId !== loadSequenceRef.current) return;
      if (res.error) {
        // GAP-3#11: surface the failure (Notice + Retry below) rather than
        // rendering an empty list that looks like "no variants".
        setLoadErr(res.error.message);
        return;
      }
      setRows(res.data.translations);
    } catch (loadError) {
      if (mountedRef.current && requestId === loadSequenceRef.current) {
        setLoadErr(
          lifecycleOperationError(
            loadError,
            "Campaign language variants could not be loaded.",
          ),
        );
      }
    } finally {
      if (mountedRef.current && requestId === loadSequenceRef.current) {
        setLoading(false);
      }
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<void> => {
    if (!locale.trim()) {
      toast.error("Enter a locale (e.g. es or fr-CA).");
      return;
    }
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    const requestedLocale = locale.trim();
    const requestedSubject = subject;
    const requestedBody = bodyHtml;
    setBusy(true);
    const request = operation.run(async (): Promise<void> => {
      try {
        const res = await api.upsertCampaignTranslation(
          campaignId,
          requestedLocale,
          {
            subject: requestedSubject,
            body_html: requestedBody,
          },
        );
        if (!mountedRef.current) return;
        if (res.error) {
          toast.error(`Couldn't save: ${res.error.message}`);
          return;
        }
        toast.success(`${res.data?.locale ?? requestedLocale} variant saved`);
        discardEditor();
        await load();
      } catch (saveError) {
        if (mountedRef.current) {
          toast.error(
            `Couldn't save: ${lifecycleOperationError(
              saveError,
              "The language-variant request did not complete.",
            )}`,
          );
        }
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    });
    if (request) await request;
  };

  const beginEdit = (tr: CampaignTranslation): void => {
    const next = {
      locale: tr.locale,
      subject: tr.subject,
      bodyHtml: tr.body_html,
    };
    setAdding(true);
    setLocale(next.locale);
    setSubject(next.subject);
    setBodyHtml(next.bodyHtml);
    setBaseline(next);
    setDraftTransition(null);
  };

  const edit = (tr: CampaignTranslation): void => {
    if (operation.promiseRef.current) return;
    if (draftDirty) {
      setDraftTransition({ kind: "edit", translation: tr });
      return;
    }
    beginEdit(tr);
  };

  const requestEditorClose = (): void => {
    if (operation.promiseRef.current) return;
    if (draftDirty) {
      setDraftTransition({ kind: "close" });
      return;
    }
    discardEditor();
  };

  // SUB-092: stage the locale, then confirm via ConfirmModal (was a
  // bare window.confirm, which silently no-ops inside the Tauri webview).
  const remove = (loc: string): void => {
    setPendingDeleteLocale(loc);
  };

  const removeRow = async (loc: string): Promise<void> => {
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    setDeleting(true);
    const request = operation.run(async (): Promise<void> => {
      try {
        const res = await api.deleteCampaignTranslation(campaignId, loc);
        if (!mountedRef.current) return;
        if (res.error) {
          toast.error(`Couldn't delete: ${res.error.message}`);
          return;
        }
        setPendingDeleteLocale(null);
        await load();
      } catch (deleteError) {
        if (mountedRef.current) {
          toast.error(
            `Couldn't delete: ${lifecycleOperationError(
              deleteError,
              "The language-variant request did not complete.",
            )}`,
          );
        }
      } finally {
        if (mountedRef.current) setDeleting(false);
      }
    });
    if (request) await request;
  };

  return (
    <div className="campaign-translations" style={{ marginTop: 16 }}>
      <div
        className="label"
        style={{ display: "flex", alignItems: "center", gap: 8 }}
      >
        Languages
        <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>
          · {rows.length} variant{rows.length === 1 ? "" : "s"}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        {authoringEnabled && !adding ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={operation.active}
            onClick={() => {
              setBaseline(EMPTY_TRANSLATION_DRAFT);
              setAdding(true);
            }}
          >
            + Add language
          </button>
        ) : null}
      </div>

      {/* GAP-3#2: language variants are authored + stored but not yet routed
          at send time (backend ResolveForLocale has no dispatch caller), so
          every recipient currently gets the default-language body. Say so
          plainly instead of letting operators assume localized delivery. */}
      <Notice
        tone="warning"
        style={{ marginTop: 8 }}
        title="Language variants are read-only until routing is available"
      >
        Existing localizations are shown for review, but recipients still
        receive the default-language subject and body. Adding, editing, and
        deleting variants is disabled until per-locale delivery is enforced by
        the send plan.
      </Notice>

      {loading ? (
        <div className="skel" style={{ height: 40, marginTop: 8 }} />
      ) : loadErr ? (
        // GAP-3#11: match the sibling panels (HoldoutCard etc.) — danger
        // Notice + Retry instead of a silently empty list.
        <Notice
          tone="danger"
          style={{ marginTop: 8 }}
          title="Couldn't load language variants"
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
          {loadErr}
        </Notice>
      ) : (
        <TranslationRows
          canMutate={authoringEnabled}
          operationActive={operation.active}
          rows={rows}
          onDelete={remove}
          onEdit={edit}
        />
      )}

      {adding ? (
        <TranslationEditor
          bodyHtml={bodyHtml}
          busy={busy}
          canMutate={authoringEnabled}
          fieldPrefix={fieldPrefix}
          locale={locale}
          operationActive={operation.active}
          subject={subject}
          onBodyChange={setBodyHtml}
          onCancel={requestEditorClose}
          onLocaleChange={setLocale}
          onSave={() => void save()}
          onSubjectChange={setSubject}
        />
      ) : null}

      <TranslationConfirmations
        deleting={deleting}
        draftTransition={draftTransition}
        operationActive={operation.active}
        pendingDeleteLocale={pendingDeleteLocale}
        onConfirmDelete={() => {
          if (pendingDeleteLocale !== null) void removeRow(pendingDeleteLocale);
        }}
        onConfirmDiscard={() => {
          const transition = draftTransition;
          discardEditor();
          if (transition?.kind === "edit") beginEdit(transition.translation);
        }}
        onKeepEditing={() => setDraftTransition(null)}
        onKeepLocale={() => setPendingDeleteLocale(null)}
      />
    </div>
  );
}
