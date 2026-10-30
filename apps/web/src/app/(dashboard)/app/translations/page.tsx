// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Campaign translations.
 *
 * Five `/api/v1/translations/*` paths desktop reached and web did not.
 *
 * `updated_at` is Go's zero time on a workspace that has never saved settings.
 * It goes through `formatWireTimestamp`, so the page says "Never saved" rather
 * than "01/01/0001" — a date that reads as corrupt data.
 *
 * TWO DIFFERENT AUTHORITIES, and conflating them would produce a button that
 * only 403s. `PUT /settings` is ScopeAdmin (enabling translation routes every
 * send through the LLM gateway, which costs money), so it is owner/admin only.
 * The dictionary and the preview are ScopeWriteCampaigns, which editors hold.
 * Each control names the tier it needs instead of showing one gate for both.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";

import { PageShell } from "@/components/dashboard/page-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ContentQueryError } from "../_content-automation/content-query-error";
import { apiErrorMessage, fetchTextAuthed } from "@/lib/api";
import { downloadTextFile } from "@/lib/download";
import {
  effectiveAuthRole,
  whoami,
  whoamiFresh,
  type MeResponse,
} from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import {
  GLOSSARY_CSV_MAX_BYTES,
  TRANSLATIONS_CSV_PATH,
  TRANSLATION_FALLBACK_STRATEGIES,
  csvIsHeaderOnly,
  deleteTranslationEntry,
  getTranslationDictionary,
  getTranslationSettings,
  importGlossaryCsv,
  isValidTranslationLocale,
  parseLocaleList,
  previewTranslation,
  saveTranslationSettings,
  upsertTranslationEntry,
  type GlossaryImportResult,
  type TranslationEntry,
  type TranslationFallbackStrategy,
  type TranslationPreview,
  type TranslationSettings,
} from "@/lib/translations-api";
import { roleCanWrite } from "@/lib/use-admin-gate";
import { base, STALE } from "@/lib/query-keys";

function canWriteCampaigns(identity: MeResponse | undefined): boolean {
  return Boolean(
    identity &&
    !identity.viewer_mode &&
    effectiveAuthRole(identity) !== "viewer",
  );
}

/** PUT /translations/settings is ScopeAdmin: owner or admin, never editor. */
function canWriteSettings(identity: MeResponse | undefined): boolean {
  return Boolean(
    identity &&
    !identity.viewer_mode &&
    roleCanWrite(effectiveAuthRole(identity)),
  );
}

async function verifyFreshAuthority(
  opened: MeResponse,
  allows: (identity: MeResponse) => boolean,
  requirement: string,
): Promise<void> {
  const fresh = await whoamiFresh();
  if (
    fresh.user_id !== opened.user_id ||
    fresh.tenant_id !== opened.tenant_id ||
    effectiveAuthRole(fresh) !== effectiveAuthRole(opened) ||
    Boolean(fresh.viewer_mode) !== Boolean(opened.viewer_mode)
  ) {
    throw new Error(
      "Workspace identity or authority changed. Nothing was changed; reload and retry.",
    );
  }
  if (!allows(fresh)) throw new Error(requirement);
}

function verifyFreshCampaignAuthority(opened: MeResponse): Promise<void> {
  return verifyFreshAuthority(
    opened,
    canWriteCampaigns,
    "Editor, admin, or owner access is required.",
  );
}

function verifyFreshSettingsAuthority(opened: MeResponse): Promise<void> {
  return verifyFreshAuthority(
    opened,
    canWriteSettings,
    "Admin or owner access is required to change translation settings.",
  );
}

interface SettingsDraft {
  enabled: boolean;
  defaultLocale: string;
  supportedLocales: string;
  fallback: TranslationFallbackStrategy;
  localeAttribute: string;
}

function isFallbackStrategy(
  value: string,
): value is TranslationFallbackStrategy {
  return (TRANSLATION_FALLBACK_STRATEGIES as readonly string[]).includes(value);
}

