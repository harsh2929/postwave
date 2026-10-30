/**
 * TranslationsPanel — coverage item #4 (translations).
 *
 * Opened from the campaign slideover's "Translate" action. Three
 * sections:
 *
 *   1. Settings (GET/PUT /translations/settings) — enable flag,
 *      default locale, supported locales, fallback strategy
 *      (subscriber_locale | default_only, mirrored from the Go
 *      validator), and the subscriber attribute that carries each
 *      recipient's locale.
 *
 *   2. Terminology dictionary (CRUD + CSV import/export) — terms the
 *      LLM must translate exactly as specified (brand names, product
 *      SKUs). Import accepts a raw CSV file; export downloads the
 *      server-generated CSV.
 *
 *   3. Preview (POST /translations/preview) — LLM-backed on cache
 *      miss, so it runs on the 60s LLM budget with explicit progress
 *      copy and honest 429/503 errors (translatePreviewErrorCopy).
 *
 * Honest-UI: every fetch failure renders inline with a Retry; the
 * preview never fakes a translation — `skipped: true` responses are
 * labeled as untranslated passthroughs.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  type TranslationDictionaryEntry,
  type TranslationImportResult,
  type TranslationRenderResult,
  type TranslationSettings,
  translationsApi,
} from "../../lib/api-client";
import {
  beginUploadTransfer,
  pickImportFiles,
  saveFile,
} from "../../lib/file-transfer";
import type { ImportPolicy } from "../../lib/file-transfer-types";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";
import { ConfirmModal } from "../ConfirmModal";
import { Modal } from "../Modal";
import { Notice } from "../Notice";
import { Skeleton } from "../Skeleton";
import { toast } from "../Toast";
import {
  type LocalePair,
  dictionaryEntryValid,
  formatLocaleList,
  parseLocaleList,
  translatePreviewErrorCopy,
  translationsFromPairs,
  pairsFromTranslations,
} from "./translations-helpers";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Current campaign body — seeds the preview textarea. */
  body: string;
  canMutate: boolean;
  /** PUT /translations/settings is ScopeAdmin server-side
   *  (translations.go) — dictionary CRUD/import and the preview stay
   *  write-gated, but the Settings section needs this stronger gate so
   *  editors don't get an enabled Save that always 403s. */
  canAdmin: boolean;
  /** When provided (slideover in edit mode), the preview result gets
   *  a "Use as body" affordance that writes the translation into the
   *  draft. Omitted = read-only preview. */
  onApplyTranslation?: (translated: string) => void;
}

const FALLBACKS = [
  { id: "subscriber_locale", label: "Subscriber locale, then default" },
  { id: "default_only", label: "Default locale only" },
] as const;
const TRANSLATION_IMPORT_POLICY: ImportPolicy = {
  label: "translation dictionary CSV",
  privacy: "confidential",
  extensions: ["csv"],
  maxBytes: 25 * 1024 * 1024,
};