function draftFromSettings(settings: TranslationSettings): SettingsDraft {
  return {
    enabled: settings.enabled,
    defaultLocale: settings.default_locale ?? "",
    supportedLocales: (settings.supported_locales ?? []).join(", "),
    fallback: isFallbackStrategy(settings.fallback_strategy)
      ? settings.fallback_strategy
      : "subscriber_locale",
    localeAttribute: settings.locale_attribute ?? "",
  };
}

/**
 * The first message the server would answer with, computed locally.
 *
 * PUT validates the whole body and rejects it whole, so one malformed locale
 * discards the other four fields' edits. Saying which value is wrong before
 * the request leaves is the difference between fixing a typo and losing the
 * form.
 */
function settingsDraftProblem(draft: SettingsDraft): string | null {
  const defaultLocale = draft.defaultLocale.trim();
  if (!isValidTranslationLocale(defaultLocale)) {
    return "Default locale must be 2–16 characters of letters, digits, - or _.";
  }
  const supported = parseLocaleList(draft.supportedLocales);
  if (supported.length === 0) {
    return "List at least one supported locale.";
  }
  const invalid = supported.find((locale) => !isValidTranslationLocale(locale));
  if (invalid !== undefined) {
    return `Supported locale "${invalid}" must be 2–16 characters of letters, digits, - or _.`;
  }
  const attribute = draft.localeAttribute.trim();
  if (attribute === "" || attribute.length > 64) {
    return "Locale attribute must be 1–64 characters.";
  }
  return null;
}

interface TermPair {
  locale: string;
  value: string;
}

const EMPTY_PAIR: TermPair = { locale: "", value: "" };

export default function TranslationsPage() {
  const queryClient = useQueryClient();
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data;
  const role = identity ? effectiveAuthRole(identity) : null;
  const canEdit = canWriteCampaigns(identity);
  const canEditSettings = canWriteSettings(identity);
  const keyBase = useMemo(
    () => base("translations", identity?.tenant_id ?? "anon", role),
    [identity?.tenant_id, role],
  );
  const settingsKey = useMemo(() => [...keyBase, "settings"], [keyBase]);
  const dictionaryKey = useMemo(() => [...keyBase, "dictionary"], [keyBase]);

  const settings = useQuery({
    queryKey: settingsKey,
    queryFn: getTranslationSettings,
    enabled: meQuery.isSuccess,
    staleTime: STALE.reference,
  });
  const dictionary = useQuery({
    queryKey: dictionaryKey,
    queryFn: getTranslationDictionary,
    enabled: meQuery.isSuccess,
    staleTime: STALE.list,
  });

  const s = settings.data;
  const entries = Array.isArray(dictionary.data) ? dictionary.data : [];
  const supportedLocales = s?.supported_locales ?? [];

  const [preview, setPreview] = useState<TranslationPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const [previewBody, setPreviewBody] = useState(
    "Hello {{ subscriber.first_name }}",
  );
  const [previewLocale, setPreviewLocale] = useState("");
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [exportFailed, setExportFailed] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportingRef = useRef(false);
  const previewingRef = useRef(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const importingRef = useRef(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<GlossaryImportResult | null>(
    null,
  );
  const [importError, setImportError] = useState<string | null>(null);

  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const savingSettingsRef = useRef(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSaved, setSettingsSaved] = useState<string | null>(null);

  const [term, setTerm] = useState("");
  const [pairs, setPairs] = useState<TermPair[]>([EMPTY_PAIR]);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [notes, setNotes] = useState("");
  const [savingTerm, setSavingTerm] = useState(false);
  const savingTermRef = useRef(false);
  const [termError, setTermError] = useState<string | null>(null);
  const [termSaved, setTermSaved] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<TranslationEntry | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);

  // Seed the editable copies once the server's values arrive, and re-seed when
  // the workspace's own settings change underneath an untouched form. A draft
  // the operator has started is never overwritten — that is their typing.
  const loadedSettingsStamp = s
    ? `${String(s.enabled)}|${s.default_locale}|${JSON.stringify(s.supported_locales ?? [])}|${s.fallback_strategy}|${s.locale_attribute}`
    : null;
  useEffect(() => {
    if (!s) return;
    setDraft((current) => current ?? draftFromSettings(s));
    setPreviewLocale((current) => {
      if (current !== "") return current;
      const first = (s.supported_locales ?? []).find(
        (locale) => locale !== s.default_locale,
      );
      return first ?? s.default_locale ?? "";
    });
    // `s` is a fresh object every render; the stamp is its VALUE identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedSettingsStamp]);

  const settingsDirty = Boolean(
    draft &&
    s &&
    (draft.enabled !== s.enabled ||
      draft.defaultLocale !== (s.default_locale ?? "") ||
      draft.supportedLocales !== (s.supported_locales ?? []).join(", ") ||
      draft.fallback !== s.fallback_strategy ||
      draft.localeAttribute !== (s.locale_attribute ?? "")),
  );

  function updateDraft(patch: Partial<SettingsDraft>) {
    setSettingsSaved(null);
    setSettingsError(null);
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }

  async function saveSettings() {
    if (savingSettingsRef.current || !identity || !canEditSettings || !draft) {
      return;
    }
    const problem = settingsDraftProblem(draft);
    if (problem) {
      setSettingsSaved(null);
      setSettingsError(problem);
      return;
    }
    savingSettingsRef.current = true;
    setSavingSettings(true);
    setSettingsError(null);
    setSettingsSaved(null);
    try {
      await verifyFreshSettingsAuthority(identity);
      const saved = await saveTranslationSettings({
        enabled: draft.enabled,
        default_locale: draft.defaultLocale.trim(),
        supported_locales: parseLocaleList(draft.supportedLocales),
        fallback_strategy: draft.fallback,
        locale_attribute: draft.localeAttribute.trim(),
      });
      // The server normalizes (deduplicates locales, falls back to the default
      // when the list empties), so the form is re-seeded from what it STORED,
      // not from what was typed.
      queryClient.setQueryData(settingsKey, saved);
      setDraft(draftFromSettings(saved));
      setSettingsSaved(
        saved.enabled
          ? `Saved. Sends are translated into ${saved.supported_locales.join(", ") || saved.default_locale}.`
          : "Saved. Translation is off, so every send uses the campaign body as written.",
      );
    } catch (error) {
      setSettingsError(
        apiErrorMessage(error, "Could not save the translation settings."),
      );
    } finally {
      savingSettingsRef.current = false;
      setSavingSettings(false);
    }
  }

  function resetSettingsDraft() {
    if (!s) return;
    setDraft(draftFromSettings(s));
    setSettingsError(null);
    setSettingsSaved(null);
  }

  const termTranslations = pairs.reduce<Record<string, string>>((acc, pair) => {
    const locale = pair.locale.trim();
    if (locale !== "") acc[locale] = pair.value;
    return acc;
  }, {});
  const invalidPairLocale = Object.keys(termTranslations).find(
    (locale) => !isValidTranslationLocale(locale),
  );

  async function saveTerm() {
    if (savingTermRef.current || !identity || !canEdit) return;
    const trimmed = term.trim();
    if (trimmed === "") {
      setTermSaved(null);
      setTermError("Enter the term to protect or replace.");
      return;
    }
    if (invalidPairLocale !== undefined) {
      setTermSaved(null);
      setTermError(
        `Locale "${invalidPairLocale}" must be 2–16 characters of letters, digits, - or _.`,
      );
      return;
    }
    savingTermRef.current = true;
    setSavingTerm(true);
    setTermError(null);
    setTermSaved(null);
    try {
      await verifyFreshCampaignAuthority(identity);
      const saved = await upsertTranslationEntry({
        term: trimmed,
        translations: termTranslations,
        case_sensitive: caseSensitive,
        notes: notes.trim(),
      });
      await dictionary.refetch();
      setTerm("");
      setPairs([EMPTY_PAIR]);
      setCaseSensitive(false);
      setNotes("");
      setTermSaved(
        Object.keys(termTranslations).length === 0
          ? `"${saved.term ?? trimmed}" is protected — the translator will leave it untouched.`
          : `"${saved.term ?? trimmed}" saved with ${Object.keys(termTranslations).length} locale replacement(s).`,
      );
    } catch (error) {
      setTermError(
        apiErrorMessage(error, "Could not save this dictionary entry."),
      );
    } finally {
      savingTermRef.current = false;
      setSavingTerm(false);
    }
  }

  /**
   * Throws on failure ON PURPOSE: ConfirmDialog keeps itself open and renders
   * the thrown message. Swallowing it here would close the dialog on a failed
   * delete, which reads exactly like a successful one.
   */
  async function confirmDelete() {
    const target = deleteTarget;
    if (deletingRef.current || !identity || !canEdit || !target?.id) return;
    deletingRef.current = true;
    setDeleting(true);
    try {
      await verifyFreshCampaignAuthority(identity);
      await deleteTranslationEntry(target.id);
      await dictionary.refetch();
      setDeleteTarget(null);
    } catch (error) {
      throw new Error(
        apiErrorMessage(error, "Could not delete this dictionary entry."),
      );
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  }

  async function exportGlossary() {
    if (exportingRef.current) return;
    exportingRef.current = true;
    setExporting(true);
    setExportNote(null);
    setExportFailed(false);
    try {
      // Streamed through the authenticated client, not an <a href> — a bare
      // link would reach the API without the session headers and save an
      // error page under a .csv name.
      const text = await fetchTextAuthed(TRANSLATIONS_CSV_PATH);
      downloadTextFile("glossary.csv", text, "text/csv;charset=utf-8");
      setExportNote(
        csvIsHeaderOnly(text)
          ? "Downloaded glossary.csv — it contains the column headers and no terms, because the glossary is empty."
          : "Downloaded glossary.csv.",
      );
    } catch {
      setExportFailed(true);
      setExportNote("Could not export the glossary.");
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  }

  async function runPreview() {
    if (previewingRef.current || !identity || !canEdit) return;
    const locale = previewLocale.trim();
    const body = previewBody.trim();
    if (body === "") {
      setPreview(null);
      setPreviewNote("Enter the copy you want translated.");
      return;
    }
    if (!isValidTranslationLocale(locale)) {
      setPreview(null);
      setPreviewNote(
        "Choose a target locale of 2–16 characters (letters, digits, - or _).",
      );
      return;
    }
    previewingRef.current = true;
    setPreviewing(true);
    setPreviewNote(null);
    try {
      await verifyFreshCampaignAuthority(identity);
      const next = await previewTranslation(previewBody, locale);
      setPreview(next);
      setPreviewNote(null);
    } catch (error) {
      setPreview(null);
      setPreviewNote(
        apiErrorMessage(
          error,
          "Could not preview this translation. Your original copy has not been presented as translated output.",
        ),
      );
    } finally {
      previewingRef.current = false;
      setPreviewing(false);
    }
  }

  async function importGlossary() {
    if (importingRef.current || !identity || !canEdit || !importFile) return;
    importingRef.current = true;
    setImporting(true);
    setImportResult(null);
    setImportError(null);
    try {
      await verifyFreshCampaignAuthority(identity);
      const result = await importGlossaryCsv(importFile);
      setImportResult(result);
      await dictionary.refetch();
      setImportFile(null);
      if (importInputRef.current) importInputRef.current.value = "";
    } catch (error) {
      setImportError(apiErrorMessage(error, "Could not import the glossary."));
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  }

  return (
    <PageShell className="max-w-5xl">
      <header>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Translations
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Send each subscriber the locale they asked for.
        </p>
      </header>

      {meQuery.isError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 p-3"
        >
          <p className="text-sm text-destructive">
            Workspace identity could not be verified, so translation data and
            write controls were not requested.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2"
            disabled={meQuery.isFetching}
            onClick={() => void meQuery.refetch()}
          >
            {meQuery.isFetching ? "Retrying…" : "Retry identity"}
          </Button>
        </div>
      ) : null}

      <section
        aria-labelledby="tr-settings"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="tr-settings" className="text-base font-medium">
          Settings
        </h2>
        {settings.isLoading ? (
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            Loading…
          </p>
        ) : settings.isError ? (
          <ContentQueryError
            message="Could not load translation settings."
            onRetry={() => settings.refetch()}
            retrying={settings.isFetching}
          />
        ) : s ? (
          <div className="mt-2 space-y-1 text-sm text-muted-foreground">
            <p className="break-words">
              Translations are{" "}
              <span className="font-medium text-foreground">
                {s.enabled ? "on" : "off"}
              </span>
              . Default locale {s.default_locale}; supported:{" "}
              {s.supported_locales.join(", ") || "none"}.
            </p>
            <p className="break-words">
              Fallback: {s.fallback_strategy}, read from the{" "}
              <code className="break-all">{s.locale_attribute}</code> attribute.
            </p>
            <p>
              {/* Go zero time means "never", not the year 1. */}
              Last saved: {formatWireTimestamp(s.updated_at, "never")}
            </p>
          </div>
        ) : null}

        {s && draft && canEditSettings ? (
          <form
            className="mt-5 space-y-4 border-t pt-5"
            onSubmit={(event) => {
              event.preventDefault();
              void saveSettings();
            }}
          >
            <div className="flex items-start gap-2">
              <Checkbox
                id="translation-enabled"
                className="mt-1"
                checked={draft.enabled}
                disabled={savingSettings}
                onChange={(event) =>
                  updateDraft({ enabled: event.target.checked })
                }
              />
              <div className="min-w-0">
                <Label htmlFor="translation-enabled">
                  Translate campaign bodies per locale
                </Label>
                <p className="text-xs text-muted-foreground">
                  Turning this on routes every send through the LLM translation
                  gateway, which is a billed request per uncached body and
                  locale.
                </p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="translation-default-locale">
                  Default locale
                </Label>
                <Input
                  id="translation-default-locale"
                  value={draft.defaultLocale}
                  disabled={savingSettings}
                  placeholder="en"
                  onChange={(event) =>
                    updateDraft({ defaultLocale: event.target.value })
                  }
                />
              </div>
              <div>
                <Label htmlFor="translation-locale-attribute">
                  Subscriber attribute holding the locale
                </Label>
                <Input
                  id="translation-locale-attribute"
                  value={draft.localeAttribute}
                  disabled={savingSettings}
                  placeholder="language"
                  onChange={(event) =>
                    updateDraft({ localeAttribute: event.target.value })
                  }
                />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="translation-supported-locales">
                  Supported locales
                </Label>
                <Input
                  id="translation-supported-locales"
                  value={draft.supportedLocales}
                  disabled={savingSettings}
                  placeholder="en, fr, es-MX"
                  onChange={(event) =>
                    updateDraft({ supportedLocales: event.target.value })
                  }
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Comma or space separated. Duplicates are dropped by the
                  server, and an empty list is stored as the default locale
                  alone.
                </p>
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="translation-fallback">
                  When a subscriber has no locale
                </Label>
                <Select
                  id="translation-fallback"
                  value={draft.fallback}
                  disabled={savingSettings}
                  onChange={(event) => {
                    const next = event.target.value;
                    if (isFallbackStrategy(next)) {
                      updateDraft({ fallback: next });
                    }
                  }}
                >
                  <option value="subscriber_locale">
                    subscriber_locale — use their attribute, else the default
                  </option>
                  <option value="default_only">
                    default_only — always send the default locale
                  </option>
                </Select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                disabled={!settingsDirty || savingSettings}
                loading={savingSettings}
              >
                Save settings
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!settingsDirty || savingSettings}
                onClick={resetSettingsDraft}
              >
                Discard changes
              </Button>
            </div>
            {settingsError ? (
              <p role="alert" className="text-sm text-destructive">
                {settingsError}
              </p>
            ) : null}
            {settingsSaved ? (
              <p role="status" className="text-sm text-muted-foreground">
                {settingsSaved}
              </p>
            ) : null}
          </form>
        ) : s && meQuery.isSuccess ? (
          <p className="mt-4 border-t pt-4 text-sm text-muted-foreground">
            These settings are read-only for this role. Admin or owner access is
            required to change them, because enabling translation bills a
            gateway request per body and locale.
          </p>
        ) : null}
      </section>

      <section
        aria-labelledby="tr-import"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="tr-import" className="text-base font-medium">
          Import glossary
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload a CSV with a required <code>term</code> column and optional
          <code> case_sensitive</code>, <code>notes</code>, and locale columns.
          Existing terms are updated. Maximum size: 5 MiB.
        </p>
        {canEdit ? (
          <form
            className="mt-4 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void importGlossary();
            }}
          >
            <div className="max-w-xl">
              <Label htmlFor="translation-glossary-csv">Glossary CSV</Label>
              <Input
                ref={importInputRef}
                id="translation-glossary-csv"
                type="file"
                accept=".csv,text/csv,application/csv"
                disabled={importing}
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  setImportResult(null);
                  setImportError(
                    file && file.size > GLOSSARY_CSV_MAX_BYTES
                      ? "Glossary CSV files must be 5 MiB or smaller."
                      : file && file.size === 0
                        ? "Choose a non-empty glossary CSV file."
                        : null,
                  );
                  setImportFile(
                    file && file.size > 0 && file.size <= GLOSSARY_CSV_MAX_BYTES
                      ? file
                      : null,
                  );
                }}
              />
            </div>
            <Button type="submit" disabled={!importFile || importing}>
              {importing ? "Importing…" : "Import glossary"}
            </Button>
          </form>
        ) : meQuery.isPending ? (
          <p role="status" className="mt-3 text-sm text-muted-foreground">
            Verifying workspace authority…
          </p>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            Import is read-only for this role. Editor, admin, or owner access is
            required.
          </p>
        )}
        {importError ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {importError}
          </p>
        ) : null}
        {importResult ? (
          <div role="status" className="mt-3 rounded-md border p-3 text-sm">
            <p>
              Imported {importResult.imported.toLocaleString()}; skipped{" "}
              {importResult.skipped.toLocaleString()}.
            </p>
            {importResult.errors.length > 0 ? (
              <>
                <p className="mt-2 font-medium">
                  {importResult.errors.length.toLocaleString()} issue
                  {importResult.errors.length === 1 ? "" : "s"} reported:
                </p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {importResult.errors.slice(0, 20).map((message, index) => (
                    <li key={`${index}:${message}`}>{message}</li>
                  ))}
                </ul>
                {importResult.errors.length > 20 ? (
                  <p className="mt-2 text-muted-foreground">
                    {importResult.errors.length - 20} additional issues are not
                    shown.
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="tr-dict">
        <h2 id="tr-dict" className="text-base font-medium">
          Dictionary
        </h2>
        {dictionary.isLoading ? (
          <p role="status" className="mt-1 text-sm text-muted-foreground">
            Loading…
          </p>
        ) : dictionary.isError ? (
          <ContentQueryError
            message="Could not load the dictionary."
            onRetry={() => dictionary.refetch()}
            retrying={dictionary.isFetching}
          />
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">
            {entries.length === 0
              ? "No translation entries yet."
              : `${entries.length} entries.`}
          </p>
        )}

        {canEdit ? (
          <form
            className="mt-3 space-y-4 rounded-lg border p-4 sm:p-6"
            onSubmit={(event) => {
              event.preventDefault();
              void saveTerm();
            }}
          >
            <div>
              <h3 className="text-sm font-medium">Add or update a term</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                A term with no locale rows is a <em>protected</em> term: the
                translator is instructed to leave it exactly as written. Add
                rows only where one locale must use a specific wording. Saving a
                term that already exists replaces its rows.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="dictionary-term">Term</Label>
                <Input
                  id="dictionary-term"
                  value={term}
                  disabled={savingTerm}
                  placeholder="Moosewave"
                  onChange={(event) => {
                    setTerm(event.target.value);
                    setTermError(null);
                    setTermSaved(null);
                  }}
                />
              </div>
              <div>
                <Label htmlFor="dictionary-notes">Notes (optional)</Label>
                <Input
                  id="dictionary-notes"
                  value={notes}
                  disabled={savingTerm}
                  placeholder="Trademark — never translate"
                  onChange={(event) => setNotes(event.target.value)}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="dictionary-case-sensitive"
                checked={caseSensitive}
                disabled={savingTerm}
                onChange={(event) => setCaseSensitive(event.target.checked)}
              />
              <Label htmlFor="dictionary-case-sensitive">
                Match this term case-sensitively
              </Label>
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">
                Locale replacements
              </legend>
              {pairs.map((pair, index) => (
                <div
                  key={`pair-${index}`}
                  className="flex flex-wrap items-end gap-2"
                >
                  <div className="w-32">
                    <Label htmlFor={`dictionary-pair-locale-${index}`}>
                      Locale
                    </Label>
                    <Input
                      id={`dictionary-pair-locale-${index}`}
                      value={pair.locale}
                      disabled={savingTerm}
                      placeholder="fr"
                      onChange={(event) => {
                        const next = event.target.value;
                        setTermError(null);
                        setPairs((current) =>
                          current.map((row, position) =>
                            position === index ? { ...row, locale: next } : row,
                          ),
                        );
                      }}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <Label htmlFor={`dictionary-pair-value-${index}`}>
                      Replacement
                    </Label>
                    <Input
                      id={`dictionary-pair-value-${index}`}
                      value={pair.value}
                      disabled={savingTerm}
                      placeholder="Moosewave"
                      onChange={(event) => {
                        const next = event.target.value;
                        setPairs((current) =>
                          current.map((row, position) =>
                            position === index ? { ...row, value: next } : row,
                          ),
                        );
                      }}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={savingTerm || pairs.length === 1}
                    aria-label={`Remove locale row ${index + 1}`}
                    onClick={() =>
                      setPairs((current) =>
                        current.filter((_row, position) => position !== index),
                      )
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={savingTerm}
                onClick={() => setPairs((current) => [...current, EMPTY_PAIR])}
              >
                Add locale row
              </Button>
            </fieldset>
            <Button
              type="submit"
              disabled={savingTerm || term.trim() === ""}
              loading={savingTerm}
            >
              Save term
            </Button>
            {termError ? (
              <p role="alert" className="text-sm text-destructive">
                {termError}
              </p>
            ) : null}
            {termSaved ? (
              <p role="status" className="text-sm text-muted-foreground">
                {termSaved}
              </p>
            ) : null}
          </form>
        ) : meQuery.isSuccess ? (
          <p className="mt-3 text-sm text-muted-foreground">
            The dictionary is read-only for this role. Editor, admin, or owner
            access is required to add or remove terms.
          </p>
        ) : null}

        {!dictionary.isLoading && !dictionary.isError && entries.length > 0 ? (
          <ul className="mt-3 divide-y rounded-lg border bg-card">
            {entries.map((entry, index) => {
              const translations = Object.entries(
                entry.translations ?? {},
              ).sort(([left], [right]) => left.localeCompare(right));
              return (
                <li
                  key={entry.id ?? `${entry.term}:${index}`}
                  className="space-y-2 p-3 text-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="min-w-0 break-words font-medium">
                      {entry.term || `Unnamed term ${index + 1}`}
                    </p>
                    <div className="flex shrink-0 items-center gap-2">
                      {entry.case_sensitive ? (
                        <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                          Case sensitive
                        </span>
                      ) : null}
                      {canEdit && entry.id ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Delete ${entry.term || "this term"}`}
                          onClick={() => setDeleteTarget(entry)}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden />
                          Delete
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {translations.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Protected term; no locale-specific replacements.
                    </p>
                  ) : (
                    <dl className="grid gap-1.5 sm:grid-cols-2">
                      {translations.map(([locale, value]) => (
                        <div
                          key={locale}
                          className="min-w-0 rounded-md bg-muted/40 px-2.5 py-2"
                        >
                          <dt className="text-xs uppercase text-muted-foreground">
                            {locale}
                          </dt>
                          <dd className="break-words">{value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {entry.notes ? (
                    <p className="break-words text-xs text-muted-foreground">
                      {entry.notes}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
        title={`Delete "${deleteTarget?.term ?? ""}" from the dictionary?`}
        description={
          <>
            The term stops being protected. Future translations of every
            campaign may render it in the target language instead of leaving it
            as written, and its{" "}
            {Object.keys(deleteTarget?.translations ?? {}).length} locale
            replacement(s) are removed. This cannot be undone; re-adding the
            term restores protection but not its history.
          </>
        }
        confirmLabel={deleting ? "Deleting…" : "Delete term"}
        confirmVariant="destructive"
        onConfirm={confirmDelete}
      />

      <section
        aria-labelledby="tr-export"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="tr-export" className="text-base font-medium">
          Export
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Download the glossary as CSV.
        </p>
        <Button
          type="button"
          onClick={exportGlossary}
          disabled={!meQuery.isSuccess || exporting}
          title={
            meQuery.isSuccess
              ? undefined
              : "Workspace identity must be verified before exporting."
          }
          variant="outline"
          className="mt-3"
        >
          {exporting ? "Exporting…" : "Export glossary"}
        </Button>
        {/* An empty export is a valid file and looks identical to a full one
            until it is opened, so the result says which was saved. */}
        {exportNote ? (
          <p
            className={
              exportFailed
                ? "mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm font-medium text-foreground"
                : "mt-2 text-sm text-muted-foreground"
            }
            role={exportFailed ? "alert" : "status"}
          >
            {exportNote}
          </p>
        ) : null}
      </section>

      <section
        aria-labelledby="tr-preview"
        className="rounded-lg border p-4 sm:p-6"
      >
        <h2 id="tr-preview" className="text-base font-medium">
          Preview a translation
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Runs one body through the dictionary and the LLM gateway without
          sending anything. A first, uncached translation can take up to a
          minute.
        </p>
        <div className="mt-4 space-y-3">
          <div>
            <Label htmlFor="translation-preview-body">Body to translate</Label>
            <Textarea
              id="translation-preview-body"
              value={previewBody}
              rows={4}
              disabled={!canEdit || previewing}
              className="font-mono"
              onChange={(event) => {
                setPreviewBody(event.target.value);
                setPreviewNote(null);
              }}
            />
          </div>
          <div className="max-w-xs">
            <Label htmlFor="translation-preview-locale">Target locale</Label>
            {/* One control, suggesting the workspace's own supported locales
                without confining the reader to them: deciding whether to ADD a
                locale means previewing it first. A branch between a <Select>
                and an <Input> would put the same id on two elements. */}
            <Input
              id="translation-preview-locale"
              list="translation-preview-locale-options"
              value={previewLocale}
              disabled={!canEdit || previewing}
              placeholder="fr"
              onChange={(event) => {
                setPreviewLocale(event.target.value);
                setPreviewNote(null);
              }}
            />
            <datalist id="translation-preview-locale-options">
              {supportedLocales.map((locale) => (
                <option key={locale} value={locale} />
              ))}
            </datalist>
            {supportedLocales.length > 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Supported here: {supportedLocales.join(", ")}. A locale outside
                that list previews fine but is not sent to anyone.
              </p>
            ) : null}
          </div>
        </div>
        <Button
          type="button"
          disabled={!canEdit || previewing}
          onClick={() => void runPreview()}
          variant="outline"
          className="mt-3"
          loading={previewing}
        >
          {canEdit
            ? previewLocale.trim() === ""
              ? "Translate"
              : `Translate into ${previewLocale.trim()}`
            : "Preview unavailable"}
        </Button>
        {!canEdit && meQuery.isSuccess ? (
          <p className="mt-2 text-xs text-muted-foreground">
            The preview endpoint requires editor, admin, or owner access.
          </p>
        ) : null}
        {previewNote ? (
          <p
            className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm font-medium text-foreground"
            role="alert"
          >
            {previewNote}
          </p>
        ) : null}
        {preview ? (
          preview.skipped ? (
            // The body comes back unchanged. Showing it would imply a
            // translation that did not happen.
            <p className="mt-3 text-sm text-muted-foreground">
              Nothing was translated — the text below is your original copy, not
              a {preview.locale || "translated"} version. The glossary matched{" "}
              {preview.dictionary_matches} term(s), so there was nothing to
              substitute.
            </p>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              Translated into {preview.locale} using{" "}
              {preview.dictionary_matches} glossary term(s)
              {preview.cache_hit ? ", served from cache" : ""}.
            </p>
          )
        ) : null}
        {preview ? (
          <pre
            tabIndex={0}
            role="group"
            aria-label="Translation preview"
            className="mt-2 overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <code>{preview.body}</code>
          </pre>
        ) : null}
      </section>
    </PageShell>
  );
}