export function TranslationsPanel({
  open,
  onClose,
  body,
  canMutate,
  canAdmin,
  onApplyTranslation,
}: Props): ReactElement {
  // Settings (PUT) is admin-scoped; write role alone isn't enough.
  const canEditSettings = canMutate && canAdmin;
  const settingsGateTitle = !canMutate
    ? "Viewer role can't change settings"
    : "Translation settings need an admin role";
  /* ------- settings ---------------------------------------------- */
  const translationSettings = useTranslationSettingsController();

  /* ------- dictionary --------------------------------------------- */
  const [entries, setEntries] = useState<TranslationDictionaryEntry[] | null>(
    null,
  );
  const [dictErr, setDictErr] = useState<string | null>(null);
  const [dictLoading, setDictLoading] = useState(true);
  const [term, setTerm] = useState("");
  const [pairs, setPairs] = useState<LocalePair[]>([{ locale: "", value: "" }]);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [notes, setNotes] = useState("");
  const [entrySaving, setEntrySaving] = useState(false);
  const [entryErr, setEntryErr] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] =
    useState<TranslationDictionaryEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const preview = useTranslationPreviewController();
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const mountedRef = useRef(true);
  const dictionarySequence = useRef(0);

  useEffect(
    () => () => {
      mountedRef.current = false;
      dictionarySequence.current += 1;
    },
    [],
  );

  const loadDictionary = async (): Promise<void> => {
    const requestId = ++dictionarySequence.current;
    setDictLoading(true);
    setDictErr(null);
    try {
      const response = await translationsApi.listDictionary();
      if (!mountedRef.current || requestId !== dictionarySequence.current) {
        return;
      }
      if (response.error) {
        setDictErr(response.error.message);
        return;
      }
      setEntries(response.data.entries ?? []);
    } catch {
      if (mountedRef.current && requestId === dictionarySequence.current) {
        setDictErr("The dictionary request did not complete.");
      }
    } finally {
      if (mountedRef.current && requestId === dictionarySequence.current) {
        setDictLoading(false);
      }
    }
  };
  const transfers = useDictionaryTransfers(loadDictionary);

  useEffect(() => {
    if (!open) {
      dictionarySequence.current += 1;
      return;
    }
    preview.reset(body);
    transfers.resetResult();
    void translationSettings.load().then((loaded) => {
      const firstLocale = loaded?.supported_locales?.[0];
      if (!preview.locale && firstLocale) preview.setLocale(firstLocale);
    });
    void loadDictionary();
    return () => {
      dictionarySequence.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const settingsDirty = translationSettings.dirty;
  const dictionaryDraft = hasDictionaryDraft(term, notes, caseSensitive, pairs);
  const previewDraft = preview.body !== body && preview.body.trim().length > 0;
  const operationActive =
    translationSettings.saving ||
    entrySaving ||
    transfers.importing ||
    transfers.exporting ||
    preview.previewing ||
    deleting;
  const dirty = settingsDirty || dictionaryDraft || previewDraft;
  const discardChanges = useCallback((): void => {
    translationSettings.reset();
    setTerm("");
    setPairs([{ locale: "", value: "" }]);
    setCaseSensitive(false);
    setNotes("");
    preview.reset(body);
    setDiscardConfirmOpen(false);
    onClose();
  }, [body, onClose, preview, translationSettings]);
  useTranslationsLifecycle({
    dirty,
    onDiscard: discardChanges,
    open,
    operationActive,
  });
  const requestClose = (): void => {
    if (operationActive) return;
    if (dirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    onClose();
  };

  const resetEntryForm = (): void => {
    setTerm("");
    setPairs([{ locale: "", value: "" }]);
    setCaseSensitive(false);
    setNotes("");
    setEntryErr(null);
  };

  const saveEntry = async (): Promise<void> => {
    if (!dictionaryEntryValid(term, pairs)) {
      setEntryErr(
        "A term plus at least one locale → translation pair is required.",
      );
      return;
    }
    setEntrySaving(true);
    setEntryErr(null);
    try {
      const response = await translationsApi.upsertDictionaryEntry({
        term: term.trim(),
        translations: translationsFromPairs(pairs),
        case_sensitive: caseSensitive,
        notes: notes.trim() || undefined,
      });
      if (!mountedRef.current) return;
      if (response.error) {
        setEntryErr(response.error.message);
        return;
      }
      toast.success('Dictionary entry "' + response.data.term + '" saved');
      resetEntryForm();
      void loadDictionary();
    } catch {
      if (mountedRef.current) {
        setEntryErr("The dictionary save request did not complete.");
      }
    } finally {
      if (mountedRef.current) setEntrySaving(false);
    }
  };

  const deleteEntry = async (): Promise<void> => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const response = await translationsApi.deleteDictionaryEntry(
        deleteTarget.id,
      );
      if (!mountedRef.current) return;
      if (response.error) {
        toast.error("Couldn't delete entry: " + response.error.message);
        return;
      }
      setDeleteTarget(null);
      toast.success("Dictionary entry deleted");
      void loadDictionary();
    } catch {
      if (mountedRef.current) {
        toast.error("Couldn't delete entry: request failed.");
      }
    } finally {
      if (mountedRef.current) setDeleting(false);
    }
  };

  const supportedLocales =
    translationSettings.settings?.supported_locales ?? [];

  return (
    <>
      <Modal
        open={open}
        onClose={requestClose}
        title="Translations"
        description="Per-locale rendering: settings, terminology dictionary, and an LLM-backed preview."
        size="lg"
      >
        <TranslationSettingsSection
          canEdit={canEditSettings}
          defaultLocale={translationSettings.defaultLocale}
          enabled={translationSettings.enabled}
          error={translationSettings.error}
          fallback={translationSettings.fallback}
          gateReason={settingsGateTitle}
          loading={translationSettings.loading}
          localeAttr={translationSettings.localeAttr}
          saving={translationSettings.saving}
          supportedInput={translationSettings.supportedInput}
          onDefaultLocaleChange={translationSettings.setDefaultLocale}
          onEnabledChange={translationSettings.setEnabled}
          onFallbackChange={translationSettings.setFallback}
          onLocaleAttrChange={translationSettings.setLocaleAttr}
          onRetry={() => void translationSettings.load()}
          onSave={() => void translationSettings.save()}
          onSupportedInputChange={translationSettings.setSupportedInput}
        />

        {/* ---------------- dictionary ------------------------------ */}
        <div className="label" style={{ marginTop: 16 }}>
          Terminology dictionary
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          Exact translations the model must respect — brand names, product
          terms, legal phrases.
        </div>
        <DictionaryEntries
          canMutate={canMutate}
          entries={entries}
          error={dictErr}
          loading={dictLoading}
          onDelete={setDeleteTarget}
          onEdit={(entry) => {
            setTerm(entry.term);
            const nextPairs = pairsFromTranslations(entry.translations);
            setPairs(
              nextPairs.length > 0 ? nextPairs : [{ locale: "", value: "" }],
            );
            setCaseSensitive(entry.case_sensitive);
            setNotes(entry.notes ?? "");
            setEntryErr(null);
          }}
          onRetry={() => void loadDictionary()}
        />

        <DictionaryEntryEditor
          canMutate={canMutate}
          caseSensitive={caseSensitive}
          error={entryErr}
          notes={notes}
          pairs={pairs}
          saving={entrySaving}
          term={term}
          onCaseSensitiveChange={setCaseSensitive}
          onNotesChange={setNotes}
          onPairsChange={setPairs}
          onSave={() => void saveEntry()}
          onTermChange={setTerm}
        />

        <DictionaryTransfers
          canMutate={canMutate}
          exporting={transfers.exporting}
          importing={transfers.importing}
          result={transfers.result}
          onExport={() => void transfers.exportCSV()}
          onImport={(file) => void transfers.importCSV(file)}
        />

        <TranslationPreviewSection
          canMutate={canMutate}
          error={preview.error}
          locale={preview.locale}
          onApplyTranslation={onApplyTranslation}
          previewBody={preview.body}
          previewing={preview.previewing}
          result={preview.result}
          supportedLocales={supportedLocales}
          onBodyChange={preview.setBody}
          onLocaleChange={preview.setLocale}
          onRetry={() => void preview.run()}
          onRun={() => void preview.run()}
        />
      </Modal>

      <ConfirmModal
        open={deleteTarget != null}
        title="Delete dictionary entry?"
        description={
          deleteTarget
            ? `"${deleteTarget.term}" will no longer pin its translations.`
            : ""
        }
        confirmLabel={deleting ? "Deleting…" : "Delete entry"}
        danger
        busy={deleting}
        onConfirm={deleteEntry}
        onClose={() => setDeleteTarget(null)}
      />
      <ConfirmModal
        open={discardConfirmOpen}
        title="Discard translation changes?"
        description="Unsaved settings, dictionary edits, and preview text will be lost."
        confirmLabel="Discard changes"
        danger
        onConfirm={discardChanges}
        onClose={() => setDiscardConfirmOpen(false)}
      />
    </>
  );
}

function hasDictionaryDraft(
  term: string,
  notes: string,
  caseSensitive: boolean,
  pairs: LocalePair[],
): boolean {
  return (
    term.trim().length > 0 ||
    notes.trim().length > 0 ||
    caseSensitive ||
    pairs.some(
      (pair, index) =>
        pair.locale.trim().length > 0 ||
        pair.value.trim().length > 0 ||
        index > 0,
    )
  );
}

function useTranslationSettingsController() {
  const [settings, setSettings] = useState<TranslationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [defaultLocale, setDefaultLocale] = useState("en");
  const [supportedInput, setSupportedInput] = useState("");
  const [fallback, setFallback] = useState<string>("subscriber_locale");
  const [localeAttr, setLocaleAttr] = useState("locale");
  const [saving, setSaving] = useState(false);
  const mountedRef = useRef(true);
  const loadSequence = useRef(0);

  useEffect(
    () => () => {
      mountedRef.current = false;
      loadSequence.current += 1;
    },
    [],
  );

  const applySettings = (next: TranslationSettings): void => {
    setSettings(next);
    setEnabled(next.enabled);
    setDefaultLocale(next.default_locale);
    setSupportedInput(formatLocaleList(next.supported_locales ?? []));
    setFallback(next.fallback_strategy);
    setLocaleAttr(next.locale_attribute);
  };

  const load = async (): Promise<TranslationSettings | null> => {
    const requestId = ++loadSequence.current;
    setLoading(true);
    setError(null);
    try {
      const response = await translationsApi.getSettings();
      if (!mountedRef.current || requestId !== loadSequence.current)
        return null;
      if (response.error) {
        setError(response.error.message);
        return null;
      }
      applySettings(response.data);
      return response.data;
    } catch {
      if (mountedRef.current && requestId === loadSequence.current) {
        setError("The translation settings request did not complete.");
      }
      return null;
    } finally {
      if (mountedRef.current && requestId === loadSequence.current) {
        setLoading(false);
      }
    }
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const response = await translationsApi.putSettings({
        enabled,
        default_locale: defaultLocale.trim() || "en",
        supported_locales: parseLocaleList(supportedInput),
        fallback_strategy: fallback,
        locale_attribute: localeAttr.trim() || "locale",
      });
      if (!mountedRef.current) return;
      if (response.error) {
        toast.error(
          "Couldn't save translation settings: " + response.error.message,
        );
        return;
      }
      applySettings(response.data);
      toast.success("Translation settings saved");
    } catch {
      if (mountedRef.current) {
        toast.error("Couldn't save translation settings: request failed.");
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const reset = (): void => {
    if (settings) applySettings(settings);
  };
  const dirty =
    settings !== null &&
    (enabled !== settings.enabled ||
      defaultLocale !== settings.default_locale ||
      supportedInput !== formatLocaleList(settings.supported_locales ?? []) ||
      fallback !== settings.fallback_strategy ||
      localeAttr !== settings.locale_attribute);

  return {
    defaultLocale,
    dirty,
    enabled,
    error,
    fallback,
    load,
    loading,
    localeAttr,
    reset,
    save,
    saving,
    settings,
    setDefaultLocale,
    setEnabled,
    setFallback,
    setLocaleAttr,
    setSupportedInput,
    supportedInput,
  };
}

function useDictionaryTransfers(onReload: () => Promise<void>) {
  const [result, setResult] = useState<TranslationImportResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const importCSV = async (file: File): Promise<void> => {
    setImporting(true);
    setResult(null);
    const transfer = beginUploadTransfer(file, {
      label: "Translation dictionary import",
      privacy: "confidential",
      retry: () => importCSV(file),
    });
    try {
      const csv = await file.text();
      const response = await translationsApi.importDictionaryCSV(csv);
      if (!mountedRef.current) return;
      if (response.error) {
        transfer.fail("translation_import_failed");
        toast.error("Import failed: " + response.error.message);
        return;
      }
      transfer.complete();
      setResult(response.data);
      void onReload();
    } catch {
      transfer.fail("translation_file_or_import_failed");
      if (mountedRef.current) {
        toast.error("Couldn't read or import the selected file.");
      }
    } finally {
      if (mountedRef.current) setImporting(false);
    }
  };

  const exportCSV = async (): Promise<void> => {
    setExporting(true);
    try {
      const response = await translationsApi.exportDictionaryCSV();
      if (!mountedRef.current) return;
      if (response.error) {
        toast.error("Export failed: " + response.error.message);
        return;
      }
      const saved = await saveFile({
        data: response.data.blob,
        suggestedName: response.data.filename,
        label: "Translation dictionary export",
        privacy: "confidential",
        mimeType: "text/csv;charset=utf-8",
      });
      if (mountedRef.current && !saved.ok) toast.error(saved.message);
    } catch {
      if (mountedRef.current) toast.error("Export failed: request failed.");
    } finally {
      if (mountedRef.current) setExporting(false);
    }
  };

  return {
    exportCSV,
    exporting,
    importCSV,
    importing,
    resetResult: (): void => setResult(null),
    result,
  };
}

function useTranslationPreviewController() {
  const [body, setBody] = useState("");
  const [locale, setLocale] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TranslationRenderResult | null>(null);
  const mountedRef = useRef(true);
  const sequence = useRef(0);

  useEffect(
    () => () => {
      mountedRef.current = false;
      sequence.current += 1;
    },
    [],
  );

  const run = async (): Promise<void> => {
    if (!locale.trim() || body.trim() === "") return;
    const requestId = ++sequence.current;
    setPreviewing(true);
    setError(null);
    setResult(null);
    try {
      const response = await translationsApi.preview({
        body,
        locale: locale.trim(),
      });
      if (!mountedRef.current || requestId !== sequence.current) return;
      if (response.error) {
        setError(translatePreviewErrorCopy(response.error));
        return;
      }
      setResult(response.data);
    } catch {
      if (mountedRef.current && requestId === sequence.current) {
        setError("The translation preview request did not complete.");
      }
    } finally {
      if (mountedRef.current && requestId === sequence.current) {
        setPreviewing(false);
      }
    }
  };

  const reset = (nextBody: string): void => {
    sequence.current += 1;
    setBody(nextBody);
    setResult(null);
    setError(null);
    setPreviewing(false);
  };

  return {
    body,
    error,
    locale,
    previewing,
    reset,
    result,
    run,
    setBody,
    setLocale,
  };
}

function useTranslationsLifecycle({
  dirty,
  onDiscard,
  open,
  operationActive,
}: {
  dirty: boolean;
  onDiscard: () => void;
  open: boolean;
  operationActive: boolean;
}): void {
  useEffect(() => {
    if (!open || (!dirty && !operationActive)) return;
    return registerLifecycleGuard({
      id: "campaign-translations-editor",
      label: "Campaign translations",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : operationActive
            ? {
                level: "blocking",
                detail:
                  "A translation save, import, export, preview, or delete operation is still in progress.",
                canDiscard: false,
              }
            : {
                level: "blocking",
                detail:
                  "Translation settings, terminology, or preview text has unsaved local changes.",
              },
      discard: onDiscard,
    });
  }, [dirty, onDiscard, open, operationActive]);
}

interface TranslationSettingsSectionProps {
  canEdit: boolean;
  defaultLocale: string;
  enabled: boolean;
  error: string | null;
  fallback: string;
  gateReason: string;
  loading: boolean;
  localeAttr: string;
  saving: boolean;
  supportedInput: string;
  onDefaultLocaleChange: (value: string) => void;
  onEnabledChange: (value: boolean) => void;
  onFallbackChange: (value: string) => void;
  onLocaleAttrChange: (value: string) => void;
  onRetry: () => void;
  onSave: () => void;
  onSupportedInputChange: (value: string) => void;
}

function TranslationSettingsSection({
  canEdit,
  defaultLocale,
  enabled,
  error,
  fallback,
  gateReason,
  loading,
  localeAttr,
  saving,
  supportedInput,
  onDefaultLocaleChange,
  onEnabledChange,
  onFallbackChange,
  onLocaleAttrChange,
  onRetry,
  onSave,
  onSupportedInputChange,
}: TranslationSettingsSectionProps): ReactElement {
  const gateDescription = canEdit ? undefined : "translation-settings-gate";
  return (
    <>
      <div className="label">Settings</div>
      {loading ? (
        <Skeleton lines={3} aria-label="Loading translation settings" />
      ) : error ? (
        <Notice
          tone="danger"
          title="Couldn't load translation settings"
          action={
            <button type="button" className="btn btn-sm" onClick={onRetry}>
              Retry
            </button>
          }
        >
          {error}
        </Notice>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {!canEdit ? (
            <div
              id="translation-settings-gate"
              className="muted"
              style={{ fontSize: 12 }}
            >
              {gateReason}.
            </div>
          ) : null}
          <label
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              fontSize: 13,
              cursor: canEdit ? "pointer" : "not-allowed",
            }}
          >
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => onEnabledChange(event.target.checked)}
              disabled={!canEdit}
              aria-describedby={gateDescription}
            />
            <span>Enable per-locale translation at send time</span>
          </label>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
            }}
          >
            <div className="field" style={{ margin: 0 }}>
              <label className="field-label" htmlFor="tr-default-locale">
                Default locale
              </label>
              <input
                id="tr-default-locale"
                type="text"
                className="input"
                value={defaultLocale}
                onChange={(event) => onDefaultLocaleChange(event.target.value)}
                placeholder="en"
                disabled={!canEdit}
                aria-describedby={gateDescription}
              />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label className="field-label" htmlFor="tr-locale-attr">
                Subscriber locale attribute
              </label>
              <input
                id="tr-locale-attr"
                type="text"
                className="input mono"
                value={localeAttr}
                onChange={(event) => onLocaleAttrChange(event.target.value)}
                placeholder="locale"
                disabled={!canEdit}
                aria-describedby={gateDescription}
              />
            </div>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label className="field-label" htmlFor="tr-supported">
              Supported locales (comma-separated)
            </label>
            <input
              id="tr-supported"
              type="text"
              className="input"
              value={supportedInput}
              onChange={(event) => onSupportedInputChange(event.target.value)}
              placeholder="en, sv, de, fr-CA"
              disabled={!canEdit}
              aria-describedby={gateDescription}
            />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label className="field-label" htmlFor="tr-fallback">
              Fallback strategy
            </label>
            <select
              id="tr-fallback"
              className="input"
              value={fallback}
              onChange={(event) => onFallbackChange(event.target.value)}
              disabled={!canEdit}
              aria-describedby={gateDescription}
            >
              {FALLBACKS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onSave}
              disabled={!canEdit || saving}
              aria-describedby={gateDescription}
            >
              {saving ? "Saving…" : "Save settings"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

interface DictionaryEntriesProps {
  canMutate: boolean;
  entries: TranslationDictionaryEntry[] | null;
  error: string | null;
  loading: boolean;
  onDelete: (entry: TranslationDictionaryEntry) => void;
  onEdit: (entry: TranslationDictionaryEntry) => void;
  onRetry: () => void;
}

function DictionaryEntries({
  canMutate,
  entries,
  error,
  loading,
  onDelete,
  onEdit,
  onRetry,
}: DictionaryEntriesProps): ReactElement {
  if (loading) {
    return <Skeleton lines={2} aria-label="Loading dictionary entries" />;
  }
  if (error) {
    return (
      <Notice
        tone="danger"
        title="Couldn't load the dictionary"
        action={
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            Retry
          </button>
        }
      >
        {error}
      </Notice>
    );
  }
  if (!entries?.length) {
    return (
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        No dictionary entries yet.
      </div>
    );
  }
  return (
    <div>
      {!canMutate ? (
        <div
          id="translation-dictionary-gate"
          className="muted"
          style={{ fontSize: 12, marginBottom: 6 }}
        >
          Viewer role can inspect dictionary entries but cannot change them.
        </div>
      ) : null}
      <table className="link-table" style={{ marginBottom: 8 }}>
        <tbody>
          {entries.map((entry) => {
            const summary = Object.entries(entry.translations)
              .map(([locale, value]) => locale + ": " + value)
              .join(" · ");
            return (
              <tr key={entry.id}>
                <td style={{ fontWeight: 600, fontSize: 12 }}>
                  {entry.term}
                  {entry.case_sensitive ? (
                    <span className="badge" style={{ marginLeft: 6 }}>
                      Aa
                    </span>
                  ) : null}
                </td>
                <td
                  className="muted"
                  style={{
                    fontSize: 11,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    maxWidth: 280,
                  }}
                  title={summary}
                >
                  {summary}
                </td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => onEdit(entry)}
                    disabled={!canMutate}
                    aria-describedby={
                      canMutate ? undefined : "translation-dictionary-gate"
                    }
                  >
                    Edit {entry.term}
                  </button>{" "}
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => onDelete(entry)}
                    disabled={!canMutate}
                    aria-describedby={
                      canMutate ? undefined : "translation-dictionary-gate"
                    }
                  >
                    Delete {entry.term}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface DictionaryEntryEditorProps {
  canMutate: boolean;
  caseSensitive: boolean;
  error: string | null;
  notes: string;
  pairs: LocalePair[];
  saving: boolean;
  term: string;
  onCaseSensitiveChange: (value: boolean) => void;
  onNotesChange: (value: string) => void;
  onPairsChange: (pairs: LocalePair[]) => void;
  onSave: () => void;
  onTermChange: (value: string) => void;
}

function DictionaryEntryEditor({
  canMutate,
  caseSensitive,
  error,
  notes,
  pairs,
  saving,
  term,
  onCaseSensitiveChange,
  onNotesChange,
  onPairsChange,
  onSave,
  onTermChange,
}: DictionaryEntryEditorProps): ReactElement {
  return (
    <div
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        padding: 10,
        display: "grid",
        gap: 8,
      }}
    >
      <div className="field" style={{ margin: 0 }}>
        <label className="field-label" htmlFor="tr-term">
          Term
        </label>
        <input
          id="tr-term"
          type="text"
          className="input"
          value={term}
          onChange={(event) => onTermChange(event.target.value)}
          placeholder="Moosewave Pro"
          disabled={!canMutate}
        />
      </div>
      {pairs.map((pair, index) => (
        <div
          key={index}
          style={{
            display: "grid",
            gridTemplateColumns: "110px 1fr auto",
            gap: 8,
          }}
        >
          <input
            type="text"
            className="input mono"
            aria-label={"Locale " + (index + 1)}
            value={pair.locale}
            onChange={(event) =>
              onPairsChange(
                pairs.map((row, rowIndex) =>
                  rowIndex === index
                    ? { ...row, locale: event.target.value }
                    : row,
                ),
              )
            }
            placeholder="sv"
            disabled={!canMutate}
          />
          <input
            type="text"
            className="input"
            aria-label={"Translation " + (index + 1)}
            value={pair.value}
            onChange={(event) =>
              onPairsChange(
                pairs.map((row, rowIndex) =>
                  rowIndex === index
                    ? { ...row, value: event.target.value }
                    : row,
                ),
              )
            }
            placeholder="Moosewave Pro (oöversatt)"
            disabled={!canMutate}
          />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() =>
              onPairsChange(pairs.filter((_, rowIndex) => rowIndex !== index))
            }
            disabled={!canMutate || pairs.length === 1}
            aria-label={"Remove pair " + (index + 1)}
          >
            ✕
          </button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => onPairsChange([...pairs, { locale: "", value: "" }])}
          disabled={!canMutate}
        >
          + Locale
        </button>
        <label
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
            fontSize: 12,
            cursor: canMutate ? "pointer" : "not-allowed",
          }}
        >
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(event) => onCaseSensitiveChange(event.target.checked)}
            disabled={!canMutate}
          />
          <span>Case sensitive</span>
        </label>
        <input
          type="text"
          className="input"
          aria-label="Notes"
          value={notes}
          onChange={(event) => onNotesChange(event.target.value)}
          placeholder="Notes (optional)"
          style={{ flex: 1 }}
          disabled={!canMutate}
        />
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onSave}
          disabled={!canMutate || saving}
        >
          {saving ? "Saving…" : "Save entry"}
        </button>
      </div>
      {error ? (
        <div className="field-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

interface DictionaryTransfersProps {
  canMutate: boolean;
  exporting: boolean;
  importing: boolean;
  result: TranslationImportResult | null;
  onExport: () => void;
  onImport: (file: File) => void;
}

function DictionaryTransfers({
  canMutate,
  exporting,
  importing,
  result,
  onExport,
  onImport,
}: DictionaryTransfersProps): ReactElement {
  const chooseImport = (): void => {
    void pickImportFiles(TRANSLATION_IMPORT_POLICY).then((picked) => {
      if (!picked.ok) toast.error(picked.message);
      else if (picked.files[0]) onImport(picked.files[0]);
    });
  };
  return (
    <div style={{ display: "grid", gap: 4, marginTop: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          type="button"
          className="btn btn-sm"
          onClick={chooseImport}
          disabled={!canMutate || importing}
          aria-describedby="translation-csv-format"
        >
          {importing ? "Importing…" : "Import CSV"}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onExport}
          disabled={exporting}
        >
          {exporting ? "Exporting…" : "Export CSV"}
        </button>
        {result ? (
          <span className="muted" style={{ fontSize: 12 }} role="status">
            Imported {result.imported}, skipped {result.skipped}
            {result.errors?.length
              ? " — " +
                result.errors.length +
                " error(s): " +
                result.errors.slice(0, 2).join("; ")
              : ""}
          </span>
        ) : null}
      </div>
      <div id="translation-csv-format" className="field-help">
        CSV columns: term, case_sensitive, notes, then one column per locale,
        such as fr, de, and es. Export CSV produces the same format.
      </div>
    </div>
  );
}

interface TranslationPreviewSectionProps {
  canMutate: boolean;
  error: string | null;
  locale: string;
  onApplyTranslation?: (translated: string) => void;
  previewBody: string;
  previewing: boolean;
  result: TranslationRenderResult | null;
  supportedLocales: string[];
  onBodyChange: (value: string) => void;
  onLocaleChange: (value: string) => void;
  onRetry: () => void;
  onRun: () => void;
}

function TranslationPreviewSection({
  canMutate,
  error,
  locale,
  onApplyTranslation,
  previewBody,
  previewing,
  result,
  supportedLocales,
  onBodyChange,
  onLocaleChange,
  onRetry,
  onRun,
}: TranslationPreviewSectionProps): ReactElement {
  const runDisabled =
    previewing || previewBody.trim() === "" || locale.trim() === "";
  return (
    <>
      <div className="label" style={{ marginTop: 16 }}>
        Translate preview
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Renders the body in a target locale through the dictionary + LLM
        pipeline. First-time translations can take up to 60 seconds.
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        <textarea
          className="input"
          rows={5}
          aria-label="Body to translate"
          value={previewBody}
          onChange={(event) => onBodyChange(event.target.value)}
          style={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            resize: "vertical",
          }}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label
            htmlFor="tr-preview-locale"
            className="muted"
            style={{ fontSize: 12 }}
          >
            Target locale
          </label>
          {supportedLocales.length > 0 ? (
            <select
              id="tr-preview-locale"
              className="input"
              value={locale}
              onChange={(event) => onLocaleChange(event.target.value)}
              style={{ width: "auto", minWidth: 120 }}
            >
              {supportedLocales.map((supportedLocale) => (
                <option key={supportedLocale} value={supportedLocale}>
                  {supportedLocale}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="tr-preview-locale"
              type="text"
              className="input mono"
              value={locale}
              onChange={(event) => onLocaleChange(event.target.value)}
              placeholder="sv"
              style={{ width: 120 }}
            />
          )}
          <span className="spacer" style={{ flex: 1 }} />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={onRun}
            disabled={runDisabled}
          >
            {previewing ? "Translating…" : "Translate preview"}
          </button>
        </div>
        {previewing ? (
          <div className="muted" style={{ fontSize: 12 }} role="status">
            Translating — LLM translation can take up to 60 seconds on a cache
            miss…
          </div>
        ) : null}
        {error ? (
          <Notice
            tone="danger"
            title="Translation failed"
            action={
              <button type="button" className="btn btn-sm" onClick={onRetry}>
                Retry
              </button>
            }
          >
            {error}
          </Notice>
        ) : null}
        {result ? (
          <div style={{ display: "grid", gap: 6 }}>
            {result.skipped ? (
              <Notice tone="warning" title="Not translated">
                The server skipped translation (translations disabled, or the
                target locale equals the default locale). The body below is the
                unmodified original.
              </Notice>
            ) : (
              <div className="muted" style={{ fontSize: 11 }}>
                Locale {result.locale} ·{" "}
                {result.cache_hit ? "cache hit" : "fresh translation"} ·{" "}
                {result.dictionary_matches} dictionary match
                {result.dictionary_matches === 1 ? "" : "es"}
              </div>
            )}
            <textarea
              className="input"
              rows={5}
              readOnly
              aria-label="Translated body"
              value={result.body}
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                resize: "vertical",
              }}
            />
            {onApplyTranslation && !result.skipped ? (
              <div style={{ display: "grid", gap: 4, justifyItems: "end" }}>
                {!canMutate ? (
                  <span
                    id="translation-apply-gate"
                    className="muted"
                    style={{ fontSize: 11 }}
                  >
                    Viewer role can't edit the draft.
                  </span>
                ) : null}
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    onApplyTranslation(result.body);
                    toast.success("Translated body applied to the draft");
                  }}
                  disabled={!canMutate}
                  aria-describedby={
                    canMutate ? undefined : "translation-apply-gate"
                  }
                >
                  Use as draft body
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
